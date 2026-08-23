# D6 — 页面 Region、Session 授权与有界 PageProjection

## 目标

把 D3 公开 HTML SAX 与既有 BrowserController/PageSnapshot 映射为同一 DocumentChannels，实现用户确认的
main-text/headings/table/links Region 预览、逐规则 Session grant 和确定性 PageProjection，结构失效 fail-closed。

## 范围与非目标

- **做**：DocumentChannels validator；RegionDescriptor validator/预览/重新定位；PageProjector；public/session 严格路由；一次性授权 token；
  capturedAt/documentId/final URL 主进程归属；login/captcha/degraded/parse health。
- **不做**：任意 CSS/XPath/JS、跨域 iframe、表单值、自动整页 fallback、登录 feed、Diff/Event/UI 完整页面。

## 涉及模块和输入文档

- `src/main/watch/browser-watch-reader.ts`、`page-projector.ts`、Session grant store；共享 PageProjection 纯函数/测试。
- 输入：detailed §3.2/§7/§8/§12.2；threat-model WT-09～WT-12、WRT-09～WRT-11。

## 预计修改文件

- 新增上述 watch 模块与测试。
- BrowserController 公共接口零变化；只通过既有 `getTabs/getPageSnapshot` 窄适配。
- preload/renderer 只允许 D9 接线，本任务可用主进程/纯逻辑 harness 验证。

## 实施步骤（红→绿）

1. 红：公开/Session DocumentChannels 恒等、Region 规范化/歧义/table header/跨域限制/授权绑定重放/导航失效测试。
2. 绿：DocumentChannels adapters → 纯 PageProjector → Region catalog/preview → grant token → BrowserWatchReader。
3. 敌手 PageSnapshot：原型链键、bidi/control、巨表/链接、表单 canary、challenge 页面；零泄露。
4. Electron 受控页冒烟：真实 documentId/time、导航后旧 grant 失效、用户 Tab 集合恒等。

## 验收标准与测试

- 只有用户显式选择的 Region 进入 Projection；main-text 明示高噪声；inputs/forms 零进入。
- grant record 绑定 source/tab/origin/target、5分钟单次；renderer 仅得 opaque handle，handle 零 DB/log，
  Cookie/session credential 零 renderer/DB/log。
- 歧义/失效/degraded/captcha/login 不建 Projection，不猜测 fallback。
- 64KiB/10 Region/50 fields 预算精确；全量门控和 dev/production 冒烟全绿。

## 完成定义

红→绿、Session 隐私扫描、Electron 证据、独立安全 Reviewer PASS、候选提交。

## 依赖与停止条件

- 依赖 D2/D3；D7/D9/D10 依赖本任务。
- 需要改 BrowserController 公共边界、执行任意 JS、读 Cookie/表单、跨域 iframe 或自动绕 challenge 时停止 REPLAN。
