// 远程网页权限策略：v1 默认拒绝（安全红线，2026-08-13 审查补丁定稿）.
// Contract source: doc/detailed-design.md §11（setPermissionRequestHandler + setPermissionCheckHandler）.
// 纯函数零 Electron 依赖（分层纪律）：SessionManager 胶水层注册 handler 时调用本模块决策。
// v1 策略固定为「一切拒绝」——未知权限类型、畸形/空来源同样安全拒绝（越界安全返回）。
// 参数保留供后续按（权限类型, 来源）扩展白名单，届时只改本模块与测试，不动调用方签名。

export function resolvePermissionRequest(permission: string, requestingUrl: string): boolean {
  // v1 固定默认拒绝，不依赖输入内容做放行判断；参数保留供未来按（权限类型, 来源）扩展白名单
  void permission;
  void requestingUrl;
  return false;
}

export function resolvePermissionCheck(permission: string, requestingOrigin: string): boolean {
  void permission;
  void requestingOrigin;
  return false;
}
