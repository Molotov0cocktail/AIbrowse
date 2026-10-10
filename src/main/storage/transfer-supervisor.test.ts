import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  superviseTransfer,
  type TransferChildEvents,
  type OwnedTransferChild,
  type TransferSupervisorOptions,
} from './transfer-supervisor';
import { TransferBudget, TRANSFER_PHASE_MS, TRANSFER_EXIT_MS } from './transfer-budget';
import { TRANSFER_ACTION_PHASES, type TransferJobRecord } from './transfer-protocol';
import { BACKUP_IDS } from './backup-container';
const job: TransferJobRecord = {
  operationId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '22222222-2222-4222-8222-222222222222',
  action: 'backup',
};
const manifest = (action: TransferJobRecord['action'] = 'backup') => ({
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
  backup: action === 'backup' ? { bytes: 1, sha256: 'a'.repeat(64) } : null,
});
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());
function fixture(overrides: Partial<TransferSupervisorOptions> = {}) {
  let events!: TransferChildEvents;
  const abort = new AbortController();
  const child: OwnedTransferChild = {
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
    disposeListeners: vi.fn(),
  };
  const budget = new TransferBudget();
  const handle = superviseTransfer({
    job,
    budget,
    signal: abort.signal,
    spawn: (_job, listeners) => {
      events = listeners;
      return child;
    },
    ...overrides,
  });
  const send = (value: Record<string, unknown>) =>
    events.onMessage(JSON.stringify({ operationId: job.operationId, ...value }));
  const phases = () => {
    send({ type: 'ready' });
    for (const phase of TRANSFER_ACTION_PHASES[overrides.job?.action ?? job.action])
      send({ type: 'phase', phase });
  };
  return { handle, events, child, budget, abort, send, phases };
}
it.each(['backup', 'restore', 'migrate'] as const)(
  'requires all fixed %s phases, a result and actual exit zero',
  async (action) => {
    const f = fixture({ job: { ...job, action } });
    f.phases();
    f.send({ type: 'result', result: manifest(action) });
    expect(f.handle.getState()).toMatchObject({ state: 'awaiting-exit', ownsChild: true });
    let done = false;
    void f.handle.done.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.events.onExit(0);
    expect(await f.handle.done).toMatchObject({
      state: 'succeeded',
      exitCode: 0,
      result: manifest(action),
    });
    expect(f.child.disposeListeners).toHaveBeenCalledTimes(1);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.handle.getState().ownsChild).toBe(false);
  },
);
it.each(
  [
    [{ type: 'ready' }, { type: 'ready' }],
    [{ type: 'phase', phase: 'sqlite' }],
    [{ type: 'ready' }, { type: 'phase', phase: 'conversations' }],
    [{ type: 'ready' }, { type: 'result', result: manifest() }],
    [{ type: 'ready', operationId: job.snapshotId }],
    [{ type: 'failed', code: 'io' }],
  ].map((messages) => ({ messages })),
)(
  'rejects illegal message ordering without allowing exit zero to revive it: %j',
  async ({ messages }) => {
    const f = fixture();
    for (const value of messages) f.send(value);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    f.phases();
    f.send({ type: 'result', result: manifest() });
    f.events.onExit(0);
    expect(await f.handle.done).toMatchObject({ state: 'failed' });
  },
);
it.each(['result', 'ready', 'phase', 'failed'])(
  'rejects %s after a result before actual exit',
  async (type) => {
    const f = fixture();
    f.phases();
    f.send({ type: 'result', result: manifest() });
    f.send(
      type === 'result'
        ? { type, result: manifest() }
        : type === 'phase'
          ? { type, phase: 'sqlite' }
          : type === 'failed'
            ? { type, code: 'io' }
            : { type },
    );
    f.events.onExit(0);
    expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'protocol' });
  },
);
it('keeps the final phase timer running after result and preserves an unexited child', async () => {
  const f = fixture();
  f.phases();
  f.send({ type: 'result', result: manifest() });
  vi.advanceTimersByTime(TRANSFER_PHASE_MS.containerIo);
  expect(f.child.kill).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(TRANSFER_EXIT_MS);
  expect(await f.handle.done).toEqual({
    state: 'recovery-required',
    code: 'deadline',
    exitCode: null,
  });
  expect(f.handle.getState().ownsChild).toBe(true);
  expect(f.child.disposeListeners).not.toHaveBeenCalled();
  f.events.onExit(0);
  await Promise.resolve();
  expect(f.handle.getState()).toMatchObject({ state: 'recovery-required', ownsChild: false });
  expect(f.child.disposeListeners).toHaveBeenCalledTimes(1);
});
it('does not reset the first phase allowance when ready or its phase request arrives', async () => {
  const f = fixture();
  vi.advanceTimersByTime(TRANSFER_PHASE_MS.sqlite - 1);
  f.send({ type: 'ready' });
  f.send({ type: 'phase', phase: 'sqlite' });
  vi.advanceTimersByTime(1);
  expect(f.child.kill).toHaveBeenCalledTimes(1);
  f.events.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'deadline' });
});
it('uses the passed remaining total allowance instead of creating a new work clock', async () => {
  const budget = new TransferBudget(() => performance.now(), {
    version: 1,
    totalRemainingMs: 100,
    phaseRemainingMs: { ...TRANSFER_PHASE_MS },
  });
  const f = fixture({ budget });
  f.phases();
  vi.advanceTimersByTime(100);
  f.events.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'deadline' });
});
it.each(['false', 'throw', 'sync-exit'] as const)(
  'handles kill %s without treating kill as exit proof',
  async (mode) => {
    const f = fixture();
    vi.mocked(f.child.kill).mockImplementation(() => {
      if (mode === 'throw') throw new Error('private path');
      if (mode === 'sync-exit') f.events.onExit(0);
      return false;
    });
    f.abort.abort();
    vi.advanceTimersByTime(TRANSFER_EXIT_MS);
    const outcome = await f.handle.done;
    expect(outcome).toMatchObject({
      state: mode === 'sync-exit' ? 'failed' : 'recovery-required',
      code: 'cancelled',
    });
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    f.handle.cancel();
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  },
);
it('handles a synchronous early exit before spawn returns without sending init', async () => {
  const child = { postMessage: vi.fn(), kill: vi.fn(() => true), disposeListeners: vi.fn() };
  const f = fixture({
    spawn: (_job, events) => {
      events.onExit(0);
      return child;
    },
  });
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'exit' });
  expect(child.postMessage).not.toHaveBeenCalled();
  expect(child.disposeListeners).toHaveBeenCalledTimes(1);
});
it('handles cancellation reentered inside spawn and retains the returned child', async () => {
  const abort = new AbortController();
  const child = { postMessage: vi.fn(), kill: vi.fn(() => true), disposeListeners: vi.fn() };
  const f = fixture({
    signal: abort.signal,
    spawn: () => {
      abort.abort();
      return child;
    },
  });
  expect(child.postMessage).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(TRANSFER_EXIT_MS);
  expect(await f.handle.done).toMatchObject({ state: 'recovery-required', code: 'cancelled' });
});
it('treats a spawn throw as unconfirmed ownership rather than cleanup permission', async () => {
  const f = fixture({
    spawn: () => {
      throw new Error('private path');
    },
  });
  expect(await f.handle.done).toEqual({
    state: 'recovery-required',
    code: 'spawn',
    exitCode: null,
  });
  expect(f.handle.getState().ownsChild).toBe(true);
});
it('accepts early ready only after init is sent and handles synchronous message responses', async () => {
  let callbacks!: TransferChildEvents;
  const posts: string[] = [];
  const f = fixture({
    spawn: (_job, events) => {
      callbacks = events;
      events.onMessage(JSON.stringify({ type: 'ready', operationId: job.operationId }));
      return {
        kill: () => true,
        disposeListeners: () => {},
        postMessage: (text) => {
          posts.push(JSON.parse(text).type);
          if (JSON.parse(text).type === 'init')
            events.onMessage(
              JSON.stringify({ type: 'phase', operationId: job.operationId, phase: 'sqlite' }),
            );
        },
      };
    },
  });
  expect(posts).toEqual(['init', 'phase']);
  expect(f.handle.getState().state).toBe('running');
  callbacks.onExit(1);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'exit' });
});
it('rejects a second result even when queued directly after exit in the same callback turn', async () => {
  const f = fixture();
  f.phases();
  f.send({ type: 'result', result: manifest() });
  f.events.onExit(0);
  f.send({ type: 'result', result: manifest() });
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'protocol' });
});
it('does not spawn for an already cancelled job', async () => {
  const abort = new AbortController();
  abort.abort();
  const spawn = vi.fn();
  const f = fixture({ signal: abort.signal, spawn });
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'cancelled' });
  expect(spawn).not.toHaveBeenCalled();
});
it.each([0, 1, null])('rejects actual exit %j before the result', async (code) => {
  const f = fixture();
  f.phases();
  f.events.onExit(code);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'exit' });
});
it('cancellation after result still prevents success at exit zero', async () => {
  const f = fixture();
  f.phases();
  f.send({ type: 'result', result: manifest() });
  f.handle.cancel();
  f.events.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'cancelled' });
});
it('cleans up listeners once and reports a synchronous cleanup failure without enemy text', async () => {
  const f = fixture();
  vi.mocked(f.child.disposeListeners).mockImplementation(() => {
    throw new Error('private path');
  });
  f.phases();
  f.send({ type: 'result', result: manifest() });
  f.events.onExit(0);
  expect(await f.handle.done).toEqual({ state: 'failed', code: 'cleanup', exitCode: 0 });
  f.events.onExit(0);
  expect(f.child.disposeListeners).toHaveBeenCalledTimes(1);
});
it('retains ownership when init posting throws and the process never exits', async () => {
  const child = {
    kill: vi.fn(() => true),
    disposeListeners: vi.fn(),
    postMessage: () => {
      throw new Error('private path');
    },
  };
  const f = fixture({ spawn: () => child });
  expect(child.kill).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(TRANSFER_EXIT_MS);
  expect(await f.handle.done).toEqual({
    state: 'recovery-required',
    code: 'transport',
    exitCode: null,
  });
  expect(child.disposeListeners).not.toHaveBeenCalled();
});
it('bounds reentrant launch messages and kills the child after launch returns', async () => {
  let callbacks!: TransferChildEvents;
  const child = { kill: vi.fn(() => true), disposeListeners: vi.fn(), postMessage: vi.fn() };
  const f = fixture({
    spawn: (_job, events) => {
      callbacks = events;
      for (let i = 0; i < 17; i++)
        events.onMessage(JSON.stringify({ type: 'ready', operationId: job.operationId }));
      return child;
    },
  });
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.postMessage).not.toHaveBeenCalled();
  callbacks.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'protocol' });
});
it('does not allow malformed result metadata to pass through an exit-zero child', async () => {
  const f = fixture();
  f.phases();
  f.send({ type: 'result', result: { ...manifest(), config: 'private' } });
  f.events.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'protocol' });
});
it('does not revive a protocol failure at a later successful result or timer tick', async () => {
  const f = fixture();
  f.send({ type: 'ready', path: 'private' });
  f.phases();
  f.send({ type: 'result', result: manifest() });
  vi.advanceTimersByTime(TRANSFER_EXIT_MS);
  f.events.onExit(0);
  expect(await f.handle.done).toMatchObject({ state: 'recovery-required', code: 'protocol' });
});
it('accepts a complete synchronous chain only after each corresponding phase dispatch', async () => {
  const dispatched: string[] = [];
  const f = fixture({
    spawn: (_job, events) => ({
      kill: vi.fn(() => true),
      disposeListeners: vi.fn(),
      postMessage: (text) => {
        const value = JSON.parse(text);
        dispatched.push(value.type === 'phase' ? value.phase : value.type);
        const send = (value: Record<string, unknown>) =>
          events.onMessage(JSON.stringify({ operationId: job.operationId, ...value }));
        if (value.type === 'init') {
          send({ type: 'ready' });
          send({ type: 'phase', phase: 'sqlite' });
        } else if (value.phase === 'sqlite') send({ type: 'phase', phase: 'conversations' });
        else if (value.phase === 'conversations') send({ type: 'phase', phase: 'containerIo' });
        else {
          send({ type: 'result', result: manifest() });
          events.onExit(0);
        }
      },
    }),
  });
  expect(await f.handle.done).toMatchObject({ state: 'succeeded' });
  expect(dispatched).toEqual(['init', 'sqlite', 'conversations', 'containerIo']);
});
it('observes exit immediately and never dispatches a pending phase afterwards', async () => {
  const posts: string[] = [];
  const f = fixture({
    spawn: (_job, events) => ({
      kill: vi.fn(() => true),
      disposeListeners: vi.fn(),
      postMessage: (text) => {
        posts.push(JSON.parse(text).type);
        events.onMessage(JSON.stringify({ type: 'ready', operationId: job.operationId }));
        events.onMessage(
          JSON.stringify({ type: 'phase', operationId: job.operationId, phase: 'sqlite' }),
        );
        events.onExit(0);
      },
    }),
  });
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'exit' });
  expect(posts).toEqual(['init']);
  expect(f.handle.getState().ownsChild).toBe(false);
});
it('rejects a result arriving before the final requested phase has actually been dispatched', async () => {
  const phases: string[] = [];
  const f = fixture({
    spawn: (_job, events) => ({
      kill: vi.fn(() => true),
      disposeListeners: vi.fn(),
      postMessage: (text) => {
        const value = JSON.parse(text);
        const send = (value: Record<string, unknown>) =>
          events.onMessage(JSON.stringify({ operationId: job.operationId, ...value }));
        if (value.type === 'init') {
          send({ type: 'ready' });
          send({ type: 'phase', phase: 'sqlite' });
        } else {
          phases.push(value.phase);
          if (value.phase === 'sqlite') send({ type: 'phase', phase: 'conversations' });
          else {
            send({ type: 'phase', phase: 'containerIo' });
            send({ type: 'result', result: manifest() });
            events.onExit(0);
          }
        }
      },
    }),
  });
  expect(await f.handle.done).toMatchObject({ state: 'failed', code: 'protocol' });
  expect(phases).toEqual(['sqlite', 'conversations']);
});
