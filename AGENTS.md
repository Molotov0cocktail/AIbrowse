# AGENTS.md — AIbrowse 项目专属开发手册

> 本文件只保存长期工程规则、稳定架构、永久红线、技术基线与当前 Stage 契约速查。
> 当前任务状态、HEAD、验证数字和执行历史只写入 `doc/tasks/progress.md`、任务文档与 Git，
> 不在本文件复制。通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`；
> 项目专属规则与通用基线冲突时，以本文件为准。

## 工程自治授权

- 主 Prompter 持续完成第七阶段 E1–E6 的实现、验证、必要独立审核及阶段收尾，无需逐任务询问。
  交付限定 Windows x64、未签名内部开发候选、手动升级；不公开发布、不引入自动更新。
  第七阶段完成后停止，不启动 Stage8 产品实现。产品需求缺失时集中请求裁决，不编造需求。
- 保持功能、体验、兼容性、安全、隐私、数据语义及实质性能/可靠性承诺；内部架构、实现、重构、依赖、
  工具、文件范围、测试和诊断方案由工程 Agent 决定。现有工程方案无法有效证明产品承诺时，应先定位约束，
  自主替换方案并修订正式契约，不把历史实现或采集手段当作不可撤销需求。不得降低验收阈值迁就失败。
  仅产品取舍、接受影响用户的未解决风险、凭据/外部权限、物理操作或未授权不可逆动作需要用户输入。
- 模型调度默认主协调/规划/常规复核 `gpt-6-astra/high`，复杂诊断、安全、并发与阶段审核
  `gpt-6-astra/xhigh`；常规实现/测试 `gpt-5.6-sol/medium`，复杂实现可用 high 或 Astra。
  实际通过调度参数设置；工具未回显 actual 时记不可验证，不阻塞工作。角色表示职责，不绑定外部执行工具。
- 可合并简单任务与普通文档收尾，并行独立调查/隔离实现；关键安全、持久化、并发和阶段验收仍需独立审核。
  不要求每项工程决定单独审批或重复审核检查点；审核通过后可提交并正常双远程推送，不强推、不改公开历史。
- 有界真实 RSS 目标可因工程理由更新，每轮执行前记录目的、对象/选择规则、预算及 oracle；保留旧失败和
  累计请求量，不重置旧账本/claim。旧固定目标、64 总量及 DEV-NAV 1/1 不是永久许可锁；禁止无界换批重试。
  实际 Public/robots/TLS/解析/Baseline/后续 acquisition 门不变，预检不代替产品验收。
- 默认冒烟可用插桩、受控输入、对照及稳定性抽样创造新证据；保留所有结果并预设停止/换路条件。
  历史根因无法恢复时保留 unknown，独立审核可据充分当前证据关闭当前验收阻塞，不能声称历史原因已定位。
- 验收工具是工程源码：通用采集器、判定器、构建脚本、离线回放与合成夹具置于受控 `tools/` 并纳入 Git；
  原始日志、真实用户数据、凭据、机器配置与运行产物不入库。失败原件和必要关联记录不得作为垃圾清理。
- 接管、验证、审核和任务拆分按实际风险组织；可复用未受影响的已验证证据，不为每次文档更新或内部增量
  重开全阶段审核。产品取舍与未解决用户风险仍须裁决，阶段最终验收仍须新的独立上下文。

## 1. 项目概览

- **定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」。应用内置 Chromium
  多标签页浏览器，用户与 AI 共享同一浏览器会话和登录状态；AI 只能经受限、可审计的
  BrowserController / Tool Layer 操作浏览器，不拥有任意系统权限。
- **当前 Stage**：Seventh Stage——安全、稳定、性能、Windows安装与发布加固，当前授权覆盖 E1–E6 实现与验收。
  需求见 `Seventh_stage.md`；设计见 `doc/stage7/proposal.md`、`high-level-design.md`、
  `detailed-design.md`，安全契约为 `doc/stage7/threat-model.md`，任务契约为 `doc/stage7/tasks.md`。
  具体审核状态、当前 HEAD 与下一唯一动作只看 `doc/tasks/progress.md`。
- **阶段纪律**：第六阶段已由新的独立D11关闭；第七阶段设计不等于实现完成，也不授发行包或公开发布通过。
  阶段硬门满足并经新独立审核后方可关闭；历史安全、隐私、资源阈值及真实证据边界继续保持。
- **已完成阶段**：第一阶段浏览器核心、第二阶段 AI 共读、第三阶段 Browser Agent、第四阶段
  Sources、第五阶段 Research、第六阶段 Watch 均已通过各自适用 Exit Gate。历史需求、契约与验收证据分别留在
  对应 Stage 文件、`doc/stage2/`～`doc/stage6/`、任务文档和 Git 中，不在本文件复述执行轮次。

### 1.1 稳定架构

当前依赖方向如下。工程重构可修订模块边界与接口，但须同步正式设计并保持浏览器、网络、数据库、
凭据与模型之间的能力隔离，不能让 renderer/网页/模型获得底层通用权限：

```text
Browser UI
  → BrowserController
  → TabManager / PageReader / SessionManager
  → Electron APIs

