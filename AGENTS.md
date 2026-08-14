# AGENTS.md — AIbrowse 项目专属开发手册

> 依据 `.agents/skills/project-rules/PROJECT_RULES.md` §8 于 2026-08-13 初始化；
> 与根目录 `Third_stage.md`（当前阶段需求/验收标准）、`ROADMAP.md` + `First_stage.md` /
> `Second_stage.md`（已完成）、`Fourth_stage.md`～`Seventh_stage.md`（后续阶段需求与验收
> 标准）配套；技术基线已于 2026-08-13 按官方来源验证冻结（§1）。
> 新会话接管顺序：本文件 → 当前阶段文件（现为 `Third_stage.md`）→ `doc/tasks/progress.md`
> → git 状态与代码核对（§2 步骤 0）。
> 与本文件冲突时以本文件为准，通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`。
> 任务进度不记在本文件：唯一进度源 `doc/tasks/progress.md`（本文件仅在有长期变化时更新，见 §2）。

## 1. 项目概览

- **一句话定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」——内置 Chromium 的
  多标签页浏览器，用户与 AI 共享同一浏览器会话与登录状态；AI 仅通过受限
  BrowserController / Tool Layer 操作浏览器，不得拥有任意系统权限。
- **当前阶段（第三阶段，Browser Agent）**：让 AI 可以通过受限、可审计、可撤销的
  Tool Layer 自主完成低风险浏览任务——tool-calling 兼容层（T1 硬前置）、Tool Registry、
  SearchProvider、scroll/click/fill/find 交互能力（elementId 生命周期）、最小可控
  Agent Loop（最大步数/超时/取消/防循环）、确定性权限分级与确认状态机（L0 自动 /
  L1 自动显著展示 / L2 用户确认 / L3 禁止）、操作可见性与审计日志。契约源
  `doc/stage3/detailed-design.md`（2026-08-14 定稿）+ 安全契约源
  `doc/stage3/threat-model.md`（Prompt Injection 威胁模型已按第二阶段约定重建，
  先于任何 Browser Tool 实现）；任务 T1–T8 见 `doc/stage3/tasks/`。
  **设计定稿与任务拆分已完成（2026-08-14），尚未开始实现**——第一个实现任务 T1
  （tool-calling 兼容层）为硬前置：T1 验证通过前禁止引入任何 Browser Tool 实现
  （Entry Gate「tool calling」项校正方式，见 doc/stage3/proposal.md §8）。
  核心原则：AI 决定「需要做什么」；确定性程序决定「是否允许、如何执行、执行结果
  是什么」。AI 不得直接获得 Electron API、webContents、Node.js、shell 或任意
  JavaScript 执行权限。
- **已完成（第二阶段，AI 共读）**：PageSnapshot / Selection → AI Context →
  Conversation——AI 侧栏、ConversationService、ContextBuilder、LLMProvider
  （OpenAI-compatible + FakeProvider）、SecureCredentialStore（safeStorage/DPAPI）。
  §9 验收逐项通过 + §10 Exit Gate 通过（2026-08-13）；用户独立复验发现 4 项
  非阻塞缺陷已修复并全量回归（2026-08-14，证据见 progress.md）。
- **已完成（第一阶段，浏览器核心）**：`Browser → PageSnapshot → Browser Tool Interface`
  ——BrowserController/TabManager/PageReader/SessionManager + WebContentsView 多标签浏览器 +
  PageSnapshot 采集 + 调试面板；Exit Gate 已于 2026-08-13 通过（First_stage.md §十四）。
- **阶段机制**：`ROADMAP.md` 描述全阶段路线与切换原则；各阶段需求/验收标准分文件存放
  （当前 `Third_stage.md`；已完成 `First_stage.md` / `Second_stage.md`；后续
  `Fourth_stage.md`～`Seventh_stage.md`）。当前处于第三阶段；**只有当前 Stage 的
  Exit Gate 通过后才切换下一 Stage**（纪律见 §2 文档职责划分）。
  各 Stage 文件的完整内容不复制进本文件，需要时直接读对应 Stage 文件。
- **技术栈**：Electron + TypeScript + React + Vite + Node.js；页面承载用官方当前推荐的
  **WebContentsView**（禁用已废弃的 BrowserView）；测试 **Vitest**、lint **ESLint**、格式 **Prettier**。
  本阶段明确禁用：Playwright（作为浏览器主体）、SQLite、向量数据库、RSS、Research Agent、
  图表系统、登录账号系统、云同步、厂商 LLM SDK（Provider 调用用原生 fetch + SSE 自实现，
  零新依赖）、Markdown/富文本回答渲染库。⚠️ LLM API 调用**允许**（本阶段核心）但仅限
  主进程内 Provider 适配器发起；API Key 不得进入源码/日志/prompt/网页/renderer 可读通道。
  若某技术选择与最新版 Electron 明显不兼容，可选更合理实现，但**必须在修改前说明原因**。
  **技术基线（2026-08-13 按官方来源验证后冻结）**：Node.js 24.x（Active LTS，本机 24.18.0；
  Electron 43.4.0 内置 Node 24.18.1，运行时实测）/ Electron 43.4.0 / electron-vite 5.0.0 / Vite 7.3.6 /
  @vitejs/plugin-react 5.2.0 / React 19.2.8 / TypeScript 6.0.3（typescript-eslint 8.67.0 官方支持范围
  `>=4.8.4 <6.1.0`）/ Vitest 4.1.10 / ESLint 10.8.1（flat config）/ Prettier 3.9.6；
  依赖全部精确版本固定（无 ^/~，`.npmrc` save-exact=true），`engines.node` `>=24 <25` +
  `.node-version` = 24.18.0；main/preload 输出 CJS（preload 必须 CJS 以兼容 `sandbox=true`）。
  ⚠️ **基线冻结**：第三阶段内任何 Agent 不得擅自升级上述核心工具链；升级必须走 §3「技术基线升级流程」。
- **交付形态**：Windows 桌面应用（Electron 产物）。
- **git 双远程**（用户已提供，2026-08-13）：
  - Gitee（默认推送目标，国内直连，无需代理）：
    `https://gitee.com/Molotov0coaktail/aibrowse`
  - GitHub（任何网络操作前必须先启用并确认代理，见 §3 代理红线）：
    `https://github.com/Molotov0cocktail/AIbrowse`
  - ✅ 两个平台用户名拼写不一致（Gitee `Molotov0coaktail` / GitHub `Molotov0cocktail`）——
    2026-08-13 已按用户提供的地址实际推送成功，URL 均正确；推送用本机已存凭据。
- **团队语言（中英混合）**：界面文案 / 错误信息 / 日志 / 提交信息 / 文档 → **中文**；
  代码注释 → **英文**。提交信息格式 `<type>: <中文描述>`，
  type ∈ feat / fix / docs / refactor / test / chore / perf；一条提交一个逻辑变更，写「为什么」。

## 2. 工作流程

### 文档职责划分（唯一权威 + 单一事实源）

```
ROADMAP.md（全阶段路线与切换原则，低频修改）
  ↓
当前阶段文件 Third_stage.md（已完成 First_stage.md / Second_stage.md；后续
Fourth_stage.md～Seventh_stage.md，Exit Gate 通过后依次启用）
  ↓
AGENTS.md（长期规则/稳定架构/技术基线，低频修改）
  ↓
doc/（第一阶段历史：proposal / high-level-design / detailed-design，定稿不覆盖；
    Second Stage 起：doc/stage2/（定稿）、doc/stage3/（当前）… 各自独立的
    proposal / 高层设计 / 详细设计 / 任务文档——目录约定 2026-08-13 起）
  ↓
doc/tasks/progress.md（当前工程状态/短期记忆，高频更新）
  ↓
Git + 代码 + Test/Typecheck/Lint/Build/冒烟（真实历史与机器验证）
```

- **阶段切换纪律**：当前处于第三阶段。只有当前 Stage 的 **Exit Gate** 全部通过（逐项核对该 Stage
  文件的 Exit Gate/验收标准、progress.md 无阻塞级缺陷、全量验证通过）后，才可切换到下一 Stage；
  切换按 ROADMAP.md「阶段切换原则」执行；阶段完成后**停下向用户报告**，不得擅自进入下一阶段
  （Third_stage.md §10 / 本文件附 C）。
- 不引入额外的状态文件 / Agent 日志 / checklist / handoff / summary 文件，除非实际开发证明必要。
- **文档用于理解需求与意图；Git、当前代码、测试和构建结果用于确认项目实际状态。**
  若 progress.md 声称某功能已完成、但代码/Git/测试证明没有：以实际工程状态为事实，修正文档，再继续开发。
  同样，代码存在也不得违背 First_stage.md / AGENTS.md 中的明确需求与安全规则。

### 步骤 0：新对话接管（每次新对话开始先做）

1. 阅读 `AGENTS.md`（本文件）
2. 阅读当前阶段文件（现为 `Third_stage.md`；已完成 `First_stage.md` / `Second_stage.md`，
   后续 `Fourth_stage.md`～`Seventh_stage.md`）
3. 阅读 `doc/tasks/progress.md`（如存在）
4. `git status` + 最近若干条 `git log --oneline`
5. 检查本次任务相关的实际代码和配置
6. 确认文档描述与代码实际状态一致（不一致按上述原则处理）
7. 然后才开始工作

### 步骤链

1. **稳定项目（含 git 前置）**：动工前摸清语言/框架/包管理器/测试/lint/构建/现有约定。
   git 远程已配置（§1）；新建项目时再执行 git init + 双远程 + .gitignore（`log/`、密钥/令牌本地文件、
   构建产物、IDE 个人配置）。
2. **需求澄清**：Third_stage.md 已是阶段需求源（契约源 `doc/stage3/detailed-design.md` +
   安全契约源 `doc/stage3/threat-model.md`）；新需求先写 proposal。
