# AGENTS.md — AIbrowse 项目专属开发手册

> 依据 `.agents/skills/project-rules/PROJECT_RULES.md` §8 于 2026-08-13 初始化；
> 与根目录 `First_stage.md`（当前阶段需求/验收标准）、`ROADMAP.md` + `Second_stage.md`～`Seventh_stage.md`
> （后续阶段路线与需求/验收标准）配套；技术基线已于 2026-08-13 按官方来源验证冻结（§1）。
> 新会话接管顺序：本文件 → 当前阶段文件（现为 `First_stage.md`）→ `doc/tasks/progress.md` → git 状态与代码核对（§2 步骤 0）。
> 与本文件冲突时以本文件为准，通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`。
> 任务进度不记在本文件：唯一进度源 `doc/tasks/progress.md`（本文件仅在有长期变化时更新，见 §2）。

## 1. 项目概览

- **一句话定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」——内置 Chromium 的
  多标签页浏览器，用户与 AI 共享同一浏览器会话与登录状态；AI 仅通过受限
  BrowserController / Tool Layer 操作浏览器，不得拥有任意系统权限。
- **当前阶段（第一阶段）**：只构建安全、稳定、可扩展的浏览器核心
  **Browser → PageSnapshot → Browser Tool Interface**；**不接入任何 LLM API**。
  完成后得到能真正运行的 Windows 桌面浏览器原型，程序自身能把当前网页转成结构化 PageSnapshot。
- **阶段机制**：`ROADMAP.md` 描述全阶段路线与切换原则；各阶段需求/验收标准分文件存放
  （当前 `First_stage.md`，后续 `Second_stage.md`～`Seventh_stage.md`）。
  当前处于第一阶段；**只有当前 Stage 的 Exit Gate 通过后才切换下一 Stage**（纪律见 §2 文档职责划分）。
  各 Stage 文件的完整内容不复制进本文件，需要时直接读对应 Stage 文件。
- **技术栈**：Electron + TypeScript + React + Vite + Node.js；页面承载用官方当前推荐的
  **WebContentsView**（禁用已废弃的 BrowserView）；测试 **Vitest**、lint **ESLint**、格式 **Prettier**。
  本阶段明确禁用：Playwright（作为浏览器主体）、SQLite、向量数据库、OpenAI/Anthropic API、
  RSS、Research Agent、图表系统、登录账号系统、云同步。
  若某技术选择与最新版 Electron 明显不兼容，可选更合理实现，但**必须在修改前说明原因**。
  **技术基线（2026-08-13 按官方来源验证后冻结）**：Node.js 24.x（Active LTS，本机 24.18.0；
  Electron 43.4.0 内置 Node 24.18.1，运行时实测）/ Electron 43.4.0 / electron-vite 5.0.0 / Vite 7.3.6 /
  @vitejs/plugin-react 5.2.0 / React 19.2.8 / TypeScript 6.0.3（typescript-eslint 8.67.0 官方支持范围
  `>=4.8.4 <6.1.0`）/ Vitest 4.1.10 / ESLint 10.8.1（flat config）/ Prettier 3.9.6；
  依赖全部精确版本固定（无 ^/~，`.npmrc` save-exact=true），`engines.node` `>=24 <25` +
  `.node-version` = 24.18.0；main/preload 输出 CJS（preload 必须 CJS 以兼容 `sandbox=true`）。
  ⚠️ **基线冻结**：第一阶段内任何 Agent 不得擅自升级上述核心工具链；升级必须走 §3「技术基线升级流程」。
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
当前阶段文件 First_stage.md（后续 Second_stage.md～Seventh_stage.md，Exit Gate 通过后依次启用）
  ↓
AGENTS.md（长期规则/稳定架构/技术基线，低频修改）
  ↓
doc/（proposal / 设计 / 任务文档，按需产出）
  ↓
doc/tasks/progress.md（当前工程状态/短期记忆，高频更新）
  ↓
Git + 代码 + Test/Typecheck/Lint/Build/冒烟（真实历史与机器验证）
```

- **阶段切换纪律**：当前处于第一阶段。只有当前 Stage 的 **Exit Gate** 全部通过（逐项核对该 Stage
  文件的 Exit Gate/验收标准、progress.md 无阻塞级缺陷、全量验证通过）后，才可切换到下一 Stage；
  切换按 ROADMAP.md「阶段切换原则」执行；阶段完成后**停下向用户报告**，不得擅自进入下一阶段
  （First_stage.md §十五 / 本文件附 C）。