AI UI
  → ConversationService
  → ContextBuilder / LLMProvider / SecureCredentialStore
  → BrowserController.getPageSnapshot（提问时刻实时采集）

Agent UI
  → ConversationService(agent)
  → AgentLoop
  → ToolRegistry
  → PermissionPolicy / ConfirmManager / ToolExecutor
  → BrowserController / SearchProvider

Sources UI / Agent Source Tools
  → SourceService
  → SourceRepository / SourceSearchIndex / SourceChangeJournal
  → SQLite driver（主进程）

Research UI
  → ResearchService
  → ResearchRuntime
  → SourceSelector / ResearchWorkspace / EvidenceValidator / ResultValidator
  → SourceService / BrowserController / SearchProvider / LLMProvider
  → ResearchRepository（独立 research.db）

Watch UI
  → WatchService
  → WatchScheduler / WatchRunCoordinator / DigestScheduler / DigestService
  → HostRequestGate / WatchTaskTabWorkspace / Acquisition / Diff / Condition / Event
  → SourceService / BrowserController / PublicWatchHttpClient / LLMProvider
  → WatchRepository（独立 watch.db）
```

Research Renderer 只消费已经验证的 Result Schema，不接触 BrowserController、SQLite、
Electron 或 Provider。模型只提出引用与结论；Evidence、Conflict、Coverage 和 Result 的
归属、形状、预算与真实性由确定性程序校验。

Watch 的采集、Diff、Condition 与 Event 事实全部由确定性程序产生；模型只能对已经验证的有界
Event 投影生成可选摘要解释，不能决定是否变化、是否命中或改写 Evidence。

### 1.2 技术基线

- Electron + TypeScript + React + Vite + Node.js；浏览器承载使用 WebContentsView，禁用已废弃的
  BrowserView；测试 Vitest，lint ESLint，格式 Prettier。
- Node.js 24.x（`.node-version` = 24.18.0，`engines.node` = `>=24 <25`）；Electron 43.7.7；
  electron-vite 5.0.0；Vite 7.3.6；React 19.2.8；TypeScript 6.0.3；Vitest 4.1.11；
  ESLint 10.8.1；Prettier 3.9.6。
- Stage7 发行构建辅助依赖精确固定：electron-builder 26.15.3、@electron/fuses 2.1.3、
  @electron/asar 4.3.1、resedit 3.1.0。它们只用于构建/验收，不扩大产品运行权限。
- 依赖精确版本固定，无 `^`/`~`；`.npmrc` `save-exact=true`；`package-lock.json` 必须入库。
  main/preload 输出 CJS，preload 必须兼容 `sandbox=true`。
- 核心工具链变更先说明工程理由、修订基线，完成受影响的 typecheck/lint/test/build/Electron
  冒烟与所需独立审核，再提交；不以无诊断升级代替根因分析。
- D3 的三个解析依赖已通过资格门并精确安装：`@federicocarboni/saxe@0.8.0`、
  `parse5-sax-parser@8.0.0`、`parse5@8.0.1`；替换或升级先 REPLAN 并完成对应安全/兼容资格。Provider 适配继续使用
  原生 fetch + SSE，不引入厂商 SDK。

### 1.3 交付、语言与远程

- 交付形态：Windows Electron 桌面应用。
- Gitee（默认直连）：`https://gitee.com/Molotov0coaktail/aibrowse`。
- GitHub（镜像；网络操作前必须确认代理）：
  `https://github.com/Molotov0cocktail/AIbrowse`。两个平台用户名拼写不同是已确认事实。
- UI 文案、错误、日志、文档和提交信息用中文；代码注释用英文。
- 提交信息：`<type>: <中文描述>`，type ∈ feat/fix/docs/refactor/test/chore/perf；
  一条提交一个逻辑变化，写明为什么。

## 2. 开发工作流

### 2.1 权威关系与事实优先级

不同事实类型由不同来源负责：

