# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。
> ⚠️ 风险编号 R-XX 按登记顺序分配，**不得重排、不得复用**（已关闭项保留编号与结论直至自然归档）。
> 「风险与限制」只登记当前仍需关注的事项；历史细节由 Git 提交与任务文档保存，不在此重复叙述。

## 当前状态

- 阶段：**第三阶段（Browser Agent）**，已于 2026-08-14 正式切换（用户指令）。Entry
  Gate 逐项核验通过（判定证据见 doc/stage3/proposal.md §8）；**设计定稿与任务拆分
  已完成（2026-08-14，纯文档）**——`doc/stage3/`：threat-model（Prompt Injection
  威胁模型重建定稿，先于任何 Browser Tool 实现）、proposal（Q1–Q15 拍板 + Entry
  Gate 核验记录）、high-level-design、detailed-design（唯一契约源，§2–§16）+
  任务 A1–A8（每任务 = 一个可验证闭环；**2026-08-14 实施前校正**：编号由 T1–T8
  改为 A1–A8 避免与第一阶段任务 T1–T5 重名，红队编号改 RT-01～RT-11，权限契约
  收紧为 click 确定性允许列表 + fail-closed——见 proposal §11 校正记录）。
  **A1 tool-calling 兼容层已完成（2026-08-14，硬前置解除）**：ProviderRequest/
  Event/Message 类型扩展、适配器 tools/SSE tool_calls 聚合解析（契约校准决议 #30）、
  FakeProvider 工具脚本、ContextBuilder tools 透传——全量验证通过（见下）。
  **A2 Tool Registry + 权限分级与确认状态机 + 审计日志已完成（2026-08-14）**：
  注册表确定性校验 + 13 工具权限矩阵纯函数（click 确定性允许列表 + fail-closed）+
  ConfirmManager + 审计脱敏 + ToolExecutor 管线 + **首批 8 个只读/导航工具接线
  BrowserController**（get_tabs/get_active_tab/read/open/navigate/back/forward/
  reload；交互工具/搜索/AgentLoop 未实现）；下一个推荐任务 = **A3 交互能力**。
  **A3 浏览器交互能力已完成（2026-08-14）**：interaction-script 固定模板 +
  BrowserController 扩展（clickElement/fillElement/scrollTab + elementId 文档
  世代绑定，决议 #31）+ 快照 isSubmit/ariaExpanded 语义元数据 +
  find/scroll/click/fill 四工具经既有 ToolExecutor 链路接线（allowedKind 由
  classifyClickTarget 单一事实源派生）+ 冒烟 A-12 与 elementId 生命周期真实 DOM
  探针（dev + 生产双场景）；SearchProvider（A4）/AgentLoop（A5）未实现；
  下一个推荐任务 = **A4 SearchProvider**。
- 前置状态：第一阶段 Exit Gate 通过（2026-08-13，First_stage.md §十四）；
  Second Stage Exit Gate 通过（2026-08-13 判定 + 2026-08-14 用户独立复验，4 项
  非阻塞缺陷已修复并全量回归，红态退出码 1 → 绿态 0；证据见 Second_stage.md
  §9/§10 与本文「最近验证结果」）。
- 路线图文档已接入（2026-08-13）：ROADMAP.md + First_stage.md～Seventh_stage.md 入库；
  各文件职责、接管顺序与阶段切换纪律见 AGENTS.md §1/§2。
- 最近 commit 与工作区状态：以 `git log --oneline` / `git status --short` 为准。
- 技术基线：2026-08-13 验证冻结（AGENTS.md §1）；依赖精确版本固定（package.json 无 ^/~）。

## 任务表

| 任务 | 内容                                                                                             | 状态 | 备注                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | 项目基线（git/文档链/脚手架/测试基建/最小应用）                                                  | ✅   | 2026-08-13 完成，见 tasks/baseline.md                                                                                                                               |
| T1   | 详细设计定稿：接口契约/错误处理/preload 清单/Tab 状态机/采集算法 + proposal Q1–Q4 拍板           | ✅   | 2026-08-13 完成，定稿见 doc/detailed-design.md（§12 决议记录）                                                                                                      |
| T2   | 浏览器核心：BrowserController + TabManager + WebContentsView + SessionManager（多 Tab 可开网页） | ✅   | 2026-08-13 完成，签名已回填 AGENTS.md §5 并与代码 grep 核对                                                                                                         |
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ✅   | 2026-08-13 完成，R-01 同闭环关闭（见下）                                                                                                                            |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ✅   | 2026-08-13 完成（含 T3 导航保护收紧，见下）                                                                                                                         |
| T5   | 收尾：安全审计（§11 逐项 + R-02 关闭 + elementId 敌对页审查）+ 验收清单逐项核对 + 文档同步       | ✅   | 2026-08-13 完成（4 个逻辑 commit，见下）                                                                                                                            |
| S1   | Provider 抽象 + SecureCredentialStore + 配置存取 + 错误归一化（FakeProvider 闭环，无 UI）        | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S1-provider-credential.md                                                                                        |
| S2   | ContextBuilder 纯核心：角色隔离/预算裁剪/selection 优先级/薄快照/表格噪声                        | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S2-context-builder.md                                                                                            |
| S3   | ConversationService + 会话 JSON 持久化 + ask 编排（实时快照防串页）+ 主进程冒烟                  | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S3-conversation-service.md                                                                                       |
| S4   | AI 侧栏 UI + IPC/bridge 扩展 + 布局 bounds 协调 + UI 端到端冒烟矩阵                              | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S4-ai-panel-ui.md                                                                                                |
| S5   | 安全审计 + Prompt Injection 验证矩阵 + 真实 Provider 可选验证                                    | ✅   | 2026-08-13 完成（§12.1/§14 逐项审计通过、矩阵 11 注入夹具增强、真实 Provider 冒烟 2 次调用全通过，见下）；任务文档 doc/stage2/tasks/S5-security-prompt-injection.md |
| S6   | 第二阶段收尾：验收清单核对 + Exit Gate 判定 + 文档同步（契约回填 AGENTS.md §5）                  | ✅   | 2026-08-13 完成（§9 逐项证据 + §10 Exit Gate 通过 + 真实 Provider 多网站验证，见下）；任务文档 doc/stage2/tasks/S6-finalize-acceptance.md                           |
| 修复 | 独立复验发现项修复闭环（Tab 状态自清理 / 表格内容依赖证据 / Key 扫描窗口 / README 状态）         | ✅   | 2026-08-14 完成（独立复验后定向修复，不切换阶段；4 项发现 + 修复证据见下）                                                                                          |

| A1 | tool-calling 兼容层（硬前置）：ProviderRequest/Event/Message 扩展 + 适配器 tools/SSE tool_calls + FakeProvider 工具脚本 | ✅ | 2026-08-14 完成（见下）；契约 §2.1/§3 + 决议 #30；任务文档 doc/stage3/tasks/A1-tool-calling-layer.md |
| A2 | Tool Registry + 权限分级与确认状态机（click 确定性允许列表 + fail-closed）+ 审计日志（接线既有只读/导航工具 8 个） | ✅ | 2026-08-14 完成（见下）；契约 §4/§7/§10；任务文档 doc/stage3/tasks/A2-tool-registry-permission-audit.md |
| A3 | 浏览器交互能力：scroll/click/fill/find + click 语义元数据 + elementId 生命周期验证 + click 执行器层白名单复核 | ✅ | 2026-08-14 完成（见下）；契约 §5 + 决议 #31（文档世代绑定）；任务文档 doc/stage3/tasks/A3-browser-interaction.md |
| A4 | SearchProvider（Bing 页面实现 + 统一结果结构 + 降级）+ search.web 工具 | ⏳ | 契约 §6；任务文档 doc/stage3/tasks/A4-search-provider.md |
| A5 | Agent Runtime：Loop 状态机 / 最大步数 / 超时 / 取消 / 防循环 / Agent 上下文与历史 / 持久化扩展 + 主进程冒烟 | ⏳ | 契约 §8–§9；任务文档 doc/stage3/tasks/A5-agent-runtime.md |
| A6 | 操作可见性 UI + IPC/bridge 扩展 + 确认流 UI + UI 端到端冒烟矩阵 | ⏳ | 契约 §11；任务文档 doc/stage3/tasks/A6-agent-ui-visibility.md |
| A7 | 威胁模型红队矩阵 RT-01～RT-11 + 安全审计 + 真实 Provider 可选验证 | ⏳ | 契约 doc/stage3/threat-model.md §4；任务文档 doc/stage3/tasks/A7-redteam-security-audit.md |
| A8 | 第三阶段收尾：验收清单核对 + Exit Gate 判定 + 文档同步 | ⏳ | Third_stage.md §9/§10；任务文档 doc/stage3/tasks/A8-finalize-acceptance.md |

> 编号说明（2026-08-14 实施前校正）：第三阶段任务编号 A1–A8（原 T1–T8），避免与
> 上表第一阶段历史任务 T0–T5（已关闭，编号不可改）重名；第一、第二阶段历史任务
> 编号一律不变。

## 最近验证结果（2026-08-14）