3. **设计先行**：风险、歧义、备选方案必须写明，不得用自信措辞掩盖不确定性。
4. **任务拆分（闭环粒度）**：**一个新对话 ≈ 一个可验证的开发闭环**，不机械等于一个文件或一个模块。
   每个任务明确：目标 / 范围 / 非目标 / 涉及模块 / 验收标准 / 测试方式 / 完成定义。
   任务应尽量小，但必须形成完整、可机器验证的闭环（例：「建立可运行项目基线」= install 成功 +
   typecheck + lint + test + build + Electron 冒烟 + diff 检查 + commit）。
5. **小步实现**：一次一个未阻塞任务；实现 → 补测试 → 跑该任务检查 → 审阅 git diff → 更新 progress。
6. **验证闭环（含提交）**：全量测试 → lint/类型检查 → 冒烟（实际启动 Electron 验证可运行）→
   diff 终检（无关改动/生成杂项/密钥泄漏/意外重写）→ 提交前清除垃圾文件并复查工作区（§3）→
   git commit + push 双远程 → 更新 progress.md → 汇报（改了啥/验证了啥/剩余风险）。
   **提交粒度**：一个 commit = 一个逻辑完整、可验证的变化；任务内部可有多个逻辑 commit；
   禁止每改几行就 commit、把大量无关修改塞进一个 commit、提交失败构建状态、
   把临时脚本/日志/截图/缓存一起提交（§3 提交纪律）。
7. **收尾状态可移交（每次对话结束前）**：检查 git diff 与 `git status --short` → 运行该任务要求的验证
   （必要时全量回归）→ 更新 progress.md → 仅在存在长期变化时更新 AGENTS.md → 提交符合规则的 commit →
   报告：做了什么 / 验证了什么 / 遗留问题 / 下一个最合适的独立任务。
   不留：未说明的半成品、不知道是否保留的临时文件、未记录原因的失败测试、与 progress.md 不一致的工作区。

**AGENTS.md 更新规则**：每个任务**不强制**更新本文件；仅当以下内容发生实质变化时才更新——
工程规则 / 稳定架构 / 重要接口约定 / 技术基线 / 长期开发流程 / 必须让后续所有 Agent 都知道的重要事实。

**询问边界（项目专属，细化 PROJECT_RULES「不确定就问」）**：仅以下情况停下来问用户——
会导致数据丢失 / 需要删除大量已有代码 / 存在两个会显著影响长期架构且无法轻易迁移的方案 /
需要密钥、账号或外部凭据。其余不影响总体设计的小问题自行做合理决定，不频繁询问。

## 3. 规则（护栏）

通用红线（出处：PROJECT_RULES.md §3，全部适用）：

1. **测试权威，不得迁就实现**：禁止改测试让现有实现过关；契约有问题先改设计文档与测试，再改实现。
2. **红→绿纪律**：改动前必写能甄别新旧结构的测试；旧代码也能通过的弱测试无效。
3. **分层纪律**：纯逻辑/核心层零副作用、零环境依赖、可单测；UI/IO/副作用放在外层胶水。
4. **越界安全返回**：越界/异常输入安全返回（undefined/空结果/降级），不抛异常（明确豁免除外）。
5. **最小改动**：只做任务范围内改动；不顺手重构、不碰其他模块、不覆盖用户已有工作。
6. **敏感信息零入库**：密钥/令牌/凭据/用户数据严禁提交（.gitignore 本地文件或环境变量；脚本只读不打印）。
7. **提交纪律**：git commit 前先清除文件夹内多余垃圾文件（临时/缓存/探测脚本/日志/截图/构建残留/
   测试与安装残留），清除后复查工作区；仅提交构建项目所必需的文档（源码/文档/测试/构建配置）；
   禁止提交开发残余文件、用户使用与测试信息、与软件使用配置无关的内容。
8. **清理纪律**：每次作业后清理旧产物、缓存、临时脚本、测试残留目录。
9. **全量回归**：作业完成必跑全量测试（+ 冒烟/构建，见附 A 验证矩阵）。
10. **语言一致**：文案/错误/日志/提交信息用中文，代码注释英文，全项目一致。
11. **详尽日志**：每次软件运行必须生成便于 bug 修复的详尽日志（启动/退出、关键操作路径、
    错误分类与堆栈、耗时、环境信息）；**所有日志统一保存在根目录 `log/`**（按日期/会话轮转），
    `log/` 加入 .gitignore（运行时产物，绝不入库）；用户数据与敏感信息脱敏后记录。

项目特有护栏：

- **GitHub 代理红线**：GitHub 上任何网络操作（拉取/推送/Release）前**必须先启用代理
  （git 代理/系统代理/镜像）并确认可用**，确认前不做任何网络动作；Gitee 直连无需代理。
- **双远程策略**：Gitee 为默认推送目标；GitHub 作为镜像同步（代理确认后推送）。
  每次任务完成两个远程都应更新。
- **架构纪律**（First_stage.md §四）：React UI **不得**直接调用 Electron webContents API；
  **BrowserController 是浏览器能力的统一入口**，依赖方向固定为
  `UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`；
  不把所有代码写进几个巨大文件，从第一天起模块化。
- **AI 子系统架构纪律**（Second_stage.md §5 + doc/stage2/detailed-design.md 定稿）：依赖方向
  `UI(AI 面板) → ConversationService → ContextBuilder / LLMProvider → SecureCredentialStore`；
  网页上下文经 `ConversationService → BrowserController.getPageSnapshot`（**提问时刻实时采集**，
  禁止复用缓存快照——防串页核心）；禁止 LLMProvider 直接访问 webContents；禁止 React Chat UI
  接触 API Key（只写不读）；禁止网页内容直接拼接进 system prompt（只进 user 消息的
  `UNTRUSTED_WEB_CONTENT` 块，system 恒为应用常量）。
- **Agent 子系统架构纪律（第三阶段新增，doc/stage3/detailed-design.md 定稿）**：依赖方向
  `UI(AI 面板) → ConversationService(agent 模式) → AgentLoop → ToolRegistry →
PermissionPolicy / ConfirmManager / ToolExecutor → BrowserController / SearchProvider`；
  工具实现**只经 BrowserController / SearchProvider**操作浏览器（禁止绕过直连 webContents）；
  AgentLoop/AgentContextBuilder 为纯核心零 Electron 依赖；**权限判定为确定性纯函数**
  （模型只是提议者，无任何通道修改工具列表/权限矩阵/system 提示）；Tool Result 与网页
  内容同等视为不可信（`UNTRUSTED_TOOL_RESULT` 块）；审计全量脱敏（fill 值只记长度）。
  **硬前置**：T1 tool-calling 兼容层验证通过前禁止引入任何 Browser Tool 实现
  （proposal §8 Entry Gate 校正方式）。
- **安全红线**（First_stage.md §八，从第一版开始）：远程网页 `nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`（架构允许时）、`webSecurity` 不得关闭；
  远程网页不得直接访问 Electron API / 文件系统 / 程序内部数据；preload bridge 最小权限，
  不把 ipcRenderer 整体暴露给网页；限制不必要的 window.open/新窗口行为；合理处理导航；
  React UI 与远程网页保持明确安全边界。**不得为省事关闭 Electron 安全机制。**
- **API Key 零暴露红线**（Second_stage.md §3.3）：Key 不入源码/日志/prompt/网页/renderer
  可读通道（设置界面只写不回显，`list` 仅回 hasKey）；落盘仅 safeStorage 密文；错误与日志
  只记 provider/model/requestId 等非敏感元数据；真实 Provider 验证需用户提供 Key
  （询问边界），未经提供不得联网调用付费 API。
- **TypeScript 纪律**（First_stage.md §十二）：类型错误不得用 `any`、`@ts-ignore` 或关闭严格
  检查解决；不得删除有意义的测试来让测试通过；不留明显 placeholder 实现然后声称完成。
- **生命周期纪律**（First_stage.md §十二）：对 Electron 生命周期、Tab 销毁、WebContents 销毁
  做好清理；注意 memory leak 与 event listener 重复注册。
- **范围纪律（第三阶段不做清单，Third_stage.md §5.3/§6 + 任务红线）**：**严禁万能工具**
  ——shell.exec、eval、任意 JavaScript 执行、任意文件系统读写、任意 HTTP POST、任意
  Electron IPC、任意数据库 SQL（**永久红线**，本阶段及以后均禁止，grep 断言）；
  **不放宽既有 Electron 安全边界**（远程网页隔离/Tab 无 preload/权限默认拒绝/
  window.open deny/UI 导航保护均不变）；**T1 tool-calling 兼容层完成前禁止任何
  Browser Tool 实现**。本阶段不做：长期信源数据库、AI 自动添加收藏、多源 Research
  报告、图表/复杂结果渲染、RSS、Watch、定时任务、自动支付/购买/发布、浏览器扩展
  生态、多 Agent 编排、Agent 记忆系统、向量数据库、page.extract 独立工具、
  向 Agent 开放的关闭 Tab 工具（Agent 打开的 Tab 归用户管理）——除非本阶段目标
  绝对必要，不得主动扩展。
- **技术基线冻结（第三阶段同样生效）**：§1 已冻结版本不得由后续 Agent 擅自升级。升级流程：
  先说明理由 → 验证 typecheck + lint + test + build + Electron 冒烟全绿 → 同步相关文档 → 提交。
- **依赖可复现**：`package-lock.json` 必须提交；禁止删除 lockfile 后重新解析依赖来「解决」问题；
  npm 出现 peer dependency / engine 警告时不得用 `--force` / `--legacy-peer-deps` 直接掩盖，
  必须先查明原因；核心工具链依赖保持精确版本固定（package.json 无 ^/~，`.npmrc` save-exact=true）。
