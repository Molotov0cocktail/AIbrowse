# AIbrowse 第三阶段 高层设计

> 状态：定稿（随 Third Stage 切换建立，2026-08-14；同日实施前校正：任务编号
> T1–T8 → A1–A8、红队编号 R-01～R-10 → RT-01～RT-11、权限契约收紧为 click 确定性
> 允许列表，见 proposal §11 校正记录）。接口契约定稿由
> `doc/stage3/detailed-design.md`（本阶段唯一契约源）承担；安全契约源
> `doc/stage3/threat-model.md`；实现任务 A1–A8。第一/二阶段契约不变
> （`doc/detailed-design.md` / `doc/stage2/detailed-design.md`）。

## 1. 架构总览

```
┌─ 渲染进程：React UI（浏览器外壳 + AI 侧栏 + Agent 可见性组件）────────────┐
│  依赖方向：UI → BrowserController / ConversationService（仅经 preload     │
│  bridge + IPC 白名单；确认 UI 只展示确定性事实，不经模型文案）             │
└──────────────────────────────┬────────────────────────────────────────┘
                     contextBridge（最小权限 IPC，类型化 channel）
┌──────────────────────────────┴────────────────────────────────────────┐
│ 主进程                                                                  │
│   AI 子系统（第二/三阶段）                                               │
│     ConversationService ──(共读 ask，不变)──► ContextBuilder ──► LLMProvider
│            │                                                              │
│            └──(agent-ask，新增)──► AgentLoop（编排状态机，纯核心可测）     │
│                      │                                                    │
│                      ├─► ToolRegistry（注册表 + schema 校验）              │
│                      │     └─► PermissionPolicy（确定性纯函数）            │
│                      │           ├─ L0/L1 ─► ToolExecutor ──► 工具实现     │
│                      │           ├─ L2 ──► ConfirmManager（用户确认）      │
│                      │           └─ L3 ──► 拒绝                            │
│                      ├─► AgentContextBuilder（纯函数：tools + 不可信块）   │
│                      ├─► LLMProvider（扩展：tools/tool_calls）             │
│                      └─► AuditLog（结构化审计，脱敏）                      │
│   工具实现（只经 BrowserController / SearchProvider）：                    │
│     浏览器只读/导航工具（复用既有接口）                                    │
│     浏览器交互工具 scroll/click/fill/find（A3 扩展 BrowserController，     │
│        固定模板交互脚本 + elementId 文档世代绑定（导航世代计数 + 快照      │
│        meta.documentId 主进程盖章 + 执行前校验，决议 #31）+ 执行时刻       │
│        重新验证 + click 执行器层白名单复核（allowedKind 由                  │
│        classifyClickTarget 单一事实源派生））                              │
│     search.web → SearchProvider（v1 浏览器搜索页 + 快照解析，A4）          │
│  浏览器核心：BrowserController → TabManager / PageReader /                │
│     SessionManager → WebContentsView（远程网页安全默认值全开，不变）      │
└────────────────────────────────────────────────────────────────────────┘
```

- **渲染进程**：AI 侧栏扩展 Agent 模式（任务输入 + 状态栏 + Tool 调用列表 + 确认
  对话框 + 停止按钮）。确认 UI 只展示程序提供的确定性事实（工具名/URL/元素摘要），
  任何文案不经模型或网页。
- **主进程**：AgentLoop 为纯编排核心（零 Electron 依赖，可单测）；工具实现全部
  经 BrowserController 或 SearchProvider；权限判定与审计在 ToolRegistry 层强制
  （工具实现无自行豁免通道）。
- **远程网页**：完全隔离不变（无 preload、无 IPC、无 Node）；交互注入脚本与快照
  脚本同约束（页面世界、固定模板、参数只进 JSON 字面量）。

## 2. 关键技术决策