```text
ROADMAP.md / 当前 Stage 文件
  → proposal / high-level-design / detailed-design / threat-model / task docs
     （需求、架构、接口、安全与验收契约）

AGENTS.md / PROJECT_RULES.md
  （长期开发规则与稳定速查）

doc/tasks/progress.md
  （唯一当前进度源与短期记忆）

Git + 实际代码 + 测试/构建/冒烟输出
  （当前工程事实与机器证据）
```

Reviewer 的事实输入优先级固定为：

```text
Git / 实际代码 / 测试输出
> 正式设计与任务契约
> progress.md
> Executor 自述报告
```

这不授权代码违背正式需求：代码与测试说明“现在是什么”，Stage/design/threat/task 说明
“应该是什么”。二者冲突时必须明确判为 REPAIR 或 REPLAN，不得选择性忽略。

禁止默认新增 `handoff.md`、`summary.md`、`checklist.md`、`agent-state.json`、Agent 日志等
第二套长期事实源。Execution Contract 是当前会话中的临时交接物；稳定决策进入正式设计/
任务文档，当前进度进入 `progress.md`，实现事实进入 Git、代码和测试。

### 2.2 Step 0：按当前任务接管

1. 读取本文件、`progress.md` 当前入口、当前 Stage 的目标/验收，以及相关设计、安全与任务章节；
   不要求每次全文重读全部阶段文档或执行历史。只有受影响的接口、风险或证据需要时才追溯历史。
2. 检查 `git status --short --branch`、近期相关提交、分支与远程配置；记录精确 baseline，保护已有修改。
3. 阅读本次任务涉及的代码、测试、配置与候选 diff；按风险执行必要的只读基线检查。
   未受影响且来源、版本和适用范围明确的机器证据可复用；完成报告本身不构成验证。
4. 核对“应当是什么”与“实际是什么”。工程契约失效时先修订设计和 oracle；产品要求、安全、隐私、
   数据语义或性能承诺不明确时集中列出待裁决项，继续不依赖裁决的工作。
5. 形成覆盖目标、范围、不变量、验证、完成条件与停止/换路条件的实施合同。已有任务文档充分时只补差量，
   不复制整套设计或新增长期交接文档。

### 2.3 职责与独立审核

#### Planner

- 独立调查需求与仓库，区分产品承诺、工程决策、验证手段与环境条件。
- 冻结产品不变量、风险、验收 oracle 和当前实施边界；纯规划任务只修改授权的设计文档，不顺手实现产品。
- 工程架构、接口或验证手段需要变化时说明依据并修订正式契约；多个工程方案由工程 Agent 选择。
  只有产品取舍、接受用户风险或缺少外部权限等事项提交用户裁决。

#### Executor / Repair Worker

- 按当前合同实现并验证；可进行保持产品承诺的实现、重构和工具调整，必要时先同步相关设计。
- 行为缺陷先建立可甄别旧实现的红态，再实施修复；保留失败原件，执行风险相称的聚焦与回归验证。
- 实际根因超出修复假设、同路线连续两轮无新增证据或需要架构改变时，停止重复尝试并由主协调者重定方案；
  这不要求向用户重新申请已授权工程工作，也不禁止并行推进独立事项。
- 可创建逻辑候选提交，不得在所需审核 PASS 前 push。受委派的独立文件边界由主协调者管理，不与其它写者冲突。

#### Reviewer

- 核对 baseline、候选 diff、关键代码与机器证据，按风险独立复跑必要检查。
- 输出 `PASS / REPAIR / REPLAN / BLOCKED`，明确证据覆盖范围；`REPAIR` 给出缺陷与关闭条件，
  `REPLAN` 指出失效工程假设或待裁决产品问题。实现者自述不能替代审查。
- 普通任务可由主协调者完成复核，不强制为每个小增量创建新上下文。关键安全/隐私、持久化/迁移、并发、
  大规模架构变化和用户要求独立验收时，使用新的独立 Reviewer；按整项风险边界审核，不重复审查未变部分。
- 阶段最终验收必须使用新的独立 Stage Auditor。模型按本文件“工程自治授权”调度，不绑定旧工具或角色模型。

#### Closer

- 在所需审核 PASS 后核对批准范围，更新 `progress.md` 与必要正式文档，执行最终状态/格式/敏感信息检查。
- 完成逻辑收尾提交并按代理规则正常推双远程；不改公开历史，不夹带产品行为变化。
- Closer 是收尾职责，可由主协调者或获委派 Agent 承担；普通文档与实现收尾可合并，不额外设审批回合。

### 2.4 Execution Contract 标准

当前实施合同至少覆盖以下字段；已有任务文档可直接引用，仅补本次差量：