- **A3 浏览器交互能力（2026-08-14，第三个实现闭环）**：步骤 0 独立核对——HEAD
  `9df48a7` = Gitee/GitHub 双远程 HEAD、工作区干净、基线 test 452/452 独立复跑
  全绿（与上一轮报告一致，已独立确认）。**① 两项编码前安全核查**：a) elementId
  生命周期真实 DOM 红态探针（先于实现，冒烟受控页面）——跨 URL 导航与同 URL
  刷新后新文档均重新分配相同 `el-N` 字符串（旧 el-0 与新文档示例链接 el-0 同串），
  URL/标题/capturedAt 均不能证明文档身份——「旧 id 自然失效」论证不成立；
  b) allowedKind 单一事实源核查——A2 decide() 仅返回 {level, reason} 无共享
  分类——导出 `classifyClickTarget(semantics) → 'submit'|'nav'|'expand'|
'toggle'|null`（permission-policy），decide 级别映射与执行器 allowedKind 均由
  该函数对同一语义 binding 派生，executor/交互脚本不自行分类。**② 契约校准
  （决议 #31，elementId 文档世代绑定）**：TabManager 以主框架 did-navigate 提交
  事件维护每 Tab 导航世代计数（页内导航不递增）；快照 `meta.documentId` 主进程
  盖章（脚本输出同名字段被忽略）；click/fill 执行前 BrowserController 校验
  「绑定世代 === 当前世代」→ stale-element 不注入脚本；模型可见工具 schema
  `{tabId?, elementId}` 不变（世代为执行器内部参数）；ElementActionResult 增
  errorCode 字段；§5.1/§5.2/§5.3/§7.1/§13.2/§15 + threat-model §3.2/§3.3/
  RT-06 已同步。**③ 红→绿**：先写测试——红态 **9 files failed / 18 failed /
  452 passed**（4 个新测试文件模块缺失 + 5 个既有文件扩展用例失败；既有用例
  零删除、零断言削弱）；实现后全量 **533/533**（新增 81：interaction-script
  28 / interaction-normalize 11 / interaction-semantics 9 / interaction-tools
  12 / permission-policy 3 / snapshot-normalize 5 / tool-registry 4 /
  tool-executor 8 / browser-tools 1；既有 452 用例仅机械夹具更新——meta 必填
  documentId 与 fakeBrowser 三方法）。**④ 实现**：shared 类型扩展（ClickAllowedKind/
  ElementSemanticsBinding/SnapshotMeta.documentId/buttons・inputs 语义元数据/
  ElementActionResult/ScrollActionResult）；snapshot-script+normalize（isSubmit
  判定与交互脚本 submit 复核同源；ariaExpanded true/false 均保留；非法布尔形状
  丢弃字段）；interaction-script 固定模板（node:vm 敌手参数逃逸测试——引号/
  反斜杠/闭合片段/脚本字符串不能逃逸、参数原样到达；click 四类 allowedKind
  实时复核 + fill 原生 setter+input/change+password・file・disabled・readonly・
  隐藏拒绝 + scroll 整数 ±50000）；interaction-normalize（页面视为敌手逐字段
  校验，异常/堆栈/页面原文零穿透）；BrowserController 扩展 + PageReader 交互
  编排 + TabManager 世代；ToolExecutor（语义 binding 提取 + derived 派生 +
  tabId 解析）；tool-registry paramRules（find text ≤200 非空 / fill text ≤2000 /
  dy 整数 ±50000）；interaction-semantics 存储（read/find 登记、按 Tab 键控、
  世代随绑定）；interaction-tools 四工具注册（find 多章节确定性匹配、无命中
  ok 空结果；click/fill 无派生参数 fail-closed——模型/网页不可写）。
  **⑤ 冒烟**：A3 交互场景 8.2 + elementId 生命周期探针——A-12 允许列表四类
  点击（含 nav 真实导航落地页）、提交类 deny/approve 确认门（审计 decision=
  denied/confirmed）、非允许列表/「立即购买/删除账户」/危险链接 forbidden 零
  DOM 动作（页面交互日志断言）、权限判定后动态变化（失去 aria-expanded/href
  变 javascript:/checkbox 变 text/text 变 password）→ 执行器复核拒绝零 DOM
  动作、fill 隐私（结果/审计 len=N 零原文 + input/change 事件真实触发 +
  password/file/disabled/readonly/隐藏零写入）、scroll 边界与 viewport、find
  多章节与无命中、elementId 世代（同文档稳定/导航后 stale/刷新后 stale/重新
  快照不碰撞/类型复核/工具级 stale 审计证据）、每次调用审计恰好一条——
  **dev 离线全矩阵 + 生产产物双场景退出码 0**；既有 8.1 探针校准为注册表
  12 工具（A2 8 + A3 4）。**⑥ 验证与终检**：test 533/533（全量连跑 4 次全绿）
  · typecheck · lint · format:check · build 全绿；红线 grep（无万能工具形态、
  交互工具零 electron import、allowedKind/documentId 不出现在模型可见 schema、
  package 零改动、SYSTEM_PROMPT/UI/preload/IPC 零改动）；敏感信息扫描与 diff
  终检零命中；根目录杂散日志清理。**⑦ 计时用例抖动观察（延续 A2 观察，未放宽
  阈值）**：期间一次全量运行出现 1 例未捕获具体测试名的失败，复跑 4 次全量 +
  fake-provider 单文件 3 次均全绿——判定为既有 30ms 墙钟断言边缘抖动，如实
  记录不放松阈值。**未调用任何付费 Provider、未输出/索取 API Key。**

- **A2 Tool Registry + 权限分级与确认状态机 + 审计日志（2026-08-14，第二个实现
  闭环）**：步骤 0 独立核对——HEAD `b9ad38a` = Gitee/GitHub 双远程 HEAD、工作区
  干净、基线 test 361/361 独立复跑全绿（与上一轮报告一致，已独立确认）。
  **① 契约校准（先于编码，ariaExpanded）**：detailed-design §7.1 矩阵行原写
  「展开：buttons 条目 ariaExpanded=true」与 §5.4「显式声明展开状态」、A3 任务
  文档执行模板 `[aria-expanded]`（属性存在选择器——值 false 同样命中）、
  threat-model §3.3（无 `=true`）矛盾——判文档疏漏：展开/折叠控件收拢态
  aria-expanded=false 同样是控件的结构化证明。最小校准为「ariaExpanded 字段
  存在（true/false 均为 L1），字段缺失不能证明 → fail-closed」（§7.1 已同步，
  threat-model 本已一致）；未发现与实际代码冲突。**② 红→绿**：先写 6 个新测试
  文件 + logger 审计形态回归 2 用例——红态 **6 files failed（模块不存在）/
  363 passed**（既有用例零改动），实现后全量 **452/452**（新增 91：tool-registry
  17 / permission-policy 18 / confirm-manager 9 / audit-log 14 / tool-executor
  14 / browser-tools 17 / logger 2；连跑 5 次全绿稳定）。**③ 实现**：
  shared/types/agent.ts（A2 类型：ToolCall/ToolResult/ToolResultErrorCode/
  ToolPermissionLevel/ElementSemantics——A5/A6 类型未提前落地）；tool-types/
  tool-registry（重复注册确定性抛出、listTools 只出模型可见 schema、按名排序
  恒等、validateToolArgs 全矩阵任意非法输入安全返回不抛异常）；permission-policy
  （TOOL_BASE_RISK 编译期矩阵 + decide 纯函数——click 判定优先级：isSubmit
  **首先**升级 L2 不因并存特征降回 → href http/https → ariaExpanded 字段存在
  （true 与 false 均 L1）→ checkbox/radio → 其余与语义缺失 L3 fail-closed；
  fill password/file 与类型元数据缺失恒 L3；open/navigate 非 http/https 恒 L3；
  未知工具名防御 L3）；confirm-manager（单 pending 同步建立、并发请求
  fail-closed 立即 denied 不覆盖、approve/deny 未知与已终结 id false 幂等、
  cancelAll 作废、无自动批准）；audit-log（summarizeArgs 键排序确定性 + fill
  text 只记 len=N 原文零出现 + url 全量 + 其余 ≤200 截断、summarizeRawArgs、
  formatAuditMessage §10.1 确定性格式、createAuditLogger 薄封装——全量经
  logger sanitize，Key 形态零暴露链单测固化）；tool-executor（校验→权限→确认→
  执行→审计单出口**每次调用恰好一条**；L2 approve/deny/cancelAll 三路；结果
  预算 2000/read 8000/search 4000 确定性截断 + 警告；错误永不以 ok:true 返回；
  异常归一化 execution-failed 并 logWarn——审计条目本身不含堆栈）；browser-tools
  8 个只读/导航工具（只经构造注入 BrowserController，不 import Electron；
  read 每次实时 getPageSnapshot 防串页；serializeSnapshotForTool 章节化确定性
  序列化含 elementId）。**④ 接线与冒烟**：index.ts 注册 8 工具 + 装配
  ToolExecutor(new ConfirmManager(), createAuditLogger())；smoke 新增 8.1 工具
  层探针（注册表恰好 8 工具/listTools 恒等/get_tabs・read 真实执行成功/
  javascript: URL forbidden 且不建 Tab/非法 tabId invalid-args/未知 tabId
  execution-failed/日志字节切片 5 条审计恰好一次一条）——**dev 离线全矩阵 +
  生产产物双场景退出码 0**，日志实证 5 条 `[audit] tool-call` 条目。**⑤ 验证
  与终检**：test 452/452 · typecheck · lint · format:check · build 全绿；红线
  grep——本任务 diff 无交互注入/executeJavaScript 新增（smoke 命中为既有 UI
  驱动代码）、无万能工具形态（仅权限测试断言 shell.exec → L3）、browser-tools
  无 click/fill/scroll/find/search.web 注册、package 零改动、SYSTEM_PROMPT 未改、
  UI/preload/IPC 零改动；敏感信息扫描与 diff 终检零命中；清理单测产生的根目录
  杂散日志（既有 provider 告警用例在 logger 未初始化时写 CWD 的测试基础设施
  现象，运行测试即重现）——.gitignore 补 `/aibrowse-*.log` 防误提交，
  tool-executor.test 以 vi.mock logger 避免本任务新增用例再产生同类文件。
  **⑥ 计时用例抖动观察（既有用例，未放宽阈值）**：fake-provider「延迟块实际
  等待」（≥30ms 墙钟断言）在红态全量运行中 2 次测得 29.94ms（差 0.06ms）；
  单文件 10/10、全量连跑 5/5 全绿——判定为并行负载下墙钟断言的边缘抖动，
  非可复现失败；按约定如实记录，A2 不修改阈值（后续会话若高频复现，评估
  根因后做安全的小范围测试改进）。**未调用任何付费 Provider、未输出/索取
  API Key。**

