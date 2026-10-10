import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }));
import { createElectronTransfer } from './transfer-electron';
import type { TransferRegistration } from './transfer-registration';

class Child extends EventEmitter {
  pid = 123;
  messages: string[] = [];
  kill = vi.fn(() => false);
  postMessage(value: string): void {
    this.messages.push(value);
  }
}
const guardian = () => ({
  authorizeUtility: vi.fn(async () => {}),
  confirmUtilityExit: vi.fn(async () => {}),
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const registration: TransferRegistration = {
  version: 1,
  userDataRoot: process.cwd(),
  generation: 'a'.repeat(32),
  productVersion: '0.1.0',
  input: null,
  job: {
    operationId: '00000000-0000-4000-8000-000000000001',
    snapshotId: '00000000-0000-4000-8000-000000000002',
    action: 'backup',
  },
};
describe('Electron维护进程端口', () => {
  it('固定entry/私有cwd、空execArgv、最小env，不继承Key或Session', async () => {
    const child = new Child();
    mock.fork.mockReturnValue(child);
    const ledger = guardian();
    const adapter = createElectronTransfer(registration, ledger);
    const onExit = vi.fn(),
      onMessage = vi.fn();
    const port = adapter.spawn(registration.job, { onMessage, onExit });
    expect(child.listenerCount('exit')).toBe(1);
    expect(child.listenerCount('message')).toBe(1);
    const [entry, args, options] = mock.fork.mock.lastCall!;
    expect(entry).toBe(join(__dirname, 'transfer-worker.js'));
    expect(args).toHaveLength(1);
    expect(JSON.parse(args[0])).toEqual(registration);
    expect(Object.keys(options.env).sort()).toEqual(['SystemRoot', 'TEMP', 'TMP']);
    expect(options.execArgv).toEqual([]);
    expect(options).not.toHaveProperty('session');
    expect(options).not.toHaveProperty('partition');
    expect(options.stdio).toBe('ignore');
    port.postMessage('frame');
    expect(child.messages).toEqual([]);
    child.emit('spawn');
    await flush();
    expect(ledger.authorizeUtility).toHaveBeenCalledExactlyOnceWith({ pid: 123, role: 'transfer' });
    expect(child.messages).toEqual(['frame']);
    child.emit('message', 'reply');
    expect(onMessage).toHaveBeenCalledWith('reply');
    expect(adapter.ownsProcess()).toBe(true);
    child.emit('exit', 0);
    expect(adapter.ownsProcess()).toBe(true);
    await flush();
    expect(ledger.confirmUtilityExit).toHaveBeenCalledExactlyOnceWith(123);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(adapter.ownsProcess()).toBe(false);
    expect(() => port.postMessage('late')).toThrow();
    port.disposeListeners();
    expect(child.listenerCount('message')).toBe(0);
  });
  it('kill=false/throw不释放所有权，不允许未退出清场或重复launch', () => {
    const child = new Child();
    mock.fork.mockReturnValue(child);
    const adapter = createElectronTransfer(registration, guardian());
    const port = adapter.spawn(registration.job, { onMessage: vi.fn(), onExit: vi.fn() });
    expect(port.kill()).toBe(false);
    expect(adapter.ownsProcess()).toBe(true);
    expect(() => port.disposeListeners()).toThrow();
    child.kill.mockImplementation(() => {
      throw new Error('失败');
    });
    expect(() => port.kill()).toThrow();
    expect(adapter.ownsProcess()).toBe(true);
    expect(() =>
      adapter.spawn(registration.job, { onMessage: vi.fn(), onExit: vi.fn() }),
    ).toThrow();
    child.emit('exit', 0);
    expect(adapter.ownsProcess()).toBe(false);
  });
  it('launch异常保持未知所有权；原生error不转发敏感report', () => {
    mock.fork.mockImplementationOnce(() => {
      throw new Error('启动失败');
    });
    const adapter = createElectronTransfer(registration, guardian());
    expect(() =>
      adapter.spawn(registration.job, { onMessage: vi.fn(), onExit: vi.fn() }),
    ).toThrow();
    expect(adapter.ownsProcess()).toBe(true);
    const child = new Child();
    mock.fork.mockReturnValue(child);
    const second = createElectronTransfer(registration, guardian()),
      onMessage = vi.fn();
    second.spawn(registration.job, { onMessage, onExit: vi.fn() });
    child.emit('error', 'FatalError', 'private-path', 'sensitive-report');
    expect(onMessage.mock.calls).toEqual([[null]]);
    expect(second.ownsProcess()).toBe(true);
  });
});