```text
TASK / BASELINE / GOAL / NON-GOALS
AUTHORITATIVE SOURCES / CURRENT VERIFIED STATE
FIXED DECISIONS / INVARIANTS / RED LINES
EXPECTED SCOPE / IMPLEMENTATION PLAN / TEST PLAN
ACCEPTANCE / STOP OR REPLAN CONDITIONS / FINAL EVIDENCE
```

- baseline 为实现开始前的精确 SHA；保留候选提交和工作区差量的关系。
- `FIXED DECISIONS` 写产品承诺及本轮工程选择，并标明后者的失效/替换条件，不能把所有内部实现永久冻结。
- 范围按完整目标及模块组织，不机械限制一个文件；超出原估计时说明原因、协调写者并同步合同。
- 验证区分聚焦红→绿、集成回归、正式长时/真实条件和最终阶段验收；说明证据复用范围及 NOT RUN 原因。
- 为不确定方案先设置最小可行性检查、预算和停止/换路条件；平台 API 不承诺的观测能力不得被当成产品事实。
- 模板位于 `.agents/skills/vibe-coding-workflow/references/prompt-templates.md`；不向模板复制当前 HEAD、结果或凭据。

### 2.5 执行、审核与修复循环

```text
接管与当前合同 → 实现/聚焦验证 → 风险相称复核或独立审核
  PASS   → 文档/提交/双远程收尾 → 持续推进已授权的下一任务
  REPAIR → 建立缺陷 oracle → 修复与受影响回归 → 重审受影响范围
  REPLAN → 重定工程方案并同步契约 → 可行性验证 → 恢复实施
  BLOCKED → 说明具体外部条件；继续独立可推进事项
```

- 任务应形成可验证结果，可合并紧密相关的小任务与文档收尾；不要求一个聊天、一个文件或每次提交即停工。
- 可并行独立调查和不重叠实现；同一文件不得并行写，保护用户修改，不 reset/checkout/clean 覆盖未知工作。
- 新证据与失败决定是否继续、修复或换路；禁止无诊断重跑、挑选绿态或让失败消失。
- 契约错误先 REPLAN；用等价或更充分的证据替换失效采集方案，应说明为何仍覆盖同一产品承诺，不能降低阈值。

### 2.6 Git、验收工具与证据边界

1. 保留 baseline、实现逻辑候选和修复提交，Reviewer 审查对应差量；审核 PASS 前不 push 候选完成状态。
2. PASS 后更新 progress/正式文档、终检、提交，再推 Gitee 与 GitHub。历史未受影响的 PASS 可按明确范围复用，
   产品或关键验证实现发生变化则重审受影响部分。
3. 不强推、不改公开历史；不以 amend 隐藏失败和修复链。已有未知修改必须保留并明确归属。
4. 通用验收采集器、判定器、回放器、合成夹具、构建与测试脚本是受版本管理的工程源码，放入受控 `tools/`；
   产品必需的 native 代码继续按其正式模块目录管理。工具应有可复现构建、版本与适用边界。
5. 原始运行日志/trace、凭据、真实用户数据、机器专属配置、数据库和构建产物不入库；私有参数在仓库外注入。
   不能因工具最初写在 `log/` 就永久把其通用源码排除在版本管理之外，也不能直接把含私有配置的旧 harness 入库。
6. 提交前检查 diff、敏感信息、状态和残留。只清理已确认无证据价值且属于本任务的临时产物；失败原件、
   claim/请求账本与必要关联记录保留在受控位置，不以“清理垃圾”为由删除、重置或伪造成功。

### 2.7 阶段切换

- 当前 Stage 的 Exit Gate、必要全量验证和真实条件必须满足，且无未裁决阻塞缺陷，由新的独立
  `gpt-6-astra/xhigh` Stage Auditor 在当前候选上逐项复验后方可关闭。
- Auditor 独立核对事实，不采信自述；可说明适用范围后复用未受影响证据，必要最终回归与独立判断不能省。
- 按当前用户授权继续下一 Stage 的入口、风险承接、必要设计和任务准备，停在其首个产品实现任务启动前；
  后续用户缩小或改变范围时以新指令为准。
- 产品运行时的多 Agent 非目标不限制开发过程按风险使用并行调查、实现与独立审核。

## 3. 规则与永久护栏

### 3.1 通用质量纪律

1. **甄别性验证**：行为缺陷先写能区分旧实现与正确行为的红态测试；可逆低影响文档/配置修改采用直接检查，
   不为流程凑测试。安全、持久化和并发边界必须有相应反例。
2. **保留验收实质**：不得删除有意义的断言或降低阈值迁就失败；失效工程 oracle 先 REPLAN，明确替代证据。
3. **有界范围**：围绕已授权目标完成必要修改，可为根因重构和替换架构；说明范围变化，保护用户工作，
   不夹带未授权产品功能或下一阶段实现。