- **A1 tool-calling 兼容层（2026-08-14，第一个实现闭环，硬前置解除）**：
  步骤 0 独立核对——HEAD `525fae8` = Gitee/GitHub 双远程 HEAD、工作区干净。
  **① 契约校准（先于编码，决议 #30）**：detailed-design §2.1 原写
  `ProviderEvent.toolCalls: ProviderToolCallDelta[]` 与 §3.1 聚合语义矛盾——
  校准为 SSE 原始分片仅作适配器内部解析状态（openai-compatible.ts 模块内
  `ToolCallFragment`/`ToolCallSlot`，不进共享契约），对外 `ProviderEvent.toolCalls`
  输出聚合校验完成的 `ProviderToolCall[]`（id/name 非空、arguments 整体
  JSON.parse 成功且结果为对象），恰好在 done 之前，绝不暴露半截 arguments；
  §2.1/§3.1/§15 已同步，AGENTS.md §5 契约速查同步校准。**② 文档残留校正**：
  threat-model §5「以上三类」重复段删除（保留四类）；A8 任务文档「三类」→四类、
  progress.md 风险与限制残余风险「三类」→四类（新增 click 允许列表目标页内 JS
  副作用）；A5 任务文档「终止理由四种」→五种（实列 step-limit/timeout/
  loop-detected/no-progress/cancelled）。**③ 红→绿**：先写失败用例——
  4 个 A1 相关测试文件红态 **31 failed / 64 passed**（全部为新增用例与 2 处
  元数据校准断言，既有用例零改动），实现后全量 **361/361**（新增 35 用例：
  openai-compatible 27——interpret tool_calls 帧判定/分槽累积/聚合校验/SSE
  管道收尾顺序/非法帧与非法 arguments → provider-error/mapMessages tool 与
  tool_calls 重放；fake 5——工具脚本整组产出/延迟/确定性/getLastRequest
  tools 恒等/abort 不产出；context-builder 3——tools 恒等透传/未传无字段）。
  实现：shared 类型扩展（ProviderTool/ProviderToolCall/tool 角色/tools 字段）+
  openai-compatible 适配器（请求体 tools 透传、v1 不发 tool_choice、SSE 管道
  streamSseBody 抽出可单测、supportsToolCalling=true）+ FakeProvider 工具脚本
  （kind:'toolCalls' 整组产出）+ ContextBuilder tools 恒等透传 +
  conversation-service 共读流 toolCalls 事件 fail-closed 归一化 internal
  （事件判别联合扩展所致最小改动）。**④ 冒烟**：矩阵 11 断言校准为「未传
  tools → 请求无 tools 字段」（`'tools' in request === false`，tool_calls
  字段断言保留）；S3 场景新增 A1 工具探针（FakeProvider 脚本级：事件严格按
  脚本顺序 delta → toolCalls → delta → done + getLastRequest 保留 tools 恒等）。
  冒烟双场景退出码 0（dev 离线全矩阵 + 生产产物），日志实证 A1 探针与矩阵 11
  校准断言通过。**⑤ 验证与终检**：test 361/361 · typecheck · lint ·
  format:check · build 全绿；红线 grep（无工具执行/交互注入/万能工具代码）、
  敏感信息扫描、diff 终检零命中；SYSTEM_PROMPT 未改动、共读路径请求无 tools
  字段保持；清理本次单测产生的根目录杂项日志。**未调用任何付费 Provider、
  未输出/索取 API Key。** 红线遵守：无任何 Browser Tool/Registry/AgentLoop/
  SearchProvider/UI/IPC 改动。

- **第三阶段设计实施前校正（2026-08-14，独立纯文档闭环，零代码改动，不实现 tool
  calling 与任何 Browser Tool）**：① 步骤 0 独立核对——HEAD `0fb7047` =
  Gitee/GitHub 双远程 HEAD（GitHub 经代理 fetch 确认）、工作区干净。② **任务编号
  校正**：第三阶段任务 T1–T8 与第一阶段历史任务 T1–T5 重名——统一改为 **A1–A8**，
  任务文档经 `git mv` 重命名（`doc/stage3/tasks/A1–A8`），AGENTS.md / README.md /
  progress.md / doc/stage3/ 全部交叉引用同步；第一、第二阶段历史任务编号
  （T0–T5 / S1–S6）一律不变（AGENTS.md §5/§6/§8 与 progress.md 任务表中的历史
  引用逐条核对保留）。③ **红队编号校正**：threat-model 红队场景 R-01～R-10 与
  progress.md 风险台账编号 R-01/R-02（按登记顺序分配、不得复用）冲突——统一改为
  **RT-01～RT-10** 并新增 **RT-11**「通用 click 越权」；全仓库搜索无残留歧义
  （风险台账 R-01/R-02 引用原位保留）。④ **权限契约收紧**（核心校正，同步
  proposal §11 校正记录 / high-level-design / detailed-design §4.2/§5.1/§5.2/
  §5.3/§5.4/§7.1/§12/§13/§14/§15/§16 / threat-model §3.3/§4/§5 / A2/A3/A7
  任务文档与验收测试要求）：通用 click 可间接触发购买/发送/删除/发布等远程写——
  「没有专用支付工具 = L3 不可达」与「只靠 isSubmit 判断副作用」均被否定。新契约：
  **L1 仅允许语义元数据可证明的低风险目标**（links 条目 href http/https、
  buttons 条目 ariaExpanded、inputs 条目 checkbox・radio）；isSubmit 提交类 → L2
  确认；**非允许列表目标/语义缺失 → L3 fail-closed**（即使确认也不执行）；
  **执行器层不可达**——click 注入模板按 allowedKind（权限决策派生，模型不可见
  不可写）复核 DOM 实时属性，权限层判 L1/L2 后页面动态变化同样被拒；L3 动作在
  权限层与执行器层双重封死。验收落点：冒烟新增 **A-12**（click 允许列表与执行器
  复核）、红队 **RT-11**、A2/A3 单测矩阵扩展。⑤ **Third_stage.md 真实场景复核
  （不破坏，证据见 proposal §11 第 4 条）**：场景 1/2/3/4 走 search/open/read/
  find/scroll/fill 不变；场景 5 提交/发送经 isSubmit 提交类 → L2 确认门（非提交类
  发送按钮 fail-closed，宁禁勿放，属 §3.5「本阶段内调整分类」授权）；场景 6 由
  RT-01/RT-03/RT-11 覆盖。⑥ 验证：test/typecheck/lint/format:check 全绿（纯文档
  按 AGENTS.md 附 A 免构建/冒烟重跑）+ 全仓库残留搜索 + diff 与敏感信息终检。
  **未调用任何付费 Provider、未输出/索取 API Key。** Third_stage.md 未改动
  （需求源保持原样）。

- **Third Stage 切换与设计定稿（2026-08-14，纯文档任务，零代码改动）**：① 步骤 0 独立核对——
  Git HEAD `9605269` = Gitee/GitHub 双远程 HEAD（GitHub 经代理确认）、工作区干净；
  全量验证独立复跑全绿（test **326/326** · typecheck · lint · format:check ·
  Electron 离线冒烟退出码 0——T2–T5 + S3 矩阵 1–8 + S4 UI 矩阵 1–12 全通过）；
  据此校正「等待修复后独立确认」→ 修复已确认、阶段切换。② **Entry Gate 逐项核验**
  （判定证据全文见 doc/stage3/proposal.md §8）：共读稳定 ✅ / ContextBuilder
  不可信输入 ✅ / BrowserController 可扩展 ✅ / Key 与日志安全 ✅ /
  **「LLM Provider 抽象支持 tool calling」→ 循环式门槛校正通过**——如实记录现状
  （`supportsToolCalling: false`、ProviderRequest 无 tools 字段、SSE 仅解析
  delta.content），判定该条字面要求与阶段目标构成循环（tool calling 兼容层是
  第三阶段自身交付物），门禁保护性意图（抽象不被锁死）已由现有扩展点满足
  （元数据字段预留/工厂注册表/自实现适配器/端点原生支持 tools）；**校正方式：
  A1 = 阶段内硬前置，A1 验证通过前禁止引入任何 Browser Tool 实现**（任务编号
  2026-08-14 实施前校正后为 A 编号，见下）。③ 新建
  `doc/stage3/`：**threat-model.md（Prompt Injection 威胁模型重建定稿，先于任何
  Browser Tool 实现）**——威胁枚举 T-01～T-10、五层防线（结构/能力/决策/审计/
  运行时）、红队矩阵（现编号 RT-01～RT-11，见下）、诚实边界声明（诱导式工具
  参数/确认疲劳/低风险动作累积三类残余风险如实登记，不宣称语义免疫）；
  **proposal.md**（目标/非目标/真实场景/验收映射/Q1–Q15 拍板/Entry Gate 核验
  记录/A1–A8 里程碑）、**high-level-design.md**（架构/决策/数据流/安全模型/
  测试/风险）、**detailed-design.md**（§2–§16 唯一契约源：tool-calling 兼容层、
  ToolRegistry 与首批 13 工具三批接线、L0–L3 权限矩阵与确认状态机、交互注入与
  elementId 生命周期、SearchProvider、AgentLoop 上限/防循环/审计、操作可见性
  UI 与通道、测试规格与验收核对清单、决议 #21–#28）、**tasks/A1–A8**（每任务 =
  一个可验证开发闭环：目标/范围/非目标/涉及文件/实施步骤/完成定义；A1 任务
  文档明确「验证通过前禁止任何 Browser Tool 实现」）。④ 更新 AGENTS.md（§1/§2 阶段指针
  与接管顺序、§3 Agent 架构纪律/万能工具永久红线/T1 硬前置、§4 结构、§5 Third
  Stage 契约速查、§8 注入边界、附 B/附 C）、README.md（当前状态/架构/目录/已知
  限制）、本文件。⑤ doc/stage2/ 与第一阶段历史文档**原位保留未覆盖**。⑥ 验证：
  全量回归（纯文档按 AGENTS.md 附 A 免构建/冒烟重跑——本会话已先行独立复跑过）
  - 文档交叉引用与格式检查。**未调用任何付费 Provider、未输出/索取 API Key。**

