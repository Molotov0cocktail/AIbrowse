// Shared browser-core types: single source of truth for the main/renderer contract.
// Contract source: doc/detailed-design.md §2.2/§2.3（定稿，T1）.
// PageSnapshot 的采集实现（PageReader）在 T4 接入；此处为定稿契约类型。
import type { ToolResultErrorCode } from './agent';

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
  // A3：主进程维护的导航世代（TabManager 主框架 did-navigate 提交计数，快照时刻盖章）——
  // elementId 与产生它的可信文档绑定的唯一依据（URL/标题/capturedAt 均不能证明文档身份，
  // 同 URL 刷新世代同样递增）；页面脚本输出中的同名字段一律被主进程侧值覆盖。
  documentId: number;
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
  // A3：buttons 条目 click 语义元数据——isSubmit（提交类升级 L2）与 ariaExpanded
  // （展开/折叠控件 L1，true/false 均保留；字段缺失 = 无法证明 → fail-closed）
  buttons: Array<{ id: string; text: string; isSubmit?: boolean; ariaExpanded?: boolean }>;
  inputs?: Array<{
    id: string;
    type: string;
    placeholder?: string;
    value?: string;
    isSubmit?: boolean; // A3：type=submit 的提交类标志
  }>;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  meta: SnapshotMeta; // 必填：调试面板与未来 Tool Layer 都依赖 degraded/warnings
}

// A3 元素交互结果（BrowserController.clickElement/fillElement 返回）：
// 参数/状态问题安全返回 ok:false + 结构化错误码（闭合枚举），不抛异常。
export interface ElementActionResult {
  ok: boolean;
  reason?: string; // 中文（定位失败/不可交互/类型拒绝/世代过期等）
  errorCode?: ToolResultErrorCode; // ok=false 时
  tag?: string; // 成功时：目标元素标签
  text?: string; // 成功时：可见文本摘要 ≤ 100 字符（确认展示/审计用）
  type?: string; // fill 成功时：input type（不含值）
}

// A3 滚动结果（BrowserController.scrollTab 返回）
export interface ScrollActionResult {
  ok: boolean;
  reason?: string;
  viewport?: { scrollX: number; scrollY: number; width: number; height: number };
}
