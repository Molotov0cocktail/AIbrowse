import { afterEach, expect, it, vi } from 'vitest';
import { createPartialRecoveryEntry } from './partial-recovery-entry';
import { TRANSFER_PHASE_MS, TRANSFER_WORK_MS } from './transfer-budget';

afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let now = 0;
  let current = true;
  let graph = true;
  const confirmRestart = vi.fn(async (message: string) => message.length > 0);
  const assertPartialGraph = vi.fn(() => {
    if (!graph) throw new Error('private graph detail');
  });
  const ensureRecoveryGate = vi.fn(async (context: { assertCurrent(): void }) => {
    context.assertCurrent();
  });
  const requestRelaunch = vi.fn(async (deadline: number) => deadline > now);
  const subject = createPartialRecoveryEntry({
    now: () => now,
    assertPartialGraph,
    confirmRestart,
    ensureRecoveryGate,
    requestRelaunch,
  });
  return {
    subject,
    confirmRestart,
    assertPartialGraph,
    ensureRecoveryGate,
    requestRelaunch,
    document: { isCurrent: () => current },
    advance(ms: number) {
      now += ms;
    },
    stale() {
      current = false;
    },
    changeGraph() {
      graph = false;
    },
  };
}

it('exposes only explicit restore and registers a gate before one cold restart', async () => {
  const f = fixture();
  expect(f.subject.getStatus().availableActions).toEqual(['restore']);
  const result = await f.subject.start('restore', f.document);
  expect(result).toMatchObject({
    state: 'awaiting-restart',
    canCancel: false,
    canRecoverOriginal: false,
    availableActions: [],
  });
  expect(f.confirmRestart.mock.calls[0]![0]).toContain('标签页');
  expect(f.ensureRecoveryGate).toHaveBeenCalledOnce();
  expect(f.requestRelaunch).toHaveBeenCalledWith(TRANSFER_PHASE_MS.drain);
  expect(f.ensureRecoveryGate.mock.invocationCallOrder[0]).toBeLessThan(
    f.requestRelaunch.mock.invocationCallOrder[0]!,
  );
  expect((await f.subject.start('restore', f.document)).code).toBe('busy');
  f.subject.beginShutdown();
  await expect(f.subject.drainBeforeClose()).resolves.toBeUndefined();
});

it('rejects backup and malformed actions without native interaction', async () => {
  const f = fixture();
  for (const action of ['backup', {}, null])
    expect((await f.subject.start(action, f.document)).code).toBe('invalid-request');
  expect(f.confirmRestart).not.toHaveBeenCalled();
});

it('cancelling native confirmation writes nothing and permits a new explicit request', async () => {
  const f = fixture();
  f.confirmRestart.mockResolvedValueOnce(false);
  expect((await f.subject.start('restore', f.document)).state).toBe('cancelled');
  expect(f.ensureRecoveryGate).not.toHaveBeenCalled();
  expect(f.requestRelaunch).not.toHaveBeenCalled();
  expect((await f.subject.start('restore', f.document)).state).toBe('awaiting-restart');
});

it('publishes native ownership before synchronous reentry and waits for its actual promise', async () => {
  const f = fixture();
  const confirmation = deferred<boolean>();
  let nested: Promise<unknown> | undefined;
  f.confirmRestart.mockImplementation(() => {
    nested = f.subject.start('restore', f.document);
    return confirmation.promise;
  });
  const original = f.subject.start('restore', f.document);
  await expect(nested).resolves.toMatchObject({ code: 'busy' });
  f.subject.beginShutdown();
  let drained = false;
  const shutdown = f.subject.drainBeforeClose().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  confirmation.resolve(true);
  expect((await original).code).toBe('cancelled');
  await shutdown;
  expect(f.ensureRecoveryGate).not.toHaveBeenCalled();
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});

it.each(['document', 'graph'] as const)(
  'rejects %s changes while native confirmation is pending',
  async (kind) => {
    const f = fixture();
    const confirmation = deferred<boolean>();
    f.confirmRestart.mockReturnValue(confirmation.promise);
    const work = f.subject.start('restore', f.document);
    if (kind === 'document') f.stale();
    else f.changeGraph();
    confirmation.resolve(true);
    expect((await work).state).toBe('recovery-required');
    expect(f.ensureRecoveryGate).not.toHaveBeenCalled();
  },
);

it('rechecks local gates after a synchronous external graph proof', async () => {
  const f = fixture();
  f.assertPartialGraph.mockImplementation(() => f.subject.beginShutdown());
  expect((await f.subject.start('restore', f.document)).code).toBe('cancelled');
  expect(f.confirmRestart).not.toHaveBeenCalled();
});