- 不引入额外的状态文件 / Agent 日志 / checklist / handoff / summary 文件，除非实际开发证明必要。
- **文档用于理解需求与意图；Git、当前代码、测试和构建结果用于确认项目实际状态。**
  若 progress.md 声称某功能已完成、但代码/Git/测试证明没有：以实际工程状态为事实，修正文档，再继续开发。
  同样，代码存在也不得违背 First_stage.md / AGENTS.md 中的明确需求与安全规则。

### 步骤 0：新对话接管（每次新对话开始先做）

1. 阅读 `AGENTS.md`（本文件）
2. 阅读当前阶段文件（现为 `First_stage.md`；后续阶段文件为 `Second_stage.md`～`Seventh_stage.md`）
3. 阅读 `doc/tasks/progress.md`（如存在）
4. `git status` + 最近若干条 `git log --oneline`
5. 检查本次任务相关的实际代码和配置
6. 确认文档描述与代码实际状态一致（不一致按上述原则处理）
7. 然后才开始工作

### 步骤链

1. **稳定项目（含 git 前置）**：动工前摸清语言/框架/包管理器/测试/lint/构建/现有约定。
   git 远程已配置（§1）；新建项目时再执行 git init + 双远程 + .gitignore（`log/`、密钥/令牌本地文件、
   构建产物、IDE 个人配置）。
2. **需求澄清**：First_stage.md 已是阶段需求源；新需求先写 proposal。
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
- **安全红线**（First_stage.md §八，从第一版开始）：远程网页 `nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`（架构允许时）、`webSecurity` 不得关闭；
  远程网页不得直接访问 Electron API / 文件系统 / 程序内部数据；preload bridge 最小权限，
  不把 ipcRenderer 整体暴露给网页；限制不必要的 window.open/新窗口行为；合理处理导航；
  React UI 与远程网页保持明确安全边界。**不得为省事关闭 Electron 安全机制。**
- **TypeScript 纪律**（First_stage.md §十二）：类型错误不得用 `any`、`@ts-ignore` 或关闭严格
  检查解决；不得删除有意义的测试来让测试通过；不留明显 placeholder 实现然后声称完成。
- **生命周期纪律**（First_stage.md §十二）：对 Electron 生命周期、Tab 销毁、WebContents 销毁
  做好清理；注意 memory leak 与 event listener 重复注册。
- **范围纪律（第一阶段不做清单，First_stage.md §十一）**：AI Chat、LLM API（OpenAI/Claude/Gemini）、
  Agent、收藏夹、SQLite、RSS、网页监控、Research、自动点击/填写、CDP Network 分析、下载管理器、
  浏览器插件、密码管理器、完整历史记录系统、浏览器同步、PDF viewer、广告拦截器——
  除非基础浏览器正常运行绝对必要，不得主动扩展。
- **技术基线冻结（第一阶段）**：§1 已冻结版本不得由后续 Agent 擅自升级。升级流程：
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
├── AGENTS.md / First_stage.md / README.md     # 手册 / 当前阶段需求与验收 / 启动与架构简介
├── ROADMAP.md / Second_stage.md～Seventh_stage.md  # 全阶段路线图 / 后续各阶段需求与验收标准
├── .agents/skills/…                           # 规则基线 + references/prompt-templates.md
├── .gitignore / .editorconfig                 # 忽略 log/、密钥、构建产物、IDE 个人配置
├── .prettierrc.json / .prettierignore         # 格式约定（需求/路线文档不参与格式化）
├── .node-version / .npmrc                     # Node 24.18.0 固定 / save-exact 精确版本
├── electron.vite.config.ts / vitest.config.ts # 构建（三目标）/ 测试配置
├── tsconfig.json + tsconfig.node/web.json     # 主进程与渲染进程各自的严格配置
├── eslint.config.mjs                          # ESLint 10 flat config（react-hooks + refresh）
├── package.json / package-lock.json           # 脚本见 §6；lockfile 入库
├── doc/                                       # proposal / 设计 / tasks（progress.md 唯一进度源）
├── log/                                       # 运行时日志（gitignore，按日轮转）
└── src/
    ├── main/
    │   ├── index.ts                           # 入口：生命周期/单实例锁/安全默认值/IPC 装配（sender 校验）/冒烟
    │   ├── logger.ts                          # log/ 文件日志（脱敏、按日轮转）
    │   ├── smoke.ts                           # AIBROWSE_SMOKE 浏览器核心场景（T2 扩展）
    │   └── browser/
    │       ├── browser-controller.ts          # 浏览器能力统一入口（接口 BrowserController + 实现类）
    │       ├── tab-manager.ts                 # WebContentsView 创建/销毁/事件→TabInfo 登记表
    │       ├── tab-state.ts / .test.ts        # 状态机纯函数 + 14 用例
    │       ├── session-manager.ts             # persist:aibrowse 分区（多 Profile 预留；双权限处理器默认拒绝）
    │       ├── permission-policy.ts / .test.ts  # 网页权限策略纯函数（v1 默认拒绝）+ 4 组用例（安全补丁）
    │       ├── page-reader.ts                 # （T4 待建）快照编排：注入 + 降级阶梯
    │       ├── snapshot-script.ts             # （T4 待建）注入脚本源（自安装 IIFE 字符串）
    │       └── snapshot-normalize.ts          # （T4 待建）脚本输出校验纯函数
    ├── preload/
    │   ├── index.ts                           # UI bridge（contextBridge 白名单，最小权限）
    │   └── index.d.ts                         # renderer 侧 window.aibrowse 类型
    ├── renderer/                              # React UI（index.html + src/）
    └── shared/
        ├── types/app.ts                       # 共享类型（AppInfo / AibrowseBridge）
        ├── types/browser.ts                   # TabInfo/TabsState/PageSnapshot/meta（T2）
        ├── types/ipc.ts                       # IPC 通道常量 + payload 类型（T2）
        └── url.ts / url.test.ts               # 地址栏输入判断纯函数 + 15 用例
