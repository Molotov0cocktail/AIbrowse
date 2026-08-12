# AGENTS.md — AIbrowse 项目专属开发手册

> 依据 `.agents/skills/project-rules/PROJECT_RULES.md` §8 于 2026-08-13 初始化；
> 同月随根目录 `First_stage.md`（第一阶段总任务）同步更新。
> 新会话只读本文件 + `First_stage.md` 即可接管开发；与本文件冲突时以本文件为准，
> 通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`。
> 项目尚未动工：首次实现作业前先完成 §2 的 git 前置与脚手架（见 §8 已知弱点）。

## 1. 项目概览

- **一句话定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」——内置 Chromium 的
  多标签页浏览器，用户与 AI 共享同一浏览器会话与登录状态；AI 仅通过受限
  BrowserController / Tool Layer 操作浏览器，不得拥有任意系统权限。
- **当前阶段（第一阶段）**：只构建安全、稳定、可扩展的浏览器核心
  **Browser → PageSnapshot → Browser Tool Interface**；**不接入任何 LLM API**。
  完成后得到能真正运行的 Windows 桌面浏览器原型，程序自身能把当前网页转成结构化 PageSnapshot。
- **技术栈**：Electron + TypeScript + React + Vite + Node.js；页面承载用官方当前推荐的
  **WebContentsView**（禁用已废弃的 BrowserView）；测试 **Vitest**、lint **ESLint**、格式 **Prettier**。
  本阶段明确禁用：Playwright（作为浏览器主体）、SQLite、向量数据库、OpenAI/Anthropic API、
  RSS、Research Agent、图表系统、登录账号系统、云同步。
  若某技术选择与最新版 Electron 明显不兼容，可选更合理实现，但**必须在修改前说明原因**。
- **交付形态**：Windows 桌面应用（Electron 产物）。
- **git 双远程**（用户已提供，2026-08-13）：
  - Gitee（默认推送目标，国内直连，无需代理）：
    `https://gitee.com/Molotov0coaktail/aibrowse`
  - GitHub（任何网络操作前必须先启用并确认代理，见 §3 代理红线）：
    `https://github.com/Molotov0cocktail/AIbrowse`
  - ⚠️ 两个平台用户名拼写不一致（Gitee `Molotov0coaktail` / GitHub `Molotov0cocktail`），
    首次连接前与用户核实。
- **团队语言（中英混合）**：界面文案 / 错误信息 / 日志 / 提交信息 / 文档 → **中文**；
  代码注释 → **英文**。提交信息格式 `<type>: <中文描述>`，
  type ∈ feat / fix / docs / refactor / test / chore / perf；一条提交一个逻辑变更，写「为什么」。

## 2. 工作流程（每次作业的步骤链）

文档链（需求自上而下）：

```
First_stage.md（阶段总任务：需求/架构/验收标准，根目录）
  → doc/proposal.md（目标/非目标/场景/输入输出/依赖/约束/验收标准/待定问题）
  → doc/high-level-design.md + doc/detailed-design.md（架构/接口契约/文件布局/算法/错误处理/边界）
  → doc/tasks/<模块>.md + doc/tasks/progress.md（唯一进度源，主 agent 维护）
```

步骤链：

1. **稳定项目（含 git 前置）**：动工前摸清语言/框架/包管理器/测试/lint/构建/现有约定。
   **git 前置**：远程地址已确认（§1）；当前目录尚未建 git 仓库，首次动工前
   `git init` + 配置双远程 + 编写 .gitignore（`log/`、密钥/令牌本地文件、构建产物、IDE 个人配置）。
2. **需求澄清**：First_stage.md 已是阶段需求源；新需求先写 proposal。
3. **设计先行**：风险、歧义、备选方案必须写明，不得用自信措辞掩盖不确定性。
4. **任务拆分**：每任务 ≤1 个模块，含目标/涉及文件/步骤/测试/完成定义/依赖。
5. **小步实现**：一次一个未阻塞任务；实现 → 补测试 → 跑该任务检查 → 审阅 git diff → 更新 progress。
6. **验证闭环（含提交）**：全量测试 → lint/类型检查 → 冒烟（实际启动 Electron 验证可运行）→
   diff 终检（无关改动/生成杂项/密钥泄漏/意外重写）→ **提交前清除垃圾文件并复查工作区（§3）** →
   **每次任务完成必 git commit + push 双远程** → 更新项目状态 → 汇报（改了啥/验证了啥/剩余风险）。
7. **文档自动同步**：作业完成后自动更新本文件与 `progress.md` 的相应章节
   （结构/接口/命令/测试约定/版本发布），无需用户提醒。

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

## 4. 项目结构（2026-08-13 实际状态 + 规划）

```
d:\AIbrowse\
├── AGENTS.md                                      # 本文件：项目专属开发手册
├── First_stage.md                                 # 第一阶段总任务（需求/架构/验收标准源）
├── .agents/
│   └── skills/
│       ├── project-rules/PROJECT_RULES.md         # 通用工程规则基线（红线出处与场景索引）
│       └── vibe-coding-workflow/SKILL.md          # vibe-coding 工作流技能
├── doc/                                           # （待建）proposal/设计/任务文档链
├── log/                                           # （待建）运行日志，须加入 .gitignore
└── src/                                           # （待建）源码，结构见 First_stage.md §四
    ├── main/
    │   └── browser/
    │       ├── BrowserController.ts               # 浏览器能力统一入口（UI/AI 唯一操作面）
    │       ├── TabManager.ts                      # 标签页状态管理
    │       ├── SessionManager.ts                  # 持久 Session（为多 Profile 留接口）
    │       ├── PageReader.ts                      # 网页 → 结构化 PageSnapshot
    │       └── types.ts
    ├── renderer/
    │   ├── browser/                               # 浏览器 UI（顶部工具/标签栏/主区域/调试面板）
    │   └── layout/
    └── shared/
        └── types/                                 # 主/渲染进程共享类型
```

