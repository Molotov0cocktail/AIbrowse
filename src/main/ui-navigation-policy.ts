// UI 窗口自身导航保护策略：纯函数、零 Electron 依赖（分层纪律，可单测）.
// Contract source: doc/detailed-design.md §9（UI 窗口导航保护，决议 #16）.
// 背景：UI 窗口 preload 随该窗口任何导航加载——若主框架被导航到远程页面，
// 远程页面将获得 window.aibrowse bridge（含 page.snapshot，可读取任意 Tab 内容）。
// 保护覆盖两条路径：will-navigate（页面发起导航，含 location.replace）与
// will-redirect（服务器重定向，程序化导航遇 302 时唯一拦截点），
// 两处 handler 共用本模块的「自身来源」判定（越界/畸形输入安全返回 false，不抛异常）。

export interface UiNavigationPolicy {
  // 开发模式：仅放行 ELECTRON_RENDERER_URL 的 origin（重定向目标同样过该判定）
  selfOrigin: string | null;
  // 生产模式：仅放行 file: 入口（按入口文件路径前缀匹配）
  selfFilePrefix: string | null;
}

export function resolveUiNavigationAllowed(targetUrl: string, policy: UiNavigationPolicy): boolean {
  if (policy.selfOrigin !== null) {
    try {
      return new URL(targetUrl).origin === policy.selfOrigin;
    } catch {
      return false; // 畸形 URL（含空串）一律拒绝
    }
  }
  if (policy.selfFilePrefix !== null) {
    return targetUrl.startsWith(policy.selfFilePrefix);
  }
  // 双空策略属装配错误：防御性全拦（默认拒绝）
  return false;
}
