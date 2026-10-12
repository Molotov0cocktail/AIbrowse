import type { LocalDataController } from './useLocalData';
import './local-data.css';

export function LocalDataPanel({ controller }: { controller: LocalDataController }) {
  const { status, storage, notice, storageNotice, starting, controlling, start, control } =
    controller;
  const storageFailure = storage?.state === 'recovery-required';
  const transferFailure = status?.state === 'recovery-required' || status?.state === 'failed';
  return (
    <section className="local-data settings-section-card" aria-label="本地数据">
      <h2>本地数据</h2>
      {(storageFailure || storageNotice) && (
        <p role="alert">
          {storageFailure
            ? '会话保存失败，不能确认已保存。请使用下方备份与恢复操作。'
            : storageNotice}
        </p>
      )}
      {transferFailure && (
        <p role="alert">
          {status.message}（{status.code}）
        </p>
      )}
      <p>
        新版备份包含 Sources、Research、Watch、浏览历史、书签和保存的对话；不包含 API Key、Provider
        配置或 Cookie。备份包含私密正文，请妥善保管。
      </p>
      <p>
        恢复会替换备份所含数据，重启应用并关闭当前标签页。旧版 v1
        备份不含浏览历史和书签，恢复时会保留当前浏览历史和书签。请在原生对话框中确认恢复。
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
    </section>
  );
}
