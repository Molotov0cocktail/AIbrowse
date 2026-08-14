# AIbrowse 第三阶段 Proposal — Browser Agent 与受限工具系统

> 需求源：根目录 `Third_stage.md`（阶段总任务）。本文档把总任务收敛为可验收的阶段提案。
> 前置：Second Stage Exit Gate 判定通过（2026-08-13）+ 用户独立复验（2026-08-14）发现项
> 已修复并全量回归 + 用户下达阶段切换指令（2026-08-14）。
> 里程碑 A1–A8 由本提案配套的 `doc/stage3/tasks/A1–A8` 任务文档单独管理。
> （2026-08-14 实施前校正：任务编号由 T1–T8 改为 A1–A8，避免与第一阶段任务 T1–T5
> 重名；红队编号由 R-01～R-10 改为 RT-01～RT-11；权限契约收紧——见 §11 校正记录。）
> 与既有文档的关系：`doc/stage2/` 为第二阶段定稿（不改写、不覆盖）；第一阶段历史文档
> 原位保留；本阶段契约源为 `doc/stage3/detailed-design.md`，安全契约源为
> `doc/stage3/threat-model.md`。

## 1. 目标

从 **AI 能读当前网页**（第二阶段）升级为 **AI 能安全地搜索、打开、阅读和操作网页**：

- **tool-calling 兼容层**：扩展 LLMProvider/ProviderRequest/SSE 解析，模型可提议工具
  调用（A1，硬前置）；
- **Tool Registry**：统一注册表 + 首批低风险 Browser/Search 工具（schema 校验、
  参数约束、错误归一化）；
- **SearchProvider**：独立搜索抽象（v1 浏览器搜索页实现），返回统一结构，
  可保留标题/URL/摘要/来源，允许以后替换供应商；
- **浏览器交互能力**：scroll / click / fill / find（elementId 生命周期、执行时刻
  重新验证、click 语义元数据（允许列表/提交类）、安全失败）；
- **Agent Runtime**：最小可控 Agent Loop（最大步数 12 / 总超时 420s / 取消 /
  防循环 / 每步审计 / 页面变化后状态刷新）；
- **确定性权限与确认状态机**：L0 自动 / L1 自动显著展示（click 仅确定性允许列表
  ——导航/展开/切换）/ L2 用户确认（提交类）/ L3 禁止（含 click 非允许列表目标
  fail-closed），权限判定为纯函数（模型只是提议者），确认 UI 只展示确定性事实；
  L3 敏感动作（购买/发送/删除/发布）在权限层与执行器层双重封死，无执行通道；
- **操作可见性**：Agent 状态 / 正在访问的网页 / 最近 Tool 调用 / 待确认动作 / 停止按钮；
- **威胁模型重建**（已定稿，`doc/stage3/threat-model.md`）：先于任何 Browser Tool 实现；
- **验证闭环**：纯逻辑单测 + FakeProvider 离线 Agent 冒烟矩阵 + 真实网站 Agent
  冒烟（真实 Provider 可选门控，沿用第二阶段凭据流程）。

核心原则（Third_stage.md §1）：**AI 决定「需要做什么」；确定性程序决定「是否允许、
如何执行、执行结果是什么」**。AI 不得直接获得 Electron API、webContents、Node.js、
shell 或任意 JavaScript 执行权限。

## 2. 非目标（本阶段明确不做）

- 长期信源数据库、AI 自动添加收藏、多源 Research 报告、图表/复杂结果渲染（Fourth/Fifth Stage）；
- RSS、Watch、定时任务（Sixth Stage）；
- 自动支付/购买/发布、浏览器扩展生态（红线：L3 动作本阶段无对应工具）；
- 多 Agent 编排、Agent 记忆系统、向量数据库；
- 万能工具：shell.exec / eval / 任意 JavaScript / 任意文件系统读写 / 任意 HTTP POST /
  任意 Electron IPC / 任意数据库 SQL（**永久红线**，本阶段及以后均禁止）；
- 放宽任何既有 Electron 安全边界（远程网页隔离、Tab 无 preload、权限默认拒绝、
  window.open deny 均不变）；
- 真实 Provider 验证仅在用户提供 Key 时进行（询问边界），无 Key 全部走 FakeProvider 离线。

