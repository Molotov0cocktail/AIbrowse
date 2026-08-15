// smoke-activate-navigate（B6/B8 补验夹具修复，2026-08-16）：真实 Provider
// Sources 场景 6/7 的导航最小可离线测试纯逻辑（零 Electron 依赖——结构接口
// 仅声明 activateTab/navigate，BrowserControllerImpl 结构兼容，typecheck 保证）。
// 背景（第四轮真实验收诊断）：场景 5 真实模型经 browser_open（auto-visible
// 契约）打开并激活新 Tab 后，场景 6/7 夹具对进入前 Tab 直接 navigate() 再等待
// 活动 Tab URL——但 navigate() 契约只加载目标 Tab 不激活（活动 Tab 仍是模型
// 打开的 Tab）→ 等待恒不满足、10 秒超时（「敌对页未就绪」）。
// 修复纪律：不修改 BrowserController 产品契约；激活必须先于导航；激活失败/
// 取消/超时不得继续导航（场景断言失败于发送任务之前，不触发任何 Provider
// 请求）；任何失败安全返回 false 不抛异常。

export interface SmokeActivateNavigator {
  activateTab(tabId: string): Promise<boolean>;
  navigate(tabId: string, url: string): Promise<boolean>;
}

/**
 * 激活后导航（SMOKE 夹具辅助）：先 activateTab(tabId)，成功后才 navigate。
 * - 空 tabId/url → false（零调用）；
 * - signal 已中止（超时/取消）→ false（零调用）；
 * - 激活失败（Tab 不存在/已销毁/参数问题返回 false，或未预期异常）→ false，
 *   **不得继续导航**；
 * - 激活成功后、导航前 signal 中止 → false（零导航）；
 * - 导航失败/未预期异常 → false。
 * 契约失败语义与 BrowserController 一致：安全返回 false，不抛异常。
 */
export async function activateThenNavigate(
  controller: SmokeActivateNavigator,
  tabId: string,
  url: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (tabId === '' || url === '') return false;
  if (signal?.aborted) return false;
  let activated: boolean;
  try {
    activated = await controller.activateTab(tabId);
  } catch {
    return false;
  }
  if (!activated) return false; // 激活失败不得继续导航
  if (signal?.aborted) return false; // 激活后导航前取消/超时 → 零导航
  try {
    return await controller.navigate(tabId, url);
  } catch {
    return false;
  }
}