- **独立复验发现项修复闭环（2026-08-14，S6 后定向修复，非新阶段任务）**：test **326/326** ✅
  · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 四场景退出码 0
  （dev 离线全矩阵 + 生产产物 + **Bing 真实 URL 变体（原失败命令，红→绿）** + Session
  set/check 跨进程）· **真实 Provider 多网站验证 ✅（最终代码状态复跑，7 次真实调用全
  complete，退出码 0，新表格内容依赖断言与扩大后的 Key 零暴露扫描均通过）** · S5
  一问一答变体 ✅（1 次调用，退出码 0）。**真实调用台账共 15 次**：多网站场景初次
  验证 7 次（修复后新表格内容依赖断言与扩大后扫描窗口的首验）→ S5 一问一答变体
  1 次（该场景扫描代码路径改动复验）→ 失败路径清理修复后多网站场景最终复验 7 次
  （最终代码状态全量证据）。修复前红态证据：`AIBROWSE_SMOKE_URL=
https://www.bing.com/` 完整命令退出码 1、失败断言「关闭网页标签页后应回到单个标签页」
  （Bing ready/标题断言本身通过）。**① Tab 状态泄漏修复（根因）**：UI 矩阵 9 为验证
  「切 Tab 后 bounds」经 UI 新建 Tab 后从未关闭，真实 URL 变体关闭自己的 Tab 后断言
  `length === 1` 因泄漏 Tab 失败——矩阵 9 改为自建自清：相关断言完成后经真实产品链路
  （UI 关闭按钮 → bridge → IPC → BrowserController）关闭该 Tab，try/finally 保证失败
  路径同样清理，退出时新增「Tab 数量 = 1 + 活动 Tab 恢复进入前」回归断言；LIVE_SITES
  切 Tab 验证创建的验证 Tab 同模式修复（BrowserController 产品链路关闭 + 数量/活动 Tab
  恢复断言）；不修改 BrowserController/TabManager「关闭最后 Tab 后新建空白页」产品策略，
  后续断言也不改成固定数字。**② 顺带修复（同根因实测触发）**：冒烟失败路径临时目录
  清理缺口——`runSmokeScenario` 后置步骤失败时 catch 直接重抛，9.1 的正常清理不执行
  （红态复现两次各留下 `aibrowse-smoke-conversations-*` 残留）——AI 句柄提升至 try 外 +
  catch 最佳努力清理（不掩盖原始错误）。**③ 表格页内容依赖证据增强**：原问题「HTML
  表格由哪些基本标签构成」可由模型先验知识回答，不能证明回答依赖页面表格数据——经
  实际探测确认 w3school 示例表格（Company/Contact/Country，六行公司数据）为多年稳定
  内容后，问题改为「根据当前页面中的示例表格，公司 Ernst Handel 的 Contact 是谁？」
  （必须读取特定行/单元格才能回答）；新增真实调用前前置断言：目标行
  Ernst Handel/Roland Mendel/Austria 完整存在于快照表格（`filterLayoutTables` 保留集）
  且经 `fillWebContentSections` 确定性序列化进入 tables 章节（= ProviderRequest 依据，
  不被布局过滤/预算裁剪丢失，ContextBuilder 契约不变）；回答断言改为「包含页面特定
  数据 Roland Mendel」（不要求完全固定措辞）；站点内容变化时前置断言明确提示更换站点
  （失败前不产生真实调用）。**④ Key 零暴露扫描窗口扩大**：此前扫描从场景开始时取日志
  偏移，Key 进入进程 → 环境变量读取 → 装配 → safeStorage 密文落盘 → process.env 删除
  的装配期不在窗口内——扫描起点提前至进程最早日志可观测点（index.ts 在 logEnvironment
  与环境变量读取之前取定 `startupLogScan`{file, offsetBefore}，经
  `LiveProviderSmoke.logScan` 传入两场景），覆盖测试子进程启动日志/环境变量读取/
  Provider/config/credential 装配/Key 密文落盘/真实请求/流式响应/结束清理全过程；
  沿用 S5 已修复的字节级 subarray 切片（无字符/字节偏移回退）；文件不存在时偏移为 0
  （首个日志写入即创建文件，扫描覆盖全部字节）；**覆盖边界如实记录**（代码注释 +
  本文）：仓库外 PowerShell harness 为独立进程（DPAPI 解密/注入/ZeroFreeBSTR 清零），
  不在应用日志扫描范围内，其环境变量清理由 harness 自身 finally 强制——不伪称全生命
  周期扫描。**⑤ README 状态同步**：架构节「AI 子系统（第二阶段，设计定稿、待实现）」
  →「已实现并通过内部验收」；当前状态补独立复验发现与修复进展。AGENTS.md 未改
  （长期测试规则无变化，§6 命令描述与修复后行为一致）；detailed-design 未改
  （ContextBuilder/产品契约无变化）。交付：smoke.ts（矩阵 9 自清理 + LIVE_SITES 验证
  Tab 自清理 + 失败路径临时目录清理 + 表格内容依赖断言 + logScan 消费）、index.ts
  （startupLogScan 起点装配 + liveSmoke.logScan 接线）。
  **本次明确不处理的观察（如实登记）**：全局场景看门狗未新增（各 waitFor 局部超时已
  够用，新 watchdog 需单独设计且易再引入真实 Provider 慢响应误杀）；`48f1838` 提交
  信息声称含 index.ts 接线而实际接线在 `c9a431f`（已推送双远程，禁止重写公共历史，
  本次不 amend/不补偿空提交）。

- **S6 第二阶段收尾与最终验收（2026-08-13，第六个实现闭环）**：test **326/326** ✅ ·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （dev 离线全矩阵 + 生产产物）· **真实 Provider 多网站共读验证 ✅ 最终运行退出码 0**。
  **① Second_stage.md §9 四组 16 项验收标准逐项核对通过**，每项证据（单测/冒烟场景/
  审计条目/运行时日志）已回填 §9 勾选注释。**② §10 Exit Gate 判定：通过**（五条件逐项
  证据已回填 §10 证据块）；项目状态登记：**Second Stage 已完成内部验收，等待用户安排
  独立复验或阶段切换**（阶段指针不切换、不实现 Browser Agent）。**③ 新增真实 Provider
  多网站共读冒烟场景**（`AIBROWSE_LIVE_SITES=1`，smoke.ts `runLiveProviderSitesScenario` +
  index.ts 门控；仓库外 harness `run-live-smoke.ps1 -Sites`）：三类真实站点形态——
  MDN 普通文章页（正文提问 + 总结 + selection 独占）、wangdoc 长文教程页（visibleText
  超 12000 章节上限 → 确定性裁剪 warnings + 回答可用）、w3school.com.cn 表格页（数据表
  提取）——外加切 Tab 与刷新防串页（url/tabId/capturedAt 更新 + 旧页标记词不串入），
  每个提问对应一个明确验收项，全部经完整生产链路（UI → bridge → IPC → ConversationService
  → ContextBuilder → OpenAI-compatible → 流式 → DOM）真实调用且 turn-done complete；
  沿用 S5 真 Key 零暴露扫描（DOM/日志/临时文件/密文形态）。**④ 验收期间修复 3 个冒烟级
  缺陷（均非共读业务缺陷）**：a) 长文站点夹具——MDN display 页在应用快照管线中正文仅
  ~9.9k 字符（大量 p 文本隐藏在 BCD 折叠区，curl 文本量误判），更换为全明文渲染的
  wangdoc stdlib/array 章节并将前置断言校准为「visibleText 超章节上限 12000」；
  b) **冒烟 30s 兜底定时器缺陷（真实项目缺陷）**——「渲染进程未在 30 秒内就绪」定时器
  在渲染进程就绪后从未清除，任何超 30s 的冒烟场景（真实 Provider 多网站验证必然超过）
  被误杀（S5 会话日志亦有 1 次触发记录；离线矩阵 ~15s 恰好未暴露）——修复为
  AppRendererReady 时 clearTimeout，场景自身超时接管（index.ts）；c) 表格页对照组断言
  过度约束——nav 密集站点 links 章节超 200 条/4000 字符上限被确定性截断产生 warnings 是
  §7.5 契约正确行为，删除「短页面无裁剪」对照组断言并加注释说明。**⑤ 真实调用台账**
  （新规则：不设固定次数，每次对应明确验收项/问题定位/修复复验，报告次数与用途）：
  共 18 次——run1 3 次（文章提问①/总结/selection，暴露长文夹具缺陷后按断言中止）/
  run2 4 次（夹具修复复验，暴露 30s 定时器缺陷后被误杀）/ run3 4 次（定时器修复复验，
  暴露表格页对照组断言问题）/ run4 7 次（最终完整验收：正文提问/总结/selection 独占/
  长文裁剪/表格提取/切 Tab/刷新，全部 complete，退出码 0）。**⑥ 风险分类校准**：Prompt
  Injection 语义层剩余风险正式登记为「已接受的剩余设计风险/计划内限制」（不分配 R 编号、
  开放风险仍为「无」、不宣称完全免疫），保留「Third Stage 引入 Browser Tool 前重建
  威胁模型」最迟复核点（见风险与限制）。**⑦ 文档同步**：Second_stage.md §9 勾选 + §10
  证据块、AGENTS.md §1/§5 S6 状态 + §6 长期真实 Provider 测试流程（固定本地说明路径、
  DPAPI 仓库外、仅环境变量注入、无固定调用上限规则）、README（当前状态/真实 Provider
  开发者流程/测试计数 326）、detailed-design §13.2 增补多网站验证与调用规则（真实契约
  变化的最小同步）、S5/S6 任务文档实施标记。交付：smoke.ts（LIVE_SITES +
  runLiveProviderSitesScenario + 辅助函数）、index.ts（LIVE_SITES_MODE 门控 + 30s 定时器
  清除修复）。