## 3. 用户与场景（Third_stage.md §7 关键真实场景）

1. 「搜索 Electron WebContentsView 官方文档，并打开最相关结果。」→ search.web →
   browser.open；
2. 「在当前网页里找到 security 部分。」→ browser.read → browser.find → browser.scroll；
3. 「打开搜索结果中的两个页面并总结差异。」→ 两次 browser.open + 两次 read + 总结；
4. 「在一个普通筛选框里输入关键词并读取更新后的结果。」→ browser.fill → browser.read；
5. 遇到需要提交/发送的动作时停止并请求确认 → click 提交类元素 → L2 确认门；
   非提交类按钮（无法排除购买/删除/发布等副作用）fail-closed 禁止——宁禁勿放，
   分类细化属 Third_stage.md §3.5「本阶段内调整」范围；
6. 恶意网页中出现 Tool 指令时不执行网页指令 → 威胁模型 RT-01/RT-03/RT-11（红队矩阵）。

## 4. 输入 / 输出

- 输入：用户任务目标文本（长度上限复用既有 question 16000 字符截断）；任务启动时
  实时 PageSnapshot（既有采集管线）；Provider 配置与 API Key（既有，主进程内）；
  会话历史（含新增 ToolStep 消息）。
- 输出：Agent 最终回答（流式 delta + turn-done，复用既有事件形态）；
  每步 ToolCall/ToolResult（agent:step 事件 + 会话内 ToolStep 持久化精简版）；
  待确认动作（agent:confirm-request 事件）；审计日志条目；
  归一化错误（错误码集合扩展：invalid-args / tool-not-found / element-not-found /
  stale-element / not-interactable / denied-by-user / forbidden / loop-detected /
  no-progress / step-limit / confirm-timeout）。

## 5. 外部依赖

- 现有技术基线（AGENTS.md §1，第三阶段内同样冻结，升级走 §3 流程）。
- **不新增任何 npm 依赖**：tool calling 用 OpenAI-compatible 原生 tools 参数
  （现有自实现 fetch+SSE 扩展）；搜索用浏览器页面 + 既有快照管线。
- 真实 Provider 验证可选（沿用第二阶段凭据流程：仓库外 DPAPI + 环境变量注入 +
  真 Key 零暴露扫描；不设固定调用次数，每次对应明确验收项）。

## 6. 约束与假设

- **架构纪律**（在第二阶段依赖方向基础上扩展）：
  `UI(AI 面板) → ConversationService(agent 模式) → AgentLoop → ToolRegistry →
PermissionPolicy / ToolExecutor → BrowserController / SearchProvider`；
  `AgentLoop → ContextBuilder(扩展) / LLMProvider(扩展) → SecureCredentialStore`。
  禁止：ToolExecutor 绕过 BrowserController 直连 webContents；AgentLoop 接触 API Key；
  工具实现访问 Electron 主进程 API 之外的能力。
- **安全红线**（全部保持 + 本阶段新增）：第二阶段七项结构性边界保持；
  `doc/stage3/threat-model.md` 为安全契约源；权限判定确定性（纯函数）；
  审计全量脱敏；交互注入脚本与快照脚本同等页面世界约束。
- **Prompt Injection 验收 = 结构性边界机器断言**（不做语义免疫承诺）：威胁模型
  §4 红队矩阵 RT-01～RT-11 + §5 诚实边界声明（残余风险四类如实登记）。
- **TypeScript / 质量门槛 / 提交纪律**：与第一/二阶段相同（AGENTS.md §3）。
- **假设**：单窗口；单 Agent run 在途（每会话单在途扩展为「共读在途与 Agent 在途互斥」）；
  快照为点时刻尽力采样；确认等待计入 Agent 总超时且无自动批准。

## 7. 待定问题（本会话已拍板，决议见 doc/stage3/detailed-design.md §15）

