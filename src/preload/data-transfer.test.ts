import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AibrowseBridge } from '../shared/types/app';
import { IPC } from '../shared/types/ipc';

const status = {
  operationId: null,
  action: null,
  state: 'recovery-required',
  code: 'recovery',
  message: '请选择备份恢复',
  canCancel: false,
  canRecoverOriginal: false,
  availableActions: ['restore'],
};

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('__E2_RUNTIME_QUALIFICATION__', false);
  electron.invoke.mockImplementation(async (channel: string) =>
    channel === IPC.UiDocumentOpen ? 'synthetic-document-token' : status,
  );
});
it.each([
  { ...status, availableActions: ['restore', 'restore'] },
  { ...status, availableActions: ['shell'] },
  { ...status, availableActions: undefined },
  { ...status, availableActions: structuredClone(new Array(1)) },
  { ...status, path: 'private' },
  { ...status, message: 'x'.repeat(513) },
  { ...status, operationId: 'arbitrary-path' },
  { ...status, state: 'unknown' },
  { ...status, state: 'validating' },
  { ...status, canCancel: true },
  { ...status, canRecoverOriginal: true },
])('传输状态拒绝未知字段或无效闭合能力：%j', async (value) => {
  const api = await bridge();
  electron.invoke.mockResolvedValue(value);
  await expect(api.dataTransfer.getStatus()).rejects.toThrow('本地数据状态无效');
});
it('合法恢复能力通过四个状态回执，返回投影独立于main对象', async () => {
  const api = await bridge();
  for (const call of [
    () => api.dataTransfer.getStatus(),
    () => api.dataTransfer.start('restore'),
    () => api.dataTransfer.cancel('x'),
    () => api.dataTransfer.recoverOriginal('x'),
  ]) {
    const result = await call();
    expect(result.availableActions).toEqual(['restore']);
    result.availableActions.length = 0;
    expect(status.availableActions).toEqual(['restore']);
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function bridge() {
  await import('./index');
  return electron.exposeInMainWorld.mock.calls.find(
    (call) => call[0] === 'aibrowse',
  )![1] as AibrowseBridge;
}
it('实际preload仅封装固定通道、闭合参数及隔离文档token', async () => {
  const api = await bridge();
  const operationId = '7f24a960-dd65-4ef2-a04a-742c0e87c845';
  await api.dataTransfer.getStatus();
  await api.getConversationStorageStatus();
  await api.dataTransfer.start('restore');
  await api.dataTransfer.cancel(operationId);
  await api.dataTransfer.recoverOriginal(operationId);
  expect(electron.invoke.mock.calls.slice(1)).toEqual([
    [IPC.DataTransferStatus, undefined, 'synthetic-document-token'],
    [IPC.ConversationStorageStatus, undefined, 'synthetic-document-token'],
    [IPC.DataTransferStart, { action: 'restore' }, 'synthetic-document-token'],
    [IPC.DataTransferCancel, { operationId }, 'synthetic-document-token'],
    [IPC.DataTransferRecoverOriginal, { operationId }, 'synthetic-document-token'],
  ]);
  expect(Object.keys(api.dataTransfer).sort()).toEqual([
    'cancel',
    'getStatus',
    'recoverOriginal',
    'start',
  ]);
});
it('文档token拒绝时五个新入口均不能抵达main业务handler', async () => {
  vi.useFakeTimers();
  electron.invoke.mockResolvedValue(null);
  const api = await bridge();
  const actions = [
    () => api.dataTransfer.getStatus(),
    () => api.getConversationStorageStatus(),
    () => api.dataTransfer.start('backup'),
    () => api.dataTransfer.cancel('x'),
    () => api.dataTransfer.recoverOriginal('x'),
  ];
  const rejected = Promise.all(
    actions.map((action) => expect(action()).rejects.toThrow('应用文档尚未授权')),
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(IPC.UiDocumentOpen);
});