- **质量门槛（不得为绿灯降门槛）**：typecheck / lint / test / build / 冒烟失败必须先修根因。
  禁止：删除或跳过有意义的测试、修改测试让错误实现通过、大范围 `eslint-disable`、随意降低 ESLint 规则、
  放宽 tsconfig 隐藏已有类型问题、用 `any` / `@ts-ignore` / `@ts-nocheck` 掩盖设计问题、注释掉失败功能、
  catch 后静默吞掉本应处理的异常、忽略 Promise rejection、`--force` / `--legacy-peer-deps`、
  删除 lockfile 重装碰运气、关闭 Electron 安全机制绕过实现问题。
  若质量规则本身确有问题：先指出规则为何不合理与修改影响 → 修改设计/规范 → 再修改实现 → 完整重新验证。

## 4. 项目结构（2026-08-13 实际状态 + 规划）

```
d:\AIbrowse\
├── AGENTS.md / Second_stage.md / README.md    # 手册 / 当前阶段需求与验收 / 启动与架构简介
├── ROADMAP.md / First_stage.md / Third_stage.md～Seventh_stage.md  # 路线图 / 已完成与后续阶段需求
├── .agents/skills/…                           # 规则基线 + references/prompt-templates.md
├── .gitignore / .editorconfig                 # 忽略 log/、密钥、构建产物、IDE 个人配置
├── .prettierrc.json / .prettierignore         # 格式约定（需求/路线文档不参与格式化）
├── .node-version / .npmrc                     # Node 24.18.0 固定 / save-exact 精确版本
├── electron.vite.config.ts / vitest.config.ts # 构建（三目标）/ 测试配置
├── tsconfig.json + tsconfig.node/web.json     # 主进程与渲染进程各自的严格配置
├── eslint.config.mjs                          # ESLint 10 flat config（react-hooks + refresh）
├── package.json / package-lock.json           # 脚本见 §6；lockfile 入库
├── doc/                                       # 第一阶段历史（定稿不覆盖）；Second Stage：stage2/；
│                                              #   tasks/progress.md 唯一进度源
├── log/                                       # 运行时日志（gitignore，按日轮转）
└── src/
    ├── main/
    │   ├── index.ts                           # 入口：生命周期/单实例锁/安全默认值/IPC 装配（sender 校验）/UI 窗口导航保护/冒烟
    │   ├── logger.ts                          # log/ 文件日志（脱敏、按日轮转；logger.test.ts 脱敏专项用例，S1）
    │   ├── smoke.ts                           # AIBROWSE_SMOKE 场景（T2 核心 + T3 导航保护拦截/bounds 上报 + S3 AI 共读矩阵 1–8）
    │   ├── ui-navigation-policy.ts / .test.ts # UI 窗口导航保护纯函数（自身来源白名单，T3 落地，9 用例）
    │   └── browser/
    │       ├── browser-controller.ts          # 浏览器能力统一入口（接口 BrowserController + 实现类）
    │       ├── tab-manager.ts                 # WebContentsView 创建/销毁/事件→TabInfo 登记表
    │       ├── tab-state.ts / .test.ts        # 状态机纯函数 + 14 用例
    │       ├── session-manager.ts             # persist:aibrowse 分区（多 Profile 预留；双权限处理器默认拒绝）
    │       ├── permission-policy.ts / .test.ts  # 网页权限策略纯函数（v1 默认拒绝）+ 4 组用例（安全补丁）
    │       ├── page-reader.ts                 # （T4）快照编排：executeJavaScript 注入 + L0–L2 降级阶梯
    │       │                                  #   （T3 规划：交互注入编排）
    │       ├── snapshot-script.ts             # （T4）注入脚本源（自安装 IIFE 字符串，DOM lib 引用保持 TS 检查；
    │       │                                  #   T3 规划：isSubmit 语义元数据）
    │       ├── interaction-script.ts          # （T3 规划）固定模板交互脚本（click/fill/scroll，
    │       │                                  #   参数只进 JSON 字面量）
    │       └── snapshot-normalize.ts / .test.ts  # （T4）脚本输出校验纯函数 + 46 用例
    │   └── ai/                                # （Second Stage 已实现，契约见 doc/stage2/detailed-design.md；
    │       │                                  #   Third Stage 规划，契约见 doc/stage3/detailed-design.md §1）
    │       ├── conversation-service.ts        # （S3 ✅）会话编排：ask 实时快照/中止/事件/持久化接线
    │       │                                  #   （T5 规划：agentAsk/confirmTool/ToolStep 持久化接线）
    │       ├── conversation-store.ts          # （S3 ✅）会话 JSON 持久化（原子写/上限/损坏容错；
    │       │                                  #   T5 规划：version 2 ToolStep 消息）
    │       ├── context-builder.ts             # （S2 ✅）纯函数：角色隔离 IR 构建 + UNTRUSTED 块
    │       │                                  #   （T1 规划：tools 透传）
    │       ├── context-budget.ts              # （S2 ✅）纯函数：预算常量与确定性裁剪
    │       ├── credential-store.ts            # （S1 ✅）SecureCredentialStore：API Key 密文落盘
    │       │                                  #   （cipher 后端注入可替换，Q2）+ 纯文件格式 + 单测
    │       ├── safe-storage-cipher.ts         # （S1 ✅）Electron safeStorage（DPAPI）→ CipherBackend 薄胶水
    │       ├── config-store.ts                # （S1 ✅）Provider 配置 JSON（非机密，形状校验 fail-closed）+ 单测
    │       ├── provider/                      # （S1 ✅）LLMProvider 接口/工厂注册表/OpenAI-compatible
    │       │                                  #   适配器（fetch+SSE）/FakeProvider/error-normalize + 单测
    │       │                                  #   （T1 规划：tools/SSE tool_calls/FakeProvider 工具脚本）
    │       ├── agent/                         # （T5 规划）agent-loop（纯编排状态机）/agent-context-builder/
    │       │                                  #   agent-history/agent-safety（防循环纯函数）
    │       ├── tools/                         # （T2 规划）tool-types/tool-registry（schema 校验）/
    │       │                                  #   tool-executor（校验→权限→确认→执行→审计）/
    │       │                                  #   browser-tools（T2 只读导航）/interaction-tools（T3）/
    │       │                                  #   search-tool（T4）
    │       ├── permission/                    # （T2 规划）permission-policy：L0–L3 确定性权限纯函数
    │       ├── confirm-manager.ts             # （T2 规划）确认状态机（pending/approve/deny/作废）
    │       ├── audit-log.ts                   # （T2 规划）结构化审计条目（参数脱敏摘要）
    │       └── search/                        # （T4 规划）search-provider：接口 + Bing 页面实现
    │                                          #   （临时 Tab → 快照解析 → 统一结果结构）
    ├── preload/
    │   ├── index.ts                           # UI bridge（contextBridge 白名单：tabs/nav/page/ui
    │   │                                      #   + conversation/config（S4 ✅）；事件通道单次注册）
    │   └── index.d.ts                         # renderer 侧 window.aibrowse 类型
    ├── renderer/                              # React UI（index.html + src/）
    │   ├── src/browser/                       # （T3/T4）chrome：Toolbar/TabBar/AddressBar +
    │   │                                      #   DebugPanel + useTabsState/useContentBounds（hooks）
    │   └── src/ai/                            # （S4 ✅）AI 侧栏：AiPanel/ChatView/Composer/
    │                                          #   ContextBadge/CitationCard/ProviderSettings +
    │                                          #   useConversation/useStream + 纯函数
    │                                          #   （stream-state/history-events/context-badge-format）
    └── shared/
        ├── types/app.ts                       # 共享类型（AppInfo / AibrowseBridge，S4 conversation/config 扩展 ✅）
        ├── types/browser.ts                   # TabInfo/TabsState/PageSnapshot/meta（T2）
        ├── types/conversation.ts              # （S1 ✅）会话/消息/上下文/错误码/Provider 类型
        │                                      #   （§2+§3.3+§3.5；S4 增 ProviderInfo/kind 常量）
        ├── types/ipc.ts                       # IPC 通道常量 + payload 类型（T2 基线 + S4 conversation/config 扩展 ✅）
        └── url.ts / url.test.ts               # 地址栏输入判断纯函数 + 15 用例
```

分层方向（不可反向或跳跃）：`UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`；
AI 子系统：`UI(AI 面板) → ConversationService → ContextBuilder / LLMProvider → SecureCredentialStore`，
网页上下文 `ConversationService → BrowserController.getPageSnapshot`；
Agent 子系统（第三阶段）：`UI → ConversationService(agent) → AgentLoop → ToolRegistry →
PermissionPolicy / ConfirmManager / ToolExecutor → BrowserController / SearchProvider`。
按实际 Electron 项目结构调整文件布局时，必须保持该分层不变。

## 5. 模块接口速查

接口契约已于 2026-08-13 **定稿**（T1），唯一契约源 `doc/detailed-design.md`（§2–§7 + §12 决议记录，
含 proposal Q1–Q4 拍板）；以下为速查摘要，**T2/T3/T4 部分已用 `grep -n "^export"` 与实际代码逐项核对**
（2026-08-13，T4 完成时回填 PageReader/normalize 部分；T5 收尾补记 will-redirect 加固与
elementId 跨集合复用）。

- **shared/url（已实现，2026-08-13 已用 grep 核对）**：`export const SEARCH_ENGINE_URL: string`
  （当前 `https://www.bing.com/search`，以后整体换 SearchProvider）；
  `export function resolveAddressBarInput(raw: string): string` —— `https://…`/`http://…`/`about:…`
  直开、裸域名/IP/localhost 补 `https://`、其余（含危险 scheme）走搜索；空输入与非法 URL
  安全返回 `''`（越界安全返回）。测试：`src/shared/url.test.ts`（15 用例）。
  另有 `export const ALLOWED_SCHEME_PATTERN`（T2 起被 Tab 导航白名单共用）。
