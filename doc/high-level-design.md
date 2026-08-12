# AIbrowse 第一阶段 高层设计

> 状态：初稿（随 M0 基线建立）。接口契约定稿由任务 T1「详细设计定稿」完成。

## 1. 架构总览

三个进程/上下文，两层安全边界：

```
┌─ 渲染进程：React UI（浏览器外壳：顶部工具栏/标签栏/主区域占位/调试面板）─┐
│  依赖方向：UI → BrowserController（仅经 preload bridge + IPC）              │
└──────────────────────────────┬──────────────────────────────────────────┘
                     contextBridge（最小权限 IPC，类型化 channel）
┌──────────────────────────────┴──────────────────────────────────────────┐
│ 主进程（Node 全权限，仅限程序自身代码）                                    │
│   BrowserController ──► TabManager / PageReader / SessionManager          │
│        │                        │                                        │
│        └──────── WebContentsView（远程网页，安全默认值全开）◄─┘            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **主进程**：创建窗口、管理 WebContentsView 生命周期、持有 BrowserController 等核心模块、
  写日志、IPC handler。
- **渲染进程**：React UI，只能通过 preload 暴露的最小 API 与主进程通信；不直接触碰 Electron API。
- **远程网页**：运行在 WebContentsView 中，与 React UI 完全隔离，`nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`、`webSecurity` 保持默认开启。

## 2. 关键技术决策

| 决策点          | 选项                                                                    | 选择                                                                 | 理由                                                                                                        |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 页面承载        | BrowserView / WebContentsView / `<webview>` / 每 Tab 一个 BrowserWindow | **WebContentsView**                                                  | 官方当前推荐；BrowserView 已废弃被禁；`<webview>` 非官方推荐且安全模型弱；每 Tab 一窗口开销大且多窗管理复杂 |
| 构建工具        | 手动 vite+tsc / electron-forge / **electron-vite**                      | **electron-vite**                                                    | 专为 Electron+Vite 设计，main/preload/renderer 三目标一体，社区主流；v5.0.0 实测与 vite 7.3.x 兼容          |
| 模块格式        | ESM main / CJS main                                                     | **CJS（不设 `"type": "module"`）**                                   | `sandbox=true` 的 preload 只支持 CJS；保守默认，避免 ESM 互操作问题                                         |
| TypeScript 版本 | 5.9.x / 6.0.x / 7.x                                                     | **6.0.3**                                                            | typescript-eslint 8.67 官方支持范围 `<6.1.0`；7.x（Go 重写）暂不支持                                        |
| Session         | 默认分区 / `persist:<name>` 自定义分区                                  | **待实测后定**（T1）                                                 | WebContentsView 的默认 session 行为需实测确认（见 proposal Q3）                                             |
| 日志            | 仅 console / 文件轮转                                                   | **main 进程写 `log/<YYYY-MM-DD>.log`**（按日轮转），console 同步输出 | PROJECT_RULES §3.11 详尽日志红线；渲染进程关键日志后续经 IPC 汇总                                           |

## 3. 模块职责

- **BrowserController**：浏览器能力统一入口（唯一操作面）。方法集：`createTab` / `closeTab` /
  `activateTab` / `navigate` / `goBack` / `goForward` / `reload` / `getTabs` / `getActiveTab` /
  `getPageSnapshot`，全部返回 Promise。未来 AI Agent 只能经它（或在其上的 Tool Layer）操作浏览器。
- **TabManager**：Tab 状态机与 WebContentsView 生命周期（创建/切换/关闭/销毁清理/事件监听注册与移除）。
  纯状态逻辑（如 activeTabId 选择、Tab 排序）与 Electron 副作用分离，便于单测。
- **PageReader**：网页 → PageSnapshot。注入只读 DOM 遍历脚本（不修改 DOM、不劫持事件、不污染网站行为），
  过滤 script/style/隐藏内容，为交互元素生成 elementId。
- **SessionManager**：持久 Session（Cookie/登录状态重启保留），接口为将来多 Profile 预留，
  本阶段不实现多 Profile。
- **shared/types**：主/渲染共享的类型（TabInfo / PageSnapshot / IPC channel 定义），
  契约唯一出处，两侧编译共享。
- **shared/url**（基线已建）：地址栏输入 → URL/搜索 判断的纯函数，UI 与 main 两侧复用，
  以后整体替换为 SearchProvider。
- **main/logger**（基线已建）：日志分级 + 文件轮转 + 敏感信息脱敏。

## 4. 数据流（关键路径）

1. **地址栏输入**：UI 把原始字符串经 IPC 交给主进程 → BrowserController 调 shared/url 纯函数
   规范化（`https://…` 直开 / `example.com` → URL / `hello world` → 搜索引擎 URL）→ navigate。
