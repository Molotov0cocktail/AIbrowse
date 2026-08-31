# AGENTS.md — AIbrowse 项目专属开发手册

> 本文件只保存长期工程规则、稳定架构、永久红线、技术基线与当前 Stage 契约速查。
> 当前任务状态、HEAD、验证数字和执行历史只写入 `doc/tasks/progress.md`、任务文档与 Git，
> 不在本文件复制。通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`；
> 项目专属规则与通用基线冲突时，以本文件为准。

## 1. 项目概览

- **定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」。应用内置 Chromium
  多标签页浏览器，用户与 AI 共享同一浏览器会话和登录状态；AI 只能经受限、可审计的
  BrowserController / Tool Layer 操作浏览器，不拥有任意系统权限。
- **当前 Stage**：Sixth Stage——RSS/Page Watch、确定性变更事件与摘要。正式设计已经独立
  Reviewer `PASS`，D1–D9 已实现并闭环。需求见 `Sixth_stage.md`；唯一产品契约源为
  `doc/stage6/detailed-design.md`，安全契约源为 `doc/stage6/threat-model.md`，任务契约为
  `doc/stage6/tasks/D1–D11`。具体完成项、当前 HEAD 与下一唯一动作只看
  `doc/tasks/progress.md`。
- **阶段纪律**：本轮纯设计授权与 D1–D9 已闭环；D8 实施前 REPLAN 与产品实现均已经新的独立
  持久化/隐私 Reviewer `PASS`，D9 已经新的独立安全/隐私 Reviewer `PASS`。下一唯一任务只看
  `doc/tasks/progress.md`；D3 已经新的独立安全 Reviewer `PASS`。
- **已完成阶段**：第一阶段浏览器核心、第二阶段 AI 共读、第三阶段 Browser Agent、第四阶段
  Sources、第五阶段 Research 均已通过各自 Exit Gate。历史需求、契约与验收证据分别留在
  对应 Stage 文件、`doc/stage2/`～`doc/stage5/`、任务文档和 Git 中，不在本文件复述执行轮次。

### 1.1 稳定架构

依赖方向不可反向或跳跃：

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
- Node.js 24.x（`.node-version` = 24.18.0，`engines.node` = `>=24 <25`）；Electron 43.4.0；
  electron-vite 5.0.0；Vite 7.3.6；React 19.2.8；TypeScript 6.0.3；Vitest 4.1.10；
  ESLint 10.8.1；Prettier 3.9.6。
- 依赖精确版本固定，无 `^`/`~`；`.npmrc` `save-exact=true`；`package-lock.json` 必须入库。
  main/preload 输出 CJS，preload 必须兼容 `sandbox=true`。
- 核心工具链不得擅自升级。升级必须先说明理由，验证 typecheck/lint/test/build/Electron
  冒烟，更新长期文档后再提交。
- D3 的三个解析依赖已通过资格门并精确安装：`@federicocarboni/saxe@0.8.0`、
  `parse5-sax-parser@8.0.0`、`parse5@8.0.1`；不得擅自替换或升级。Provider 适配继续使用
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

### 2.2 Step 0：每个新会话先独立接管

1. 完整阅读本文件、当前 Stage 文件、当前 Stage 的 proposal/high-level-design/
   detailed-design/threat-model/相关 task 文档及 `doc/tasks/progress.md`。
2. 检查 `git status --short --branch`、最近若干条 `git log --oneline --decorate`、远程与分支。
3. 阅读本次任务相关代码、测试、配置和最近候选提交；记录 baseline SHA。
4. 运行与风险相称的只读基线验证；不采信上一 Agent 的“已完成/全绿”自述。
5. 核对契约、progress、Git、代码与测试。契约事实看正式文档，工程事实看 Git/代码/机器验证；
   发现漂移先记录并在本闭环内修正对应事实源。
6. 然后才能形成 Execution Contract 或开始经批准的修改。

### 2.3 四个角色

#### Planner — Codex GPT-5.6 Sol

- 独立调查仓库、理解需求，判断是否需要正式设计变更。
- 冻结架构、边界、不变量、安全约束、测试 oracle、风险与歧义。
- 把当前唯一任务压缩为 Execution Contract；任务文件已完整时引用它，只补本次 baseline、
  实施顺序和停止条件。
- 默认只读。规划任务不得顺手修改产品代码；需要改变正式契约时，先修改契约并获得所需裁决。
- 不承担常规机械实现；当前环境没有可用 Executor 时，不得假装已经委派或验证。

#### Executor — OpenCode + DeepSeek

- 只按已批准的 Execution Contract 实现；可做合同范围内的局部代码设计。
- 执行红→绿测试、typecheck/lint/build/smoke、diff 自审和结构化证据汇报。
- 可以创建有界的 local logical candidate commit(s)，但默认不得 push。
- 不得重设已冻结架构、公共接口、不变量、安全边界或验收 oracle。

Repair Worker 同样使用 OpenCode + DeepSeek，只能按 Reviewer 给出的 Repair Contract 追加有界
修复候选提交；不能借修复重开设计或扩大任务。

遇到以下任一情况必须停止并返回 Planner：

- Contract、正式文档与实际代码存在实质冲突；
- 需要改变既定架构、公共接口或显著扩大范围；
- 安全、隐私、数据完整性边界不明确；
- 测试疑似与正式契约冲突；
- 同一根因连续两轮修改仍失败；
- 存在两个显著不同且长期影响较大的方案；
- 需要用户裁决、密钥、账号、外部权限或不可逆操作。

#### Reviewer — Codex GPT-5.6 Sol

- 独立确认 baseline，审查 `baseline..HEAD` candidate diff、关键代码、测试和范围。
- 按风险复跑必要验证；核对验收条件、文档同步、敏感信息、垃圾文件和工作区状态。
- 不因 Executor 声称“全部通过”而 PASS；输出只能是 `PASS` / `REPAIR` / `REPLAN` /
  `BLOCKED`，并附证据。
- `REPAIR` 必须产出有界 Repair Contract；修复后重新 Reviewer。

普通任务可由同一 Sol 会话承担 Planner 与 Reviewer。下列情况必须使用新的独立 Sol 上下文：

- Stage Exit Gate；
- 安全/隐私关键任务；
- 数据迁移或持久化高风险任务；
- 大规模架构变化；
- 用户明确要求独立验收。

#### Closer

只有 Reviewer=`PASS` 后才执行：

- 更新 `progress.md`；仅在长期规则或稳定架构变化时更新本文件。
- 运行最终状态检查，完成批准的收尾提交。
- 按代理与双远程规则 push；报告交付证据与下一唯一任务。
- Closer 可由 DeepSeek 执行，因为其工作必须是已批准、确定性的收尾；不得借收尾扩大范围。

### 2.4 Execution Contract 标准

Planner → Executor 的临时交接至少包含以下固定字段：

```text
TASK
BASELINE
GOAL
NON-GOALS
AUTHORITATIVE SOURCES
CURRENT VERIFIED STATE
FIXED DECISIONS
INVARIANTS / RED LINES
EXPECTED SCOPE
IMPLEMENTATION PLAN
TEST PLAN
ACCEPTANCE
STOP / ESCALATE CONDITIONS
FINAL EVIDENCE
```

- `BASELINE` 必须是候选实现开始前的精确 SHA；Reviewer 以它审查 `baseline..HEAD`。
- `AUTHORITATIVE SOURCES` 引用具体文档章节，不复制整个项目文档。
- `EXPECTED SCOPE` 写预期文件/模块及允许的例外处理；出现范围外文件必须解释或停止。
- `TEST PLAN` 明确红态 oracle、聚焦验证、全量验证和适用的冒烟/真实 Provider 条件。
- `ACCEPTANCE` 必须客观可判；`FINAL EVIDENCE` 规定提交、命令、结果、diff 与剩余风险格式。

模板位置：`.agents/skills/vibe-coding-workflow/references/prompt-templates.md`。模板不写动态 HEAD、
当前任务状态、临时测试数字或凭据。

### 2.5 执行、审核与修复循环

```text
Planner 调查并批准 Execution Contract
  → Executor 实现/验证/自审/local candidate commit(s)/STOP
  → Reviewer 独立审核
      PASS    → Closer 更新事实源/最终验证/提交/push
      REPAIR  → Repair Contract → Executor 修复 → Reviewer 重审
      REPLAN  → Planner 重做设计或 Contract
      BLOCKED → 明确外部阻塞与所需用户/环境动作