- **shared/types/browser.ts（T2）**：`TabState`（idle/loading/ready/error）、`TabInfo`、
  `TabsState`、`PageSnapshot`（含必填 `meta{capturedAt,readyState,degraded,warnings}`，
  降级阶梯 L0–L2 见 detailed-design §4）、`SnapshotDegradation`、`SnapshotMeta`。
- **shared/types/ipc.ts（T2）**：`IPC` 通道常量（tabs:list/create/close/activate、
  nav:navigate/back/forward/reload、page:snapshot、ui:content-bounds、app:get-info、
  app:renderer-ready、tabs:updated）+ `ContentBounds`/`TabsCreatePayload`/`TabIdPayload`/
  `NavNavigatePayload`。
- **BrowserController（T2 已实现）**：契约接口 `export interface BrowserController` +
  实现类 `export class BrowserControllerImpl implements BrowserController`（lint 规则要求分名）。
  接口方法（未来 AI Agent 只能经它/Tool Layer 操作浏览器）：
  `createTab(url?) → Promise<TabInfo>`（新 Tab 自动成为活动 Tab；空 URL 创建空白 Tab + warn）/
  `closeTab · activateTab · navigate · goBack · goForward · reload → Promise<boolean>`
  （参数/状态问题安全返回 `false`，不抛异常）/
  `getTabs() → Promise<TabInfo[]>` / `getActiveTab() → Promise<TabInfo | null>` /
  `getPageSnapshot(tabId) → Promise<PageSnapshot | null>`（null = L3；L0–L2 由 PageReader
  编排——注入只读采集脚本 + normalize 校验 + 降级阶梯，T4 接入）/ `dispose(): void`
  （退出路径全量清理，幂等，不触发最后 Tab 策略）。
  **类方法（不在 AI 契约接口内，UI 接线用）**：`setContentBounds(bounds: ContentBounds): void`
  （ui:content-bounds 通道落点，非法值忽略 + warn）。
  地址栏原始输入由 main 侧 IPC handler 统一规范化后再进 controller（§9）。
- **TabManager（T2）**：`export class TabManager` + `TabEntry`/`TabEntryInfo`/`TabManagerOptions`。
  每个 Tab 一个 WebContentsView（显式安全默认值：无 preload、`nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`、`session=persist:aibrowse`）；可见性用 `setVisible`
  切换（不用 removeChildView）；全部监听器注册于创建时、closeTab/dispose 时逐一移除；
  `will-navigate` + `will-redirect` 白名单 http/https/about（302 目标同过白名单，T5 R-02
  加固——程序化 loadURL 遇重定向时唯一拦截点）+ `setWindowOpenHandler` 一律 deny。
- **tab-state（T2，纯函数零 Electron 依赖）**：`export type TabStateEvent`（start-loading/
  finish-load/fail-load，含 isMainFrame/errorCode）；
  `export function transition(state, e): TabState`（子框架忽略；-3=ERR_ABORTED 忽略；
  fail→error；start-loading 从任意状态→loading）；
  `export function selectNextActive(tabs, activeTabId, closedTabId): string | null`
  （**tabs 为关闭前完整列表**；关闭活动 Tab → 右邻优先/左邻/唯一时 null→最后 Tab 策略自动新建空白 Tab）。
  测试：`tab-state.test.ts`（14 用例）。
- **SessionManager（T2）**：`export const PERSIST_PARTITION = 'persist:aibrowse'`；
  `export interface SessionManager { getSession(profile?): Session }`；
  `export class AppSessionManager`（`session.fromPartition` 懒加载单例；'main'→PERSIST_PARTITION，
  未来 Profile 映射 `persist:aibrowse-<profile>`）。本阶段仅持久 Session（重启后 Cookie/登录状态保留），
  不真正实现多 Profile。
- **permission-policy（安全补丁，2026-08-13）**：`export function resolvePermissionRequest(
permission, requestingUrl): boolean` / `export function resolvePermissionCheck(permission,
requestingOrigin): boolean` —— 网页权限策略纯函数，v1 固定默认拒绝（未知权限/畸形来源同样拒绝）；
  由 SessionManager 在分区首次创建时注册的 `setPermissionRequestHandler` +
  `setPermissionCheckHandler` 调用（官方要求两者同时实现）。测试：`permission-policy.test.ts`（4 组）。
  后续扩展权限白名单只改本模块与测试。
- **PageReader（T4 已实现）**：`export class PageReader` +
  `snapshot(webContents: WebContents) → Promise<PageSnapshot>`（前置守卫/L3 由 BrowserController
  完成；执行失败/页面崩溃/脚本结果不可用 → L2，不抛异常）。`executeJavaScript` 注入
  `SNAPSHOT_SCRIPT_SOURCE`（`snapshot-script.ts` 导出，自安装 IIFE 字符串——采集函数经
  `/// <reference lib="dom" />` 保持完整 TS 检查后 `.toString()` 序列化）。
  `snapshot-normalize.ts`：`export const NORMALIZE_LIMITS`（校验限额常量，与采集限额一致）+
  `export function normalizeSnapshot(raw: unknown, fallback: SnapshotFallback): PageSnapshot`
  ——页面输出视为敌手：逐字段类型校验/限额二次截断/elementId 格式 `el-N` 过滤/表格行列补齐截断/
  warnings 合并去重；任何输入（含 null）返回合法 PageSnapshot 不抛异常；L2 形状由同一模块产出。
  测试：`snapshot-normalize.test.ts`（46 用例）。结构化快照**不得默认返回整个 DOM**；过滤
  script/style/隐藏内容等噪声；`elementId` 双层映射（data-aibrowse-el 属性烙印 + 每次快照
  重建的有界 Map，§8.4）在一次快照生命周期内对应真实 DOM 元素；同一元素出现在多个集合
  （a[role=button]、input[type=button]）时跨集合复用同一 id，敌手预置顶格合法烙印时分配
  回绕（T5 修复）；type=password 不采集 value；
  PageReader 不污染网站正常行为（唯一写操作是幂等烙印属性）；远程网页不得通过此机制执行
  Node.js 或 Electron privileged API（脚本页面世界运行，无 preload/无 IPC）。
- **URL 判断逻辑（已实现）**：见上 shared/url；地址栏原始输入经 `nav:navigate`/`tabs:create`
  由 main 侧 IPC handler 统一规范化（T3 已接入，UI 不做 URL 判断）。
  已知限制：不支持中文/国际化域名（IDN）；以后替换 SearchProvider 时一并评估。
- **preload bridge（AibrowseBridge，T3 已实现）**：`src/shared/types/app.ts` 定稿签名
  （§3.2）+ `src/preload/index.ts` 白名单实现。`tabs.list/create/close/activate/onUpdated`
  （onUpdated 返回退订函数，preload 内同一通道只注册一次 ipcRenderer 监听、JS 侧管理
  listener 列表）；`nav.navigate/back/forward/reload`（navigate 传原始输入）；`page.snapshot`；
  `ui.reportContentBounds`。原始 `ipcRenderer` 永不暴露给渲染层。
- **ui-navigation-policy（T3 已实现，安全，T4 收紧）**：`export interface UiNavigationPolicy`
  （selfOrigin / selfFileUrl）+ `export function resolveUiNavigationAllowed(targetUrl,
policy): boolean`——UI 窗口导航保护纯函数（零 Electron 依赖）。开发模式仅放行
  `ELECTRON_RENDERER_URL` origin；生产仅放行 `file:` 入口文件 URL **精确匹配**（scheme+pathname
  相等，hash/query 变体视为同一文档；同目录其他文件/`..` 路径穿越/大小写变体一律拒绝，失败关闭；
  不用 origin 比较——file: 的 origin 恒为 'null'，会误放行所有本地文件）；畸形输入安全返回 `false`。
  由 `main/index.ts` 挂到 UI 窗口 `will-navigate` + `will-redirect`（§9，两处共用同一判定）。
  测试：`ui-navigation-policy.test.ts`（10 用例）。
- **渲染层 chrome（T3/T4 已实现）**：`renderer/src/browser/`——Toolbar（后退/前进/刷新/地址栏/
  新建 Tab）/ TabBar（标题兜底「新标签页」、切换/关闭、active 高亮、loading spinner、
  error 红标）/ AddressBar（聚焦期不随 URL 刷新草稿、失焦同步、Enter 提交原始输入）/
  DebugPanel（「读取当前网页」→ 活动 Tab PageSnapshot JSON + degraded 徽标 L0–L3 +
  warnings 列表 + 可收起；面板在 chrome 容器内，高度变化经 ResizeObserver 自动上报 bounds）；
  hooks：`useTabsState`（tabs:updated 全量推送幂等更新，先订阅后拉取防旧快照回退）、
  `useContentBounds`（ResizeObserver 测 chrome 高，防抖 50ms 上报 ui:content-bounds）。
  主区域为占位容器，真实网页由 WebContentsView 按上报 bounds 覆盖渲染。

### Second Stage AI 共读契约速查（定稿 2026-08-13；S1–S4 全部已实现并经 `grep -n "^export"` 逐项核对；S5 审计与 S6 验收通过，2026-08-13 最终状态）

> 唯一契约源 `doc/stage2/detailed-design.md`（§2–§12 + §15 决议记录，含 proposal Q1–Q10 拍板）；
> 任务拆分见 `doc/stage2/tasks/S1–S6`。以下为速查摘要；S1–S4 部分签名已于 2026-08-13 与
> 实际代码 `grep -n "^export"` 逐项核对。

