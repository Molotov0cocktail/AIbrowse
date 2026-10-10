import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BACKUP_IDS } from '../../src/main/storage/backup-container';
import {
  TransferBudget,
  TRANSFER_PHASE_MS,
  TRANSFER_EXIT_MS,
} from '../../src/main/storage/transfer-budget';
import {
  TRANSFER_ACTION_PHASES,
  type TransferJobRecord,
} from '../../src/main/storage/transfer-protocol';
import {
  superviseTransfer,
  type TransferChildEvents,
  type OwnedTransferChild,
} from '../../src/main/storage/transfer-supervisor';

const job: TransferJobRecord = {
  operationId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '22222222-2222-4222-8222-222222222222',
  action: 'backup',
};
const manifest = () => ({
  manifest: {
    formatVersion: 1,
    productVersion: '0.1.0',
    snapshotId: job.snapshotId,
    members: BACKUP_IDS.map((id) => ({
      id,
      present: true,
      schemaVersion: id === 'watch' ? 5 : 1,
      bytes: 0,
      sha256: 'a'.repeat(64),
    })),
  },
  backup: { bytes: 1, sha256: 'b'.repeat(64) },
});
const send = (events: TransferChildEvents, value: Record<string, unknown>) =>
  events.onMessage(JSON.stringify({ operationId: job.operationId, ...value }));
function resultSequence(events: TransferChildEvents): void {
  send(events, { type: 'ready' });
  for (const phase of TRANSFER_ACTION_PHASES.backup) send(events, { type: 'phase', phase });
  send(events, { type: 'result', result: manifest() });
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('新结果夹具在正常实际阶段准入后可成功，防止畸形结果掩盖原时序反例', async () => {
  let events!: TransferChildEvents;
  const child = { postMessage: vi.fn(), kill: vi.fn(() => true), disposeListeners: vi.fn() };
  const handle = superviseTransfer({
    job,
    budget: new TransferBudget(),
    signal: new AbortController().signal,
    spawn: (_job, callbacks) => {
      events = callbacks;
      return child;
    },
  });
  send(events, { type: 'ready' });
  for (const phase of TRANSFER_ACTION_PHASES.backup) {
    send(events, { type: 'phase', phase });
    expect(child.postMessage).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'phase', operationId: job.operationId, phase }),
    );
  }
  send(events, { type: 'result', result: manifest() });
  events.onExit(0);
  expect(await handle.done).toEqual({ state: 'succeeded', result: manifest(), exitCode: 0 });
  expect(handle.getState().ownsChild).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(['before-init', 'inside-init'] as const)(
  '启动重入在%s提前发送所有结果并退出不能绕过真实阶段准入',
  async (when) => {
    let callbacks!: TransferChildEvents;
    const child: OwnedTransferChild = {
      postMessage: vi.fn((text: string) => {
        if (when === 'inside-init' && JSON.parse(text).type === 'init') {
          resultSequence(callbacks);
          callbacks.onExit(0);
        }
      }),
      kill: vi.fn(() => true),
      disposeListeners: vi.fn(),
    };
    const handle = superviseTransfer({
      job,
      budget: new TransferBudget(),
      signal: new AbortController().signal,
      spawn: (_job, events) => {
        callbacks = events;
        if (when === 'before-init') {
          resultSequence(events);
          events.onExit(0);
        }
        return child;
      },
    });
    const outcome = await handle.done;
    expect(outcome.state).not.toBe('succeeded');
    if (when === 'before-init') expect(child.postMessage).not.toHaveBeenCalled();
    expect(handle.getState().ownsChild).toBe(false);
  },
);

it('正常阶段消息不能给之前使用过的总额度续租', async () => {
  let events!: TransferChildEvents;
  const child = { postMessage: vi.fn(), kill: vi.fn(() => false), disposeListeners: vi.fn() };
  const budget = new TransferBudget(() => performance.now(), {
    version: 1,
    totalRemainingMs: 30,
    phaseRemainingMs: { ...TRANSFER_PHASE_MS },
  });
  const handle = superviseTransfer({
    job,
    budget,
    signal: new AbortController().signal,
    spawn: (_job, callbacks) => {
      events = callbacks;
      return child;
    },
  });
  send(events, { type: 'ready' });
  for (const phase of TRANSFER_ACTION_PHASES.backup) {
    vi.advanceTimersByTime(9);
    send(events, { type: 'phase', phase });
  }
  send(events, { type: 'result', result: manifest() });
  vi.advanceTimersByTime(3);
  expect(child.kill).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(TRANSFER_EXIT_MS);
  expect(await handle.done).toEqual({
    state: 'recovery-required',
    code: 'deadline',
    exitCode: null,
  });
  expect(handle.getState().ownsChild).toBe(true);
  events.onExit(0);
  await Promise.resolve();
  expect(handle.getState()).toMatchObject({ state: 'recovery-required', ownsChild: false });
  expect(child.disposeListeners).toHaveBeenCalledTimes(1);
});
