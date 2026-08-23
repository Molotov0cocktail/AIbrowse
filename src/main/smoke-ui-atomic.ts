// smoke-ui-atomic（8.13 B-06 UI 时序修复，2026-08-23）：Sources UI 冒烟
// 原子「存在即点击」脚本生成纯逻辑（零 Electron 依赖，node 环境单测）。
// 目的：把「检查 + 条件点击」放进**同一次** renderer 脚本内同步完成——
// React 重渲染不能在两次 executeJavaScript 之间移除目标元素（TOCTOU 竞态
// 消除），这是「有界诊断」的可离线验证纯逻辑，与 smoke.ts 的
// clickUi/clickIfPresent 共用同一脚本。
//
// 8.13 根因（诊断结论）：UI Undo（真实 DOM → IPC → SourceService.undoChange）
// 成功后，useSourcesPanel.undo 触发 refreshAll → loadDetail(detail.id)；因该
// Undo **删除**详情中的源，get 返回 not-found → setDetail(null) → 详情异步
// 自动关闭 → .sources-back 异步消失。smoke 的 waitFor 轮询的是主进程
// listUndoable，可能早于 renderer 的 get IPC 落地；旧 panelGoBack 分两次
// 脚本执行 uiHas → clickUi，元素恰在两步之间消失 → clickUi 脚本内抛
// 「UI 元素不存在」→ executeJavaScript 以通用 renderer 错误拒绝。
//
// 语义契约：`clickIfPresentScript(selector)` 生成的脚本永不抛错——元素
// 存在则 click() 并返回 true，不存在则返回 false。调用方据返回值决定
// 是否继续（panelGoBack 的既有契约「无 detail/back 时安全 no-op」保持）。
export function clickIfPresentScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.click();
    return true;
  })()`;
}