- **shared/types/conversation.ts（S1 ✅ 已实现；S4 增补）**：`ContextMode`（selection/snapshot/none）、
  `ContextSource`（mode/tabId/url/title/capturedAt/degraded/thin/selectionExcerpt/warnings）、
  `ConversationMessage`（role ∈ user|assistant；status complete/aborted/error；
  contextSource 仅 user 消息携带；**不持久化快照正文**）、`ConversationSession`
  （含 ephemeral「不保存」）、`NormalizedErrorCode`（not-configured/invalid-key/rate-limit/
  timeout/network/context-too-long/provider-error/aborted/busy/not-found/internal）、
  `NormalizedProviderError`（code/message/retryable/providerId/model/requestId/httpStatus，
  **不含响应体/请求头/密钥**）、`ContextPreview`、`AskResult`、事件 payload
  `StreamChunkEvent`（requestId/sessionId/delta）与 `TurnDoneEvent`（requestId/sessionId/
  status/message/error/contextSource）；Provider 类型——`ProviderMetadata`/`ProviderMessage`/
  `ProviderRequest`/`ProviderUsage`/`ProviderEvent`/`ProviderConfig` + S4 增补
  `ProviderInfo`（providerId/label/baseUrl/model/hasKey——**无 Key 值**）与常量
  `PROVIDER_KIND_OPENAI_COMPATIBLE`（Provider 数据类型放 shared，preload/renderer 直接复用）。
- **ConversationService（S3 ✅ 已实现，2026-08-13 grep 核对）**：接口 `ConversationService`
  与实现类 `ConversationServiceImpl`——`createSession(opts?): Promise<ConversationSession | null>`
  （**决议 #19**：达 50 会话上限拒绝新建 → null；实际签名与唯一契约源 §3.1 均为可空返回）/
  `listSessions`（新→旧）/`getHistory`（null=不存在）/
  `deleteSession`（先中止在途生成 → 删内存+文件含残留 tmp → 更新索引）/
  `setEphemeral`（false=现有消息落盘，true=移除磁盘文件）/`ask`（同步校验+注册在途后
  立即返回 `{ok:true,requestId}`，生成后台执行经事件回调推送）/`abort(requestId)`
  （幂等，无匹配 false）/`previewContext`（实时快照摘要不含正文）/`dispose`（中止全部
  在途，幂等）；纯函数 `selectRegisteredProviderInfo(infos, kinds)`（**决议 #20**：
  v1 单 Provider 选择契约，见下）。构造注入：`browser: SnapshotSource`（getActiveTab/
  getPageSnapshot 最小接口，BrowserControllerImpl 结构兼容；实时采集防串页）/`store`/
  `configStore`/`credentials`/`resolveProviderFn?`（冒烟注入 FakeProvider 缝；缺省生产
  resolveProvider，决议 #17）`onStreamChunk`/`onTurnDone`（§3.1 事件输出，index.ts
  转发主窗口 send）。
  ask 编排时序即防串页契约：实时 `getPageSnapshot(activeTabId)`（禁止复用缓存快照）→
  **Provider 选择（决议 #20）**：`selectRegisteredProviderInfo(await configStore.list(),
listProviderKinds())`——取 providerId 属于已注册工厂 kind 的配置；v1 仅注册
  `openai-compatible` 一种 kind、ConfigStore 以 providerId 为键 upsert 同键恒唯一，
  选择唯一且**与 `list()` 条目顺序无关**（不依赖任何隐含排序）；无已注册 kind 配置 →
  not-configured 零网络请求；多 kind 并存是 Third Stage+ 扩展点 → `buildContext`
  （requestId 先生成、model 来自所选配置——决议 #18）→
  **先持久化 user 消息（含 ContextSource + meta.warnings）** → `resolveProvider` →
  `provider.stream` → delta 逐块转发 → 终态组装 assistant 消息（complete 全文 /
  aborted 保留部分 / error 保留部分+errorCode）→ 持久化 → turn-done 恰好一次。
  每会话单在途（busy，ask 同步段注册原子）；参数/状态问题安全返回不抛异常
  （not-found/busy/internal）；未预期异常 → error 日志 + 归一化 internal 且保证
  turn-done；deleteSession 中止竞态下在途编排不得复活已删会话文件（appendMessage
  存活守卫）。日志链：开始/结束各一条（requestId/providerId/model/mode/url/耗时/
  status/errorCode，无内容与密钥）。
- **ConversationStore（S3 ✅ 已实现，2026-08-13 grep 核对）**：`export class
ConversationStore(userDataDir)`——`dirPath`/`loadSessions`/`saveSessions`（写入前过滤
  ephemeral 纵深防御）/`loadMessages`（缺失/损坏 → 空，fail-closed 不暴露原文）/
  `saveMessages`（原子写 tmp+rename）/`deleteFiles`（消息文件+残留 tmp）。纯函数：
  `deriveTitle`（首问 ≤30 字符，换行折叠）、`validateMessageShape`/`validateSessionShape`
  （§9 逐条校验）、`serialize/parseMessagesFile`/`serialize/parseIndexFile`（version 1；
  整体不可解析 → null；索引解析丢弃 ephemeral 条目）、`cropMessagesToLimit`（200 条
  裁最早）、常量 `SESSION_LIMIT=50`/`MESSAGE_LIMIT=200`/`TITLE_MAX_CHARS=30`。
  布局 `<userData>/conversations/index.json + <sessionId>.json`（运行时目录，不入库）。
- **ContextBuilder（S2 ✅ 已实现，2026-08-13 grep 核对）**：`buildContext({question,
snapshot, history, system, requestId, model, budget?}) → {request, meta}`——
  `request: ProviderRequest`（requestId/model 由 Service 传入，决议 #18；web 块只进
  末条 user 消息）；`deriveContextMode(snapshot, thin)`（null/L3 → none；selection
  trim 非空优先独占 → selection；其余 → snapshot——thin 不改变模式，L2 保留身份降级）；
  `isThinSnapshot`（正文合计 < 300 字符）；`buildContextSource(snapshot, mode, thin,
tabId)`（tabId 由 Service 传入，决议 #18；selectionExcerpt ≤ 200）。网页内容只进
  user 消息 `UNTRUSTED_WEB_CONTENT` 块（`</` → `<\/` 闭合转义 + 属性 `& < > "` 转义 +
  `<selection>`/`<section name>` 结构），`SYSTEM_PROMPT` 编译期常量（恒等断言）。
  context-budget.ts：`CONTEXT_BUDGET`（§7.5 全量表，可注入）/`THIN_SNAPSHOT_THRESHOLD`/
  `TRUNCATION_MARK`/`truncateWithMark`/`countSnapshotBodyChars`/`filterLayoutTables`
  （表头空且行少或内容稀薄 → 跳过）/`fillWebContentSections`（text→headings→tables→
  links→buttons→inputs 优先级 + 各节/条目上限 + 总预算 30000 停止 + 任何截断标记）/
  `trimHistory`（最近 8 对 + 12000 字符）/`renderHistoryMessageContent`（单条 2000 +
  来源行 ≤ 120 计入预算）。
- **LLMProvider（S1 ✅ 已实现，src/main/ai/provider/）**：`llm-provider.ts`——
  `export interface LLMProvider`（`metadata` + `stream(request, signal): AsyncIterable<
ProviderEvent>`，delta/done/error）、`PROVIDER_KIND_OPENAI_COMPATIBLE`、
  `ProviderFactory`/`registerProviderFactory`/`listProviderKinds`、`resolveProvider
(config, store) → Promise<LLMProvider | null>`（async——无 Key 判定依赖 §3.4 异步
  `store.has()`；设计 §3.3 签名已校准为 Promise（决议 #17）；未配置/无 Key/未注册
  kind → null → not-configured，不发起网络请求）。`openai-compatible.ts`——`OpenAICompatibleProvider`
  （原生 fetch + SSE 自解析：`\n\n` 分帧/`[DONE]`/usage 末帧/末帧 delta+usage 同帧不丢
  内容/CRLF 归一化，`POST {baseUrl}/chat/completions`，Key 请求时从 store 取不缓存、
  适配器不记录请求头，超时 `PROVIDER_TIMEOUTS` 连接 15s/空闲 chunk 60s/总 300s
  AbortController 组合，零 Electron import）+ 可单测纯函数 `parseSseFrame`/
  `interpretSsePayload`/`mapMessages`。`fake-provider.ts`——`FakeProvider`
  （确定性脚本 `FakeChunk`/`FakeProviderScript`：分块/延迟/错误注入 code|httpStatus/
  中止 + `getLastRequest()` 供冒烟断言）+ `FAKE_PROVIDER_METADATA`。
  `error-normalize.ts`——`normalizeProviderError`（判别联合 `NormalizeInput`：
  http/network/timeout/aborted/parse/not-configured/internal）+ `isContextTooLongIndicator`
  纯函数：状态码矩阵 → 错误码（401/403→invalid-key、429→rate-limit、400/422 上下文
  指征→context-too-long、5xx→provider-error retryable、网络/超时/中止/解析失败各归一；
  脱敏断言：错误绝不含响应体/密钥）。
- **SecureCredentialStore（S1 ✅ 已实现，src/main/ai/）**：`credential-store.ts`——
  `export interface SecureCredentialStore`（`isAvailable/set/get/has/delete`，`has` 供 IPC
  查询不含密钥）+ `SecureCredentialStoreImpl`（cipher 后端注入 `CipherBackend`，Q2 可替换；
  safeStorage/Windows DPAPI 密文落盘 `userData/credentials.json`（原子写 tmp+rename）；
  不可用 fail-closed：set 返回 false 不落盘 + 仅内存 Key（退出即弃）；损坏/解密失败 → 空/
  null + warn）+ 纯文件格式 `serializeCredentialsFile`/`parseCredentialsFile`/
  `isCiphertextShape`（sk- 明文形态条目丢弃）。`safe-storage-cipher.ts`——
  `SafeStorageCipher`（Electron 薄胶水，运行时行为已由 S4 冒烟场景 10 验证：真实
  safeStorage 密文落盘 + DOM/日志零暴露断言，§13.2）。
  **渲染层只写不读**（S4：bridge 仅 `setKey` 写入，`has` 为 main 侧方法不进 bridge——
  renderer 只能经 `list()` 拿到 hasKey 布尔，无 get 通道）。`config-store.ts`——
  `ConfigStore`（`get`/`set`/`list(): Promise<ProviderInfo[]>`——设计 §3.5 签名已校准为
  Promise（决议 #17）：hasKey 依赖 §3.4 异步 `store.has()`；ProviderConfig 定义于 shared
  并重导出）+ 纯校验 `normalizeBaseUrl`（仅 http/https 去尾 /）/`validateProviderConfig`
  （model/providerId 非空）；文件 `userData/provider-config.json` 形状校验 fail-closed
  （Key 不入此文件）。