- **S5 安全审计与 Prompt Injection 验证（2026-08-13，第五个实现闭环）**：test **326/326** ✅
  （无新增单测——审计未发现需新增纯函数的缺陷；注入夹具与真实 Provider 场景为冒烟胶水层）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 三场景退出码 0
  （dev 离线全矩阵 + 生产产物 + 真实 Provider 变体）。
  **① §12.1 七项结构性边界逐项审计通过**（代码审查 + 全仓库 grep + 单测 + 运行时探针）：
  边界 1/2/3——网页内容只进末条 user 消息 UNTRUSTED 块（serializeUntrustedBlock）、
  `</`→`<\/` 闭合转义 + 属性转义（escapeBlockContent/escapeAttribute）、system 恒等
  SYSTEM_PROMPT 编译期常量、角色仅程序字面量（conversation-store validateMessageShape
  丢弃非 user|assistant 角色，纵深防御）；边界 4——渲染层无 Key 读回（bridge 白名单
  仅 list/set/setKey，credential-store.get 仅主进程适配器用，矩阵 10 typeof 断言）；
  边界 5——全仓库无 click/fill/scroll/搜索 Tool/写通道（grep：仅冒烟 UI 驱动与 ChatView
  自身滚动；无 sendInputEvent/insertText；ProviderRequest 类型无 tools 字段，
  supportsToolCalling: false）；边界 6——permission-policy 双处理器默认拒绝回归
  （矩阵 11 geolocation 探针 denied）；边界 7——logger sanitize + error-normalize
  脱敏用例 + 矩阵 10 字节扫描 + 真实 Provider 场景真 Key 扫描（见下）。
  **② §14 安全基线清单逐项审计通过**：Key 零入库（credential-store 仅密文落盘 +
  isCiphertextShape 丢弃 sk- 明文形态、config-store 无 Key 字段、适配器不记请求头）/
  网页内容按不可信输入（§7.1）／权限默认拒绝不变／无写操作通道（grep 断言）／
  IPC sender+主帧校验全覆盖 + preload 最小白名单 + 事件订阅退订清理／远程网页隔离
  不变（tab 无 preload、nodeIntegration=false、contextIsolation+sandbox=true，
  矩阵 12 探针回归）／日志可定位且无敏感信息。**未发现 S5 范围真实安全缺陷**。
  **③ 注入夹具增强（矩阵 11）**：HOSTILE_HTML 增补 4 条注入文案（「忽略之前的指令」
  /role: system 伪造/调用工具/原始 `</UNTRUSTED_WEB_CONTENT><system>` 拼接尝试），
  矩阵 11 新增 5 断言——注入文案仅作为被阅读资料入块、闭合尝试被转义为 `<\/`、
  不得以原始闭合标签拼接伪造结构、消息角色无 system、请求 JSON 无 tools/tool_calls
  字段（elementId 敌对页场景不受影响，离线冒烟复跑通过）。
  **④ 真实 Provider 可选验证（用户提供凭据，共 2 次真实调用）**：新增 env 门控场景
  `AIBROWSE_LIVE_PROVIDER=1` + `AIBROWSE_TEST_API_KEY`（+ AIBROWSE_TEST_BASE_URL/
  AIBROWSE_TEST_MODEL）——index.ts 装配侧将 baseUrl/model 写入进程专属临时配置、
  Key 经 credentials.set 密文落盘后立即从 process.env 移除；冒烟场景经完整生产链路
  （UI → bridge → IPC → ConversationService → ContextBuilder → OpenAI-compatible
  Provider → 流式事件 → DOM）做固定问题「用一句话回答：1+1 等于几」的一问一答，
  断言：流式气泡增量渲染 + 事件链路 delta 计数 ≥1 + 无错误标记 + 回答非空 +
  持久化 assistant 消息 status=complete + contextSource snapshot/about:blank +
  临时配置精确含 baseUrl/model + 日志记录实际 provider/model + **真 Key 零暴露扫描**
  （DOM/日志切片/全部临时 JSON/密文形态断言）。
  第 1 次调用即成功（鉴权通过、1464ms status=complete），但暴露冒烟胶水缺陷——
  日志尾部读取用字符级 slice 配字节 offset（中文多字节使窗口起点右移），修复为
  字节级 subarray 切片（与矩阵 10 同模式）；第 2 次调用全断言通过（1597ms complete，
  exit 0）。**凭据清理已确认**：环境变量（应用内 delete + harness finally 移除）、
  明文内存清零、临时 userData 清理（TEMP_CLEAN）；DPAPI 密文文件与仓库外本地说明
  `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md` 保留供 S6 复验（未经用户要求
  不删除/轮换测试 Key）。交付：smoke.ts（矩阵 11 增强 + runLiveProviderUiScenario +
  SmokeOptions.liveSmoke + 门控装配）、index.ts（LIVE_PROVIDER_MODE 装配 + env
  移除 + delta 计数）；AGENTS.md §6 同步长期凭据流程通用规则（不含任何真实凭据）。
- **S4 契约交接校准（2026-08-13，独立校准 commit，纯文档）**：按 detailed-design.md
  头部要求对 S1–S4 实际导出签名逐项 grep 核对——决议 #17（`resolveProvider` 与
  `ConfigStore.list()` 均 async：`Promise<LLMProvider | null>` / `Promise<ProviderInfo[]>`）、
  决议 #18（`ContextBuildInput` 含 requestId/model；`buildContextSource(snapshot, mode,
