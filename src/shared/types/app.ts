// Shared types: single source of truth for the main/renderer contract (UI bridge part).
// Contract source: doc/detailed-design.md §3.2（AibrowseBridge 白名单，定稿，T1/T3 落地）.
// 最小权限：仅白名单方法；远程网页无 preload（Tab view 不配置 preload），不触及本 bridge。

import type { PageSnapshot, TabInfo, TabsState } from './browser';
import type { ContentBounds } from './ipc';

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
  tabs: {
    list(): Promise<TabInfo[]>;
    // 原始地址栏输入（可为空），main 侧统一规范化（§9）；无法解析 → 创建空白 Tab
    create(url?: string): Promise<TabInfo | null>;
    close(tabId: string): Promise<boolean>;
    activate(tabId: string): Promise<boolean>;
    // tabs:updated 全量推送（§3.2）；返回退订函数（preload 内同一通道只注册一次监听）
    onUpdated(listener: (state: TabsState) => void): () => void;
  };
  nav: {
    // 原始输入由 main 侧 IPC handler 统一规范化（UI 不做 URL 判断，First_stage §十）
    navigate(tabId: string, input: string): Promise<boolean>;
    back(tabId: string): Promise<boolean>;
    forward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<boolean>;
  };
  page: {
    // null = L3（tab 不存在/已销毁）；L1/L2 降级见 meta.degraded（§4）
    snapshot(tabId: string): Promise<PageSnapshot | null>;
  };
  ui: {
    // 渲染层 ResizeObserver 测量 chrome 高度后上报内容区矩形（§6，单向 send）
    reportContentBounds(bounds: ContentBounds): void;
  };
}