- **IPC/bridge 扩展（S4 ✅ 已实现，2026-08-13 grep 核对）**：invoke——conversation:list/
  create/get-history/delete/set-ephemeral/ask/abort/preview、config:providers:list/set/
  set-key（apiKey='' = 删除）——11 个通道常量与 payload 类型在 shared/types/ipc.ts
  （§4.1）；两事件通道常量与 StreamChunkEvent/TurnDoneEvent payload 类型 S3 已落地。
  main 侧 handler 全部复用既有 `handle()` sender+主帧校验包装（index.ts），逐参数验证
  安全返回不抛异常；question > 16000 字符确定性截断（truncateWithMark +
  CONTEXT_BUDGET.questionMaxChars + warn，§4.1；buildContext 内 §7.5 预算截断为
  纵深防御）、空串/非串 → AskResult{ok:false, internal}；事件只发主窗口。preload
  bridge 白名单（§4.2）：`conversation.{list/create/getHistory/remove/setEphemeral/
ask/abort/preview/onStreamChunk/onTurnDone}` + `config.providers.{list/set/setKey}`
  ——事件订阅返回退订函数、preload 内同一通道只注册一次 ipcRenderer 监听 + JS 侧
  listener 集合（与 tabs:updated 同模式，eventRelay 泛型封装）；**API Key 只写不回读**：
  setKey 后 Key 无法经任何通道回渲染层，list() 仅含 hasKey（无读回方法，冒烟场景 10
  白名单断言）。ProviderInfo 与 PROVIDER_KIND_OPENAI_COMPATIBLE 常量定义于
  shared/types/conversation.ts（单一事实源；config-store/llm-provider 重导出）。
- **AI 侧栏与布局（S4 ✅ 已实现，2026-08-13 grep 核对）**：`renderer/src/ai/`——
  AiPanel（header：新建/会话列表/删除/不保存开关/设置/收起）· ChatView（消息流 +
  追溯卡片 + 已中止/错误标记；回答纯文本 pre-wrap，不引入 Markdown 库）· Composer
  （textarea Enter 发送 / Shift+Enter 换行；生成中显示「中止」）· ContextBadge
  （conversation:preview 驱动：面板打开/tabs:updated 即时/窗口 focus 防抖 300ms；
  文案纯函数 `describeContextPreview`）· CitationCard（ContextSource 摘要）·
  ProviderSettings（v1 只配置已注册 openai-compatible kind——决议 #20，无多 Provider
  选择 UI，与 list() 顺序无关；API Key type=password 只写不回显、保存后清空、apiKey=''
  = 删除）；hooks `useConversation`（会话列表/当前会话/历史镜像 + turn-done 补
  contextSource 收敛，纯函数 `reduceHistory`）与 `useStream`（requestId → delta 逐块
  追加、turn-done 收敛，纯函数 `reduceStream`；竞态残留事件按 requestId 忽略）；面板
  定宽 380px 停靠挤压、默认收起、不持久化、无拖拽/动画；useContentBounds 升级为测量
  内容容器两维矩形（ResizeObserver + 防抖 50ms，通道/契约 ui:content-bounds 不变）；
  布局：Toolbar+TabBar（chrome）→ 内容行（内容容器 + 面板）→ DebugPanel 底部通栏。
  冒烟模式 AI 子系统走进程专属临时目录 + FakeProvider 注入（不触碰用户 userData）。
- **Prompt Injection 验收边界（S5 ✅ 已实施验证，S6 ✅ 分类校准，2026-08-13）**：机器可
  验证断言——网页内容只存在于 user 消息 UNTRUSTED 块、system 恒等、块不可被内容闭合
  （`</`→`<\/` 转义）、角色程序字面量赋值、渲染层无 Key 读回、本阶段无浏览器写 Tool
  （click/fill/scroll 不存在，grep 断言 + 请求无 tools 字段）、权限默认拒绝回归、
  日志无 Key——全部经 S5 逐项审计与运行时探针验证（§12.1/§14 结论见 progress.md；
  矩阵 11 注入夹具已增强为含「忽略之前的指令」/伪造 role/原始闭合标签拼接等 4 条
  文案 + 5 断言；真实 Provider 场景真 Key 零暴露扫描已落地，§6；S6 多网站验证沿用
  同套扫描）。
  **不承诺（也不得宣称）模型语义层完全免疫**：语义层剩余风险经 S6 分类校准正式登记为
  「已接受的剩余设计风险/计划内限制」（progress.md，不分配 R 编号、开放风险为「无」）；
  **威胁模型已于 2026-08-14 随 Third Stage 切换重建定稿**（`doc/stage3/threat-model.md`，
  先于任何 Browser Tool 实现）。

### Third Stage Browser Agent 契约速查（定稿 2026-08-14；T1–T8 待实现，实现后回填）

> 唯一契约源 `doc/stage3/detailed-design.md`（§2–§16 + §15 决议记录，含 proposal
> Q1–Q15 拍板与决议 #21–#28）；安全契约源 `doc/stage3/threat-model.md`（威胁枚举
> T-01～T-10、五层防线、红队矩阵 R-01～R-10、诚实边界声明）；任务 T1–T8 见
> `doc/stage3/tasks/`。以下为速查摘要，**尚未与实现核对**（T1 起逐步回填）。

- **tool-calling 兼容层（T1，硬前置）**：`ProviderRequest.tools?: ProviderTool[]`
  （Registry 序列化，程序生成）；`ProviderEvent` 增 `{type:'toolCalls',
toolCalls: ProviderToolCallDelta[]}`（SSE `delta.tool_calls` 按 index 分槽累积，
  finish_reason=tool_calls 收尾；非法帧/非法 arguments → provider-error）；
  `ProviderMessage` role 增 `'tool'`（toolCallId 关联）+ assistant toolCalls 重放；
  `supportsToolCalling` 校准为真实值；FakeProvider 工具脚本（离线确定性）；
  `ContextBuildInput.tools` 透传。**T1 验证通过前禁止任何 Browser Tool 实现**。
- **ToolRegistry（T2）**：`ToolDefinition`（name/description/parameters
  （ProviderToolParameter 子集）/baseRisk/riskLift/executor）注册表；
  `listTools(): ProviderTool[]` / `validateToolArgs`（JSON.parse 失败/未知工具/
  缺必填/类型/enum/未知键/长度上限/tabId UUID 形状/elementId `el-N` 形状 → 失败）；
  首批 13 工具分三批：T2 只读导航 8 个（get_tabs/get_active_tab/read/open/
  navigate/back/forward/reload）、T3 交互 4 个（find/scroll/click/fill）、
  T4 search.web；page.extract 与关闭 Tab 工具 v1 不实现（决议 #21/#28）。
- **权限分级（T2，确定性纯函数）**：L0 自动（只读/滚动/查找/搜索）/ L1 自动显著
  展示（导航/打开/click 普通元素/fill 筛选字段）/ L2 用户确认（click 提交类元素
  ——isSubmit 结构化元数据升级）/ L3 禁止（password/file 填写、非 http/https URL；
  购买支付等无对应工具）；`decide(toolName, args, elementSemantics)` 纯函数，
  模型与网页无通道修改矩阵；确认状态机 pending/approve/deny/取消作废、
  无自动批准、等待计入总超时。
- **交互能力与 elementId 生命周期（T3）**：BrowserController 扩展
  `clickElement/fillElement/scrollTab`（安全返回不抛异常）；interaction-script
  固定模板（click=原生 el.click()、fill=原生 value setter+input/change、
  scroll=window.scrollBy；参数只进 JSON 字面量）；elementId 仅当轮快照有效、
  **执行时刻实时重新定位** + 元素类型复核、导航/刷新后旧 id → stale-element；
  快照扩展 isSubmit 语义标志（inputs/buttons）。
- **SearchProvider（T4）**：`search(query, signal) → SearchProviderResult`
  （SearchResult {title/url/snippet/source}）；v1 Bing 搜索页实现（临时可见 Tab →
  ready → 实时快照 → 确定性解析 → 关闭 Tab）；容忍设计（结构变化 → 空结果 +
  warnings）；接口隔离保未来替换（决议 #22）。
- **AgentRuntime（T5）**：AgentLoop 纯编排状态机（running/waiting-confirm/done/
  cancelled/step-limit/timeout/loop-detected/no-progress/error）；上限常量
  MAX_STEPS=12 / 总超时 420s（含确认等待）；防循环（签名=工具名+规范化参数，
  连续 3 次/累计 5 次 → loop-detected，连续 2 步无工具无文本 → no-progress，
  无白名单例外——决议 #24）；ToolResult ≤ 4000 字符截断（read 8000）+ 错误
  结构化错误码（工具错误永不以 ok=true 出现）；agent-ask 与共读 ask 在途互斥；
  ToolStep 消息持久化（精简版，fill 值替换「（已输入 N 字符）」，version 2
  读兼容 v1）；AGENT_SYSTEM_PROMPT 编译期常量；Tool Result 进
  UNTRUSTED_TOOL_RESULT 块（闭合转义同 UNTRUSTED 块）。