| #   | 问题                                                                | 拍板（2026-08-14）                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | tool-calling 落点：新增 Provider kind vs 扩展现有 OpenAI-compatible | **扩展现有适配器**（tools 参数为 chat/completions 原生能力）+ FakeProvider 增工具脚本；不新增 kind                                                                                              |
| Q2  | Agent 与共读的关系：改造 ask vs 独立编排                            | **独立 agent-ask 通道 + AgentLoop 编排**；共读 ask 契约不变（已验收能力不回归）；共用 ContextBuilder/Provider/持久化                                                                            |
| Q3  | SearchProvider v1：搜索 API vs 浏览器搜索页                         | **浏览器搜索页（Bing）+ 快照解析**（零新依赖/零新 Key；容忍设计；接口隔离保未来替换）                                                                                                           |
| Q4  | click/fill 实现方式：注入任意脚本 vs 固定模板                       | **固定模板交互脚本**（与 snapshot-script 同模式）：click=原生 el.click()；fill=原生 value setter+input/change；参数只进 JSON 字面量                                                             |
| Q5  | 权限判定位置：模型判断 vs 确定性纯函数                              | **确定性纯函数**（工具名+参数+元素语义元数据 → 级别）；click 分级依据采集脚本结构化元数据（href/aria-expanded/input type/isSubmit）构成的确定性允许列表，不经模型                               |
| Q6  | click 语义元数据识别来源                                            | **扩展快照采集**：buttons 条目增 isSubmit + ariaExpanded 标志（最小契约扩展，normalize 同步；inputs 条目 type 已有）；password/file 字段 fill → L3 拒绝；非允许列表 click 目标 → L3 fail-closed |
| Q7  | 防循环机制                                                          | 签名=工具名+规范化参数 JSON；连续 3 次同签名 / 累计 5 次 / 连续 2 步无工具无文本增量 → 终止 + 结构化理由                                                                                        |
| Q8  | 最大步数 / 超时                                                     | MAX_STEPS=12；总超时 420s（含确认等待）；单模型轮沿用 Provider 连接 15s/空闲 60s                                                                                                                |
| Q9  | ToolResult 长度                                                     | ≤ 4000 字符确定性截断 + 标记；错误走结构化错误码（无响应体）                                                                                                                                    |
| Q10 | 审计落点                                                            | 主进程 logger 结构化条目（实时）+ 会话 ToolStep 精简持久化（**不含 fill 输入值**）；无新存储层                                                                                                  |
| Q11 | 搜索临时 Tab 策略                                                   | SearchProvider 经 BrowserController 新建可见 Tab → ready → 快照解析 → 关闭（操作可见性）；Agent 的 browser.open 结果 Tab 保留                                                                   |
| Q12 | 取消语义                                                            | 复用 requestId abort；取消 → 中止模型流 + 在途确认全部作废 + run 以 cancelled 终态结束                                                                                                          |
| Q13 | fill 值隐私                                                         | fill 值不持久化、审计只记长度与目标类型；fill 目标禁止 password/file（L3）                                                                                                                      |
| Q14 | Agent 系统提示                                                      | 独立 `AGENT_SYSTEM_PROMPT` 编译期常量（Agent 模式专用安全规则）；共读 SYSTEM_PROMPT 保持不变                                                                                                    |
| Q15 | 模型多轮对话中请求工具 / 纯文本的终态判定                           | 无工具调用且产出文本增量 → 该轮为最终回答；有工具调用 → 执行后继续（步数内）；两者皆无 → no-progress 终止                                                                                       |

## 8. Entry Gate 核验记录（2026-08-14，本会话独立核验）

按 Third_stage.md §2 五项逐项核验（证据：Git HEAD `9605269` = Gitee/GitHub 双远程
HEAD、工作区干净、全量验证独立复跑全绿）：

1. **Second Stage 当前网页共读稳定** ✅：本会话独立复跑——test 326/326、typecheck、
   lint、format:check 全绿；Electron 离线冒烟退出码 0（T2–T5 + S3 矩阵 1–8 +
   S4 UI 矩阵 1–12 全通过）；Second_stage.md §9 16 项逐项勾选 + §10 Exit Gate
   判定通过（含真实 Provider 多网站验证）；用户独立复验发现的 4 项非阻塞缺陷已修复
   并全量回归（红态退出码 1 → 绿态 0，progress.md 修复闭环）。
2. **LLM Provider 抽象支持 tool calling，或已有可靠的兼容层** ⚠️ **循环式门槛，
   经判断理由记录后校正通过（见下）**。
