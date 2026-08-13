# S4 AI 侧栏 UI 与布局协调（可验证闭环）

- **目标**：AI 侧栏完整 UI（会话管理/消息流/中止/上下文徽标/追溯卡片/Provider 设置）+
  preload bridge 与 IPC 扩展（白名单 + sender 校验）+ 布局 bounds 协调 +
  UI 端到端冒烟矩阵（FakeProvider，离线）。
- **输入文档**：doc/stage2/detailed-design.md §4/§11/§13.2（全矩阵 UI 驱动）；
  Second_stage.md §3.1/§9。
- **范围**：shared/types/app.ts（bridge 扩展）、shared/types/ipc.ts（通道常量）、
  preload/index.ts（conversation/config 白名单）、main/index.ts（handler 装配 + 事件转发）、
  renderer/src/ai/*（面板组件 + hooks）、useContentBounds 升级（内容容器两维测量）。
- **非目标**：不做真实 Provider 验证（S5）；不引入 Markdown 渲染库（纯文本展示）；
  面板不做宽度拖拽（定宽 380px）；不做回答自动重试；**严禁新增 click/fill/scroll、
  自动搜索、多步 Browser Agent Tool**（Third Stage 范围——UI 之外不产生任何浏览器写通道）。

## 涉及文件

- 修改：`src/shared/types/app.ts`、`src/shared/types/ipc.ts`、`src/preload/index.ts`、
  `src/main/index.ts`、`src/renderer/src/browser/useContentBounds.ts`、`src/renderer/src/App.tsx`、
  `src/main/smoke.ts`（UI 端到端驱动）；
- 新增：`src/renderer/src/ai/`（AiPanel/ChatView/Composer/ContextBadge/CitationCard/
  ProviderSettings + useConversation/useStream，含纯 reducer 测试）。

## 实施步骤

- [ ] IPC 常量与 payload 扩展 → main handler（复用既有 sender 校验 handle 包装）→
      preload bridge 白名单（事件通道单次注册 + JS 侧 listener 列表，沿用 tabs:updated 模式）
- [ ] useContentBounds 升级：测量内容容器两维矩形（ResizeObserver + 防抖 50ms 不变）
- [ ] App 布局：内容容器 + 面板停靠（定宽 380px，可收起）；DebugPanel 保留
- [ ] 面板组件：会话列表/新建/删除/不保存开关/设置（API Key type=password 只写不回显）/
      消息流（delta 追加 reducer）/中止按钮/ContextBadge（preview 驱动，防抖 300ms）/
      CitationCard（ContextSource 展示）
- [ ] useStream：requestId → delta 追加 + turn-done 收敛（纯函数可测）
- [ ] 冒烟 UI 端到端（矩阵全量，React DOM 事件驱动沿用 T5 方法）：1–12 全部场景，
      含 9（bounds 宽度断言）/ 10（Key 不可达：DOM/日志字节扫描、credentials.json 密文、
      list 仅 hasKey）/ 11（注入结构断言）/ 12（远程隔离回归）
- [ ] 全量回归 + 提交

## 测试与检查

- `npm test` 全绿（含 hooks 纯 reducer 用例）；`npm run typecheck` / `lint` / `format:check`；
  `npm run build`；Electron 冒烟（dev 离线 + 生产产物）退出码 0，UI 端到端全断言通过。

## 完成定义

- 以上检查全部通过；grep 断言确认无任何浏览器写 Tool 通道、无 Key 读回通道；
  diff 终检；逻辑 commit（bridge/UI/冒烟可拆分）推送双远程；progress.md S4 ✅。