4. **分层**：核心逻辑保持可独立验证，Electron/IO/UI 保持清晰能力边界；重构不得扩大网页/模型权限。
5. **安全失败**：敌手或越界输入 fail-closed，返回受控错误/空结果，不回显敌手正文。
6. **严格 TypeScript**：禁止用 `any`、`@ts-ignore`、`@ts-nocheck`、关闭严格检查或大范围
   eslint-disable 掩盖问题。
7. **依赖可复现**：不得删除 lockfile 碰运气，不用 `--force`/`--legacy-peer-deps` 掩盖根因。
8. **生命周期**：Electron、Tab、WebContents、数据库、监听器、临时目录和异步任务必须有幂等清理。
9. **日志与证据**：运行日志写受控 `log/` 或生产 userData，按现有 logger 脱敏且不入库；日志不等于产品事实。
   保留失败原件；验证命令、结果和当前证据索引记入任务文档/Git/progress，不另建长期 Agent 状态源。
10. **风险相称回归**：每次改动先完成受影响范围的检查，集成点与阶段结束执行所需全量门；通过后仅因
    新改动、失败或未解决风险追加验证，不重复运行未受影响的高成本矩阵。

### 3.2 Electron 与浏览器安全

- 远程网页必须保持 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、
  `webSecurity=true`；Tab 不加载应用 preload。
- 远程网页不得访问 Electron API、文件系统或内部数据；preload 只暴露最小白名单，禁止整体暴露
  ipcRenderer；UI 自身导航/重定向只允许入口文档；`window.open` 默认拒绝。
- React UI 不直接访问 webContents；BrowserController 是浏览器能力统一入口。
- AI/网页/模型永远不能获得 shell、eval、任意 JavaScript、任意文件系统、任意 HTTP POST、
  任意 Electron IPC、任意 SQL 或任意通用数据库工具。
- Browser Tool 权限由确定性 PermissionPolicy 决定：L0 自动、L1 自动且显著展示、L2 用户确认、
  L3 禁止；模型和网页不能改写工具列表、权限矩阵或 system prompt。

### 3.3 凭据、隐私与 Provider

- API Key 不进入源码、Git、日志、prompt、网页、renderer 可读通道、会话文件、sources.db、
  research.db 或报告；设置界面只写不读，只返回 hasKey。
- 持久化凭据仅使用 safeStorage/Windows DPAPI 密文；真实 Provider 通过仓库外说明、DPAPI 文件与
  受控 harness 注入，Key 不出现在命令行参数和工具输出。
- 真实 Provider 已获长期授权（决议 #117）：只有明确开发、验收、定位或复验目的才调用；
  不设固定次数但禁止无界/无诊断重复；凭据缺失写“凭据不可用”，不得伪称未获授权或用
  FakeProvider 冒充真实证据。报告只记调用次数、用途和结果分类。
- 网页、Source note、Tool Result、模型输出都视为不可信；分别放入固定 UNTRUSTED 块，system
  指令保持编译期常量。模型思维、完整 transcript 和 capture 正文不得持久化。

### 3.4 SQLite、Sources、Research 与 Watch 数据边界

- SQLite driver 固定为 `node:sqlite`；Sources 使用 sources.db，Research 使用独立 research.db，
  Watch 使用独立 watch.db。
- 业务 SQL 只能位于 Repository 的编译期常量或 migration，用户/网页/模型文本只能作为 prepared
  statement 参数。禁止动态 `exec(sql)`、动态表/列/排序表达式和 SQLite 扩展加载。
- renderer、preload、AgentLoop 和 Tool 实现不得执行 SQL；模型没有 SQL 通道。
- Source 工具固定为有界检索/读取与 change set 写入；AI change set ≤20 项，必须具备幂等键并经
  preview → L2 确认 → expectedVersion 复验 → 单事务 → durable Undo。AI 推断的 trust
  永远是 unverified。
- Sources 数据库、备份和 change journal 不进模型上下文；Research capture 正文零落盘。
- Research Evidence/Result 只持久化经过确定性验证的有界投影；数据库 v1 本地明文边界必须如实说明。
- Watch 原始 HTTP body 与 PageSnapshot 正文零落盘；只持久化经过确定性验证的有界投影、
  Diff、Condition、Event 与 typed old/new Evidence，哈希不得作为唯一 Evidence。

### 3.5 Research 稳定边界

