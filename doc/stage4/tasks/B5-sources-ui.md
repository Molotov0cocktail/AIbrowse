# B5 — Sources UI + 手工管理 + 当前页快速添加 + IPC/bridge

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§6 手工操作/§8.2
> 分享模式 UI 要求/§10.3 恢复态诊断/§11 本地明文如实说明）。

## 目标

落地 Sources UI：AI 侧栏新增 Sources 面板（与 AiPanel 并列切换）、分组浏览/搜索/
详情（备注/标签/优先级/信任与 provenance 展示/分享模式三态说明）、手工添加与
编辑、当前网页快速添加、禁用/恢复、手工 Undo、永久删除二次确认、恢复态中文
诊断、IPC/bridge 通道扩展（全部 sender+主帧校验、参数验证、事件只发主窗口）。

## 前置依赖

- B2（SourceService 手工操作路径）、B3（search/list 检索）；UI 冒烟驱动需 B4
  完成后统一回归（B-05 场景可先在本任务内以 UI 直连 Service 形态落地）。

## 范围

- shared/types/ipc.ts：sources 通道常量与 payload 类型（sources:list/get/add/
  update/disable/restore/hard-delete/undo/undoable/search/quick-add + 事件
  sources:changed）；
- main/index.ts：全部 handler 复用既有 handle() sender+主帧校验包装，逐参数
  验证安全返回；
- preload：bridge 白名单扩展（eventRelay 模式，原始 ipcRenderer 不暴露）；
- renderer/src/ai/sources/：面板组件 + 纯函数（列表状态/筛选/格式化——
  可单测部分拆纯函数）；note 纯文本渲染（无 dangerouslySetInnerHTML/Markdown）；
  provenance 展示（「官方来源（用户标定）/官方来源（AI 推断·未核验）」）；
  快速添加按钮（当前活动 Tab URL 经主进程获取——URL 与名称由主进程生成
  「可能相关」提示，不自动覆盖同 origin）；
- 手工永久删除：UI 二次确认（不可 Undo 的明确文案）+ hardDeleteManual；
- 恢复态 UI：只读恢复态中文诊断（检测结果/原库位置/备份位置/建议动作）；
- 本地明文如实说明（「备注与 URL 以明文保存在本机」）；
- 冒烟 B-05（快速添加 → 列表 → 分享模式/备注修改 → Undo → 永久删除二次确认）。

## 非目标

- AI 端到端管理（B6）；usage 展示（B7）；恢复操作实现（仅诊断展示，恢复流程
  本身 B7）；图表/富文本；面板拖拽调宽（沿用 380px 契约）。

## 涉及模块

`src/shared/types/ipc.ts`、`src/main/index.ts`、`src/preload/index.ts`、
`src/shared/types/app.ts`（bridge 类型）、`src/renderer/src/ai/sources/`（新增）、
`src/main/smoke.ts`（B-05）；纯函数单测 + UI 冒烟。

## 红态测试（先红后绿）

- IPC payload 校验矩阵（非法 id/页码/长度超限安全返回）；
- bridge 白名单形状（原始 ipcRenderer 不暴露回归）；
- 面板纯函数（列表状态/筛选/格式化/provenance 文案映射）；
- 冒烟 B-05 端到端：快速添加（默认 metadata）→ 列表出现 → 改分享模式与备注
  → 手工 Undo 生效 → 永久删除二次确认后消失且无 Undo 入口 → 重启读回。

## 实现步骤

1. IPC 通道常量与 payload 类型（红→绿）；
2. main handler + preload bridge（红→绿）；
3. 面板纯函数与组件（红→绿）；
4. 快速添加与删除/恢复态/明文说明（红→绿）；
5. 冒烟 B-05；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §6 手工操作/§8.2 三态 UI/§10.3 诊断/§11 明文说明全部落地；
- 手工操作与 Agent 共用 SourceService（同一事务/审计/journal 语义，单测证据）；
- 快速添加不自动覆盖同 origin 既有条目（「可能相关」提示）；
- 恢复态下 UI 不崩溃且写入口禁用（中文诊断可见）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟（含 B-05 与既有 UI 矩阵回归）· diff 终检 ·
敏感信息扫描（note 不落 DOM 之外通道）。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B5 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- IPC/panel 与既有 bridge 契约冲突 → 回设计流程校准，不得绕过 sender 校验或
  暴露原始 ipcRenderer；
- UI 复杂度过高 → 最小化（无拖拽/无富文本/无图表），不为美观放宽安全渲染
  规则（note 恒纯文本）。
