# D6 — 页面 Region、Session 授权与有界 PageProjection

## 目标

把 D3 公开 HTML SAX 与既有 BrowserController/PageSnapshot 映射为同一 DocumentChannels，实现用户确认的
main-text/headings/table/links Region 预览、逐规则 Session grant、每 run 精确 task-tab acquisition 和确定性
PageProjection，结构失效 fail-closed。

## 范围与非目标

- **做**：DocumentChannels validator；RegionDescriptor validator/预览/重新定位；PageProjector；public/session
  严格路由；一次性授权 token；WatchTaskTabWorkspace 精确/provisional ownership、焦点三态、abort/cleanupAll
  drain；host gate 后 `createTab(pageUrl)`、ready/snapshot/final URL 复验；login/captcha/degraded/parse health。
- **不做**：任意 CSS/XPath/JS、跨域 iframe、表单值、自动整页 fallback、登录 feed、Diff/Event/UI 完整页面。

## 涉及模块和输入文档

- `src/main/watch/watch-task-tab-workspace.ts`、`browser-watch-reader.ts`、`page-projector.ts`、Session grant store；
  共享 PageProjection 纯函数/测试。
- 输入：detailed §3.2/§7/§8/§12.2；threat-model WT-09～WT-12、WRT-09～WRT-11。

## 预计修改文件

- 新增上述 watch 模块与测试。
- BrowserController 公共接口零变化；Workspace 只通过既有 createTab/closeTab/activateTab/getTabs/getActiveTab，
  Reader 只通过 getTabs/getPageSnapshot；不得访问 webContents/executeJavaScript/Cookie。
- preload/renderer 只允许 D9 接线，本任务可用主进程/纯逻辑 harness 验证。

## 实施步骤（红→绿）

1. 红：公开/Session DocumentChannels 恒等、Region 规范化/歧义/table header/跨域限制/授权绑定重放；敌手
   create 返回用户 id、create 期间 abort、焦点恢复三态、用户关闭、ready/error/timeout、redirect/final origin/
   locator、close false/throw、cleanupAll drain、重启 catch-up 无旧 tabId 测试。
2. 绿：DocumentChannels adapters → 纯 PageProjector → Region catalog/preview → grant token →
   WatchTaskTabWorkspace → BrowserWatchReader；Session create 前 host gate 由 D5 注入窄 port。
3. 敌手 PageSnapshot：原型链键、bidi/control、巨表/链接、表单 canary、challenge 页面；零泄露。
4. Electron 受控页冒烟：真实共享 Session/documentId/time；授权 Tab 关闭与新进程后 task Tab 重建；每 attempt
   create/close 精确序列；用户 Tab id/url/title/active 恒等；导航后旧 grant/locator 失效。

## 验收标准与测试

- 只有用户显式选择的 Region 进入 Projection；main-text 明示高噪声；inputs/forms 零进入。
- grant record 绑定 source/tab/origin/target、5分钟单次；renderer 仅得 opaque handle，handle 零 DB/log，
  Cookie/session credential 零 renderer/DB/log；只持久化 consent + pageUrl，不持久化 preview/run tabId。
- 每次 run 只读取本 run 新建并证明 owned 的 Tab；用户 Tab 零 navigate/close。create 自动激活后焦点三态恢复；
  cleanup 失败保留 ownership、零结果提交并使 Watch unavailable，shutdown 可精确重试。
- app 重启/原授权 Tab 关闭不使 consent 自动失效；通过共享 Chromium Session 新建 task Tab。Source/origin/
  pageUrl locator 变化或用户撤销才失效，且不自动扩大授权。
- 歧义/失效/degraded/captcha/login 不建 Projection，不猜测 fallback。
- 64KiB/10 Region/50 fields 预算精确；全量门控和 dev/production 冒烟全绿。

## 完成定义

红→绿、Session 隐私扫描、Electron 证据、独立安全 Reviewer PASS、候选提交。

## 依赖与停止条件

- 依赖 D2/D3/D5（host gate）；D7/D9/D10 依赖本任务。
- 需要改 BrowserController 公共边界、持久化/复用 tabId、执行任意 JS、读 Cookie/表单、跨域 iframe 或自动绕
  challenge 时停止 REPLAN。