```

- 一个新对话约等于一个可验证闭环；任务小，但必须同时有目标、非目标、验收、测试和完成定义。
- 无需为了该流程强制引入 Git worktree；默认使用简单、可恢复、可审计的本地候选提交。
- 同一批文件不得并行修改；保护用户现有修改，不 reset/checkout/clean 覆盖未知工作。
- 发现缺陷必须先定位根因并建立能甄别新旧实现的红态测试；测试契约有误时先 REPLAN，
  不得修改测试迁就实现。

### 2.6 Git、提交与 push 边界

1. Planner 记录 baseline，不改产品代码。
2. Executor：实现 → 验证 → diff 自审 → local logical candidate commit(s) → STOP。
3. Reviewer：独立审查 `baseline..HEAD`，必要时复跑验证；Reviewer 未 PASS 前不得把候选状态
   push 为远程完成状态。
4. Closer：Reviewer PASS 后更新 progress/docs、最终检查、完成收尾提交，再推 Gitee 与 GitHub。
5. REPAIR 只允许按 Repair Contract 追加修复候选提交；不得重写已公开历史或用 amend 掩盖审计链，
   除非用户明确要求且远程历史未受影响。

既有任务文档完成定义中的“提交/双远程推送”描述的是整个任务经 Reviewer PASS 后的最终关闭状态，
不授权 Executor 在审核前 push。

提交前必须清除并复查临时文件、缓存、探测脚本、日志、截图、测试/安装残留和构建杂项；
不得提交凭据、用户数据、机器专属配置或仓库外 harness。

### 2.7 阶段切换

- 当前 Stage 只有在 Exit Gate 逐项通过、`progress.md` 无阻塞缺陷、全量验证通过并经独立
  Stage Auditor 后，才可由用户指令切换下一 Stage。
- Stage Auditor 必须使用新的独立 Codex GPT-5.6 Sol 上下文，不采信当前 Stage 各实现任务报告
  或既有验收总结，按当前 HEAD 独立复验。
- Fifth Stage 的产品非目标“多 Agent 编排 / Planner-Worker”只约束 AIbrowse 产品运行时
  Research 架构；不限制开发过程中使用外部 Sol Planner + DeepSeek Executor + Sol Reviewer。

## 3. 规则与永久护栏

### 3.1 通用质量纪律

1. **红→绿**：代码行为变化先写能甄别新旧结构的测试，确认红态，再做最小实现到绿。
2. **测试不得迁就实现**：禁止删除/跳过有意义的测试或降低断言；契约疑似错误走 REPLAN。
3. **最小改动**：只修改 Contract 范围；不顺手重构，不覆盖用户工作，不夹带下一任务。
4. **分层**：核心逻辑纯函数、零环境依赖；Electron/IO/UI 保持薄胶水。
5. **安全失败**：敌手或越界输入 fail-closed，返回受控错误/空结果，不回显敌手正文。
6. **严格 TypeScript**：禁止用 `any`、`@ts-ignore`、`@ts-nocheck`、关闭严格检查或大范围
   eslint-disable 掩盖问题。
7. **依赖可复现**：不得删除 lockfile 碰运气，不用 `--force`/`--legacy-peer-deps` 掩盖根因。
8. **生命周期**：Electron、Tab、WebContents、数据库、监听器、临时目录和异步任务必须有幂等清理。
9. **日志**：运行日志写受控 `log/` 或生产 userData，按现有 logger 脱敏；日志不入库。

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

| 改动类型                | 最低验证                                                                                       | 追加验证                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 纯文档/流程             | 文档一致性搜索、`npm run format:check`（适用文件）、`git diff --check`、diff/敏感信息/状态终检 | 文档声称代码事实时，复跑相应聚焦测试     |
| 纯逻辑/共享类型         | 聚焦红→绿 + 全量 test + typecheck + lint + format:check + diff-check                           | 影响构建边界时 build                     |
| 主进程/renderer/preload | 上述全量验证 + build                                                                           | dev+production 相关冒烟                  |
| 数据库/迁移/安全/权限   | 上述验证 + 敌手矩阵 + 恢复/跨进程/红线扫描                                                     | 新独立 Reviewer；必要时真实受控场景      |
| Stage Exit Gate         | 当前 HEAD 全量验证、全冒烟/门控、红线与隐私扫描、真实 Provider 条件                            | 新独立 Stage Auditor；逐项判定 Exit Gate |

Reviewer 必须记录实际命令、退出码、测试范围和任何 NOT RUN 理由；AGENTS.md 不保存瞬时用例数。

## 8. 已知长期限制

- PageSnapshot v1 主要采集主文档；跨域 iframe 为降级边界。页面主世界原型篡改可能使采集降级，
  不得为提高覆盖关闭 Electron 安全机制。
- shared/url 不直接支持 IDN；不明确的输入走搜索兜底。
- 日志保留/大小、ConversationStore 字节上限、Vitest 默认 worker 固化、冒烟耗时、CI 与打包仍有
  后续硬化空间；当前分级与处理计划只看 `doc/tasks/progress.md` 的开放风险登记。
- 开发日志位置与打包后 userData 不同；排障时先确认运行形态。
- 本机 GitHub 代理与 `ELECTRON_RUN_AS_NODE` 是环境事实，不得通过修改用户全局配置“修复”。