- Research 使用独立有界 ResearchRuntime，不修改 AgentLoop 的 12 步/420s 契约。
- ToolRegistry 仍保持 17 个工具；Research 模型轮只使用六工具编译期子集，不新增 Research 工具。
- 任务 Tab 采用精确 tabId 所有权；只关闭本任务创建的 Tab，用户 Tab 永不关闭。
- Result Schema 闭合白名单；Markdown raw HTML 关闭、URL 仅 http/https、失败纯文本降级；
  CSV 只经主进程 dialog 安全通道并防公式注入。
- Research 产品运行时不做多 Agent/Planner-Worker、无限上下文/无限步骤、Timeline/Chart、
  跨重启续跑、云同步、多用户、向量数据库或任意渲染库。
- threat-model 的“结构性防御/诚实限制/观察项”必须分开报告，不宣称语义层完全免疫。

### 3.6 Sixth Stage 产品边界

- Watch 只在应用进程存活期间运行；仅支持固定间隔与每日时刻，不做 cron、系统服务或退出后后台运行。
- Public 采集使用 Node 核心 HTTP/HTTPS，仅允许 80/443，逐跳执行 DNS/重定向/robots 校验，
  不发送 Cookie、不执行 JavaScript、不加载子资源。Session 采集必须使用明确的 task-owned Tab
  获取路径，与 Public 共用主进程 HostRequestGate；不持久化 tabId/Cookie，不导航或关闭用户 Tab。
- Diff、Condition 与 Event 必须确定性产生；每个 Event 保留可解释的 typed old/new Evidence，
  不能只有哈希。AI 只能生成可选的 digest 解释，不能成为事实判定器。
- Source locator fingerprint 与 Source row version 分离；采集正文零落盘，watch.db 只保存有界投影，
  并执行正式设计规定的预算、保留期与清理策略。
- 不提供任意 HTTP、任意 JavaScript、正则条件、AI 条件规则、退出后 RSS 后台服务或云同步。

### 3.7 GitHub 代理与双远程

- Gitee 直连。GitHub 任何 fetch/pull/push/Release 前必须先确认代理可用；本机 Git 只认
  `http.proxy`，使用 `-c http.proxy=http://127.0.0.1:7890`，不要依赖无效的 `https.proxy`。
- Reviewer PASS 前候选提交不 push；Closer 才推两个远程。任一远程失败必须如实报告并保留
  可恢复的本地提交状态。

## 4. 项目结构

```text
D:\AIbrowse\
├── AGENTS.md / ROADMAP.md / <Stage>.md
├── .agents/skills/
│   ├── project-rules/PROJECT_RULES.md
│   └── vibe-coding-workflow/references/prompt-templates.md
├── doc/
│   ├── stage2/ … stage6/                  # 各 Stage 冻结设计、威胁模型、任务
│   └── tasks/progress.md                  # 唯一当前进度源
├── src/
│   ├── main/
│   │   ├── index.ts / logger.ts / smoke*.ts
│   │   ├── browser/                       # Controller/Tab/Page/Session
│   │   ├── ai/                            # Provider/Conversation/Agent/Tools
│   │   ├── sources/                       # Sources domain/repository/service/store
│   │   └── research/                      # Research domain/runtime/validators/store/IPC
│   ├── preload/                           # 最小 bridge 白名单
│   ├── renderer/                          # React UI
│   └── shared/                            # 共享类型与纯逻辑
├── log/                                   # 运行时日志，gitignored
├── tools/                                 # 验收工具源码的受控位置（按任务建立）
├── package.json / package-lock.json
└── electron.vite.config.ts / vitest.config.ts / tsconfig*.json / eslint.config.mjs
```

目录职责或接口变化先看对应 detailed-design；本节不记录某个 D/C/B/A 任务当前是否完成。

## 5. 稳定契约速查

### 5.1 Browser Core

- `BrowserController`：create/close/activate/navigate/back/forward/reload/getTabs/getActiveTab/
  getPageSnapshot/dispose；UI 专用可见性能力不进入 AI 接口。
- 每个 Tab 一个 WebContentsView，使用 `persist:aibrowse` Session；最后一个用户 Tab 关闭后按产品
  契约补空白 Tab，dispose 路径不触发该策略。
- PageSnapshot 由主进程盖章 `capturedAt/readyState/documentId/degraded/warnings`；页面输出先经
  normalize，L0–L3 降级，未知 tabId 返回 null。
- elementId 与文档世代绑定；导航/刷新后旧 id 必须 stale，执行时重新定位并复核语义。

### 5.2 AI 共读与 Provider

