import { beforeEach, expect, it, vi } from 'vitest';
import type { AibrowseBridge, TraySettings } from '../shared/types/app';
import { IPC } from '../shared/types/ipc';

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
    channel === IPC.UiDocumentOpen
      ? 'synthetic-document-token'
      : ({ runInTray: false, available: true, error: null } satisfies TraySettings),
  );
});

it('preload仅以授权invoke暴露托盘偏好的无参读取与闭合布尔写入', async () => {
  await import('./index');
  const api = electron.exposeInMainWorld.mock.calls.find(
    (call) => call[0] === 'aibrowse',
  )![1] as AibrowseBridge;

  await expect(api.appPreferences.get()).resolves.toEqual({
    runInTray: false,
    available: true,
    error: null,
  });
  await api.appPreferences.setRunInTray(true);

  expect(electron.invoke.mock.calls).toEqual([
    [IPC.UiDocumentOpen],
    [IPC.AppPreferencesGet, undefined, 'synthetic-document-token'],
    [IPC.AppPreferencesSet, { runInTray: true }, 'synthetic-document-token'],
  ]);
  expect(Object.keys(api.appPreferences).sort()).toEqual(['get', 'setRunInTray']);
});
