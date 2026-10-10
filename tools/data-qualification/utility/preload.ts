import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld(
  'qualification',
  Object.freeze({
    ping: (sequence: number): Promise<number> => ipcRenderer.invoke('qualification:ping', sequence),
    sample: (sequence: number, milliseconds: number): Promise<void> =>
      ipcRenderer.invoke('qualification:sample', sequence, milliseconds),
    environment: (nodeVisible: boolean): Promise<void> =>
      ipcRenderer.invoke('qualification:environment', {
        nodeVisible,
        sandboxed: process.sandboxed === true,
        contextIsolated: process.contextIsolated === true,
      }),
  }),
);