2. **导航与页面加载**：WebContentsView.loadURL → Tab 状态机 loading → ready（`did-finish-load`）
   → Tab 标题更新事件经 IPC 推给 UI 标签栏。
3. **读取当前网页**：UI 点「读取当前网页」→ IPC → BrowserController.getPageSnapshot →
   PageReader 注入采集脚本 → 结构化结果（含 elementId）→ 调试面板渲染 JSON。
4. **关闭 Tab**：TabManager 销毁 WebContentsView（含事件监听清理）→ 若为最后一个 Tab 则按策略
   新建空 Tab（策略 T1 定稿）。

## 5. 安全模型

- 远程网页永远在 WebContentsView 中，安全默认值：`nodeIntegration=false`、`contextIsolation=true`、
  `sandbox=true`、不关闭 `webSecurity`。
- preload bridge 只暴露白名单 channel 与最小方法集；**不把 ipcRenderer 整体暴露**；远程网页与
  React UI 不共用 preload（T1 定稿：PageReader 采集脚本与 UI bridge 分离）。
- 主进程 IPC handler 校验调用方（区分 UI webContents 与远程网页 webContents），远程网页发来的
  请求一律拒绝。
- 限制 `window.open` / 新窗口行为（setWindowOpenHandler 白名单/拒绝）。
- PageReader 采集脚本为只读遍历：不改 DOM、不注册持久监听、不执行 Node API。

## 6. 存储

- 持久 Session（Cookie/登录态），位置由 Electron 默认用户数据目录管理；仅留 Profile 接口。
- 无数据库、无自定义持久化文件（日志除外）。

## 7. 测试策略

- **单测（Vitest，node 环境）**：纯逻辑——URL 判断（基线已有）、PageSnapshot 数据规范化、
  Tab 状态机纯逻辑部分。零环境依赖、零副作用。
- **不测**：Electron 内部行为不强行 mock 成复杂系统；靠冒烟验证真实启动链路。
- **冒烟**：应用真实启动（AIBROWSE_SMOKE=1 自检模式：窗口创建 → 渲染进程就绪 → 退出码 0）。
- **静态检查**：typecheck（tsc --noEmit，main/preload 与 renderer 两套 tsconfig）、ESLint、
  Prettier。

## 8. 风险与不确定性

| 风险                                                        | 影响                   | 缓解                                                           |
| ----------------------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| WebContentsView 多实例叠加/遮挡管理（bounds 同步、z-order） | 标签切换显示错乱       | T1 设计定稿 + T2 早期小步实测验证；不一次性写全                |
| 采集脚本污染网站行为（选择器/样式副作用）                   | 违反「不污染网站」要求 | 只读遍历白名单实现 + 在真实网页上人工抽查                      |
| elementId 映射失效（DOM 变化后回查不到元素）                | 未来 AI 操作受限       | 快照生命周期内短时缓存 + 重新定位策略（T1 定稿）               |
| Electron 二进制下载受网络影响                               | 安装失败               | 已实测本机代理可用（127.0.0.1:7890）；必要时设 ELECTRON_MIRROR |
