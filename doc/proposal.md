# AIbrowse 第一阶段 Proposal — 浏览器核心原型

> 需求源：根目录 `First_stage.md`（阶段总任务）。本文档把总任务收敛为可验收的阶段提案。
> 里程碑 M0「项目基线」由本提案配套的 tasks/baseline.md 单独管理（已随基线完成）。

## 1. 目标

交付一个真正能运行的 **Windows 桌面浏览器原型**：内置 Chromium（Electron WebContentsView）、
多标签页浏览、地址栏（URL 规范化 / 搜索）、持久 Session；程序自身能把当前网页读取为
**结构化 PageSnapshot**（URL/标题/主要文本/heading/link/button/input/table，交互元素带 elementId），
并在开发调试面板中显示快照 JSON。**不接入任何 LLM API。**

## 2. 非目标（本阶段明确不做）

AI Chat、LLM API（OpenAI/Claude/Gemini）、Agent、收藏夹、SQLite、向量数据库、RSS、网页监控、
Research、自动点击/填写、CDP Network 分析、下载管理器、浏览器插件、密码管理器、完整历史记录、
浏览器同步、PDF viewer、广告拦截器。（完整清单见 First_stage.md §十一）

## 3. 用户与场景

- 用户：开发者本人（阶段验收者）+ 未来扩展的 AI Agent（经受限 Tool Layer）。
- 场景：打开网页 → 浏览/切换标签 → 点击「读取当前网页」→ 在调试面板查看 PageSnapshot JSON。
- 未来场景（非本阶段）：AI 与用户共享同一浏览器会话，通过受限 Browser Tools 操作浏览器。

## 4. 输入 / 输出

- 输入：地址栏字符串（`https://…` / `example.com` / `hello world` 三种形态，判断逻辑统一封装）。
- 输出：
  - 浏览器行为：多 Tab 的新建/切换/关闭、前进/后退/刷新、Tab 标题随网页变化。
  - `PageSnapshot` 结构化数据（接口见 First_stage.md §七，实现后可改进）。
  - 调试面板展示的快照 JSON。

## 5. 外部依赖

- Electron（内含 Chromium）、React、Vite、TypeScript、Node.js、Vitest、ESLint、Prettier。
- 网络：安装依赖与推送代码需要外网（Gitee 直连；GitHub 需经本机代理，见约束）。
- 无需用户提供凭据（git 身份与远程已在 AGENTS.md §1 给定）。

## 6. 约束与假设

- **架构纪律**：依赖方向固定 `UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`；
  React UI 不得直接调用 Electron webContents API；BrowserController 是浏览器能力统一入口。
- **安全红线**（第一版起生效）：远程网页 `nodeIntegration=false`、`contextIsolation=true`、
  `sandbox=true`（架构允许时）、`webSecurity` 不关闭、preload bridge 最小权限、限制 window.open、
  远程网页与 React UI 明确隔离。
- **页面承载**：WebContentsView（官方当前推荐），禁用已废弃的 BrowserView。
- **TypeScript 纪律**：不得用 `any`/`@ts-ignore`/关闭严格检查解决类型错误；不留 placeholder 实现。
- **语言**：界面文案/错误/日志/提交信息/文档中文；代码注释英文。
- **假设**：单 Profile（多 Profile 仅留接口）；默认搜索引擎 URL 先用简单实现（以后替换 SearchProvider）。

## 7. 验收标准

完整清单见 First_stage.md §十四（浏览器 / Session / PageSnapshot / Architecture / Security / Engineering 六组）。
摘要（AGENTS.md 附 B）：应用正常启动、开网页、地址栏 URL/搜索、多 Tab 全操作、前进后退刷新、
Tab 标题随网页变化、持久 Session、PageSnapshot 结构化读取 + elementId + 调试面板、四模块独立分层、
安全默认值全部满足、TS 编译/lint/测试通过、README 含启动方式与架构简述。

## 8. 待定问题

| # | 问题 | 影响 | 拍板时机 |
|---|---|---|---|
| Q1 | elementId 与真实 DOM 元素在一次快照生命周期内的映射方案（注入脚本内 Map 缓存 vs 重新定位） | 影响未来 AI 点击/填写工具的可行性 | 详细设计定稿（T1） |
| Q2 | WebContentsView 运行时细节：多 view 的叠加/遮挡与 bounds 管理、view 与 BrowserWindow 生命周期关系 | TabManager 实现细节 | T1 定稿 + T2 实现中验证 |
| Q3 | WebContentsView 默认使用的 session 分区（defaultSession vs 自定义 persist: 分区） | 持久 Session 是否生效 | T1 定稿（以实测为准） |
| Q4 | 跨域 iframe / 页面销毁 / 执行失败时 PageSnapshot 的降级粒度 | PageReader 错误处理契约 | T1 定稿 |
| Q5 | GitHub 推送的代理方式 | 目前 git 全局已配置 `http://127.0.0.1:7890` 且实测可用，可回填 AGENTS.md §6 | 已确认（2026-08-13 实测） |
| Q6 | 双远程用户名拼写不一致（Gitee `Molotov0coaktail` / GitHub `Molotov0cocktail`） | 推送失败或推错仓库 | 首次推送时实测验证 |

## 9. 里程碑划分

- **M0 项目基线**（本次会话，见 tasks/baseline.md）：git 前置 + 文档链骨架 + 脚手架 + 测试/lint/typecheck/format
  基础设施 + 最小可启动 Electron 应用 + 冒烟验证。
- **M1 浏览器核心**：BrowserController / TabManager / SessionManager + WebContentsView + 顶部/标签栏 UI。
- **M2 PageSnapshot**：PageReader + elementId + 调试面板。
- **M3 收尾**：安全审计 + 验收清单逐项核对 + README/文档同步。