```

分层方向（不可反向或跳跃）：`UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`。
按实际 Electron 项目结构调整文件布局时，必须保持该分层不变。

## 5. 模块接口速查

接口契约已于 2026-08-13 **定稿**（T1），唯一契约源 `doc/detailed-design.md`（§2–§7 + §12 决议记录，
含 proposal Q1–Q4 拍板）；以下为速查摘要，**T2 部分已用 `grep -n "^export"` 与实际代码逐项核对**
（2026-08-13）；PageReader 部分（T4）尚未实现。

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
  `getPageSnapshot(tabId) → Promise<PageSnapshot | null>`（null = L3；**当前返回真实 L2 快照**，
  采集脚本 T4 接入）/ `dispose(): void`（退出路径全量清理，幂等，不触发最后 Tab 策略）。
  **类方法（不在 AI 契约接口内，UI 接线用）**：`setContentBounds(bounds: ContentBounds): void`
  （ui:content-bounds 通道落点，非法值忽略 + warn）。
  地址栏原始输入由 main 侧 IPC handler 统一规范化后再进 controller（§9）。
- **TabManager（T2）**：`export class TabManager` + `TabEntry`/`TabEntryInfo`/`TabManagerOptions`。
  每个 Tab 一个 WebContentsView（显式安全默认值：无 preload、`nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`、`session=persist:aibrowse`）；可见性用 `setVisible`
  切换（不用 removeChildView）；全部监听器注册于创建时、closeTab/dispose 时逐一移除；
  `will-navigate` 白名单 http/https/about + `setWindowOpenHandler` 一律 deny。
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
- **PageSnapshot**（T4 实现）要求：结构化快照**不得默认返回整个 DOM**；过滤
  script/style/隐藏内容等噪声；为交互元素生成 `elementId`（双层映射，§8.4），在一次快照
  生命周期内对应真实 DOM 元素。PageReader 不污染网站正常行为；对执行失败/跨域/页面销毁
  合理错误处理；远程网页不得通过此机制执行 Node.js 或 Electron privileged API。
- **URL 判断逻辑（已实现）**：见上 shared/url；地址栏接入后 main 侧统一调用（T3）。
  已知限制：不支持中文/国际化域名（IDN）；以后替换 SearchProvider 时一并评估。

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
  - `npm test` — Vitest 全量测试（当前 33 用例）
  - `npm run typecheck` — tsc 严格检查（node + web 两套 tsconfig）
  - `npm run lint` / `npm run format` / `npm run format:check` — ESLint / Prettier 格式化 / 检查
  - **冒烟自检**：`env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev`
    （启动 → 窗口 → React 挂载 → preload bridge 链路 → T2 起再跑浏览器核心场景：多 Tab
    创建/切换/关闭、最后 Tab 自动新建、dispose 幂等无泄漏 → 自动退出，退出码 0 即通过；
    日志链见 log/）。可选真实网页加载验证（需网络）：
    `AIBROWSE_SMOKE_URL=https://www.bing.com/` 附加设置（15 秒超时，验证 state=ready + 标题非空）。
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
  - ⏳ PageSnapshot 数据规范化（规划 T4：`snapshot-normalize.test.ts`）
