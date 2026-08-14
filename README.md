# AIbrowse — AI 信息浏览器

> 第三阶段目标：**Browser Agent 与受限工具系统**——AI 通过受限、可审计、可撤销的
> Tool Layer 自主完成低风险浏览任务：tool-calling 兼容层（A1 硬前置）、Tool Registry、
> SearchProvider、scroll/click/fill/find 交互能力（elementId 生命周期）、最小可控
> Agent Loop（最大步数/超时/取消/防循环）、确定性权限分级与确认状态机（L0 自动 /
> L1 自动显著展示 / L2 用户确认 / L3 禁止）、操作可见性与审计日志。契约源
> `doc/stage3/detailed-design.md`；安全契约源 `doc/stage3/threat-model.md`
> （Prompt Injection 威胁模型已重建定稿，先于任何 Browser Tool 实现）。
> **设计定稿与任务拆分已完成（2026-08-14），尚未开始实现**（任务 A1–A8；
> 2026-08-14 实施前校正：任务编号由 T1–T8 改为 A1–A8 避免与第一阶段任务 T1–T5 重名、
> 红队编号改 RT-01～RT-11、权限契约收紧为 click 确定性允许列表，见
> `doc/stage3/proposal.md` §11）。
> 核心原则：AI 决定「需要做什么」；确定性程序决定「是否允许、如何执行、执行结果是什么」。
> 需求源：`Third_stage.md`；开发手册：`AGENTS.md`；进度：`doc/tasks/progress.md`。

## 当前状态（2026-08-14）

- ✅ **第一阶段完成（Exit Gate 通过，2026-08-13）**：T0 项目基线 → T1 详细设计定稿 →
  T2 浏览器核心（BrowserController/TabManager/SessionManager + WebContentsView）→
  T3 浏览器 UI → T4 PageSnapshot（PageReader/采集脚本/normalize/调试面板）→
  T5 收尾（安全审计 + R-02 will-redirect 加固 + 验收清单逐项核对 + 文档同步）。
  验收证据见 `First_stage.md` §十四。
- ✅ **第二阶段（AI 共读）完成并通过验收（2026-08-13/14）**：S1 Provider 抽象与凭据
  安全基座 → S2 ContextBuilder 纯核心 → S3 ConversationService 与会话持久化 →
  S4 AI 侧栏 UI 与 IPC/bridge 扩展 → S5 安全审计与 Prompt Injection 验证 →
  S6 收尾验收（§9 四组 16 项逐项通过 + §10 Exit Gate 判定通过，含真实 Provider
  多网站共读验证）。用户独立复验（2026-08-14）发现的 4 项非阻塞测试基础设施/
  文档缺陷已修复并全量回归（红态退出码 1 → 绿态 0）。证据见 `Second_stage.md`
  §9/§10 与 `doc/tasks/progress.md`。
- 🔨 **第三阶段（Browser Agent）设计定稿与任务拆分完成（2026-08-14）**：Entry Gate
  逐项核验通过（「tool calling」项经循环式门槛判定记录校正——该能力属第三阶段自身
  交付物，校正为 A1 硬前置：A1 验证通过前禁止引入任何 Browser Tool 实现，判定证据
  见 `doc/stage3/proposal.md` §8）；Prompt Injection 威胁模型重建定稿
  （`doc/stage3/threat-model.md`）；契约定稿 `doc/stage3/detailed-design.md`；
  任务 A1–A8 见 `doc/stage3/tasks/`（**下一个推荐任务：A1**）。**尚未开始实现，
  不引入任何 Browser Tool。**

## 技术栈（实际落地版本）

Electron 43.4.0（WebContentsView 承载网页）· electron-vite 5 · Vite 7.3.6 · React 19.2.8 ·
TypeScript 6.0.3 · Vitest 4 · ESLint 10（flat config）· Prettier 3.9 · Node.js 24.x（engines `>=24 <25`）

## 快速开始

```bash
npm install      # 首次安装 Electron 二进制见下方「本机环境注意」第 2 条
npm run dev      # 开发模式启动（真实启动 Electron 应用）
```