- `ConversationService.ask` 在提问时刻获取活动 Tab 与实时快照，禁止复用缓存快照防止串页。
- 网页上下文只进入 user 消息的 `UNTRUSTED_WEB_CONTENT` 块；`SYSTEM_PROMPT` 为常量。
- LLMProvider 使用 OpenAI-compatible fetch+SSE；FakeProvider 只用于确定性离线测试。
- SecureCredentialStore 只写密文，renderer 无读 Key 通道；会话不持久化快照正文。

### 5.3 Browser Agent

- AgentLoop 最大 12 步、总超时 420 秒，支持取消、防循环和终态单一所有权。
- ToolRegistry 固定 17 工具：8 个只读/导航、4 个交互、`search_web`、4 个 Source 工具。
- 所有工具调用经过 schema 校验、确定性权限、必要确认、执行和恰好一条脱敏审计。
- Tool Result 进入 `UNTRUSTED_TOOL_RESULT`；fill 值只记录长度，持久化 toolCalls 的 URL query 值脱敏。

### 5.4 Sources

- 唯一入口 SourceService；UI 与 Agent 共用同一语义，audience 明确区分 user/agent。
- FTS5/trigram + 有界降级检索；sharing mode 为 full/metadata/blocked；note 摘录有界。
- canonicalization、provenance、change set、journal、Undo、usage、backup/recovery 的唯一契约源为
  `doc/stage4/detailed-design.md`；安全边界见 `doc/stage4/threat-model.md`。
- Source Tool 不新增网络能力；打开/读取仍经 browser_open/browser_read。

### 5.5 Research

- Fifth Stage Exit Gate 已 `GO/PASS`，现作为已完成历史阶段维护。
- 唯一契约源：`doc/stage5/detailed-design.md`；安全契约：`doc/stage5/threat-model.md`。
- ResearchTask 状态、候选合并排序、Capture/Evidence、Cross-check/Conflict、Result Schema、
  存储、Tab 所有权、IPC、预算和决议以详细设计当前章节为准，不在本文件复制任务完成状态。
- Research 六工具编译期子集：browser_open/browser_read/search_web/source_search/source_list/
  source_get；执行语义为 Research 专属且只读。
- SourceSelector 只接受已校验候选；收藏不自动等于可信，trust 不改变确定性基础排序。
- Evidence 必须绑定本任务 capture/candidate；URL、标题、时间、documentId 取主进程记录；
  未验证引用不得渲染为证据。
- Conflict、Coverage、fetchedAt、evidenceMap 等可信字段由程序生成；模型草案不能控制。
- Renderer 不使用 `dangerouslySetInnerHTML`，Evidence 下钻显示来源与诚实边界；导出只包含当前
  Table 视图，不包含 Evidence 摘录或任意文件路径。

### 5.6 Watch（正式设计；D1–D9 已实现）

- 唯一契约源：`doc/stage6/detailed-design.md`；安全契约：`doc/stage6/threat-model.md`；
  任务契约：`doc/stage6/tasks/D1–D11`。
- D1 logger/Clock、D2 域契约/状态机/条件引擎、D3 安全 Feed/Public 网络/解析器、
  D4 watch.db/Source 生命周期观察协议、D5 Scheduler/RunCoordinator/共享 HostRequestGate、
  D6 页面 Region/Session 授权/有界 PageProjection、D7 确定性 Diff/Baseline/Event·
  Evidence/health 与 D8 Digest/Sharing/可选 AI Explanation 均已实现并经独立 Reviewer `PASS`
  （D3 为独立安全审查，D8 为独立持久化/隐私审查）；其余任务状态
  与下一唯一动作只看 `doc/tasks/progress.md`。
- D8 已按正式契约实现 observation journal cursor、可恢复 cycle/batch、Schedule/run/Provider 闭合
  状态机、原子 scrub 与 v4 fail-closed migration，并经独立持久化/隐私 Reviewer `PASS`。
- Schedule、采集、Diff、Condition、Event、Evidence、网络边界、Session task-owned Tab、
  Source 观察协议、watch.db 和保留策略均以正式设计为准。D9 Watch 工作区、严格 IPC/bridge、
  通知隐私与安全导出已实现并经新的独立安全/隐私 Reviewer `PASS`。
- old/new Evidence 必须可解释且类型化，不能只保存哈希；AI digest 只解释确定性事件事实。
- D3 的三个解析依赖已通过资格门并按技术基线精确固定版本。

## 6. 常用命令

### 6.1 本地环境

- `node --version` 应为 24.x；版本不符先修环境，不用 `--force`。
- 本机可能存在全局 `ELECTRON_RUN_AS_NODE=1`，不要改全局值。启动 Electron 前在当前进程清除：
  PowerShell `$env:ELECTRON_RUN_AS_NODE=$null`。
