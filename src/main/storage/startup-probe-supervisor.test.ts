import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { TransferBudget } from './transfer-budget';
import { superviseStartupProbe } from './startup-probe-supervisor';
import type { TransferChildEvents } from './transfer-supervisor';
const result = {
  state: 'recovery-required' as const,
  code: 'schema' as const,
  domain: 'sources' as const,
};
it('requires an authorized result and actual exit while charging the existing SQLite allowance', async () => {
  const operationId = randomUUID();
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  now = 80000;
  budget.leave();
  let granted = 0;
  const handle = superviseStartupProbe({
    operationId,
    budget,
    signal: new AbortController().signal,
    spawn(_id, events) {
      return {
        postMessage(raw) {
          const init = JSON.parse(raw) as { remainingMs: number };
          granted = init.remainingMs;
          events.onMessage(JSON.stringify({ type: 'ready', operationId }));
          events.onMessage(JSON.stringify({ type: 'result', operationId, result }));
          events.onExit(0);
        },
        kill() {
          return false;
        },
        disposeListeners() {},
      };
    },
  });
  await expect(handle.done).resolves.toMatchObject({ state: 'succeeded', result });
  expect(granted).toBe(10000);
});
it.each([
  'early-ready',
  'early-result',
  'early-exit',
  'duplicate-ready',
  'duplicate-result',
  'old-operation',
  'unknown',
  'late-result',
] as const)('fails sticky for %s without granting later permission', async (mode) => {
  const operationId = randomUUID();
  const posts: string[] = [];
  const ready = JSON.stringify({ type: 'ready', operationId });
  const terminal = JSON.stringify({ type: 'result', operationId, result });
  const handle = superviseStartupProbe({
    operationId,
    budget: new TransferBudget(),
    signal: new AbortController().signal,
    spawn(_id, events) {
      if (mode === 'early-ready') events.onMessage(ready);
      if (mode === 'early-result') events.onMessage(terminal);
      if (mode === 'early-exit') events.onExit(0);
      return {
        postMessage(raw) {
          posts.push(raw);
          if (mode === 'old-operation')
            events.onMessage(JSON.stringify({ type: 'ready', operationId: randomUUID() }));
          else if (mode === 'unknown')
            events.onMessage(
              JSON.stringify({ type: 'ready', operationId, secret: 'never echoed' }),
            );
          else {
            events.onMessage(ready);
            if (mode === 'duplicate-ready') events.onMessage(ready);
            events.onMessage(terminal);
            if (mode === 'duplicate-result') events.onMessage(terminal);
          }
          events.onExit(0);
          if (mode === 'late-result') events.onMessage(terminal);
        },
        kill() {
          events.onExit(0);
          return true;
        },
        disposeListeners() {},
      };
    },
  });
  await expect(handle.done).resolves.toHaveProperty('state', 'failed');
  if (mode.startsWith('early')) expect(posts).toEqual([]);
});
it.each(['false', 'throw'] as const)('does not release ownership on kill %s', async (mode) => {
  const abort = new AbortController();
  const timers: Array<() => void> = [];
  let events!: TransferChildEvents;
  const handle = superviseStartupProbe({
    operationId: randomUUID(),
    budget: new TransferBudget(),
    signal: abort.signal,
    timers: {
      set(_ms, fn) {
        timers.push(fn);
        return () => {};
      },
    },
    spawn(_id, sink) {
      events = sink;
      return {
        postMessage() {},
        kill() {
          if (mode === 'throw') throw new Error('native');
          return false;
        },
        disposeListeners() {},
      };
    },
  });
  abort.abort();
  timers.at(-1)!();
  await expect(handle.done).resolves.toMatchObject({
    state: 'recovery-required',
    code: 'cancelled',
  });
  expect(handle.ownsChild()).toBe(true);
  events.onExit(0);
  expect(handle.ownsChild()).toBe(false);
});
it('handles cancellation reentered during native launch with exactly one kill', async () => {
  const abort = new AbortController();
  const kill = vi.fn();
  const post = vi.fn();
  const handle = superviseStartupProbe({
    operationId: randomUUID(),
    budget: new TransferBudget(),
    signal: abort.signal,
    spawn(_id, events) {
      abort.abort();
      return {
        postMessage: post,
        kill() {
          kill();
          events.onExit(0);
          return true;
        },
        disposeListeners() {},
      };
    },
  });
  await expect(handle.done).resolves.toMatchObject({ state: 'failed', code: 'cancelled' });
  expect(kill).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
});
it('does not launch for an exhausted shared SQLite budget', async () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  now = 90001;
  const spawn = vi.fn();
  const handle = superviseStartupProbe({
    operationId: randomUUID(),
    budget,
    signal: new AbortController().signal,
    spawn,
  });
  await expect(handle.done).resolves.toMatchObject({ state: 'failed', code: 'deadline' });
  expect(spawn).not.toHaveBeenCalled();
});
it('keeps ambiguous synchronous launch failure owned', async () => {
  const handle = superviseStartupProbe({
    operationId: randomUUID(),
    budget: new TransferBudget(),
    signal: new AbortController().signal,
    spawn() {
      throw new Error('unknown launch');
    },
  });
  await expect(handle.done).resolves.toMatchObject({ state: 'recovery-required', code: 'spawn' });
  expect(handle.ownsChild()).toBe(true);
});
it('does not treat a result without native exit as success', async () => {
  const operationId = randomUUID();
  let events!: TransferChildEvents;
  const timers: Array<() => void> = [];
  let now = 0;
  let killed = 0;
  const handle = superviseStartupProbe({
    operationId,
    budget: new TransferBudget(() => now),
    signal: new AbortController().signal,
    timers: {
      set(_ms, fn) {
        timers.push(fn);
        return () => {};
      },
    },
    spawn(_id, sink) {
      events = sink;
      return {
        postMessage() {
          events.onMessage(JSON.stringify({ type: 'ready', operationId }));
          events.onMessage(JSON.stringify({ type: 'result', operationId, result }));
        },
        kill() {
          killed++;
          return false;
        },
        disposeListeners() {},
      };
    },
  });
  now = 90001;
  timers[0]?.();
  timers.at(-1)?.();
  await expect(handle.done).resolves.toMatchObject({ state: 'recovery-required' });
  expect(killed).toBe(1);
  expect(handle.ownsChild()).toBe(true);
  events.onExit(0);
  expect(handle.ownsChild()).toBe(false);
});
