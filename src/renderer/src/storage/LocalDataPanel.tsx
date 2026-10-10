import { useEffect, useRef, useState } from 'react';
import type { ConversationStorageStatus } from '../../../shared/types/conversation';
import type { DataTransferAction, DataTransferStatus } from '../../../shared/types/data-transfer';
import './local-data.css';

const ACTIVE = new Set([
  'choosing',
  'confirming',
  'draining',
  'validating',
  'verifying',
  'publishing',
  'handoff',
  'awaiting-restart',
  'recovering-original',
  'recovery-required',
]);
interface PendingRead {
  startedAt: number;
  completion: Promise<void>;
}

/** Always mounted in browser chrome so recovery errors remain reachable without AI services. */
export function LocalDataPanel() {
  const [status, setStatus] = useState<DataTransferStatus | null>(null);
  const [storage, setStorage] = useState<ConversationStorageStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [controlling, setControlling] = useState(false);
  const lifecycle = useRef(0);
  const sequence = useRef(0);
  const published = useRef(0);
  const current = useRef<DataTransferStatus | null>(null);
  const transferRead = useRef<PendingRead | null>(null);
  const storageRead = useRef<PendingRead | null>(null);
  const startPending = useRef(false);
  const controlPending = useRef(false);

  const publish = (value: DataTransferStatus, order: number): void => {
    if (order < published.current) return;
    published.current = order;
    current.current = value;
    setStatus(value);
    setNotice(null);
  };

  useEffect(() => {
    const epoch = ++lifecycle.current;
    let live = true;
    const valid = () => live && lifecycle.current === epoch;
    const observe = (
      slot: { current: PendingRead | null },
      read: () => Promise<void>,
      unavailable: () => void,
    ): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const poll = (): void => {
        if (!valid()) return;
        let pending = slot.current;
        if (pending === null) {
          let complete!: () => void;
          pending = {
            startedAt: performance.now(),
            completion: new Promise<void>((resolve) => {
              complete = resolve;
            }),
          };
          slot.current = pending;
          const owned = pending;
          // Publish the slot before invoking the bridge. Only this effect may
          // accept its result; successors observe completion and request afresh.
          void (async () => {
            try {
              await read();
            } catch {
              if (valid()) unavailable();
            } finally {
              if (slot.current === owned) slot.current = null;
              complete();
            }
          })();
        }
        const observed = pending;
        const remaining = 10_000 - (performance.now() - observed.startedAt);
        const timedOut = () => {
          if (valid() && slot.current === observed) unavailable();
        };
        // Reattach to the original deadline after StrictMode cleanup. Never
        // restart an occupied slot or adopt the old effect's eventual value.
        if (remaining <= 0) timedOut();
        else watchdog = setTimeout(timedOut, remaining);
        void observed.completion.then(() => {
          clearTimeout(watchdog);
          if (valid())
            timer = setTimeout(poll, ACTIVE.has(current.current?.state ?? '') ? 500 : 2000);
        });
      };
      poll();
      return () => {
        clearTimeout(timer);
        clearTimeout(watchdog);
      };
    };
    const stopTransfer = observe(
      transferRead,
      async () => {
        const order = ++sequence.current;
        try {
          const value = await window.aibrowse.dataTransfer.getStatus();
          if (valid()) publish(value, order);
        } catch {
          if (valid() && order >= published.current) setNotice('本地数据状态暂不可用，请稍候');
        }
      },
      () => setNotice('本地数据状态暂不可用，请稍候'),
    );
    const stopStorage = observe(
      storageRead,
      async () => {
        const value = await window.aibrowse.getConversationStorageStatus();
        if (valid()) {
          setStorage(value);
          setStorageNotice(null);
        }
      },
      () => setStorageNotice('会话保存状态暂不可用，不能确认已保存'),
    );
    return () => {
      live = false;
      if (lifecycle.current === epoch) lifecycle.current++;
      stopTransfer();
      stopStorage();
    };
  }, []);

  const start = async (action: DataTransferAction): Promise<void> => {
    if (
      startPending.current ||
      controlPending.current ||
      !current.current ||
      !current.current.availableActions.includes(action)
    )
      return;
    startPending.current = true;
    setStarting(true);
    const epoch = lifecycle.current;
    const order = ++sequence.current;
    published.current = order;
    try {
      const value = await window.aibrowse.dataTransfer.start(action);
      if (epoch === lifecycle.current) publish(value, order);
    } catch {
      if (epoch === lifecycle.current) setNotice('操作未完成，请查看本地数据状态后重试');
    } finally {
      startPending.current = false;
      if (epoch === lifecycle.current) setStarting(false);
    }
  };
  const control = async (kind: 'cancel' | 'recoverOriginal'): Promise<void> => {
    const value = current.current;
    if (
      controlPending.current ||
      !value?.operationId ||
      (kind === 'cancel' ? !value.canCancel : !value.canRecoverOriginal)
    )
      return;
    controlPending.current = true;
    setControlling(true);
    const epoch = lifecycle.current;
    const order = ++sequence.current;
    published.current = order;
    try {
      const result = await window.aibrowse.dataTransfer[kind](value.operationId);
      if (epoch === lifecycle.current) publish(result, order);
    } catch {
      if (epoch === lifecycle.current) setNotice('操作未完成，请查看本地数据状态后重试');
    } finally {
      controlPending.current = false;
      if (epoch === lifecycle.current) setControlling(false);
    }
  };
  const storageFailure = storage?.state === 'recovery-required';
  const transferFailure = status?.state === 'recovery-required' || status?.state === 'failed';
  return (
    <section className="local-data" aria-label="本地数据">
      {(storageFailure || storageNotice) && (
        <p role="alert">
          {storageFailure
            ? '会话保存失败，不能确认已保存。请打开本地数据查看备份与恢复操作。'
            : storageNotice}
        </p>
      )}
      {transferFailure && (
        <p role="alert">
          {status.message}（{status.code}）
        </p>
      )}
      <details>
        <summary>
          本地数据{status && ACTIVE.has(status.state) ? ' · ' + status.message : ''}
        </summary>
        <div className="local-data-body">
          <p>
            备份包含 Sources、Research、Watch 三库和保存的对话；不包含 API Key、Provider 配置或
            Cookie。备份包含私密正文，请妥善保管。
          </p>
          <p>
            恢复将替换这三库与保存的对话，重启应用并关闭当前标签页。旧动作不会重放。请在原生对话框中确认恢复。
          </p>
          <p role="status" aria-live="polite">
            {status ? status.message : '正在读取本地数据状态…'}
          </p>
          {notice && <p role="alert">{notice}</p>}
          <div className="local-data-actions">
            <button
              type="button"
              disabled={starting || controlling || !status?.availableActions.includes('backup')}
              onClick={() => void start('backup')}
            >
              备份本地数据
            </button>
            <button
              type="button"
              disabled={starting || controlling || !status?.availableActions.includes('restore')}
              onClick={() => void start('restore')}
            >
              选择备份恢复
            </button>
            {status?.canCancel && (
              <button type="button" disabled={controlling} onClick={() => void control('cancel')}>
                取消当前操作
              </button>
            )}
            {status?.canRecoverOriginal && (
              <button
                type="button"
                disabled={controlling}
                onClick={() => void control('recoverOriginal')}
              >
                恢复原数据运行
              </button>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