- Electron 本身难以单元测试的部分**不强 mock 成复杂系统**；纯逻辑与 Electron 壳分层
  （§3 分层纪律），让可测逻辑零环境依赖。
- 红→绿纪律 + 作业完成必跑全量回归（§3）。

## 8. 已知弱点与改进建议

- **本机环境变量陷阱**：`ELECTRON_RUN_AS_NODE=1` 全局存在（未改动，可能被本机 node 依赖），
  每次启动 Electron 须 `env -u` 排除，容易忘 → 后续可在 dev 脚本内兜底检测并给出中文提示。
- **本机全局 git 配置的 `https.proxy` 是无效键**：git 只认 `http.proxy`，该全局配置被静默忽略，
  GitHub 推送必须显式 `-c http.proxy=…`（§6）；是否清理全局配置待用户确认（属用户机器配置，未动）。
- **接口契约已定稿**（2026-08-13，T1）：唯一契约源 doc/detailed-design.md（含 Q1–Q4 决议与
  相对草案的 14 条变更）。T2 部分（BrowserController/TabManager/SessionManager/tab-state/
  shared 类型/IPC）签名已于 2026-08-13 回填 §5 并与代码 grep 核对；PageReader 部分待 T4。
  已知设计限制：PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（快照点时刻尽力采样）。
- **PageSnapshot 当前为 L2-only（T2 状态）**：采集脚本（PageReader）T4 接入前，
  `getPageSnapshot` 始终返回真实 L2 降级快照（主进程侧 url/title + 空集合 +
  `degraded:'main-process-only'` + warnings 明示原因）；调试面板（T4）据此可区分
  「页面没有链接」与「采集失败」。
- **shared/url 已知限制**：不支持 IDN（中文域名）；无 SearchProvider 抽象（Bing 硬编码）；
  非 http/https/about 的 scheme 一律按搜索处理（安全优先，可接受）。
- **日志位置随打包变化**：开发时 log/ 在项目根目录；打包后写用户数据目录（asar 只读），排查注意两处。
- **尚无 CI / 打包配置**：第一阶段验收不要求；electron-builder 打包与 GitHub Actions
  （lint + test + typecheck）待阶段收尾评估。
- **冒烟已扩展（T2）**：覆盖多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等与
  webContents 无残留；真实网页加载需 `AIBROWSE_SMOKE_URL` 附加验证（§6）。仍不覆盖：
  地址栏 UI 交互（T3）、PageSnapshot 采集（T4）。

## 附 A：验证矩阵（「作业完成」的定义）

| 改动类型     | 必做验证                        | 说明                                |
| ------------ | ------------------------------- | ----------------------------------- |
| 任何改动     | 全量测试 + diff 终检 + 文档同步 | 测试全绿；diff 无杂项/密钥/意外重写 |
| 用户可见行为 | + 冒烟/实际运行验证             | 实际启动 Electron 验证可运行        |
| 交付物相关   | + 重新构建产物                  | 产物必须包含本次改动                |
| 重大版本     | + Release 发布与独立验证        | tag + 上传 + 下载 URL 验证          |
| 纯文档       | 免构建/重打包                   | 但提交推送必须                      |

## 附 B：第一阶段验收标准（摘要，完整清单见 First_stage.md §十四）

- **浏览器**：应用正常启动、打开网页、URL 输入、地址栏搜索、多 Tab（新建/切换/关闭）、
  前进/后退/刷新有效、Tab 标题随网页变化。
- **Session**：Cookie 使用持久 Session；重启应用后普通网站登录状态保持。
- **PageSnapshot**：可读取当前网页，返回 URL/标题/主要文本/heading/link/button、识别常见 table、
  为交互元素生成 elementId；调试面板能显示 PageSnapshot JSON。
- **Architecture**：BrowserController / TabManager / PageReader / SessionManager 各自独立；
  React UI 不滥用 Electron privileged API；类型定义清晰。
- **Security**：nodeIntegration 未对远程网页开启、contextIsolation 开启、webSecurity 不关闭、
  远程网站无法直接调用 Node.js、IPC 暴露遵循最小权限。
- **Engineering**：TypeScript 编译通过、lint 通过、测试通过；README 包含启动方式并简述架构。

## 附 C：第一阶段完成报告格式（First_stage.md §十五）

阶段完成后**停下**，不擅自开发第二阶段，向用户报告：已实现内容 / 项目结构 /
测试和构建结果 / 已知限制 / 下一阶段最适合做什么，然后等待下一条指令。