thin, tabId)`）、决议 #19（`createSession(opts?) → Promise<ConversationSession | null>`）、
  决议 #20（`selectRegisteredProviderInfo(infos, kinds): ProviderInfo | null`）、
  `ProviderInfo`/`PROVIDER_KIND_OPENAI_COMPATIBLE` 定义于 shared/types/conversation.ts
  （config-store/llm-provider 重导出，renderer ProviderSettings 直接引用）、11 个 invoke
  通道常量与 payload 类型（shared/types/ipc.ts）、两个事件 payload（StreamChunkEvent/
  TurnDoneEvent）、AibrowseBridge 全部方法及三个事件订阅退订签名（onUpdated/
  onStreamChunk/onTurnDone → `() => void`，与 preload eventRelay 实现一致）、
  ConversationStore/ContextBuilder/context-budget/Provider/凭据/配置/渲染层纯函数全部
  导出——**未发现真实签名偏差**。AGENTS.md §5 同步 4 处过期/表述偏差：① 速查标题
  「S2–S4 待实现后回填」→「S1–S4 全部已实现并经 grep 逐项核对」；② SafeStorageCipher
  运行时验证描述「S3+ 冒烟验证」→「已由 S4 冒烟场景 10 验证」（实际验证发生在 S4）；
  ③ 渲染层只写不读表述「setKey/has」→「bridge 仅 setKey 写入，has 为 main 侧方法不进
  bridge，renderer 只能经 list() 拿 hasKey 布尔」（与白名单实际一致）；④ 三处
  prettier 列表规范化把行首「+ 实现类」「+ turn-done 收敛」「+ 退订」改写为「-」
  导致语义失真的格式伪影，分别改为「与实现类」「逐块追加、turn-done 收敛」
  「JS 侧 listener 集合退订」消除歧义。同时补记 shared/types/conversation.ts 的
  S4 增补（事件 payload/ProviderInfo/kind 常量）。progress.md S4/S5 状态核对：
  任务表 S4 ✅ / S5 ⏳、当前状态、下一个推荐任务（S5）均与实际一致；S4 条目内
  同类「+ 退订」伪影一并在本闭环修正。验证：test 326/326 · typecheck · lint ·
  format:check（纯文档改动，按 AGENTS.md 附 A 豁免 build/冒烟）。
- **S4 AI 侧栏 UI 与布局协调（2026-08-13，第四个实现闭环）**：test **326/326** ✅
  （304 基线 + 22 新增：stream-state 10 / history-events 6 / context-badge-format 6）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （dev 离线 + 生产产物），**UI 端到端矩阵 1–12 全部断言通过**（React DOM 事件驱动，
  FakeProvider 离线，真实 IPC/bridge/服务链路——UI → preload 白名单 → sender 校验 →
  ConversationServiceImpl → 事件推送 → DOM）：
  ① 端到端流式（delta 逐块渐进到达渲染 DOM——第三段不得与首块同时出现 + turn-done
  complete + 追溯卡片 url === 提问时页 URL + 真实页面正文入 web 块 + 非薄长文页徽标
  无「稀薄」提示）；② selection 独占（页面真实选中 → 徽标「选中文本（N 字）」+ 请求
  含 `<selection>` 不含页面正文 + 摘录卡片）；③ 防串页（UI 切页后提问 → 请求含页 B
  内容、页 A 内容不出现、追溯卡片 url 更新）；④ L3（dispose 后经 UI 提问 →
  徽标「无网页上下文」+ 请求无 web 块 + 无错误标记）；⑤ 薄快照（空白页 → 徽标
  「稀薄」提示 + 追溯卡片警告）；⑥ 中止（慢速 FakeProvider 中途点击「中止」→
  「已中止」标记 + 部分保留 + 流停 + 中止按钮消失）；⑦ 错误归一化（注入 401 →
  invalid-key 文案、注入超时 → timeout 文案；失败轮 user 消息仍展示）；⑧ 会话管理
  UI（新建/切换/「不保存」开关双向/删除：ephemeral 提问不落盘、转保存落盘、删除即
  消失、全新 Service 实例同目录重启恢复）；⑨ 布局协调（面板开 → 活动 view
  bounds.width = 窗口宽 − 380；关 → 恢复；DebugPanel 收起/展开 → 高度变化；
  切 Tab 后 bounds 保持；窗口缩放 → bounds 跟随）；⑩ **Key 安全（真实 safeStorage
  运行）**：设置界面保存非真实测试标记 Key → credentials.json 仅 base64 密文、
  渲染 DOM 与日志字节扫描零暴露、保存后输入立即清空、list() 仅 hasKey 布尔且结构
  无 apiKey 字段、bridge 白名单仅 list/set/setKey（typeof getKey/get === 'undefined'）；
  ⑪ Prompt Injection 结构断言（敌对页提问 → system 恒等于编译期常量、web 块恰好
  单块闭合、geolocation 权限请求被默认拒绝）；⑫ 远程隔离回归（window.aibrowse/
  process/require/electron 均 undefined）。**红→绿抓出并修复 3 个冒烟断言缺陷**：
  `.ai-status-error` 选择器误中历史首条错误（改为末条）、矩阵 6 中止断言与矩阵 1
  回答文本撞车（分块文案改用矩阵独有文本）、L3 错误标记断言误中历史旧错误
  （改为仅检末条 assistant 消息）。
  交付内容：① shared/types/ipc.ts 11 个 invoke 通道常量 + payload 类型（§4.1）；
  ② main/index.ts handler 装配（全部复用既有 handle() sender+主帧校验，逐参数验证
  安全返回；question > 16000 字符确定性截断 + warn、空串/非串 → internal 拒绝；
  config:providers:set-key 只写不回读，apiKey='' = 删除）；③ preload bridge 白名单
  （conversation 8 方法 + config.providers 3 方法；事件通道单次注册、JS 侧 listener
  集合退订，沿用 tabs:updated 模式；原始 ipcRenderer 不暴露）；④ renderer/src/ai/ 面板
  （AiPanel/ChatView/Composer/ContextBadge/CitationCard/ProviderSettings +
  useConversation/useStream + 纯函数 stream-state/history-events/context-badge-format/
  error-labels；回答纯文本 pre-wrap 渲染，零新依赖）；⑤ useContentBounds 升级为内容
  容器两维矩形测量（通道/契约不变）+ App 布局（内容行 + 面板定宽 380px 停靠、
  默认收起不持久化、无拖拽/动画；DebugPanel 移底部通栏）；⑥ 冒烟 UI 端到端矩阵
  1–12（冒烟模式 AI 子系统走进程专属临时目录 + FakeProvider 注入，场景 10 凭据为
  真实 safeStorage 密文，全程不触碰用户 userData，结束清理）；⑦ ProviderInfo 与
  PROVIDER_KIND_OPENAI_COMPATIBLE 常量移至 shared 单一事实源（决议 #20：v1 设置
  UI 只配置已注册 openai-compatible kind，不新增多 Provider 选择 UI，与 list() 顺序
  无关）。仍不做真实 Provider 验证（S5）、不做专项安全审计（S5）。
- **S3 ConversationService 与会话持久化（2026-08-13，第三个实现闭环）**：test **299/299** ✅
  （242 基线 + 57 新增：conversation-store 27 / conversation-service 30）· typecheck ✅ ·
  lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0（dev 离线 +
  生产产物），**AI 共读矩阵 1–8 全部断言通过**（主进程驱动，FakeProvider 离线，
  真实持久化文件）：① 端到端流式（分块按序 + turn-done complete + contextSource.url
  === 提问时页 URL + 真实页面正文经真实快照管线进末条 user 消息 web 块 + model 来自
  配置）；② selection 独占（页面真实选中文本 → 请求含 `<selection>` 不含页面正文，
  selectionExcerpt 摘录）；③ 防串页三断言（页 B 轮 url 更新/capturedAt 严格递增/
  页 A 内容不出现在页 B 轮；关闭活动 Tab 自动新建空白页 → 快照为空白页非旧页内容）；
  ④ L3 → mode='none'（dispose 后无任何标签页提问——最后 Tab 策略使正常运行中始终存在
  活动 Tab，真实 L3 仅此路径可达，设计 §13.2 矩阵 4 已同步说明）；⑤ 薄快照（空白页
  thin 标记 + 提示）；⑥ 中止（慢速 FakeProvider 中途 abort → 流停 + aborted + 部分
  保留 + 在途 busy + 终态后 abort 幂等 false）；⑦ 错误归一化（注入 401 → invalid-key
  文案/httpStatus、注入超时 → timeout retryable；失败轮 user 消息仍先落盘）；⑧ 会话
  持久化（普通会话文件落盘/ephemeral 不落盘与 setEphemeral 双向切换/新 Service 实例
  同目录重启恢复/删除即消失含残留 tmp）。
  交付内容：① `conversation-store.ts`——纯函数（消息/会话形状校验、version 1 文件
  格式、索引不含 ephemeral、200 条上限确定性裁剪、title 首问推导 ≤30）+ JSON 读写
  （`<userData>/conversations/`，原子写 tmp+rename、损坏 fail-closed 按空处理不暴露
  原文、删除含残留 tmp）；② `conversation-service.ts`——会话生命周期（50 会话上限
  拒绝新建，决议 #19）+ 每会话单在途状态机（busy/abort 幂等）+ §6.1 ask 编排
  （实时快照防串页 → buildContext → 先持久化 user 消息 → resolveProvider →
  provider.stream → 事件转发 → 终态持久化）+ previewContext（实时摘要不含正文）；
  ③ 事件通道常量（conversation:stream-chunk/turn-done + StreamChunkEvent/
  TurnDoneEvent）与 index.ts 最小装配（事件回调转发主窗口 send，before-quit dispose）；
  ④ 冒烟矩阵 1–8 主进程驱动扩展（进程专属临时目录，不触碰用户 userData，结束清理）。
  **红→绿抓出 2 个集成缺陷并修复**：deleteSession 与在途生成竞态下 user 消息落盘
  复活已删会话文件（appendMessage 存活守卫）；200 条裁剪后落盘仍用未裁剪数组引用
  （落盘改用裁剪结果）。**契约校准决议 #19**（与实现同 commit）：createSession 达
  上限返回 null（§9 拒绝新建与 §4.2 可空 bridge 要求失败通道，§3.1 已同步）。
  仍不接 renderer UI/IPC invoke 通道（S4）、不做真实 Provider 联网；
  safeStorage 运行时验证仍留 S4 场景 10；零新依赖。
- **S3 收尾交接校准（2026-08-13，独立校准 commit）**：① progress.md「下一个推荐任务」
  指针修正为 S4（原误留 S3）；② AGENTS.md §5 createSession 签名显式化为
  `Promise<ConversationSession | null>`（实际代码与唯一契约源 §3.1 一致，决议 #19）；
  ③ **决议 #20 Provider 选择契约**——ask 原「取 `ConfigStore.list()` 首个已配置项」
  依赖文件条目顺序的隐含规则，已定稿并落地为「providerId 属于已注册工厂 kind 的配置」
  （纯函数 `selectRegisteredProviderInfo`，v1 仅注册 openai-compatible、ConfigStore 以
  providerId 为键 upsert 同键恒唯一 → 选择唯一且与条目顺序无关；无已注册 kind 配置 →
  not-configured 零网络请求）。同步唯一契约源 §6.1/§15 与 AGENTS.md §5；单测新增 5 用例
  （纯函数 3 + 服务级 2：多配置共存顺序无关/仅未注册 kind → not-configured）；测试与
  冒烟进程内注册 'fake' kind（与生产同路径）。test 304/304 · typecheck · lint ·
  format:check · build · 冒烟双场景退出码 0。
- **S2 ContextBuilder 纯核心（2026-08-13，第二个实现闭环）**：test **242/242** ✅
  （170 基线 + 72 新增：context-budget 42 / context-builder 30）· typecheck ✅ · lint ✅ ·
  format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0（dev 离线 + 生产产物，
  既有场景回归，S2 纯逻辑不扩冒烟）。交付内容：① `context-builder.ts`——
  `buildContext`（组装 ProviderRequest：system 恒等透传 + 历史重放 + 末条 user 消息含
  UNTRUSTED_WEB_CONTENT 块）/ `deriveContextMode`（selection trim 非空优先独占 → snapshot →
  none；L2 保留身份降级）/ `isThinSnapshot`（正文合计 < 300）/ `buildContextSource` /
  `SYSTEM_PROMPT` 编译期常量；块闭合转义（`</` → `<\/`）+ 属性 `& < > "` 转义 +
  `<selection>`/`<section name>` 结构；② `context-budget.ts`——`CONTEXT_BUDGET`（§7.5
  全量表）+ 确定性裁剪（text→headings→tables→links→buttons→inputs 优先级填充、各节/
  条目上限、总预算 30000 停止、任何截断 `…[已截断]` 标记 + 警告、布局表启发式过滤
  「跳过 N 个疑似布局表格」）+ `trimHistory`/`renderHistoryMessageContent`（最近 8 对 /
  12000 字符 / 单条 2000 含来源行 ≤120 计入预算）；③ 契约校准决议 #18（与实现同 commit）：
  `ContextBuildInput` 增补 requestId/model、`buildContextSource` 增补 tabId、§7.6 实现
  落点明确（§3.2/§6.1/§7.6/§15 已同步）。纯函数零 Electron 依赖、零新依赖、不接
  IPC/UI、不联网；ProviderRequest 类型与 S1 交付一致（无冲突）。
