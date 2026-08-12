// Tab state machine: pure logic, zero Electron dependency (分层纪律，可单测).
// Contract source: doc/detailed-design.md §2.6/§5（定稿，T1）.
// 事件→状态迁移仅三条：start-loading → loading / finish-load → ready / fail-load → error；
// 子框架事件一律忽略；ERR_ABORTED（-3）表示导航被新导航取代，不是真实失败。

import type { TabInfo, TabState } from '../../shared/types/browser';

export type TabStateEvent =
  | { type: 'start-loading'; isMainFrame: boolean }
  | { type: 'finish-load'; isMainFrame: boolean }
  | { type: 'fail-load'; isMainFrame: boolean; errorCode: number };

const ERR_ABORTED = -3;

export function transition(state: TabState, e: TabStateEvent): TabState {
  if (!e.isMainFrame) return state; // 子框架加载不影响 Tab 状态
  if (e.type === 'start-loading') return 'loading';
  if (e.type === 'finish-load') return 'ready';
  return e.errorCode === ERR_ABORTED ? state : 'error';
}

// 关闭标签页后的激活选择策略（§5）：
// 关闭的不是活动 Tab（或 closedTabId 不在列表）→ 原 activeTabId 不变；
// 关闭的是活动 Tab → 右邻优先，无右邻取左邻；列表只剩它一个 → null（controller 执行最后 Tab 策略）。
// 参数放宽为 {id} 结构（契约签名的 TabInfo[] 也满足），供登记表内部条目直接复用。
export function selectNextActive(
  tabs: ReadonlyArray<Pick<TabInfo, 'id'>>,
  activeTabId: string | null,
  closedTabId: string,
): string | null {
  const closedIndex = tabs.findIndex((t) => t.id === closedTabId);
  if (closedIndex === -1) return activeTabId;
  if (activeTabId !== closedTabId) return activeTabId;
  const right = tabs[closedIndex + 1];
  if (right !== undefined) return right.id;
  const left = tabs[closedIndex - 1];
  if (left !== undefined) return left.id;
  return null;
}
