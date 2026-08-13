# AIbrowse 第二阶段 Proposal — AI 共读与当前网页对话

> 需求源：根目录 `Second_stage.md`（阶段总任务）。本文档把总任务收敛为可验收的阶段提案。
> 前置：第一阶段 Exit Gate 已通过、Second Stage Entry Gate 独立定向审查通过（2026-08-13，
> 证据见 doc/tasks/progress.md「最近验证结果」）。
> 里程碑 S1–S6 由本提案配套的 doc/stage2/tasks/S1–S6 任务文档单独管理。
> 与第一阶段文档的关系：`doc/proposal.md`、`doc/high-level-design.md`、`doc/detailed-design.md`
> 为第一阶段历史文档（定稿，不再修改）；本阶段契约源为 `doc/stage2/detailed-design.md`。

## 1. 目标

在**不破坏第一阶段浏览器安全边界**的前提下交付「AI 共读」闭环：

**PageSnapshot / Selection → AI Context → Conversation**

- 可收起的 AI 侧栏：新建/继续会话、流式回答、中止生成、明确的上下文模式指示
  （当前网页 / 当前选中文本 / 无网页上下文）；
- 用户可对当前网页、当前选中文字提问，让 AI 总结、解释、比较页面内容；
- **提问时刻实时采集快照**：切 Tab / 刷新 / 导航不会导致旧上下文串页；
- 确定性 ContextBuilder：角色隔离（网页内容 ≠ 系统指令）、上下文预算与确定性裁剪、
  selection 优先级、薄快照提示、布局表噪声容忍、L1/L2 降级；
- Provider 抽象（不绑定任何厂商 SDK）+ 流式输出 / 中止 / 超时 / 错误归一化；
- API Key 的 Windows 安全存储（Electron safeStorage / DPAPI），日志脱敏，
  renderer 与远程网页不可读；
- 会话本地持久化、删除与「不保存」策略（最小化持久化，不囤积网页快照）；
- 每个回答携带**可追溯的网页信息卡片**（用了哪个页面/哪段选中文本）；
- AI 侧栏与 WebContentsView bounds 的布局协调（面板停靠、内容区两维 bounds 上报）；
- fake provider 单测 + 真实 Provider 可选验证 + Electron 共读冒烟矩阵。

本阶段**不实现自主浏览 Agent**（不新增 click/fill/scroll、自动搜索、多步 Browser Agent
Tool——均属 Third Stage）。

## 2. 非目标（本阶段明确不做）

- AI 自动搜索互联网；AI 自动创建/关闭大量标签页；AI 自动点击、填写、提交表单；
  **多步 Browser Agent；任何 click / fill / scroll Browser Tool**（Third Stage 范围）；
- 收藏 / 信源库、Research、RSS / Watch、图表系统、自动网页 Diff、多 Agent 编排、后台定时任务；
- SQLite 业务数据层（会话持久化用 userData 下 JSON 文件，不得借机引入数据库）；
- 完整浏览器历史记录系统、密码管理器（SecureCredentialStore 仅管 API Key，不扩展为通用凭据库）；
- Markdown / 富文本回答渲染（v1 纯文本展示）、回答自动重试、多窗口；
- 引用级（句子级）网页出处高亮（本阶段追溯粒度 = 本轮上下文卡片；句子级引用属 Research 阶段）。

## 3. 用户与场景

- 用户：开发者本人（阶段验收者）。
- 场景：
  1. 浏览网页 → 打开 AI 侧栏 → 提问「总结这个页面」→ 流式回答 + 上下文卡片（页面标题/URL/采集时间）；
  2. 在页面中选中一段文字 → 提问「解释我选中的这段」→ 上下文卡片显示选中文本摘录；
  3. 切到另一个 Tab 再提问 → 回答依据新 Tab 的内容（不串页）；
  4. 页面刷新/销毁后提问 → 明确降级提示（无网页上下文），不错误复用旧快照；
  5. 配置 Provider（baseUrl / model / API Key）→ 正常对话；Key 不落日志、不落盘明文、
     不出现在 renderer 可读的任何通道；
  6. 删除会话 / 开启「不保存」→ 本地数据按要求消失；
  7. 生成中点击「中止」→ 流停止，已生成部分保留并标记「已中止」。

## 4. 输入 / 输出

- 输入：
  - 用户问题文本（≤ 16 000 字符，超限确定性截断）；
  - 提问时刻实时采集的 `PageSnapshot`（含 `selection`，第一阶段契约，L0–L3 降级阶梯复用）；
  - Provider 配置（providerId / baseUrl / model / API Key，用户经设置界面输入）；
  - 会话历史（已持久化消息）。
- 输出：
  - 流式回答（delta 事件流 + turn-done 终态事件）；
  - 每个 user 消息携带 `ContextSource`（模式 / tabId / URL / 标题 / capturedAt / 降级与薄快照标记 /
    选中文本摘录）——追溯卡片数据源；
  - 归一化错误（中文文案 + 错误码 + 可重试标记，不含密钥/响应体/请求头）。

## 5. 外部依赖

- 现有技术基线（AGENTS.md §1，第二阶段内同样冻结，升级走 §3 流程）。
- **不新增任何 npm 依赖**：Provider 调用用 Node 24 原生 fetch + SSE 手写解析（无厂商 SDK）；
  API Key 存储用 Electron 内置 `safeStorage`（Windows 后端为 DPAPI）。
- 真实 Provider 验证为**可选**：需要用户提供 API Key（询问边界：需密钥、账号或外部凭据）；
  无 Key 时全部冒烟走 FakeProvider（离线确定性），不阻塞开发与验收。
- 网络：仅安装依赖/推送代码需要外网（规则不变，AGENTS.md §6）。

