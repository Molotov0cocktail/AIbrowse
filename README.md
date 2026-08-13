# AIbrowse — AI 信息浏览器

> 第一阶段目标：安全、稳定、可扩展的 **Windows 桌面浏览器核心原型**——`Browser → PageSnapshot → Browser Tool Interface`；
> 程序自身能把当前网页读取为结构化 PageSnapshot。**不接入任何 LLM API。**
> 需求源：`First_stage.md`；开发手册：`AGENTS.md`；进度：`doc/tasks/progress.md`。

## 当前状态（2026-08-13）

- ✅ **第一阶段完成（Exit Gate 通过）**：T0 项目基线 → T1 详细设计定稿 → T2 浏览器核心
  （BrowserController/TabManager/SessionManager + WebContentsView）→ T3 浏览器 UI
  （工具栏/标签栏/地址栏/导航保护）→ T4 PageSnapshot（PageReader/采集脚本/normalize/调试面板）→
  T5 收尾（安全审计 + R-02 will-redirect 加固 + 验收清单逐项核对 + 文档同步）。
  验收证据见 `First_stage.md` §十四；进度见 `doc/tasks/progress.md`。
  下一步等待用户指令，按 `ROADMAP.md` 切换第二阶段。

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
自动退出，退出码 0 即通过）：

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev
```

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
| `npm test`                        | Vitest 全量测试（当前 89 用例）                     |
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

## 目录结构

```
src/
├── main/          # 主进程：入口（生命周期/窗口/安全默认值/IPC 装配/导航保护）、logger、
│   │              #   smoke（冒烟自检：多 Tab/导航保护/真实采集/敌对页/302/UI 端到端/Session）
│   └── browser/   # BrowserController / TabManager / SessionManager / PageReader /
│                  #   snapshot-script + snapshot-normalize / tab-state / permission-policy
├── preload/       # UI bridge（contextBridge，白名单 IPC，最小权限）
├── renderer/      # React UI：Toolbar / TabBar / AddressBar / DebugPanel + hooks
└── shared/        # 共享类型（app/browser/ipc）+ 纯逻辑（url.ts）
```

完整结构与职责见 `AGENTS.md` §4。

## 日志

每次运行生成详尽日志（启动/退出、关键路径、错误堆栈、环境信息）：项目根目录 `log/`（按日轮转，已 gitignore）。
打包后写入用户数据目录下 `log/`。

## 测试

Vitest（node 环境）测核心纯逻辑（89 用例）：地址栏输入判断（15）、Tab 状态机（14）、
网页权限策略（4 组）、UI 导航保护（10）、PageSnapshot 数据规范化（46，页面视为敌手）。
Electron 行为由冒烟自检真实启动验证（见上）。约定见 `AGENTS.md` §7。

## 已知限制

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（设计决议，点时刻尽力采样）。
- 地址栏不支持中文/国际化域名（IDN，走搜索兜底）；搜索引擎暂硬编码 Bing（后续换 SearchProvider）。
- 无 CI / 打包配置（第一阶段验收不要求；打包属 Seventh Stage）。
- 冒烟中的搜索验证在离线环境断言「发起 Bing 搜索导航」而非页面加载完成（联网冒烟变体可验证）。
- 详细清单见 `doc/tasks/progress.md`「计划内限制与延期项」。