| 决策点            | 选项                                  | 选择                                                         | 理由                                                                                               |
| ----------------- | ------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| tool calling 落点 | 新增 Provider kind / 扩展现有适配器   | **扩展 OpenAI-compatible 适配器 + FakeProvider 工具脚本**    | tools 参数是 chat/completions 原生能力；零新依赖；FakeProvider 工具脚本保离线确定性（proposal Q1） |
| Agent 编排形态    | 改造共读 ask / 独立编排               | **独立 agent-ask + AgentLoop**                               | 共读是已验收稳定能力，不回归；Agent 循环是新增状态机，共用底层模块（proposal Q2）                  |
| SearchProvider    | 搜索 API（新 Key/依赖）/ 浏览器搜索页 | **浏览器搜索页（Bing）+ 快照解析**                           | 零新依赖零新 Key；复用已验证采集管线；接口隔离保未来替换；容忍设计（proposal Q3）                  |
| click/fill 实现   | 任意注入脚本 / 固定模板               | **固定模板交互脚本（与 snapshot-script 同模式）**            | 无任意 JS 红线；click=原生 el.click()；fill=原生 setter+input/change（React 兼容）（proposal Q4）  |
| 权限判定          | 模型判断 / 确定性纯函数               | **确定性纯函数 permission-policy**                           | 模型只是提议者；同一输入同一决策；网页文本无法影响（threat-model §3.3）（proposal Q5）             |
| 提交类识别        | 模型看快照判断 / 采集脚本结构化标志   | **快照采集扩展 click 语义元数据（isSubmit + ariaExpanded）** | 结构化元数据不经模型，click 允许列表与 L2 升级判定确定性（proposal Q6，2026-08-14 校正）           |
| 防循环            | 仅步数上限 / 签名检测组合             | **签名连续 3 次/累计 5 次 + 无进展 2 步 + 步数 12**          | 三重复合判定，终止理由结构化（proposal Q7）                                                        |
| 审计落点          | 独立数据库 / 日志+会话持久化          | **logger 结构化条目 + 会话 ToolStep 精简持久化**             | 无新存储层；实时可查 + 重启可回溯；fill 值不持久化（proposal Q10）                                 |
| Agent system 提示 | 复用共读 SYSTEM_PROMPT / 独立常量     | **独立 AGENT_SYSTEM_PROMPT 编译期常量**                      | Agent 模式安全规则不同（工具使用边界）；共读提示不变（proposal Q14）                               |
| 工具错误传播      | 异常穿透 / 结构化 ToolResult 错误     | **结构化 ToolResult（ok=false + 错误码）回注历史**           | 模型能区分「执行失败」与「结果为空」；Third_stage.md §8「工具错误不会被模型误认为成功」            |

## 3. 模块职责

- **AgentLoop（main/ai/agent/，A5，纯核心零 Electron 依赖）**：单 run 状态机
  （idle → running → waiting-confirm → done/aborted/error/cancelled/loop-detected/
  no-progress/step-limit/timeout）；单步编排 = 构建上下文 → Provider 流（累积
  tool_calls）→ 逐工具校验/权限判定/确认 → 执行 → ToolResult 回注 → 循环；
  上限/超时/取消/防循环；审计与可见性事件出口。
- **ToolRegistry（main/ai/tools/，A2）**：ToolDefinition（name/description/
  JSON-Schema 子集/风险级别/executor）注册表；`listTools()` 序列化为模型可见
  tools 列表（程序生成）；`validateToolArgs` 确定性校验；未知工具 → tool-not-found。
- **PermissionPolicy（main/ai/permission/，A2，纯函数）**：`decide(toolName,
args, elementSemantics?) → {level, reason}`；L0/L1/L2/L3 矩阵为编译期常量；
  click 确定性允许列表（链接/展开/切换 → L1）、提交类升级（isSubmit → L2）、
  非允许列表目标 fail-closed（→ L3）、密码字段禁止为确定性规则（threat-model §3.3）。
- **ConfirmManager（A2）**：pending 确认登记/approve/deny/取消作废；等待计入
  Agent 总超时；无自动批准。
- **AuditLog（A2）**：结构化审计条目（时间/requestId/toolCallId/工具/参数摘要/
  决策/结果/耗时/错误码）；fill 值只记长度与目标类型；沿用 logger 脱敏。
- **工具实现（A2–A4）**：首批工具分三批接线——
  A2 只读/导航（get_tabs/get_active_tab/read/open/navigate/back/forward/reload，
  全部复用既有 BrowserController 接口，零新浏览器能力）；
  A3 交互（scroll/click/fill/find + BrowserController 扩展 + elementId 生命周期 +
  click 执行器层白名单复核）；
  A4 search.web（SearchProvider）。
- **SearchProvider（main/ai/search/，A4）**：接口隔离；v1 实现经 BrowserController
  临时 Tab（本次调用精确 tabId 独占所有权，任何路径 finally 清理——决议 #32）→
  Bing 搜索页 → ready 等待（15s 可注入）→ 实时快照 → 确定性解析 → 统一结果结构 →
  关闭 Tab；解析失败/结构变化 → 降级（错误诚实映射：结构无法识别/L2/L3/超时 →
  search-failed，合法空结果 → ok 空数组 + 提示）；v1 snippet 恒空串（扁平快照无
  可靠关联证据，宁缺勿错）。