## 6. 约束与假设

- **架构纪律**（在 First_stage 依赖方向基础上扩展，Second_stage.md §5）：
  `UI(AI 面板) → ConversationService → ContextBuilder / LLMProvider → SecureCredentialStore`；
  网页上下文：`ConversationService → BrowserController.getPageSnapshot(…) → PageReader`。
  禁止：LLMProvider 直接访问 webContents；React Chat UI 接触 API Key；
  网页内容直接拼接进 system prompt；renderer 任意 IPC 调主进程。
- **安全红线（第一阶段全部保持）**：远程网页 `nodeIntegration=false`、`contextIsolation=true`、
  `sandbox=true`、`webSecurity` 不关闭、Tab 无 preload、IPC sender 校验 + 白名单。
  新增：API Key 零暴露（不入源码/日志/prompt/网页/renderer 可读通道）。
- **Prompt Injection 验收 = 机器可验证的结构性边界**（不做语义免疫承诺）：
  网页内容不能取得权限、读取密钥、调用写操作或改变消息角色；剩余风险明确登记。
- **TypeScript / 质量门槛 / 提交纪律**：与第一阶段相同（AGENTS.md §3）。
- **假设**：单窗口；每会话单在途生成；快照为点时刻尽力采样（复用第一阶段契约）。

## 7. 验收标准

完整清单见 Second_stage.md §9（AI 配置 / 共读 / 安全 / Engineering 四组）。摘要：

- AI 配置：可配置至少一种 LLM Provider；API Key 不进入源码、日志、网页或 prompt；
  Provider 抽象不绑定业务逻辑。
- 共读：可回答当前网页/选中文本问题；可总结页面；切 Tab 后上下文正确更新；
  页面刷新/销毁不导致旧快照错误复用；超长页面有明确裁剪策略。
- 安全：网页内容按不可信输入处理；网页 Prompt Injection 不能覆盖系统/用户指令
  （结构性断言 + 无写工具可触发）；当前阶段 AI 不具备自主浏览写操作；
  Renderer/远程网页无法读取 API Key。
- Engineering：test / typecheck / lint / build 全绿；Electron 实际共读冒烟通过；
  日志可定位 Provider / Context 问题且无敏感信息。

## 8. 待定问题（本会话已拍板，决议见 doc/stage2/detailed-design.md §15）

| #   | 问题                                                                             | 影响                 | 拍板（2026-08-13）                                                                      |
| --- | -------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| Q1  | 主 Provider 选型：绑定某家 SDK vs OpenAI-compatible 通用适配器（自实现，无 SDK） | 依赖与覆盖面         | OpenAI-compatible 适配器（原生 fetch + SSE）+ FakeProvider；接口为未来适配器预留        |
| Q2  | API Key 存储：safeStorage（DPAPI） vs 明文配置 vs 第三方库                       | Key 安全性           | Electron safeStorage（Windows DPAPI）；接口可替换；不可用时 fail-closed + 仅内存 key    |
| Q3  | 会话持久化：SQLite vs JSON 文件 vs 仅内存；是否存网页快照                        | 存储复杂度与隐私     | userData 下 JSON 文件（原子写 + 上限裁剪）；只存消息与 ContextSource 摘要，不存快照正文 |
| Q4  | 网页内容注入位置：system 拼接 vs user 消息标记块                                 | 注入风险与角色隔离   | user 消息内 `UNTRUSTED_WEB_CONTENT` 标记块 + 闭合转义；system 恒为应用常量              |
| Q5  | 流式通道形态：invoke 整包返回 vs send 事件流                                     | 流式体验与实现复杂度 | invoke 受理（返回 requestId）+ send 事件流（stream-chunk / turn-done）                  |
| Q6  | 面板布局：悬浮覆盖 vs 停靠挤压内容区                                             | 布局与 bounds 协调   | 停靠挤压，复用 `ui:content-bounds` 机制升级为内容容器两维测量                           |
| Q7  | 中止语义：丢弃 vs 保留部分                                                       | 用户体验             | 保留部分并标记「已中止」                                                                |
| Q8  | 并发生成策略                                                                     | 服务状态机           | 每会话单在途；在途时新 ask 返回 busy 错误                                               |
| Q9  | selection 优先级规则：选中时是否还送整页                                         | 上下文聚焦与预算     | selection 独占（只送选中文本 + 页面身份），不送整页                                     |
| Q10 | 超时参数                                                                         | 错误体验             | 连接 15s / 空闲 chunk 60s / 总时长 300s（常量，可配）                                   |

## 9. 里程碑划分（每任务 = 一个可验证开发闭环，任务文档见 doc/stage2/tasks/）

| 任务 | 内容                                                                                           | 依赖  |
| ---- | ---------------------------------------------------------------------------------------------- | ----- |
| S1   | Provider 抽象 + SecureCredentialStore + Provider 配置 + 错误归一化（FakeProvider 闭环，无 UI） | 无    |
| S2   | ContextBuilder 纯核心：角色隔离 / 预算裁剪 / selection 优先级 / 薄快照 / 表格噪声              | S1    |
| S3   | ConversationService + 会话 JSON 持久化（删除/不保存）+ ask 编排（实时快照防串页）+ 主进程冒烟  | S1/S2 |
| S4   | AI 侧栏 UI + preload bridge / IPC 扩展 + 布局 bounds 协调 + UI 端到端冒烟矩阵                  | S3    |
| S5   | 安全审计 + Prompt Injection 验证矩阵 + 真实 Provider 可选验证                                  | S4    |
| S6   | 验收清单逐项核对 + Exit Gate 判定 + 文档同步（契约回填 AGENTS.md §5）                          | S1–S5 |
