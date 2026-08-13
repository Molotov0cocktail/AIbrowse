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
  // 生产模式：仅放行 file: 入口文件 URL（精确匹配，hash/query 变体视为同一文档）
  selfFileUrl: string | null;
}

export function resolveUiNavigationAllowed(targetUrl: string, policy: UiNavigationPolicy): boolean {
  if (policy.selfOrigin !== null) {
    try {
      return new URL(targetUrl).origin === policy.selfOrigin;
    } catch {
      return false; // 畸形 URL（含空串）一律拒绝
    }
  }
  if (policy.selfFileUrl !== null) {
    try {
      const target = new URL(targetUrl);
      const entry = new URL(policy.selfFileUrl);
      // 精确入口匹配：file: 协议 + pathname 完全相等；hash/query 变体是同一文档（放行）。
      // 注意 file: 的 origin 语义（Chromium 中恒为 'null'）：绝不能用 origin 比较——
      // 那会把所有本地文件视为同源（宽松判断）；同目录其他文件、'..' 路径穿越、
      // 大小写变体一律拒绝（失败关闭，Windows 大小写不敏感亦从严）。
      return (
        target.protocol === 'file:' &&
        entry.protocol === 'file:' &&
        target.pathname === entry.pathname
      );
    } catch {
      return false;
    }
  }
  // 双空策略属装配错误：防御性全拦（默认拒绝）
  return false;
}
