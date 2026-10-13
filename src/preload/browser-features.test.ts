import { beforeEach, expect, it, vi } from 'vitest';
import type { AibrowseBridge } from '../shared/types/app';
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
    channel === IPC.UiDocumentOpen ? 'document-token' : true,
  );
});

it('IDM bridge 固定为状态读取与 URL 交接，复用当前 UI 文档授权', async () => {
  await import('./index');
  const api = electron.exposeInMainWorld.mock.calls[0]![1] as AibrowseBridge;
  await api.downloads.getStatus();
  await api.downloads.sendToIdm('https://example.com/file.zip');
  expect(electron.invoke.mock.calls).toEqual([
    [IPC.UiDocumentOpen],
    [IPC.IdmGetStatus, undefined, 'document-token'],
    [IPC.IdmSend, { url: 'https://example.com/file.zip' }, 'document-token'],
  ]);
  expect(Object.keys(api.downloads).sort()).toEqual(['getStatus', 'sendToIdm']);
});

it('指定脚本 UI bridge 不暴露远程脚本私有 IPC 能力', async () => {
  await import('./index');
  const api = electron.exposeInMainWorld.mock.calls[0]![1] as AibrowseBridge;
  await api.qualifiedScripts.list();
  await api.qualifiedScripts.install('ac-baidu');
  await api.qualifiedScripts.installFile('github-zh');
  await api.qualifiedScripts.setEnabled('github-zh', false);
  await api.qualifiedScripts.remove('ac-baidu');
  await api.qualifiedScripts.showMenu();
  expect(electron.invoke.mock.calls).toEqual([
    [IPC.UiDocumentOpen],
    [IPC.QualifiedScriptsList, undefined, 'document-token'],
    [IPC.QualifiedScriptsInstall, { id: 'ac-baidu' }, 'document-token'],
    [IPC.QualifiedScriptsInstallFile, { id: 'github-zh' }, 'document-token'],
    [IPC.QualifiedScriptsSetEnabled, { id: 'github-zh', enabled: false }, 'document-token'],
    [IPC.QualifiedScriptsRemove, { id: 'ac-baidu' }, 'document-token'],
    [IPC.QualifiedScriptsMenu, undefined, 'document-token'],
  ]);
  expect(Object.keys(api.qualifiedScripts).sort()).toEqual([
    'install',
    'installFile',
    'list',
    'remove',
    'setEnabled',
    'showMenu',
  ]);
});

it('分组与脚本 bridge 只使用当前 UI 文档授权且不接受导入路径或源代码', async () => {
  await import('./index');
  const api = electron.exposeInMainWorld.mock.calls[0]![1] as AibrowseBridge;
  const tabId = '11111111-1111-4111-8111-111111111111';
  const groupId = '22222222-2222-4222-8222-222222222222';
  await api.tabs.getState();
  await api.tabs.createGroup({ tabId, name: '阅读', color: 'blue' });
  await api.tabs.updateGroup({ groupId, name: '资料', color: 'green', collapsed: true });
  await api.tabs.setGroup({ tabId, groupId });
  await api.tabs.ungroup(groupId);
  await api.userscripts.list();
  await api.userscripts.importScript();
  await api.userscripts.setEnabled(tabId, false);
  await api.userscripts.remove(tabId);
  expect(electron.invoke.mock.calls).toEqual([
    [IPC.UiDocumentOpen],
    [IPC.TabsGetState, undefined, 'document-token'],
    [IPC.TabsCreateGroup, { tabId, name: '阅读', color: 'blue' }, 'document-token'],
    [
      IPC.TabsUpdateGroup,
      { groupId, name: '资料', color: 'green', collapsed: true },
      'document-token',
    ],
    [IPC.TabsSetGroup, { tabId, groupId }, 'document-token'],
    [IPC.TabsUngroup, { groupId }, 'document-token'],
    [IPC.UserScriptsList, undefined, 'document-token'],
    [IPC.UserScriptsImport, undefined, 'document-token'],
    [IPC.UserScriptsSetEnabled, { id: tabId, enabled: false }, 'document-token'],
    [IPC.UserScriptsRemove, { id: tabId }, 'document-token'],
  ]);
  expect(Object.keys(api.userscripts).sort()).toEqual([
    'importScript',
    'list',
    'remove',
    'setEnabled',
  ]);
});
