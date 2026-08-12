// Shared types: single source of truth for the main/renderer contract (UI bridge part).
// Browser core types (TabInfo / PageSnapshot) will extend this layer in tasks T1/T2 —
// the baseline deliberately does not pre-declare them.

export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

// Minimal-privilege bridge exposed by the preload script to the renderer (React UI only).
export interface AibrowseBridge {
  getAppInfo(): Promise<AppInfo>;
  notifyRendererReady(): void;
}
