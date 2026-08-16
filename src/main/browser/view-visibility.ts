// C8 决议 #158：大结果画布与 WebContentsView 可见性——仅 React 切 viewMode
// 不足以显示结果画布（原生 WebContentsView 覆盖在 DOM 之上）。本纯函数
// （零 Electron import）是可见性决策的单一事实源：contentVisible=false 时
// 全部 Tab 不可见（不关闭、不导航、不改 Tab 集合）；true 时仅 active Tab
// 可见。隐藏期间 create/activate/焦点恢复均不得重新显示或 focus——
// BrowserControllerImpl 的 applyActiveVisual 以本函数结果执行 setVisible。
export function resolveViewVisibility(
  tabIds: readonly string[],
  activeTabId: string | null,
  contentVisible: boolean,
): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>();
  if (!contentVisible) {
    for (const id of tabIds) map.set(id, false);
    return map;
  }
  for (const id of tabIds) {
    map.set(id, activeTabId !== null && id === activeTabId);
  }
  return map;
}