冒烟自检（启动 → 窗口 → React 挂载 → preload bridge 链路 → 浏览器核心场景 →
T3 UI 导航保护/bounds → T4 PageSnapshot 真实采集 → T5 敌对页/302 拦截/UI 端到端/远程隔离 →
S3/S4 AI 共读场景：FakeProvider 离线矩阵流式端到端/selection 独占/防串页/L3 降级/薄快照/
中止/错误归一化/会话持久化/UI 端到端/bounds 协调/Key 不可达/注入结构断言 →
自动退出，退出码 0 即通过；矩阵见 `doc/stage2/detailed-design.md` §13.2）：

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev
```

真实 Provider 可选验证（开发者流程，需用户已提供 Key——未经提供不联网调用付费 API；
Key 永不写进命令行或项目文件）：

1. 先读取仓库外本地说明 `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md`（记录测试用
   base URL / model / DPAPI 密钥文件路径与注入规则——凭据与机器专属配置不进本仓库）。
2. API Key 以 Windows DPAPI 密文保存在仓库外 `%LOCALAPPDATA%\AIbrowse\S5\provider-key.dpapi`，
   测试时由仓库外启动脚本在受控子进程中解密并经环境变量短暂注入（测试结束清零内存、
   清除环境变量与临时目录，不打印 Key）：

```powershell
# S5 固定问题一问一答 / S6 多网站共读验证（§10 Exit Gate）
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AIbrowse\S5\run-live-smoke.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AIbrowse\S5\run-live-smoke.ps1" -Sites
```

3. 不设固定调用次数：每次真实调用必须对应明确的验收项或缺陷复验；完成报告列出调用
   次数与用途，不包含凭据。

Session 跨进程持久化验证（两个独立进程 + 同一临时目录，验证 Cookie 重启后保留；
以生产产物验收，先执行 `npm run build`）：

```bash
# 进程 A：写入 Cookie 后完整退出；进程 B：新进程读回 Cookie
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set AIBROWSE_USER_DATA_DIR=C:\Temp\aibrowse-session-smoke npm run start
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=check AIBROWSE_USER_DATA_DIR=C:\Temp\aibrowse-session-smoke npm run start
```

| 命令                              | 作用                                                |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | Electron 开发模式（渲染进程 HMR）                   |
| `npm run build`                   | 构建产物 `out/`（main / preload / renderer 三目标） |
| `npm run start`                   | 以构建产物启动（preview）                           |
| `npm test`                        | Vitest 全量测试（当前 326 用例）                    |
| `npm run typecheck`               | 严格类型检查（node + web 两套 tsconfig）            |
| `npm run lint`                    | ESLint 检查                                         |
| `npm run format` / `format:check` | Prettier 格式化 / 检查                              |

## 本机环境注意（重要）

1. **本机全局环境变量 `ELECTRON_RUN_AS_NODE=1`**：会让 Electron 以纯 Node 模式启动而崩溃。
   该全局变量可能被你的 Node 配置依赖，本项目不改动它，启动 Electron 时命令级排除：
   `env -u ELECTRON_RUN_AS_NODE npm run dev`（PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null; npm run dev`）。
2. **安装依赖走代理**（Electron 二进制从 GitHub 下载；Node 24 原生 fetch 需显式开启代理支持）：
   `NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm install`

## 架构简述

三层依赖方向固定，不可反向或跳跃：

```
React UI（渲染进程）→ BrowserController（主进程，浏览器能力统一入口）
                    → TabManager / PageReader / SessionManager
                    → Electron APIs（WebContentsView 承载远程网页）
```

- 每个 Tab 一个 WebContentsView（`persist:aibrowse` 持久分区），React UI 是独立的主窗口
  webContents；两者处于明确安全边界（UI 有 preload bridge，Tab 无 preload）。
- 远程网页：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，`webSecurity` 不关闭。
- React UI 仅经最小 preload bridge（`window.aibrowse` 白名单）通信，绝不直接调用 Electron
  webContents API；主进程每个 IPC handler 校验 sender 为主窗口主帧。
- PageSnapshot 采集（PageReader）：`executeJavaScript` 注入观察性采集脚本（不注册事件、
  不执行 Node API），唯一写操作是为交互元素做唯一、命名空间受控（`data-aibrowse-el`）、
  幂等的 elementId 属性烙印；页面输出视为敌手，经 normalize 逐字段校验后返回；
  降级阶梯 L0（完整）/ L1（iframe 跳过/未加载完，partial）/ L2（采集失败，仅主进程侧
  url/title）/ L3（tab 不可用，null）。type=password 不采集 value。
- 纯逻辑（地址栏输入判断 `src/shared/url.ts`、Tab 状态机、权限策略、UI 导航保护、
  快照 normalize）零环境依赖、可单测；UI/IO 副作用在外层胶水。
- AI 子系统（第二阶段，已实现并通过验收）：依赖方向 `UI(AI 面板) → ConversationService →
ContextBuilder / LLMProvider → SecureCredentialStore`；网页上下文经 `ConversationService →
BrowserController.getPageSnapshot`（**提问时刻实时采集**，禁止复用缓存快照——防串页）。
  LLM 请求仅在主进程发起（API Key 不出主进程，渲染层只写不读）；网页内容只进 user 消息的
  `UNTRUSTED_WEB_CONTENT` 块（system 恒为应用常量）；Key 落盘仅 safeStorage（Windows DPAPI）
  密文；会话持久化为 userData 下 JSON（不存快照正文，支持「不保存」会话）。