- **AgentContextBuilder（A5，纯函数）**：复用 ContextBuilder 角色隔离机制；
  tools 序列化透传；历史含 tool 消息（role='tool'，tool_call_id 关联）；
  ToolResult 进 `UNTRUSTED_TOOL_RESULT` 标记块；AGENT_SYSTEM_PROMPT 常量。
- **ConversationService 扩展（A5）**：agent-ask 编排入口（校验/单在途互斥/
  run 生命周期接线）；ToolStep 消息持久化（精简，不含 fill 值）。
- **渲染层（A6）**：Agent 模式输入、AgentStatusBar、ToolCallList、ConfirmDialog、
  停止按钮；消息流渲染 ToolStep 紧凑条目。

## 4. 数据流（Agent run 关键路径）

```
用户提交任务：
1. AI 面板 → bridge conversation.agent-ask {sessionId, goal} → IPC（sender 校验）
2. ConversationService：会话/在途校验（共读与 Agent 在途互斥）→ goal 长度上限
3. AgentLoop 启动：run 状态 idle → running
4. 每步：
   a. AgentContextBuilder.build({goal, snapshot?, history(含 tool 轮), tools,
      system=AGENT_SYSTEM_PROMPT}) → ProviderRequest（含 tools）
      —— 实时快照按需采集（与共读同管线；Agent 模式首轮携带当前页，后续按
         read 工具结果为准）
   b. provider.stream → 累积文本增量 + tool_calls（增量索引关联）
   c. 无工具调用且有文本 → 该轮为最终回答 → 流式转发 → done
   d. 有工具调用 → 逐条（**决议 #33 校准：防循环与步数上限在执行管线前判定**——
      触发次零副作用；阻断调用计步 + 恰好一条审计（decision=invalid）+ 一个
      ToolStep；同轮调用数超过剩余步数 → 只执行预算内，未执行零伪造）：
      ToolRegistry.validateToolArgs → 失败 → ToolResult(invalid-args) 回注
      PermissionPolicy.decide → L3 → ToolResult(forbidden)；L2 → ConfirmManager
      （pending + agent:confirm-request 事件 → 等待用户 approve/deny，计入总超时；
        deny → denied-by-user 回注）
      执行 → ToolExecutor → 结构化 ToolResult（≤4000 字符截断）→ 审计条目
      → ToolStep 持久化 → agent:step 事件（含审计同源 argsSummary 脱敏摘要，
        决议 #34——UI 可见性，不扩大持久化）→ 回注历史
   e. 步数/超时/防循环检查 → 继续或终止（结构化理由）
   —— **A6 实时可见性**（决议 #34）：每步执行前 agent:status 事件
      （starting/thinking/executing（含当前工具名与 stepsUsed/maxSteps）/
      waiting-confirm/confirm-resolved（含 approve/deny/cancelled outcome）/
      finalizing——全部为确定性运行事实，不含思维过程）；ConfirmManager 多监听者
      Set 分发（多 Service 共享状态机互不覆盖，dispose 退订）
5. 终态：done（最终回答全文）/ cancelled / aborted / 终止理由 → turn-done 事件
   → 持久化 assistant 消息（含 run 摘要）
   —— **决议 #33 校准**：终态单一所有权（done/abort/超时/取消先到先得，恰好一次
   事件与持久化；终态后零工具执行、迟到事件被忽略）；终态映射 done→complete、
   cancelled→aborted、timeout→error(timeout)、step-limit/loop-detected/no-progress
   →error（权威终止理由在 AgentRunSummary.status）；持久化历史按完整交互组校验
   （assistant 轮次 toolCalls 脱敏持久化 + 孤立/不完整组过滤；共读重放过滤工具轮；
   finalText = 最后一个模型轮的文本，每轮文本恰好落盘一次）
```

- 页面变化后的状态刷新：Agent 不信任任何缓存快照——read 工具每次调用实时采集
  （与共读防串页同一纪律）；导航/点击后模型重新 read 才能看到新页面状态。
- 取消：abort(requestId) → 模型流 abort + 在途确认作废 → run 以 cancelled 终态结束。

## 5. 安全模型（概要，契约源 doc/stage3/threat-model.md）

- **决策链**：模型提议（ToolCall）→ 程序校验（schema/参数）→ 程序分级（纯函数）
  → 分级处置（auto / 显著展示 / 用户确认 / 禁止）→ 全量审计。模型无任何通道
  改变工具列表、权限矩阵、system 提示。
- **不可信输入**：网页内容（UNTRUSTED_WEB_CONTENT 块）与 Tool Result
  （UNTRUSTED_TOOL_RESULT 块）同等视为不可信；闭合转义机制沿用。