3. **ContextBuilder 已将网页内容视为不可信** ✅：UNTRUSTED_WEB_CONTENT 块 +
   闭合转义 + 常量 system（S2 30 用例 + 冒烟矩阵 11 注入夹具 5 断言 + S5 审计）。
4. **BrowserController 第一阶段接口已证明可扩展** ✅：ConversationService 以最小
   SnapshotSource 接口消费 BrowserControllerImpl 即扩展实证（第二阶段 S3 全量验证）；
   接口 12 方法全部实现并有测试；本阶段 Tool 层同样只经它操作浏览器。
5. **API Key 与日志安全无阻塞问题** ✅：S5 审计 + S6 复验 + 真 Key 零暴露扫描
   （装配期窗口扩大修复后回归）；progress.md 阻塞项「无」。

### 第 2 项循环式门槛判定记录（如实）

**现状事实（代码级，不粉饰）**：`ProviderMetadata.supportsToolCalling: false`
（shared/types/conversation.ts:103，注释「reserved for Third Stage」）；
`ProviderRequest` 无 tools 字段；`LLMProvider.stream` 仅产出 delta/done/error；
SSE 解析仅处理 `delta.content`——**当前代码不具备 tool calling**。

**判定：属可合理校正的循环式门槛，不构成禁止切换的代码级前置阻塞。理由**：

- 字面要求「已支持 tool calling」与本阶段目标（第三阶段自身包含 tool-calling
  兼容层的设计与实现）构成循环——该能力无法在进入阶段前满足，否则阶段无内容可做；
- 门禁的保护性意图是「Provider 抽象不得锁死在无法扩展工具调用的形态」——该意图
  已由现有扩展点满足：`supportsToolCalling` 元数据字段已预留（Second_stage.md §3.2
  明确要求）、工厂注册表 + kind 机制、自实现 fetch+SSE 适配器（OpenAI-compatible
  端点原生支持 tools 参数，扩展路径明确且零新依赖）、`LLMProvider` 接口未绑定任何
  厂商 SDK；
- **校正方式（保留门禁意图的约束力）**：A1「tool-calling 兼容层」为第三阶段
  **第一个实现任务与硬前置**——在 A1 落地并通过验证（单测 + FakeProvider 工具脚本
  - 冒烟回归）**之前，禁止引入任何 Browser Tool 实现**（A2–A4 依次依赖）。
    即「可靠的兼容层」在工具存在之前就位，与门禁的保护顺序一致。
- 该判定记录于本文、AGENTS.md §1 与 progress.md，供后续会话审计。

## 9. 验收标准映射（Third_stage.md §9 → 本阶段测试落点）

完整清单见 Third_stage.md §9；映射见 `doc/stage3/detailed-design.md` §13 测试规格
与 §14 验收核对清单（A8 实施）：

- **Agent**：多步任务完成（离线矩阵 + 真实网站场景 1/3/4）→ A5/A6 冒烟；最大步骤/
  超时/取消 → A5 单测+冒烟；全程可审计 → A2/A5；失败安全停止 → 防循环 A5。
- **Browser Tools**：核心工具稳定 → A3；elementId 生命周期 → A3 单测+冒烟；
  刷新后不误操作旧元素 → A3 冒烟 + 威胁模型 RT-06。
- **Search**：统一 SearchProvider → A4；结果可交 Agent 打开读取 → A4/A5 冒烟。
- **Permission**：高风险动作无法无确认执行 → A2 单测 + 威胁模型 RT-03/RT-05；
  click 非允许列表目标无任何执行通道 → A2/A3 + 威胁模型 RT-11；
  网页文本无法提升权限 → RT-01/RT-09；无万能工具 → grep 断言（各任务红线）。
- **Engineering**：全量验证通过 → 每个任务；真实网站 Agent smoke → A7（需 Key，
  可选门控）；Agent 日志无敏感信息 → A2 审计脱敏 + A7 扫描。

## 10. 里程碑划分（每任务 = 一个可验证开发闭环，任务文档见 doc/stage3/tasks/）

