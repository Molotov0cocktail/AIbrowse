import { contextBridge, ipcRenderer } from 'electron';
import type { AibrowseBridge, AppInfo } from '../shared/types/app';
import type { PageSnapshot, TabInfo, TabsState } from '../shared/types/browser';
import { IPC } from '../shared/types/ipc';

// Minimal-privilege bridge (design §3.2): only whitelisted methods are exposed;
// the raw ipcRenderer is never handed to the renderer (安全红线：preload bridge 最小权限).
const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

// tabs:updated 全量推送：preload 内同一通道只注册一次 ipcRenderer 监听，
// 由 JS 侧管理 listener 列表（防重复注册；渲染层卸载时退订，§3.2）。
const tabsListeners = new Set<(state: TabsState) => void>();
ipcRenderer.on(IPC.TabsUpdated, (_event, state: TabsState) => {
  for (const listener of tabsListeners) listener(state);
});

const bridge: AibrowseBridge = {
  getAppInfo: () => invoke<AppInfo>(IPC.AppGetInfo),
  notifyRendererReady: () => {
    ipcRenderer.send(IPC.AppRendererReady);
  },
  tabs: {
    list: () => invoke<TabInfo[]>(IPC.TabsList),
    create: (url) => invoke<TabInfo | null>(IPC.TabsCreate, { url }),
    close: (tabId) => invoke<boolean>(IPC.TabsClose, { tabId }),
    activate: (tabId) => invoke<boolean>(IPC.TabsActivate, { tabId }),
    onUpdated: (listener) => {
      tabsListeners.add(listener);
      return () => {
        tabsListeners.delete(listener);
      };
    },
  },
  nav: {
    navigate: (tabId, input) => invoke<boolean>(IPC.NavNavigate, { tabId, input }),
    back: (tabId) => invoke<boolean>(IPC.NavBack, { tabId }),
    forward: (tabId) => invoke<boolean>(IPC.NavForward, { tabId }),
    reload: (tabId) => invoke<boolean>(IPC.NavReload, { tabId }),
  },
  page: {
    snapshot: (tabId) => invoke<PageSnapshot | null>(IPC.PageSnapshot, { tabId }),
  },
  ui: {
    reportContentBounds: (bounds) => {
      ipcRenderer.send(IPC.UiContentBounds, bounds);
    },
  },
};

contextBridge.exposeInMainWorld('aibrowse', bridge);