- **能力边界**：工具白名单封闭；无万能工具（grep 断言）；交互注入脚本固定模板、
  参数白名单；URL 仅 http/https；fill 禁止 password/file；**click 确定性允许列表**
  （L1 仅链接/展开/切换类目标；提交类 → L2；非允许列表目标 fail-closed → L3）；
  **L3 动作在权限层与执行器层双重封死，无执行通道**（click 模板 allowedKind
  复核，权限层判 L1/L2 后页面动态变化同样被拒）。
- **Electron 安全边界不变**：远程网页隔离/无 preload/权限默认拒绝/window.open
  deny/UI 导航保护全部保持；本阶段不注册自定义协议、不放宽任何权限。
- **Key 零暴露不变**：Agent 上下文/审计/日志全部受 logger sanitize 与
  「Key 不进 prompt」约束（工具与审计层不接触凭据）。

## 6. 存储

- 会话持久化扩展（userData/conversations，既有位置）：消息文件增 ToolStep 消息
  （tool 名/结果摘要/时间/错误码——**不含 fill 输入值、不含快照正文**）；
  version 升 2（向后兼容读取 v1，写入恒 v2，A5 定稿迁移规则）。
- 审计：主进程日志（log/，既有轮转与脱敏）；不新增数据库/独立审计文件。
- SearchProvider：无持久化（结果即用即弃，不落盘）。

## 7. 测试策略

- **单测（Vitest，node 环境，纯逻辑）**：tool-calling SSE 解析（tool_calls 增量/
  同帧多工具/arguments 分片）、tool-registry schema 校验矩阵、permission-policy
  决策矩阵（含提交类升级/密码禁止/URL scheme）、confirm-manager 状态机、
  agent-loop 状态机（FakeProvider 工具脚本：正常多步/步数上限/超时/取消/防循环
  三触发/确认 approve/deny 两路/工具错误回注）、agent-safety 防循环纯函数、
  search-provider 解析纯函数、交互脚本参数模板校验、审计条目脱敏断言。
- **集成/冒烟（Electron 真实启动，FakeProvider 工具脚本，离线确定性）**：
  受控本地页面 Agent 多步任务（open → read → find → scroll → click → fill →
  结果断言）；click 允许列表与执行器复核（允许目标执行/提交类确认/非允许目标
  无 DOM 动作）；确认流（提交类 click → 确认对话框 → approve/deny）；取消/步数
  上限/防循环触发；审计日志断言；敌对页红队矩阵 RT-01～RT-09（RT-10 需真实 Key）。
  矩阵清单见 detailed-design §13。
- **真实 Provider 可选验证（A7，需用户提供 Key，询问边界）**：真实 tool calling
  多步任务 + Third_stage.md §7 六个关键真实场景；沿用第二阶段凭据流程与真 Key
  零暴露扫描；无 Key 跳过并记录，不阻塞验收。
- **静态检查**：typecheck / ESLint / Prettier（规则不变）+ 红线 grep 断言
  （无 shell/eval/任意 JS/文件系统/HTTP POST/任意 IPC/SQL）。

## 8. 风险与不确定性

| 风险                                              | 影响                   | 缓解                                                                                                  |
| ------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 网页文本诱导模型提议「合法但恶意」的工具调用      | 导航到钓鱼页等         | 权限分级 + click 允许列表 + L2 确认 + 全量审计 + 威胁模型 RT-02；语义层残余风险如实登记（不承诺免疫） |
| 确认疲劳                                          | 用户误批准高危动作     | 确认 UI 确定性事实 + deny 默认高亮 + 步数上限；残余风险登记                                           |
| 搜索页结构变化导致解析失败                        | search.web 返回空/降级 | 容忍设计：空结果 + warnings + 结构化错误；接口隔离保替换 API 供应商                                   |
| 交互注入在动态框架页面失效（虚拟 DOM/Shadow DOM） | click/fill 成功率受限  | 原生事件派发（最接近用户语义）；失败 → not-interactable 安全返回；真实网站冒烟验证                    |
| 模型多轮循环消耗预算/时间                         | 任务失败               | 步数 12 + 总超时 420s + 防循环三触发 + 结构化终止理由                                                 |
| Provider 对 tools 的支持差异                      | 部分兼容端点无工具能力 | supportsToolCalling 元数据（A1 校准为真实值）；FakeProvider 离线保底                                  |
| 审计日志体积增长                                  | 日志膨胀               | 既有按日轮转 + 参数摘要截断；不新增持久化层                                                           |