- Browser Agent（第三阶段，设计定稿待实现）：`UI → ConversationService(agent 模式) →
AgentLoop → ToolRegistry → PermissionPolicy / ConfirmManager / ToolExecutor →
BrowserController / SearchProvider`；工具实现只经 BrowserController/SearchProvider 操作
  浏览器；权限判定为确定性纯函数（模型只是提议者）；**click 走确定性允许列表
  （链接/展开/切换 L1、提交类 L2、非允许列表目标 fail-closed L3），L3 敏感动作
  在权限层与执行器层双重封死无执行通道**；Tool Result 与网页内容同等视为不可信；
  禁止万能工具（shell/eval/任意 JS/文件系统/HTTP POST/任意 IPC/SQL 永久红线）；
  Element 交互经固定模板注入脚本（click/fill/scroll，参数只进 JSON 字面量），
  elementId 执行时刻重新定位；威胁模型见 `doc/stage3/threat-model.md`。

## 目录结构

```
src/
├── main/          # 主进程：入口（生命周期/窗口/安全默认值/IPC 装配/导航保护）、logger、
│   │              #   smoke（冒烟自检：多 Tab/导航保护/真实采集/敌对页/302/UI 端到端/Session/
│   │              #             AI 共读矩阵）
│   ├── browser/   # BrowserController / TabManager / SessionManager / PageReader /
│   │              #   snapshot-script + snapshot-normalize / tab-state / permission-policy
│   │              #   （第三阶段 A3 规划：interaction-script 交互注入）
│   └── ai/        # （第二阶段已实现）ConversationService / ConversationStore /
│                  #   ContextBuilder + budget / CredentialStore / ConfigStore /
│                  #   provider（LLMProvider/OpenAI-compatible/FakeProvider/error-normalize）
│                  # （第三阶段规划）agent/（AgentLoop 等）+ tools/（Registry/executor）
│                  #   + permission/ + confirm-manager + audit-log + search/（A1–A5）
├── preload/       # UI bridge（contextBridge，白名单 IPC：tabs/nav/page/ui + conversation/config；
│                  #   第三阶段 A6 规划 agent 通道）
├── renderer/      # React UI：chrome（Toolbar/TabBar/AddressBar/DebugPanel）+ ai/（AI 侧栏；
│                  #   第三阶段 A6 规划 Agent 模式/状态栏/确认对话框）
└── shared/        # 共享类型（app/browser/ipc/conversation + 第三阶段 A2 规划 agent）+ 纯逻辑（url.ts）
```

完整结构与职责见 `AGENTS.md` §4；第二阶段契约与任务见 `doc/stage2/`（定稿）；
第三阶段契约与任务见 `doc/stage3/`。

## 日志

每次运行生成详尽日志（启动/退出、关键路径、错误堆栈、环境信息）：项目根目录 `log/`（按日轮转，已 gitignore）。
打包后写入用户数据目录下 `log/`。

## 测试

Vitest（node 环境）测核心纯逻辑（当前 326 用例）：地址栏输入判断（15）、Tab 状态机（14）、
网页权限策略（4 组）、UI 导航保护（10）、PageSnapshot 数据规范化（46，页面视为敌手）；
第二阶段（S1–S4）新增：错误归一化状态码矩阵与脱敏、FakeProvider 确定性行为、
credential/config 校验（81）、上下文预算确定性裁剪、ContextBuilder 角色隔离与注入夹具
（system 恒等/块闭合转义/selection 独占）（72）、会话消息校验与编排（57）、
UI 纯 reducer 与徽标文案（22）、logger 脱敏密钥专项用例。
Electron 行为由冒烟自检真实启动验证（见上）。约定见 `AGENTS.md` §7。

## 已知限制

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（设计决议，点时刻尽力采样）。
- 地址栏不支持中文/国际化域名（IDN，走搜索兜底）；搜索引擎暂硬编码 Bing（后续换 SearchProvider）。
- 无 CI / 打包配置（第一阶段验收不要求；打包属 Seventh Stage）。
- 冒烟中的搜索验证在离线环境断言「发起 Bing 搜索导航」而非页面加载完成（联网冒烟变体可验证）。
- Prompt Injection 边界：第二阶段结构性隔离保证网页内容不能取得权限、读取密钥、调用写
  操作或改变消息角色（机器可验证）；第三阶段引入 Browser Tool 前**威胁模型已重建定稿**
  （`doc/stage3/threat-model.md`：五层防线 + 红队矩阵 RT-01～RT-11）。仍**不承诺**模型在
  语义层完全不受网页文本诱导——第三阶段四类残余风险（诱导式工具参数/确认疲劳/低风险
  动作累积/click 允许列表目标的页内 JS 副作用）如实登记，不宣称免疫。
- 详细清单见 `doc/tasks/progress.md`「计划内限制与延期项」。