- Electron 依赖下载需要代理时使用 `NODE_USE_ENV_PROXY=1`、`HTTP_PROXY`、`HTTPS_PROXY`；
  D3 的三个解析依赖已通过正式资格门并精确安装；后续依赖变更仍须先获任务授权并通过对应门禁。

### 6.2 质量与运行

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npm run format:check
npm run build

$env:ELECTRON_RUN_AS_NODE=$null
$env:AIBROWSE_SMOKE='1'
npm run dev

# 已构建产物
npm run start
```

- 默认冒烟矩阵、专属门控和场景编号以 `src/main/smoke*.ts` 与当前 Stage 测试规格为准，
  不在本文件复制每个场景和临时测试数字。
- 跨进程门控：`AIBROWSE_SESSION_SMOKE=set|check`、`AIBROWSE_SOURCES_SMOKE=set|check`、
  `AIBROWSE_SOURCES_UI_SMOKE=set|check`、`AIBROWSE_RESEARCH_SMOKE=set|check`；必须使用受控临时
  userData，结束精确清理。
- 真实 Provider 统一经仓库外 `%LOCALAPPDATA%\AIbrowse\S5\run-live-smoke.ps1` 和 DPAPI 凭据；
  开关、互斥与场景以仓库外说明和当前 smoke gate 为准。不得把机器路径、base URL、model 或
  凭据复制进仓库文档。

### 6.3 Git（仅 Closer 在 PASS 后 push）

```powershell
git status --short --branch
git log --oneline --decorate -12
git diff --check

git push gitee main
git -c http.proxy=http://127.0.0.1:7890 push github main
```

## 7. 测试与验收约定

- Vitest 默认按单 worker 执行：`npm test -- --maxWorkers=1`，避免墙钟/资源竞争造成边缘抖动。
- 纯逻辑测试与 Electron 壳分层；Electron 生命周期、真实 DOM、Session、数据库跨进程和
  WebContentsView 行为由 dev+production 冒烟验证。
- FakeProvider 证明确定性协议，不证明真实 Provider 兼容或语义质量；需要真实验收时必须走受控
  harness、真 Key 零暴露扫描与调用台账。
- 红队结论区分结构边界、诚实限制和观察项；不能用日志字符串或 FakeProvider 冒充产品事实。

| 改动类型                   | 当前增量最低验证                                                                      | 集成与独立验证                                                     |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 纯文档/流程                | 相关文档一致性搜索、变更文件格式、`git diff --check`、diff/敏感信息/状态终检          | 新增或改变代码事实声明时，核对相应代码/证据并按需复跑聚焦测试      |
| 纯逻辑/共享类型            | 甄别性聚焦测试、受影响类型/lint/格式检查与 diff-check                                 | 合并相关增量后跑受影响集成及必要全量回归；构建边界变化加 build     |
| 主进程/renderer/preload    | 受影响测试、typecheck/lint/格式与 build                                               | dev+production 相关冒烟；跨模块集成或发布候选跑所需全量门          |
| 数据库/迁移/安全/权限/并发 | 上述适用检查及敌手矩阵、恢复/跨进程/红线扫描                                          | 新独立 Reviewer；风险边界覆盖完整，必要时全量与真实受控场景        |
| 验收工具                   | 解码/判定/清理反例、离线回放、构建及最小可行性检查                                    | 新采集方案先证明适用性再长测；安全或并发关键工具独立审核           |
| Stage Exit Gate            | 当前候选的全量 test/typecheck/lint/format/build、全冒烟/门控、红线/隐私及正式真实条件 | 新独立 Stage Auditor；逐项判定 Exit Gate，明确复用证据与非阻断观察 |

Reviewer 必须记录实际命令、退出码、测试范围和任何 NOT RUN 理由；AGENTS.md 不保存瞬时用例数。

## 8. 已知长期限制

- PageSnapshot v1 主要采集主文档；跨域 iframe 为降级边界。页面主世界原型篡改可能使采集降级，
  不得为提高覆盖关闭 Electron 安全机制。
- shared/url 不直接支持 IDN；不明确的输入走搜索兜底。
- 日志保留/大小、ConversationStore 字节上限、Vitest 默认 worker 固化、冒烟耗时、CI 与打包仍有
  后续硬化空间；当前分级与处理计划只看 `doc/tasks/progress.md` 的开放风险登记。
- 开发日志位置与打包后 userData 不同；排障时先确认运行形态。
- 本机 GitHub 代理与 `ELECTRON_RUN_AS_NODE` 是环境事实，不得通过修改用户全局配置“修复”。