- **S1 Provider 抽象与凭据安全基座（2026-08-13，首个实现闭环）**：test **170/170** ✅
  （89 基线 + 81 新增：error-normalize 18 / fake 12 / openai-compatible 12 / llm-provider 6 /
  credential 16 / config 11 / logger 6）· typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 双场景退出码 0（dev 离线 + 生产产物，既有场景回归，S1 不扩冒烟）。
  交付内容（1 个逻辑 commit c254465）：① `shared/types/conversation.ts` 定稿落地
  （§2 全部类型 + Provider 类型——Provider 数据类型放 shared，S4 preload/renderer 可复用，
  与任务文档一致）；② error-normalize 状态码矩阵纯函数（脱敏断言：错误不含响应体/密钥）；
  ③ LLMProvider 接口 + 工厂注册表 + resolveProvider；④ FakeProvider 确定性脚本
  （分块/延迟/错误注入/中止/getLastRequest）；⑤ OpenAI-compatible 适配器（原生 fetch +
  SSE 自解析：`\n\n` 分帧/[DONE]/usage 末帧/末帧 delta+usage 同帧不丢内容/CRLF 归一化；
  连接 15s/空闲 60s/总 300s AbortController 组合；Key 每请求从 store 取不缓存、适配器
  不记请求头；零 Electron import）；⑥ SecureCredentialStore（cipher 后端注入可替换 +
  `safe-storage-cipher.ts` Electron 薄胶水——设计 §1 布局外的唯一新增文件，分层纪律所需；
  密文落盘/原子写/损坏容错 fail-closed/不可用仅内存降级/sk- 明文形态条目丢弃）；
  ⑦ config-store（baseUrl 仅 http/https 去尾 /、model 非空、加载形状校验 fail-closed、
  list() 含 hasKey）；⑧ logger sanitize 导出 + sk- 形态 Key/apiKey 键值对脱敏。
  **契约一致性校准（2026-08-13 同日闭环，独立 commit）**：`resolveProvider` 与
  `ConfigStore.list()` 为 async 经独立核对判定必要——§3.4 将 `SecureCredentialStore.has()`
  定为异步接口（「无 Key → null」与 hasKey 判定必须 await），§4.2 bridge 本就按 Promise
  建模 `list()`，§6.1 ask 编排在 async 上下文内 await 无成本；设计文档 §3.3/§3.5 签名与
  §6.1 await 时序已同步并新增决议 #17，不再遗留至 S6。不接 IPC/UI、不联网、零新依赖；
  safeStorage 运行时行为按计划留待 S4 冒烟验证（§13.2 场景 10）。
- Second Stage 切换与设计定稿（2026-08-13，纯文档任务，零代码改动）：① 步骤 0 核对——
  git 工作区干净、First Stage Exit Gate 与 Second Stage Entry Gate 均已有独立复验证据；
  ② 定稿 `doc/stage2/proposal.md`（目标/非目标/验收/Q1–Q10 拍板/S1–S6 里程碑）、
  `doc/stage2/high-level-design.md`（架构/决策/数据流/安全模型/存储/测试/风险）、
  `doc/stage2/detailed-design.md`（§2–§16 唯一契约源：五模块职责与接口、IPC 白名单、
  错误契约、实时快照防串页、selection 优先级/薄快照/表格噪声、预算与确定性裁剪、
  角色隔离与 UNTRUSTED 块、流式/中止/超时、会话持久化与不保存、Key 安全、面板布局、
  注入验收边界与剩余风险、冒烟矩阵）、`doc/stage2/tasks/S1–S6`（每任务 = 一个可验证
  开发闭环：目标/范围/非目标/测试/完成定义/依赖；每个任务重申三阶段红线——严禁新增
  click/fill/scroll、自动搜索、多步 Browser Agent Tool）；③ 更新 AGENTS.md（§1/§2
  阶段指针与接管顺序、§3 AI 架构纪律/Key 零暴露红线/第二阶段不做清单、§4 结构、
  §5 Second Stage 契约速查、§6 冒烟与真实 Provider 可选验证、§7 测试、§8 注入边界声明、
  附 B/附 C）、README.md（当前状态/冒烟/架构/测试/已知限制）、本文件；
  ④ 第一阶段 doc/proposal、doc/high-level-design、doc/detailed-design 与
  doc/tasks/baseline.md **原位保留未覆盖**（历史定稿）；Second Stage 及后续文档按
  `doc/stageN/` 目录约定独立存放；⑤ 验证：npm test 全量回归 + typecheck + lint +
  format:check（纯文档按 AGENTS.md 附 A 免构建/冒烟）+ 文档交叉引用与格式检查。
- Second Stage Entry Gate 独立定向审查（2026-08-13，纯审查零代码改动）：按 Second_stage.md
  §2 逐项复核——① 四模块稳定边界与 AGENTS.md §5 契约逐项一致；② PageSnapshot 真实页面探针
  （example.com/MDN 长文/w3school 表格页/cnblogs 长文/百度百科动态长文/sspai 动态首页/bing
  首页七页：长文与表格内容质量良好、L0/L1 阶梯与 warnings 正常；bing 首页文本稀薄属页面特性）；
  ③ elementId 生命周期与销毁错误处理（敌对页冒烟复跑）；④ 权限隔离冒烟复跑；⑤ 全量验证
  复跑全绿（test 89/89 · typecheck · lint · format:check · build · dev/生产/真实 URL 冒烟 ·
  Session set/check）；⑥ 本文档无阻塞级缺陷。另以同视图导航/刷新一致性探针证实无旧快照
  复用，selection 焦点保持探针证实 chrome 获得焦点后页面 selection 保留且真实采集脚本可读
  （支撑「对选中文字提问」链路）。判定：**Entry Gate 通过，无阻塞项**。审查发现的文档
  不一致（AGENTS.md §6 Session 冒烟命令缺 `AIBROWSE_SMOKE=1`）已于本闭环修复；新增
  Second Stage 设计约束三条登记于「计划内限制与延期项」。
- T5 收尾（2026-08-13）：test 89/89 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 全场景退出码 0：① dev 离线（含 T5 新场景）；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。新增验证：
  ① **安全审计**：detailed-design §11 逐项核对实际代码全部落实（Tab/UI 安全默认值、
  IPC sender+主帧校验、preload 白名单、双权限处理器默认拒绝、监听器逐一清理）；
  ② **R-02 关闭**：Tab will-redirect 白名单 + 受控 302 冒烟（允许目标 http→http 跟随、
  禁止目标 custom:// 拦截 + 日志字节切片断言；探针实测 file:/data:/about:blank 被
  Chromium 网络层先拦、自定义协议/mailto: 真实触发 will-redirect）；
  ③ **elementId 敌对页审查**：修复同元素跨集合双 id 漂移 + 顶格烙印分配溢出两处缺陷，
  敌对页冒烟断言（重复/畸形/超大/负数/冲突烙印 → id 唯一、1–10 位数字、无歧义对应
  活 DOM 真实元素、跨快照稳定）；
  ④ **UI 端到端冒烟**：React DOM 点击/键盘事件驱动（地址栏 URL/搜索、多 Tab 新建/切换/关闭、
  后退/前进/刷新、标题随网页变化、调试面板 L0 徽标+JSON / L1 徽标+warnings 展示），
  远程页面隔离探针（window.aibrowse/process/require/electron 均 undefined）；
  ⑤ **Session 跨进程持久化**：AIBROWSE_SESSION_SMOKE=set/check 双独立进程 + 临时
  userData（HttpOnly Cookie 落盘 → 完整退出 → 新进程读回，测试后清理临时数据）。
  交付 4 个逻辑 commit：① R-02 will-redirect 加固（+logger 日志路径导出）；
  ② elementId 两处修复；③ 冒烟四场景扩展 + index 接线；④ 文档同步。
  仍不接入 LLM、CI、打包；第一阶段 Exit Gate 通过，停止等待用户指令。

- T4 PageSnapshot 闭环（2026-08-13）：test 89/89 ✅（42 基线 + 1 导航保护收紧新增 + 46
  snapshot-normalize 新增）· typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 三场景退出码 0：① dev 离线；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。冒烟新增真实采集断言：
  本地受控双服务器页面实际注入只读脚本——L0 内容对照（heading/link/button/table/
  visibleText/elementId 唯一性与跨快照稳定）、L1 跨域 iframe 跳过警告、L3 未知 tabId null。
  交付内容（5 个逻辑 commit）：① T3 核查发现导航保护生产 file: 前缀语义过宽
  （同目录扩展/路径穿越可放行）→ 收紧为入口精确匹配（scheme+pathname 相等，hash/query
  变体视为同一文档）+ 冒烟三探针；② snapshot-normalize 校验纯函数（页面视为敌手）+
  46 组红绿测试；③ 只读采集脚本（IIFE 字符串，DOM lib 引用保持 TS 检查）+ PageReader
  L0–L2 阶梯接入 BrowserController；④ 调试面板（JSON + degraded 徽标 + warnings + 可收起）；
  ⑤ 冒烟采集扩展。仍未接入 LLM、未开始 T5。
- T3 浏览器 UI 闭环（2026-08-13）：test 42/42 ✅（33 基线 + 9 ui-navigation-policy 新增）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 三场景退出码 0：
  ① dev 离线（T2 场景回归 + UI 导航保护拦截 + bounds 上报生效）；
  ② 生产产物（`npm run start`，file: 入口导航保护路径）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/，ready + 标题非空）。
  交付内容：UI 窗口导航保护（will-navigate + will-redirect 自身来源白名单，纯函数
  ui-navigation-policy + 9 用例，**bridge 扩展硬前提，与 bridge 同闭环落地**）→
  preload bridge 扩展（tabs/nav/page/ui 白名单，§3.2 定稿签名）→ 浏览器 chrome UI
  （工具栏/标签栏/地址栏/主区域 + ResizeObserver bounds 上报 + 原始输入 main 侧规范化）→
  冒烟扩展。分 4 个逻辑 commit 提交。
