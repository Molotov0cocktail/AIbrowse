// Shared browser-core types: single source of truth for the main/renderer contract.
// Contract source: doc/detailed-design.md §2.2/§2.3（定稿，T1）.
// PageSnapshot 的采集实现（PageReader）在 T4 接入；此处为定稿契约类型。

export type TabState = 'idle' | 'loading' | 'ready' | 'error';

export interface TabInfo {
  id: string; // crypto.randomUUID()，程序内唯一；与 webContents.id 解耦（避免 id 复用）
  title: string; // 页面标题；空串时 UI 显示兜底「新标签页」
  url: string;
  active: boolean;
  state: TabState;
}

export interface TabsState {
  tabs: TabInfo[];
  activeTabId: string | null;
}

// 快照降级阶梯（§4）：L0 none / L1 partial / L2 main-process-only / L3 null（无快照）
export type SnapshotDegradation = 'none' | 'partial' | 'main-process-only';

export interface SnapshotMeta {
  capturedAt: number; // 主进程侧盖章（epoch ms），不信任页面时钟
  readyState: 'loading' | 'interactive' | 'complete' | 'unknown';
  degraded: SnapshotDegradation;
  warnings: string[]; // 中文警告（iframe 跳过、截断、部分采集失败等）
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport?: { scrollX: number; scrollY: number; width: number; height: number };
  selection?: string;
  visibleText?: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ id: string; text: string; href: string }>;
  buttons: Array<{ id: string; text: string }>;
  inputs?: Array<{ id: string; type: string; placeholder?: string; value?: string }>;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  meta: SnapshotMeta; // 必填：调试面板与未来 Tool Layer 都依赖 degraded/warnings
}
