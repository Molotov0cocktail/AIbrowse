import { contextBridge, ipcRenderer } from 'electron';
import type { AibrowseBridge, AppInfo } from '../shared/types/app';

// Minimal-privilege bridge: only whitelisted methods are exposed;
// the raw ipcRenderer is never handed to the renderer (安全红线：preload bridge 最小权限).
const bridge: AibrowseBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info') as Promise<AppInfo>,
  notifyRendererReady: () => {
    ipcRenderer.send('app:renderer-ready');
  },
};

contextBridge.exposeInMainWorld('aibrowse', bridge);