- 安全补丁（2026-08-13，审查发现→修复）：persist Session 权限默认放行漏洞已修复——
  `setPermissionRequestHandler` + `setPermissionCheckHandler` 双处理器默认拒绝（v1），
  策略纯函数 `permission-policy.ts` + 4 组纯测试（无 Electron mock）。test 33/33 ✅ ·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0，离线场景）。
  同步定稿：detailed-design §7/§9/§11/§12（权限默认拒绝 + UI 窗口导航保护事件集，
  Electron 43.4.0 实证：will-navigate 覆盖页面发起导航含 location.replace；
  will-redirect 覆盖页面发起与程序化两条路径的 302；不采用 will-frame-navigate）。
- T0 基线：test 15/15 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0）
- T1 定稿（2026-08-13，纯文档任务）：基线验证复跑全绿（test 15/15 · typecheck · lint · format:check · build）；
  Electron 冒烟按验证矩阵「纯文档」豁免（代码零改动）。定稿契约依据本地 electron.d.ts（43.4.0）
  逐项核实：WebContentsView/setVisible/addChildView/executeJavaScript/fromPartition/navigationHistory 均可用。
- T2 浏览器核心（2026-08-13）：test 29/29 ✅（15 基线 + 14 tab-state 新增）· typecheck ✅ ·
  lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （离线：多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等 + webContents 无残留；
  真实 URL：AIBROWSE_SMOKE_URL=https://www.bing.com/ 加载 ready + 标题非空）。
  冒烟首跑抓出并修复 2 个集成 bug：① closeTab 把「移除后」列表传给 selectNextActive
  （契约要求关闭前完整列表）→ 关闭活动 Tab 后邻居接管失效；② 窗口 closed 后
  BaseWindow 已销毁，removeChildView 抛 Object has been destroyed → 已加 isDestroyed 守卫。
- 规范校准：技术矩阵按官方来源（npm registry metadata + 官方文档）验证通过并冻结；
  依赖树健康（`npm ls` 无 invalid/missing peer）。

## 风险与限制

> 编号规则见文件顶部；正常后续任务、已接受的设计决议、机器环境说明不登记为风险
> （分别在任务表 / detailed-design / AGENTS.md §6）。

### 已关闭风险摘要

> 已关闭项保留编号与结论直至自然归档（不重排、不复用编号）。

- **R-01 UI 窗口导航保护缺失**（Medium，T3 内关闭，2026-08-13）：UI 窗口 preload 随任何导航
  加载，主框架被导航到远程页面即泄露 `window.aibrowse` bridge。处置：T3 先于 bridge 扩展
  落地 will-navigate + will-redirect 自身来源白名单（纯函数 `ui-navigation-policy.ts` + 用例；
  冒烟三探针实跑通过）。证据与影响详见 detailed-design §9/§12 决议 #16。
- **R-02 Tab 导航白名单未覆盖服务器重定向**（Low，T5 关闭，2026-08-13）：Tab 仅挂
  will-navigate，302 目标（如自定义协议）可绕过白名单。处置：补 will-redirect 与同一
  scheme 白名单，受控 302 实测（允许目标 http→http 放行跟随；禁止目标 custom:// 拦截 +
  日志断言；探针证实 file:/data:/about:blank 被 Chromium 网络层先拦、自定义协议/mailto:
  真实触发 will-redirect——自定义协议正是该风险的验证路径）。当前项目未注册自定义协议，
  该防护为防御纵深；结论 **Resolved**，详见 detailed-design §12 决议 #17。

### 开放风险登记

- 当前无开放风险。

### 计划内限制与延期项

（正常后续任务 / 已接受设计决议 / 明确延期，不虚构严重度与证据）

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过——已接受设计决议
  （detailed-design §12 决议 #13，快照为点时刻尽力采样）。
- 采集边界（T4 落地，非缺陷）：iframe 跨域计数为尽力采样（未加载完成的同源 iframe 可能被
  计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回 L2（按契约降级）；
  L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟强制触发（normalize 单测覆盖 L2 形状）。
- Tab will-redirect 白名单为防御纵深（T5）：file:/data:/about:blank 等目标已被 Chromium
  网络层拦截（ERR_UNSAFE_REDIRECT），当前无自定义协议注册；未来注册 `aibrowse://` 等协议
  时该拦截点是唯一防线（冒烟已用 custom:// 目标验证 handler 真实触发）。
- 无 CI / 打包配置：第一阶段验收不要求（Second Stage 起评估 CI：lint + test + typecheck；
  打包属 Seventh Stage Product Hardening）。
- fake-provider「延迟块实际等待」计时用例（≥30ms 墙钟断言）在全量并行负载下 2 次
  测得 29.94ms（差 0.06ms，2026-08-14 A2 会话观察）；单文件 10/10、全量连跑 5/5
  全绿——判定为墙钟断言边缘抖动、非可复现失败，阈值未放宽；后续会话若高频复现，
  评估根因后做安全的小范围测试改进（如改用与计时器同源时钟或断言最小等待语义）。
- shared/url 不支持 IDN（中文域名走搜索兜底，安全无副作用）；SearchProvider 抽象已定稿
  于 Third Stage A4（doc/stage3/detailed-design.md §6：v1 Bing 页面实现 + 接口隔离
  保替换；shared/url 的 SEARCH_ENGINE_URL 常量语义不变，由 SearchProvider 引用）。
- UI 窗口（defaultSession）未注册权限处理器：UI 只加载自身内容，R-01 已关闭（导航保护落地）
  后无远程页面可达，当前无需处理；未来 UI 嵌入远程内容时重新评估。
- 地址栏搜索的端到端验证在离线环境断言「导航目标为 Bing 搜索 URL」（did-start-navigation），
  真实搜索页加载需联网（冒烟含 AIBROWSE_SMOKE_URL 联网变体；URL 判断本身有 15 用例单测）。
- Second Stage 设计约束（2026-08-13 Entry Gate 审查登记；属第二阶段的输入约束而非本阶段
  风险，不进入开放风险登记、不占用 R 编号）：三条已由 Second Stage 详细设计定稿化解——
  ① **提问时刻实时采集防串页** → ask 编排时序即契约（doc/stage2/detailed-design.md
  §6.1/§6.2 + 防串页三断言）；② **薄快照降级策略** → thin 阈值 300 字符 + 提示
  （§7.2/§7.4）；③ **布局表噪声** → 确定性启发式过滤 + 容忍设计（§7.5/§7.7）。
- Second Stage 设计决议（2026-08-13 定稿时接受，属设计决议非风险）：① 字符预算 ≠
  token 预算（无 tokenizer，保守字符上限 + Provider 400 映射 context-too-long 兜底）；
  ② 会话不持久化快照正文（跨轮「结合上一页」类追问仅靠 contextSource 来源行，
  最小化持久化，Second_stage.md §7）；③ 布局表启发式为容忍设计（误删只是少内容、
  误留只是多冗余，均有 warnings）；④ 回答渲染 v1 纯文本（无 Markdown 库）；
  ⑤ 面板定宽 380px（不做拖拽调宽）。
- **Prompt Injection 语义层剩余风险（S5 已复核，S6 分类校准 2026-08-13——正式登记为
  「已接受的剩余设计风险/计划内限制」，不分配 R 编号，开放风险仍为「无」）**：
  机器可验证的结构性结论已由 S5 逐项验证——网页内容**不能**取得权限（permission-policy
  默认拒绝探针）、读取密钥（bridge 无读回 + 真 Key 零暴露扫描）、调用写操作（全仓库无
  写 Tool/写通道 + 请求无 tools 字段）或改变消息角色（程序字面量 + 单块闭合转义断言），
  详见 §12.1 审计。**不承诺（也不得宣称）Prompt Injection 完全免疫**：模型在语义层仍
  可能受网页文本诱导（如诱导生成误导性回答、诱导式表述）——当前阶段无浏览器写 Tool，
  该诱导无法转化为真实操作，故不构成需要当前阶段继续修复的缺陷。
  **最迟复核点已执行**：2026-08-14 随 Third Stage 切换**威胁模型重建定稿**
  （`doc/stage3/threat-model.md`）——「网页文本诱导调用工具」成为真实攻击面，
  防线升级为五层（结构/能力/决策/审计/运行时）+ 红队矩阵 RT-01～RT-11（A7 实施）；
  第三阶段语义层残余风险四类（诱导式工具参数/确认疲劳/低风险动作累积滥用/click
  允许列表目标的页内 JS 副作用，2026-08-14 实施前校正新增）正式登记
  为「已接受的剩余设计风险」（threat-model §5），不分配 R 编号；Fourth Stage 前按
  ROADMAP.md 阶段切换原则重新评估。

## 阻塞项

- 无。

## 下一个推荐任务

- **A4 SearchProvider（新对话 = 一个可验证闭环）**：`search(query, signal) →
SearchProviderResult`（SearchResult {title/url/snippet/source}）；v1 Bing 搜索页
  实现（临时可见 Tab → ready → 实时快照 → 确定性解析纯函数 `parseBingSearchResults`
  → 关闭 Tab）；容忍设计（结构变化 → 空结果 + warnings，不抛异常）；接口隔离保
  未来替换（决议 #22）；`search.web` 工具注册（{query} ≤500 字符非空，L0，结果
  预算 4000 已备）。任务文档 `doc/stage3/tasks/A4-search-provider.md`；
  契约 `doc/stage3/detailed-design.md` §6 + §13.1 A4 行。
  **红线**：不实现 AgentLoop（A5）/UI/IPC（A6）；不联网调用真实 Provider；
  搜索实现不得绕过 BrowserController 或放宽既有安全边界；A3 已落地的 click
  允许列表/世代绑定/审计链路不得削弱。

## 第一阶段验收未完成项

- 无：First_stage.md §十四 全部验收项已逐项核对并通过（T5，2026-08-13）；
  证据摘要见 First_stage.md §十四「验收证据」与本文「最近验证结果」。
