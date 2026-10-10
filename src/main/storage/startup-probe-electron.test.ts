import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }));
import {
  createElectronStartupProbe,
  parseStartupProbeRegistration,
} from './startup-probe-electron';
import { superviseStartupProbe } from './startup-probe-supervisor';
import { TransferBudget } from './transfer-budget';
class Child extends EventEmitter {
  pid = 123;
  postMessage = vi.fn();
  kill = vi.fn(() => false);
}
const guardian = () => ({
  authorizeUtility: vi.fn(async () => {}),
  confirmUtilityExit: vi.fn(async () => {}),
});
const registration = () => ({
  version: 1 as const,
  operationId: randomUUID(),
  userDataRoot: process.cwd(),
});
it('uses one fixed entry and a minimal environment and retains the native handle until exit', () => {
  const r = registration(),
    child = new Child();
  mock.fork.mockReturnValue(child);
  const adapter = createElectronStartupProbe(r, guardian());
  const events = { onMessage: vi.fn(), onExit: vi.fn() };
  const port = adapter.spawn(r.operationId, events);
  const [entry, args, options] = mock.fork.mock.lastCall!;
  expect(entry).toBe(join(__dirname, 'startup-probe-worker.js'));
  expect(JSON.parse(args[0])).toEqual(r);
  expect(options.env).toEqual({ SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' });
  expect(options.stdio).toBe('ignore');
  expect(options.execArgv).toEqual([]);
  expect(adapter.ownsProcess()).toBe(true);
  expect(port.kill()).toBe(false);
  expect(() => port.disposeListeners()).toThrow();
  child.emit('error', 'private diagnostic');
  expect(events.onMessage).toHaveBeenCalledWith(null);
  child.emit('exit', 0);
  expect(adapter.ownsProcess()).toBe(false);
  expect(() => port.postMessage('late')).toThrow();
  port.disposeListeners();
  expect(child.listenerCount('message')).toBe(0);
  expect(() => adapter.spawn(r.operationId, events)).toThrow();
});
it('can still kill an owned child after partial listener registration fails', async () => {
  const r = registration(),
    child = new Child();
  const original = child.on.bind(child);
  vi.spyOn(child, 'on').mockImplementation((event, listener) => {
    if (event === 'message') throw new Error('subscribe');
    return original(event, listener);
  });
  child.kill.mockImplementation(() => {
    child.emit('exit', 0);
    return true;
  });
  mock.fork.mockReturnValue(child);
  const adapter = createElectronStartupProbe(r, guardian());
  const handle = superviseStartupProbe({
    operationId: r.operationId,
    budget: new TransferBudget(),
    signal: new AbortController().signal,
    spawn: adapter.spawn,
  });
  await expect(handle.done).resolves.toMatchObject({ state: 'failed', code: 'protocol' });
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.postMessage).not.toHaveBeenCalled();
  expect(adapter.ownsProcess()).toBe(false);
});
it('keeps an ambiguous fork exception owned and rejects unregistered bootstrap fields', () => {
  const r = registration();
  mock.fork.mockImplementationOnce(() => {
    throw new Error('native launch');
  });
  const adapter = createElectronStartupProbe(r, guardian());
  expect(() => adapter.spawn(r.operationId, { onMessage() {}, onExit() {} })).toThrow();
  expect(adapter.ownsProcess()).toBe(true);
  expect(() =>
    parseStartupProbeRegistration(JSON.stringify({ ...r, script: 'execute' })),
  ).toThrow();
});