- **审计与可见性（T2/T6）**：每工具调用恰好一条审计（requestId/toolCallId/工具/
  参数摘要/决策 auto|auto-visible|confirmed|denied|forbidden/结果/耗时/错误码）；
  fill 值只记长度；IPC 通道 conversation:agent-ask/agent-confirm/agent-step/
  agent-confirm-request/agent-run-done（sender 校验 + 只发主窗口）；
  UI：Agent 模式切换/AgentStatusBar/ToolCallList/ConfirmDialog（确定性 summary，
  文案不经模型网页，deny 默认高亮）/停止按钮/ToolStep 紧凑条目。

## 6. 常用命令

- **Node 环境固定（技术基线，§1）**：`node --version` 应为 24.x（`.node-version` = 24.18.0，
  `engines.node` `>=24 <25`）。新环境按 `.node-version` 装好 Node 24 再 `npm install`；
  版本不符时 npm 会给出 engine 警告，先解决版本问题，不要用 `--force` 掩盖。
- **本机环境两个坑（Windows，实测 2026-08-13）**：
  1. 全局环境变量 `ELECTRON_RUN_AS_NODE=1`（可能被本机 node 配置依赖，**不要动全局变量**）——
     任何启动 Electron 的命令前加 `env -u ELECTRON_RUN_AS_NODE`，如：
     `env -u ELECTRON_RUN_AS_NODE npm run dev`
     （PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null; npm run dev`）。
  2. Electron 二进制从 GitHub 下载，Node 24 原生 fetch 默认不走代理；安装依赖用：
     `NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm install`
- **常用脚本**（以 package.json 为准，已核对落地）：
  - `npm run dev` — Electron 开发模式（渲染进程 HMR）
  - `npm run build` — 构建产物 `out/`（main/preload/renderer 三目标，CJS）
  - `npm run start` — 以构建产物启动
  - `npm test` — Vitest 全量测试（当前 326 用例）
  - `npm run typecheck` — tsc 严格检查（node + web 两套 tsconfig）
  - `npm run lint` / `npm run format` / `npm run format:check` — ESLint / Prettier 格式化 / 检查
  - **冒烟自检**：`env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev`
    （启动 → 窗口 → React 挂载 → preload bridge 链路 → 浏览器核心场景：多 Tab
    创建/切换/关闭、最后 Tab 自动新建、dispose 幂等无泄漏 → T3 起再验证 UI 窗口导航保护
    拦截（远程/同目录 file:/路径穿越三探针，800ms 后 UI URL 不变）与渲染层 bounds 上报生效
    （活动 view y>0）→ T4 起再验证 PageSnapshot 真实采集（本地受控页面 L0 内容对照/
    L1 跨域 iframe 跳过/L3 null/elementId 唯一与跨快照稳定）→ T5 起再验证：敌对页面
    elementId（重复/畸形/超大/冲突烙印 → 唯一且对应活 DOM 真实元素）、Tab 302 重定向
    白名单（允许目标跟随/禁止目标 custom:// 拦截 + 日志断言）、UI 端到端（React DOM 点击/
    键盘驱动：地址栏 URL/搜索、多 Tab、后退前进刷新、标题随网页变化、调试面板 L0/L1 徽标
    - warnings 展示）、远程页面隔离探针（window.aibrowse/process/require/electron 均
      undefined）→ S3 起再验证 AI 共读场景（FakeProvider 离线：流式端到端/selection 独占/
      防串页/L3 降级/薄快照/中止/错误归一化/会话持久化与删除/ephemeral 不落盘）→ S4 起
      再验证 UI 端到端矩阵 1–12（流式分块渐进 DOM/selection/防串页/L3/薄快照/中止/错误
      归一化/会话管理 UI/布局 bounds 380 收缩与恢复/Key 不可达——DOM 与日志字节扫描 +
      credentials.json 密文 + 白名单无读回/注入结构断言/远程隔离回归；矩阵见
      doc/stage2/detailed-design.md §13.2）→ 自动退出，退出码 0 即通过；日志链见 log/）。
      生产产物路径同样可跑：
      `AIBROWSE_SMOKE=1 npm run start`（file: 入口精确匹配导航保护）。可选真实网页加载验证
      （需网络）：`AIBROWSE_SMOKE_URL=https://www.bing.com/` 附加设置（15 秒超时，验证
      state=ready + 标题非空）。
  - **Session 跨进程持久化冒烟**（§十四 Session 验收，以生产产物验收，需先 `npm run build`）：
    两个独立应用进程共用同一临时 userData——进程 A
    `AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set` 经受控页 Set-Cookie（HttpOnly）写入
    persist:aibrowse 分区后完整退出；进程 B `AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=check`
    新进程读回 Cookie。两进程均需 `AIBROWSE_SMOKE=1`（缺省不会运行冒烟、只启动普通应用）与
    `AIBROWSE_USER_DATA_DIR=<临时目录>`（app ready 前 setPath，不触碰用户真实数据，测试后
    清理该目录）；命令（与 README 一致）：
    `env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set AIBROWSE_USER_DATA_DIR=<临时目录> npm run start`
    （check 同理），退出码 0 即通过。
  - **真实 Provider 可选验证（S5 落地，长期安全测试流程，S6 起为通用规则）**：
    两个 env 门控场景，均需 `AIBROWSE_SMOKE=1` + `AIBROWSE_LIVE_PROVIDER=1` +
    `AIBROWSE_TEST_API_KEY`（无 Key 环境跳过并记录、回退离线矩阵，不作为失败）：
    - **S5 一问一答**（缺省）：固定问题「用一句话回答：1+1 等于几」真实流式一问一答
      （完整生产链路 UI → IPC → ConversationService → ContextBuilder → OpenAI-compatible
      Provider → 流式事件 → DOM；断言流式 delta / turn-done complete / 回答非空 /
      配置与日志使用记录 / **真 Key 零暴露扫描**：DOM、日志切片、全部临时文件均不含
      Key、凭据文件为密文形态）。
    - **S6 多网站共读**（`AIBROWSE_LIVE_SITES=1`，§10 Exit Gate 证据）：多个真实网站
      各对应一个明确验收项——普通文章页（正文提问 + 总结）/ 长文页（确定性裁剪 +
      warnings + 回答可用）/ 表格页（信息提取）/ selection 独占 / 切 Tab 与刷新
      （URL、capturedAt、内容更新，旧页内容不串入）+ 同套 Key 零暴露扫描。
    - **调用规则（2026-08-13 用户更新，取消固定次数上限）**：**不设固定 API 调用次数**。
      每次真实调用必须服务于明确的验收项、问题定位或修复复验；**禁止**无界循环、
      无诊断依据的重复请求和无关问题测试；完成报告必须列出实际调用次数及每次用途。
      失败时区分 Provider 侧问题（余额/权限/服务/模型）与代码缺陷，不得为排查打印
      Key、削弱安全机制或无限重试。
      **凭据与启动的通用流程（长期规则，后续 Agent 直接复用，不重新索取/重新设计）**：
      ① 本地说明文件固定路径 `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md`
      （后续 Agent **优先读取本地说明**获取 Provider kind / base URL / model / DPAPI
      文件路径 / 注入规则——base URL 与 model **只存在于本地说明**，不写进项目文档；
      说明严禁写入明文 Key/DPAPI 密文/请求头/任何可用于认证的数据，不得入库/快照/报告）；
      ② API Key 用 Windows DPAPI 加密保存在仓库外 `%LOCALAPPDATA%\AIbrowse\S5\provider-key.dpapi`；
      ③ 仅通过受控子进程的环境变量 `AIBROWSE_TEST_API_KEY` 短暂注入（应用读取后立即从
      process.env 移除；禁止命令行参数/明文文件/聊天输入）；测试子进程用仓库外启动脚本
      `%LOCALAPPDATA%\AIbrowse\S5\run-live-smoke.ps1`（`-Sites` 开关进入 S6 多网站场景；
      DPAPI 解密 → 短暂赋环境变量 → 启动冒烟 → finally 清环境变量 + ZeroFreeBSTR 清零
      明文内存 + 清理临时 userData；脚本纯 ASCII——PowerShell 5.1 按 ANSI 解析无 BOM 的
      .ps1，中文会破坏解析）；④ 测试结束清除环境变量、明文内存和临时目录；⑤ 完成报告
      只列出调用次数与用途，不报告凭据或机器专属配置。
      **未经用户明确提供 Key 不得联网调用任何付费 API**；DPAPI 文件与本地说明默认保留
      供后续阶段复验，未经用户要求不得删除或轮换测试 Key。
- **git 双远程**（已初始化，2026-08-13 双远程推送验证）：
  ```bash
  # 日常推送：Gitee 直连
  git push gitee main
  # GitHub：经本机代理（git 只认 http.proxy 键；本机全局的 https.proxy 是无效键）
  git -c http.proxy=http://127.0.0.1:7890 push github main

  # 提交前必做：git status --short 复查工作区，无多余文件/敏感信息/构建产物
  ```
- **代理配置（已确认可用，2026-08-13 实测）**：本机代理 `http://127.0.0.1:7890`（Clash 类），
  github.com 经代理可达；Gitee 直连/代理均可达。⚠️ **git 的合法代理键是 `http.proxy`**
  （本机全局配置的 `https.proxy` 是无效键、会被静默忽略，导致推送时直连 github 超时）；
  推送 GitHub 一律用 `-c http.proxy=http://127.0.0.1:7890`。

## 7. 测试约定

- **框架**：Vitest 4，`environment: 'node'`（纯逻辑零环境依赖，分层纪律）；测试文件 `src/**/*.test.ts`。
- **重点测核心业务逻辑**（First_stage.md §十三），至少覆盖：
  - ✅ 地址栏输入 → URL / 搜索判断（`src/shared/url.test.ts`，15 用例，T0 红→绿落地）
  - ✅ Tab 状态机纯逻辑（`src/main/browser/tab-state.test.ts`，14 用例，T2 红→绿落地）
  - ✅ 网页权限策略默认拒绝（`src/main/browser/permission-policy.test.ts`，4 组用例，安全补丁）
  - ✅ UI 窗口导航保护自身来源白名单（`src/main/ui-navigation-policy.test.ts`，10 用例，T3 红→绿落地 + T4 收紧精确匹配）
  - ✅ PageSnapshot 数据规范化（`src/main/browser/snapshot-normalize.test.ts`，46 用例，T4 红→绿落地：
    不可信输入→L2 合法快照、限额二次截断、elementId 格式过滤、非法条目丢弃、表格行列对齐、
    warnings 去重）
