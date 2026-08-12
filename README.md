# AIbrowse — AI 信息浏览器

> 第一阶段目标：安全、稳定、可扩展的 **Windows 桌面浏览器核心原型**——`Browser → PageSnapshot → Browser Tool Interface`；
> 程序自身能把当前网页读取为结构化 PageSnapshot。**不接入任何 LLM API。**
> 需求源：`First_stage.md`；开发手册：`AGENTS.md`；进度：`doc/tasks/progress.md`。

## 当前状态（2026-08-13）

- ✅ **T0 项目基线**：git 双远程 / 文档链 / 脚手架 / 测试·lint·类型检查·格式基础设施 / 最小可启动应用 / 冒烟自检。
- ⏳ T1–T5：详细设计定稿 → 浏览器核心（BrowserController/TabManager/WebContentsView）→ 浏览器 UI → PageSnapshot → 收尾。

## 技术栈（实际落地版本）

Electron 43.4.0（WebContentsView 承载网页）· electron-vite 5 · Vite 7.3.6 · React 19.2.8 ·
TypeScript 6.0.3 · Vitest 4 · ESLint 10（flat config）· Prettier 3.9 · Node.js 24.x（engines `>=24 <25`）

## 快速开始

```bash
npm install      # 首次安装 Electron 二进制见下方「本机环境注意」第 2 条
npm run dev      # 开发模式启动（真实启动 Electron 应用）
```

冒烟自检（启动 → 窗口创建 → React 挂载 → preload bridge 链路确认 → 自动退出，退出码 0 即通过）：

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev
```

| 命令                              | 作用                                                |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | Electron 开发模式（渲染进程 HMR）                   |
| `npm run build`                   | 构建产物 `out/`（main / preload / renderer 三目标） |
| `npm run start`                   | 以构建产物启动（preview）                           |
| `npm test`                        | Vitest 全量测试（当前 15 用例）                     |
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

- 远程网页：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，`webSecurity` 不关闭。
- React UI 仅经最小 preload bridge 通信，绝不直接调用 Electron webContents API；
  远程网页与 React UI 处于明确安全边界。
- 纯逻辑（如地址栏输入判断 `src/shared/url.ts`）零环境依赖、可单测；UI/IO 副作用在外层胶水。

## 目录结构

```
src/
├── main/          # 主进程：入口（生命周期/窗口/安全默认值）、logger（log/ 按日轮转）
│   └── browser/   # （待建）BrowserController / TabManager / SessionManager / PageReader / types
├── preload/       # UI bridge（contextBridge，白名单 IPC，最小权限）
├── renderer/      # React UI（Vite）
└── shared/        # 共享类型 + 纯逻辑（types/、url.ts）
```

完整结构与职责见 `AGENTS.md` §4。

## 日志

每次运行生成详尽日志（启动/退出、关键路径、错误堆栈、环境信息）：项目根目录 `log/`（按日轮转，已 gitignore）。
打包后写入用户数据目录下 `log/`。

## 测试

Vitest（node 环境）测核心纯逻辑——当前：地址栏输入判断（`src/shared/url.test.ts`，15 用例，
覆盖 URL 直开/域名规范化/搜索/危险 scheme/越界安全返回）。约定见 `AGENTS.md` §7。