分层方向（不可反向或跳跃）：`UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`。
按实际 Electron 项目结构调整文件布局时，必须保持该分层不变。

## 5. 模块接口速查

接口契约源为 First_stage.md §五/§七（草案，可改进但不得机械复制；实现后回填实际签名，
并用 `grep -n "^export"` 与实际代码逐项核对）：

- **BrowserController**（浏览器能力统一入口；未来 AI Agent 只能经它/Tool Layer 操作浏览器）：
  `createTab(url?)` / `closeTab(tabId)` / `activateTab(tabId)` / `navigate(tabId, url)` /
  `goBack(tabId)` / `goForward(tabId)` / `reload(tabId)` / `getTabs()` / `getActiveTab()` /
  `getPageSnapshot(tabId)`，均返回 Promise；TabInfo/PageSnapshot 类型见 shared 层。
- **PageSnapshot**（结构化快照，**不得默认返回整个 DOM**；过滤 script/style/隐藏内容等噪声；
  为交互元素生成 `elementId`，在一次快照生命周期内对应真实 DOM 元素）：
  `url` / `title` / `viewport?{scrollX,scrollY,width,height}` / `selection?` / `visibleText?` /
  `headings{level,text}[]` / `links{id,text,href}[]` / `buttons{id,text}[]` /
  `inputs?{id,type,placeholder,value}[]` / `tables?{headers,rows}[]`。
  要求：PageReader 不污染网站正常行为；对执行失败/跨域/页面销毁合理错误处理；
  远程网页不得通过此机制执行 Node.js 或 Electron privileged API。
- **SessionManager**：本阶段仅持久 Session（重启后 Cookie/登录状态保留），
  为将来多 Profile（Personal/School/Work）留接口，不真正实现多 Profile。
- **URL 判断逻辑**：地址栏输入统一封装（不在 UI 散落）——`https://…` 直开、`example.com`
  规范化成 URL、`hello world` 走简单搜索引擎 URL；以后整体替换成 SearchProvider。

## 6. 常用命令

- **脚手架尚未建立**：项目未初始化，无 package.json/tsconfig；以下为按标准
  Electron + Vite + Vitest + ESLint + Prettier 项目预期的命令，**落地后以实际
  package.json scripts 为准并回填核对**：
  - `npm run dev` — 启动 Electron 开发模式
  - `npm run build` — 构建产物
  - `npm run test` — Vitest 全量测试
  - `npm run lint` — ESLint 检查
  - `npm run format` — Prettier 格式化
- **git 双远程**（已确定）：
  ```bash
  # 首次初始化（当前目录尚未建 git 仓库）
  git init
  git remote add gitee https://gitee.com/Molotov0coaktail/aibrowse
  git remote add github https://github.com/Molotov0cocktail/AIbrowse

  # 日常推送：Gitee 直连；GitHub 仅在代理确认可用后推送
  git push gitee main
  git push github main

  # 提交前必做：git status --short 复查工作区，无多余文件/敏感信息/构建产物
  ```
- **代理配置（GitHub 操作前必查）**：待定（以本机可用方式为准：git 代理 / 系统代理 / 镜像；
  首次使用前与用户确认并回填具体命令）。

## 7. 测试约定

- **框架**：Vitest（+ 随技术栈确定的运行环境）。
- **重点测核心业务逻辑**（First_stage.md §十三），至少覆盖：
  - 地址栏输入 → URL / 搜索判断（§5 URL 判断逻辑）
  - PageSnapshot 数据规范化
  - Tab 状态管理中的纯逻辑部分
- Electron 本身难以单元测试的部分**不强 mock 成复杂系统**；纯逻辑与 Electron 壳分层
  （§3 分层纪律），让可测逻辑零环境依赖。
- 红→绿纪律 + 作业完成必跑全量回归（§3）。

## 8. 已知弱点与改进建议

- **git 仓库尚未初始化** → 首次动工前按 §2 第 1 步完成 git init、双远程、.gitignore。
- **SKILL.md 引用的 `references/prompt-templates.md` 不存在** → 撰写 proposal/设计/任务文档前
  需先补齐该模板文件或另立模板。
- **双远程用户名拼写不一致** → 首次连接前与用户核实，避免推送失败或推错仓库。
- **项目零代码、无脚手架** → 首次动工先立「最小可测闭环」基线
  （PROJECT_RULES §4.1：文档链骨架 + 测试基建 + 提交基线），再做功能。
- **接口契约为草案** → First_stage.md 的示例接口可改进；详细设计阶段需细化：
  错误处理（跨域/页面销毁/执行失败）、preload bridge 最小权限清单、Tab 状态机的纯逻辑边界。
- **尚无 CI** → 技术栈确定后尽早建立 lint、类型检查、CI，让机器早期接住低级错误。

## 附 A：验证矩阵（「作业完成」的定义）

| 改动类型 | 必做验证 | 说明 |
|---|---|---|
| 任何改动 | 全量测试 + diff 终检 + 文档同步 | 测试全绿；diff 无杂项/密钥/意外重写 |
| 用户可见行为 | + 冒烟/实际运行验证 | 实际启动 Electron 验证可运行 |
| 交付物相关 | + 重新构建产物 | 产物必须包含本次改动 |
| 重大版本 | + Release 发布与独立验证 | tag + 上传 + 下载 URL 验证 |
| 纯文档 | 免构建/重打包 | 但提交推送必须 |

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