- Second Stage（规格见 doc/stage2/detailed-design.md §13.1）：
  - ✅ S1（2026-08-13 红→绿落地，81 用例）：error-normalize 状态码矩阵与脱敏断言（18）、
    FakeProvider 确定性分块/错误注入/中止/getLastRequest（12）、OpenAI-compatible SSE
    分帧/帧判定（含末帧 delta+usage 同帧）/消息映射纯函数（12）、resolveProvider 注册表
    与 not-configured 路径（6）、credential-store 密文落盘/损坏容错/不可用降级/纯格式
    （16，cipher 后端注入测试替身，safeStorage 行为由冒烟验证）、config-store 校验规则
    与持久化（11）、logger sanitize `sk-…` 形态与 apiKey 键值对脱敏（6）。
  - ✅ S2（2026-08-13 红→绿落地，72 用例）：context-budget 确定性裁剪（42：预算优先级/
    各节与条目上限/总预算停止/截断标记/历史裁剪轮数与字符/单条重放上限与来源行/布局表
    过滤边界）、context-builder 角色隔离（30：system 恒等/块闭合转义与属性转义/注入文案
    夹具/selection 独占/模式推导矩阵/薄快照/L2 降级/历史重放/问题截断/warnings 合并/
    buildContextSource）。
  - ✅ S3（2026-08-13 红→绿落地，57 用例）：conversation-store 纯格式与文件读写（27：
    消息/会话形状校验、索引不含 ephemeral、整体损坏 fail-closed、上限裁剪、title 推导、
    原子写无 tmp 残留、删除含残留 tmp）、conversation-service 编排（30：生命周期/上限
    拒绝新建、§6.1 时序——实时采集防串页/L3/selection 独占/薄快照/先持久化 user 消息
    （磁盘探针）/错误归一化/not-configured 零网络、busy/abort 幂等与部分保留/dispose/
    deleteSession 中止不复活文件/ephemeral 不落盘与切换/重启恢复/200 条裁剪）。
  - ✅ S4（2026-08-13 红→绿落地，22 用例）：stream-state 纯 reducer（10：delta 追加/
    turn-done 收敛以终态全文为准/aborted-error 保留部分/requestId 不匹配竞态残留忽略/
    ask 拒绝文案）、history-events 历史收敛（6：乐观追加/turn-done 补 contextSource +
    追加终态/磁盘历史不覆盖/替换）、context-badge-format 徽标文案映射（6：selection
    N 字/snapshot thin-degraded 提示/none 原因）。UI 端到端矩阵 1–12 由 Electron 冒烟
    覆盖（§6）；IPC/bridge 参数校验与 Key 只写不回读为 main/preload 胶水层（冒烟断言）。
- Electron 本身难以单元测试的部分**不强 mock 成复杂系统**；纯逻辑与 Electron 壳分层
  （§3 分层纪律），让可测逻辑零环境依赖；真实采集行为由冒烟集成场景覆盖（§6）。
- 红→绿纪律 + 作业完成必跑全量回归（§3）。

## 8. 已知弱点与改进建议

- **本机环境变量陷阱**：`ELECTRON_RUN_AS_NODE=1` 全局存在（未改动，可能被本机 node 依赖），
  每次启动 Electron 须 `env -u` 排除，容易忘 → 后续可在 dev 脚本内兜底检测并给出中文提示。
- **本机全局 git 配置的 `https.proxy` 是无效键**：git 只认 `http.proxy`，该全局配置被静默忽略，
  GitHub 推送必须显式 `-c http.proxy=…`（§6）；是否清理全局配置待用户确认（属用户机器配置，未动）。
- **接口契约已定稿**（2026-08-13，T1）：唯一契约源 doc/detailed-design.md（含 Q1–Q4 决议与
  相对草案的 14 条变更）。T2/T3/T4 部分签名已于 2026-08-13 回填 §5 并与代码 grep 核对。
  已知设计限制：PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（快照点时刻尽力采样）。
- **PageSnapshot 采集已接入（T4）**：L0/L1/L2/L3 全阶梯可用；调试面板展示 degraded/warnings，
  能区分「页面没有链接」与「采集失败」。已知边界：iframe 跨域计数为尽力采样（未加载完成的
  同源 iframe 可能被计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回
  L2（按契约降级，不构成安全问题）；L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟中
  强制触发（normalize 单测覆盖 L2 形状，PageReader 拒绝路径为薄胶水）。
- **shared/url 已知限制**：不支持 IDN（中文域名）；无 SearchProvider 抽象（Bing 硬编码）；
  非 http/https/about 的 scheme 一律按搜索处理（安全优先，可接受）。
- **日志位置随打包变化**：开发时 log/ 在项目根目录；打包后写用户数据目录（asar 只读），排查注意两处。
- **尚无 CI / 打包配置**：第一阶段验收不要求；electron-builder 打包与 GitHub Actions
  （lint + test + typecheck）待阶段收尾评估。
- **冒烟已扩展（T2–T5 + S3–S4）**：覆盖多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等与
  webContents 无残留；T3 起覆盖 UI 窗口导航保护拦截（远程/同目录 file:/路径穿越三探针，
  dev origin 与生产 file: 精确匹配两条路径）与渲染层 bounds 上报生效；T4 起覆盖
  PageSnapshot 真实采集（本地受控双服务器页面：L0 内容对照/元素 id 唯一性与跨快照稳定/
  L1 跨域 iframe 跳过警告/L3 null）；T5 起覆盖敌对页面 elementId（重复/畸形/超大/冲突烙印）、
  Tab 302 重定向白名单（R-02 验证）、**UI 端到端**（React DOM 点击/键盘驱动地址栏/搜索/
  多 Tab/后退前进刷新/标题/调试面板，不引入 Playwright）、远程页面隔离探针、Session 跨进程
  持久化（AIBROWSE_SESSION_SMOKE=set/check 双进程，§6）；S3 起覆盖 AI 共读主进程矩阵
  1–8；S4 起覆盖 **AI 面板 UI 端到端矩阵 1–12**（含真实 safeStorage 密文落盘与 Key 零
  暴露断言，场景 10）。真实网页加载需 `AIBROWSE_SMOKE_URL` 附加验证（§6）。仍不覆盖：
  L2 触发路径（渲染进程崩溃）的强制触发（normalize 单测覆盖 L2 形状，PageReader 拒绝
  路径为薄胶水）。
- **Tab will-redirect 白名单为防御纵深（T5）**：file:/data:/about:blank 等重定向目标已被
  Chromium 网络层拦截（ERR_UNSAFE_REDIRECT，探针实测不触发 will-redirect）；当前无自定义
  协议注册，未来注册 `aibrowse://` 等协议时该拦截点是唯一防线（冒烟以 custom:// 目标验证
  handler 真实触发）。
- **Prompt Injection 边界声明（长期事实，第三阶段已重建）**：第二阶段结构性隔离保证
  网页内容不能取得权限、读取密钥、调用写操作或改变消息角色（doc/stage2/detailed-design.md
  §12）；第三阶段引入 Browser Tool 前**威胁模型已重建定稿**（2026-08-14，
  `doc/stage3/threat-model.md`：威胁枚举 T-01～T-10、五层防线、红队矩阵 R-01～R-10、
  诚实边界声明——语义层诱导式工具参数/确认疲劳/低风险动作累积三类残余风险如实登记，
  不宣称免疫）。

## 附 A：验证矩阵（「作业完成」的定义）

| 改动类型     | 必做验证                        | 说明                                |
| ------------ | ------------------------------- | ----------------------------------- |
| 任何改动     | 全量测试 + diff 终检 + 文档同步 | 测试全绿；diff 无杂项/密钥/意外重写 |
| 用户可见行为 | + 冒烟/实际运行验证             | 实际启动 Electron 验证可运行        |
| 交付物相关   | + 重新构建产物                  | 产物必须包含本次改动                |
| 重大版本     | + Release 发布与独立验证        | tag + 上传 + 下载 URL 验证          |
| 纯文档       | 免构建/重打包                   | 但提交推送必须                      |

## 附 B：第三阶段验收标准（摘要，完整清单见 Third_stage.md §9）

- **Agent**：可完成多步低风险网页任务；有最大步骤（12）/超时（420s）/取消；
  Tool 调用全程可审计；失败能安全停止而非无限重试（防循环三触发 + 结构化终止理由）。
- **Browser Tools**：read/find/scroll/open/click/fill 等核心工具稳定；elementId
  生命周期正确；页面刷新后不会误操作旧元素（执行时刻重新定位）。
- **Search**：AI 可经统一 SearchProvider 查询；搜索结果可继续交给 Browser Agent
  打开读取。
- **Permission**：高风险动作无法无确认执行（L2 确认门）；网页文本无法提升 Tool
  权限（确定性权限纯函数）；无万能 shell/eval/filesystem 工具（永久红线 grep 断言）。
- **Engineering**：全量验证通过；多个真实网站 Agent smoke test 通过（真实 Provider
  可选门控，需用户提供 Key）；Agent 操作日志无敏感信息。

## 附 C：第三阶段完成报告格式（Third_stage.md §10）

阶段完成后**停下**，不擅自开发第四阶段：更新 progress.md → 向用户报告（已实现内容 /
验证结果 / 剩余风险 / Fourth Stage 的切入点建议）→ **不直接实现信源数据库**，
等待下一条指令。