it('rejects a synchronous document change inside the external graph proof', async () => {
  const f = fixture();
  f.assertPartialGraph.mockImplementation(() => f.stale());
  expect((await f.subject.start('restore', f.document)).code).toBe('stale-document');
  expect(f.confirmRestart).not.toHaveBeenCalled();
});

it('retains a failed gate and never offers an in-process retry or recovery of original data', async () => {
  const f = fixture();
  f.ensureRecoveryGate.mockRejectedValue(new Error('private path content'));
  const result = await f.subject.start('restore', f.document);
  expect(result).toMatchObject({
    state: 'recovery-required',
    code: 'handoff',
    availableActions: [],
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect((await f.subject.start('restore', f.document)).code).toBe('busy');
  expect(f.requestRelaunch).not.toHaveBeenCalled();
  await expect(f.subject.drainBeforeClose()).resolves.toBeUndefined();
});

it('shutdown keeps the original gate promise owned and prevents its late continuation', async () => {
  const f = fixture();
  const gate = deferred<void>();
  f.ensureRecoveryGate.mockReturnValue(gate.promise);
  const work = f.subject.start('restore', f.document);
  await vi.waitFor(() => expect(f.ensureRecoveryGate).toHaveBeenCalledOnce());
  f.subject.beginShutdown();
  let drained = false;
  const shutdown = f.subject.drainBeforeClose().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  gate.resolve();
  expect((await work).code).toBe('cancelled');
  await shutdown;
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});

it('does not count native confirmation as work or renew the gate deadline', async () => {
  const f = fixture();
  f.confirmRestart.mockImplementation(async () => {
    f.advance(TRANSFER_WORK_MS);
    return true;
  });
  f.ensureRecoveryGate.mockImplementation(async (context) => {
    f.advance(TRANSFER_PHASE_MS.containerIo);
    context.assertCurrent();
  });
  expect((await f.subject.start('restore', f.document)).code).toBe('deadline');
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});

it('rejects late relaunch acknowledgement using the original drain deadline', async () => {
  const f = fixture();
  f.requestRelaunch.mockImplementation(async () => {
    f.advance(TRANSFER_PHASE_MS.drain);
    return true;
  });
  expect((await f.subject.start('restore', f.document)).code).toBe('deadline');
  expect(f.subject.getStatus().availableActions).toEqual([]);
});

it('rejects a document change before committing the durable gate handoff', async () => {
  const f = fixture();
  f.ensureRecoveryGate.mockImplementation(async () => {
    await Promise.resolve();
    f.stale();
  });
  expect((await f.subject.start('restore', f.document)).code).toBe('stale-document');
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});

it('navigation and normal shutdown cannot revoke an already committed main handoff', async () => {
  const f = fixture();
  f.requestRelaunch.mockImplementation(async () => {
    f.stale();
    f.changeGraph();
    f.subject.beginShutdown();
    await Promise.resolve();
    return true;
  });
  expect((await f.subject.start('restore', f.document)).state).toBe('awaiting-restart');
  await expect(f.subject.drainBeforeClose()).resolves.toBeUndefined();
});

it('makes a relaunch refusal and later asynchronous failure sticky', async () => {
  const f = fixture();
  f.requestRelaunch.mockResolvedValue(false);
  expect((await f.subject.start('restore', f.document)).code).toBe('relaunch');
  expect(f.subject.getStatus().availableActions).toEqual([]);
  const g = fixture();
  await g.subject.start('restore', g.document);
  g.subject.relaunchFailed();
  expect(g.subject.getStatus()).toMatchObject({
    state: 'recovery-required',
    code: 'relaunch',
    availableActions: [],
  });
});

it('deadline revokes a pending gate without declaring its original IO drained', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const gate = deferred<void>();
  f.ensureRecoveryGate.mockReturnValue(gate.promise);
  const work = f.subject.start('restore', f.document);
  await Promise.resolve();
  expect(f.ensureRecoveryGate).toHaveBeenCalledOnce();
  f.advance(TRANSFER_PHASE_MS.containerIo);
  await vi.advanceTimersByTimeAsync(TRANSFER_PHASE_MS.containerIo);
  expect(f.subject.getStatus()).toMatchObject({ code: 'deadline', availableActions: [] });
  let drained = false;
  const shutdown = f.subject.drainBeforeClose().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  gate.resolve();
  expect((await work).code).toBe('deadline');
  await shutdown;
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});

it('a synchronous guardian failure cannot be overwritten by a relaunch ACK', async () => {
  const f = fixture();
  f.requestRelaunch.mockImplementation(async () => {
    f.subject.relaunchFailed();
    return true;
  });
  expect((await f.subject.start('restore', f.document)).code).toBe('relaunch');
  expect(f.subject.getStatus().state).toBe('recovery-required');
});
