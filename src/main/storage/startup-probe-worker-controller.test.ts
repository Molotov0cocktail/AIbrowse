import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createStartupProbeWorkerController } from './startup-probe-worker-controller';
import { superviseStartupProbe } from './startup-probe-supervisor';
import { TransferBudget } from './transfer-budget';
const result = { state: 'recovery-required' as const, code: 'schema' as const, domain: null };
it('runs no probe before main authorization and waits for the scheduled real exit', async () => {
  const operationId = randomUUID();
  const work = vi.fn(async () => result);
  let finish!: () => void;
  const handle = superviseStartupProbe({
    operationId,
    budget: new TransferBudget(),
    signal: new AbortController().signal,
    spawn(_id, events) {
      const controller = createStartupProbeWorkerController(
        operationId,
        {
          send: events.onMessage,
          exit: events.onExit,
          scheduleExit(fn) {
            finish = fn;
          },
        },
        work,
      );
      expect(work).not.toHaveBeenCalled();
      return {
        postMessage: controller.receive,
        kill() {
          events.onExit(1);
          return true;
        },
        disposeListeners() {},
      };
    },
  });
  await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
  expect(handle.ownsChild()).toBe(true);
  finish();
  await expect(handle.done).resolves.toMatchObject({ state: 'succeeded', result });
});
it('a duplicate init cancels the original work and never sends its late result', async () => {
  const operationId = randomUUID();
  const sent: string[] = [];
  const exits: number[] = [];
  let resolve!: (value: typeof result) => void;
  const controller = createStartupProbeWorkerController(
    operationId,
    { send: (v) => sent.push(v), exit: (v) => exits.push(v), scheduleExit: (fn) => fn() },
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const init = JSON.stringify({ type: 'init', operationId, remainingMs: 1000 });
  controller.receive(init);
  await Promise.resolve();
  controller.receive(init);
  resolve(result);
  await Promise.resolve();
  await Promise.resolve();
  expect(exits).toEqual([2]);
  expect(sent.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual(['ready']);
});