| 任务 | 内容                                                                                                                        | 依赖  |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| A1   | **tool-calling 兼容层（硬前置）**：ProviderRequest/Event/Message 扩展 + 适配器 tools/SSE tool_calls + FakeProvider 工具脚本 | 无    |
| A2   | Tool Registry + 权限分级与确认状态机 + 审计日志（接线既有只读/导航工具）                                                    | A1    |
| A3   | 浏览器交互能力：scroll/click/fill/find + click 语义元数据 + elementId 生命周期验证                                          | A2    |
| A4   | SearchProvider（浏览器搜索页实现 + 统一结果结构 + 降级）+ search.web 工具                                                   | A2    |
| A5   | Agent Runtime：Loop 状态机 / 最大步数 / 超时 / 取消 / 防循环 / Agent 上下文与历史 / 持久化扩展 + 主进程冒烟                 | A1–A4 |
| A6   | 操作可见性 UI + IPC/bridge 扩展 + 确认流 UI + UI 端到端冒烟矩阵                                                             | A5    |
| A7   | 威胁模型红队矩阵 RT-01～RT-11 + 安全审计 + 真实 Provider 可选验证                                                           | A6    |
| A8   | 验收清单逐项核对 + Exit Gate 判定 + 文档同步（契约回填 AGENTS.md §5）                                                       | A1–A7 |

**红线（每个任务文档重申）**：A1 完成前禁止引入任何 Browser Tool 实现；本阶段严禁
新增 shell/eval/任意 JS/任意文件系统/任意 HTTP POST/任意 Electron IPC/任意 SQL
万能工具；不得放宽第一阶段 Electron 安全边界与第二阶段 Key 零暴露红线；威胁模型
（doc/stage3/threat-model.md）先于 A3 交互能力定稿（已满足）。

## 11. 实施前校正记录（2026-08-14，纯文档校正，先于 A1 实现）

三项校正均不影响 Third_stage.md 需求与关键真实场景（§7 六场景逐条复核通过，见下）：

1. **任务编号 T1–T8 → A1–A8**：与第一阶段历史任务 T1–T5（progress.md 任务表已关闭
   条目，编号不可改）重名，交叉引用易歧义——第三阶段任务统一改 A 编号并重命名
   任务文档（`doc/stage3/tasks/A1–A8`），全部交叉引用同步；第一、第二阶段历史任务
   编号（T0–T5 / S1–S6）一律不变。
2. **红队编号 R-01～R-10 → RT-01～RT-10（并新增 RT-11）**：与 progress.md 风险台账
   编号 R-01/R-02（按登记顺序分配、不得复用）冲突——红队矩阵改 RT 编号，全仓库
   无残留歧义；新增 RT-11「通用 click 越权」覆盖收紧后的 click 契约。
3. **权限契约收紧（click 确定性允许列表，详见 detailed-design §7.1/决议 #29 与
   threat-model §3.3）**：通用 click 可间接触发购买/发送/删除/发布等远程写——不能
   以「没有专用支付工具」证明 L3 不可达，也不能只靠 isSubmit 判断副作用。收紧为：
   - L1 仅允许语义元数据可证明的低风险目标（链接 http/https / aria-expanded 展开
     控件 / checkbox・radio 切换）；
   - 提交类（isSubmit）→ L2 确认；**非允许列表目标（普通按钮/语义不明）→ L3
     fail-closed 禁止**——无法排除 L3 敏感行为时不执行，即使用户确认也不执行；
   - 执行器层不可达：click 注入模板按 allowedKind（权限决策派生，模型不可见）
     复核 DOM 实时属性，权限层判 L1/L2 后页面动态变化同样被拒——L3 动作在权限层
     与执行器层双重封死。
4. **Third_stage.md 真实场景复核（结论：不破坏）**：场景 1/2/3 走 search/open/read/
   find/scroll（L0–L1 不变）；场景 4 走 fill（筛选字段 L1）→ read，页面若以提交类
   按钮触发筛选则走 L2 确认门；场景 5 提交/发送 → isSubmit 提交类 → L2 确认门
   （非提交类「发送」按钮因无法与「购买/删除/发布」确定性区分而 fail-closed——
   宁禁勿放，分类细化属 Third_stage.md §3.5「进入本阶段后以测试和产品体验调整」
   授权范围）；场景 6 红队矩阵 RT-01/RT-03/RT-11 覆盖。威胁模型 §5 残余风险由
   三类更新为四类（新增「click 允许列表目标的页内 JS 副作用」，如实登记）。
