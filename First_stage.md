你现在要帮助我从零构建一个 Windows 桌面应用项目。这是一个长期项目，请优先保证架构清晰、可维护、可测试，不要为了快速展示效果而堆砌临时代码。

## 一、项目最终目标

我要开发一个“AI 信息浏览器 / AI Information Browser”。

长期目标包括：

* 内置 Chromium 浏览器
* 多标签页浏览
* 用户与 AI 共享同一个浏览器会话和登录状态
* AI 可以读取当前网页的结构化信息
* AI 可以调用受限的 Browser Tools：

  * 打开网页
  * 切换标签
  * 前进/后退
  * 滚动
  * 查找
  * 点击
  * 填写文本
  * 提取网页正文、链接、按钮、表格等
* 用户可以一边阅读网页，一边和 AI 讨论当前页面
* AI 可以自动搜索互联网并访问多个网页完成 Research
* 用户可以建立“信源库”
* 信源可以分组、添加标签、优先级和自然语言备注
* AI 可以根据对话自动添加或修改信源
* 以后加入 RSS、网页更新监控、Diff、通知、日报
* AI 可以把结果渲染成 Markdown、表格、卡片、图表等
* 所有 AI 行为必须经过受限 Tool Layer，AI 不得直接拥有任意系统权限

但是：

**现在不要实现上述全部功能。**

第一阶段只构建安全、稳定、可扩展的浏览器核心。

---

# 二、本阶段唯一目标

实现：

**Browser → PageSnapshot → Browser Tool Interface**

暂时不要接入任何 LLM API。

本阶段完成后，我应该得到一个真正能够运行的 Windows 桌面浏览器原型，并且程序自身能够读取当前网页，将其转换成结构化 PageSnapshot。

---

# 三、技术栈

优先使用：

* Electron
* TypeScript
* React
* Vite
* Chromium / Electron WebContentsView
* Node.js
* Vitest（如果适合）
* ESLint
* Prettier

当前阶段暂时不要加入：

* Playwright 作为浏览器主体
* SQLite
* 向量数据库
* OpenAI API
* Anthropic API
* RSS
* Research Agent
* 图表系统
* 登录账号系统
* 云同步

如果你发现某个技术选择与当前最新版 Electron 明显不兼容，可以选择更合理的实现，但必须在修改前说明原因。

版本基线（2026-08-13 按官方来源验证并冻结）：

* Node.js 24.x（Active LTS）
* Electron 43.4.0
* electron-vite 5.0.0
* Vite 7.3.6
* React 19.2.8
* TypeScript 6.0.3
* Vitest 4.1.10
* ESLint 10.8.1（flat config）
* Prettier 3.9.6

升级任何核心工具链必须先说明理由并完成全量验证（typecheck / lint / test / build / Electron 冒烟），
流程见 AGENTS.md §3；具体兼容性依据见 AGENTS.md §1。

---

# 四、非常重要的架构要求

不要把所有代码写进几个巨大的文件。

从一开始就进行模块化。

推荐至少按照类似结构组织：

src/

main/
browser/
BrowserController.ts
TabManager.ts
SessionManager.ts
PageReader.ts
types.ts

renderer/
browser/
layout/

shared/
types/

如果根据实际 Electron 项目结构需要调整，可以调整，但必须保持：

UI
↓
BrowserController
↓
TabManager / PageReader / SessionManager
↓
Electron APIs

不要让 React UI 到处直接调用 Electron webContents API。

BrowserController 应当成为浏览器能力的统一入口。

---

# 五、BrowserController

请设计清晰的 BrowserController interface。

至少考虑这些能力：

```ts
interface BrowserController {
  createTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;

  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;

  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;

  getPageSnapshot(tabId: string): Promise<PageSnapshot>;
}
```

具体类型可以改进。

不要为了满足这个示例而机械复制。

重点是：

以后 AI Agent 只能通过 BrowserController / Tool Layer 操作浏览器，而不是直接调用 Electron API。

---

# 六、浏览器 UI

第一阶段至少实现：

## 顶部

* 后退
* 前进
* 刷新
* 地址栏
* 新建标签页按钮

## 标签栏

* 显示多个 Tab
* 显示网页标题
* 可以切换
* 可以关闭
* 当前 Tab 有明确状态

## 主区域

显示真正的网页。

使用 Electron 官方当前推荐的页面承载方式，例如 WebContentsView。

不要使用已经废弃的 BrowserView。

## 辅助调试区域

第一阶段可以增加一个开发用途的侧栏或底部面板：

按钮：

“读取当前网页”

点击后显示当前 PageSnapshot 的 JSON。

这个调试面板以后会被 AI Chat 替换。

---

# 七、PageSnapshot

这是当前阶段最重要的模块之一。

不要简单返回整个 HTML。

请创建结构化 PageSnapshot。

第一版至少包含：

```ts
interface PageSnapshot {
  url: string;
  title: string;

  viewport?: {
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
  };

  selection?: string;

  visibleText?: string;

  headings: Array<{
    level: number;
    text: string;
  }>;

  links: Array<{
    id: string;
    text: string;
    href: string;
  }>;

  buttons: Array<{
    id: string;
    text: string;
  }>;

  inputs?: Array<{
    id: string;
    type: string;
    placeholder?: string;
    value?: string;
  }>;

  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
}
```

可以根据实现需要改进。

要求：

1. 不要默认返回完整 DOM。
2. 尽量过滤 script、style、隐藏内容等噪声。
3. 为将来 AI 操作网页保留 elementId。
4. elementId 在一次 PageSnapshot 生命周期中应该能够对应真实 DOM 元素。
5. PageReader 不应污染网站本身的正常行为。
6. 对执行失败、跨域、页面销毁等情况进行合理错误处理。
7. 不要让远程网页能够通过这个机制执行 Node.js 或 Electron privileged API。

---

# 八、页面安全

这个项目以后会让 AI 浏览任意网页，因此安全必须从第一版开始处理。

对于远程网页：

* nodeIntegration = false
* contextIsolation = true
* sandbox = true（如果架构允许）
* webSecurity 不得关闭
* 不允许远程网页直接访问 Electron API
* 不允许网页直接访问文件系统
* 不允许网页读取程序内部数据
* 不要把 ipcRenderer 整体暴露给网页
* preload bridge 必须最小权限
* 限制不必要的 window.open / 新窗口行为
* 对导航做好合理处理

应用自己的 React UI 与远程网页必须处于明确的安全边界。

不要为了省事关闭 Electron 安全机制。

---

# 九、Session

建立 SessionManager 抽象。

第一阶段只需要：

* 使用持久 Session
* 用户关闭并重新打开程序后，普通 Cookie / 登录状态能够保留
* 为将来支持多个 Profile 留好接口

例如以后可能有：

* Personal
* School
* Work

但现在不需要真正实现多个 Profile。

---

# 十、URL / 搜索框行为

地址栏输入：

https://example.com

→ 直接打开。

输入：

example.com

→ 自动规范化为合理 URL。

输入：

hello world

→ 可以暂时使用一个简单搜索引擎 URL 进行搜索。

把 URL 判断逻辑封装，不要散落在 UI 中。

以后我会替换成 SearchProvider。

---

# 十一、暂时不要做的东西

这一点非常重要。

不要主动扩展范围实现：

* AI Chat
* OpenAI
* Claude
* Gemini
* Agent
* 收藏夹
* SQLite
* RSS
* 网页监控
* Research
* 自动点击
* 自动填写
* CDP Network 分析
* 下载管理器
* 浏览器插件
* 密码管理器
* 完整历史记录系统
* 浏览器同步
* PDF viewer
* 广告拦截器

除非为了基础浏览器正常运行而绝对必要。

当前目标是把基础架构做正确，而不是一次性做完整产品。

---

# 十二、开发方式

这是一个 Vibecoding 长期项目，所以请遵守：

1. 开始前先检查当前目录。
2. 如果是空目录，初始化项目。
3. 如果已经存在项目，不要覆盖已有代码，先阅读并理解。
4. 每完成一个相对独立模块，检查类型错误。
5. 运行 lint。
6. 运行测试。
7. 实际启动 Electron 检查是否能够运行。
8. 不要留下明显的 placeholder 实现然后声称完成。
9. 不要把 TypeScript 错误简单用 `any`、`@ts-ignore` 或关闭严格检查解决。
10. 不要为了让测试通过而删除有意义的测试。
11. 对 Electron 生命周期、Tab 销毁、WebContents 销毁等情况做好清理。
12. 注意 memory leak 和 event listener 重复注册问题。

如果发现设计需要调整，可以自行调整，但保持总体架构目标。

---

# 十三、测试

至少为适合测试的纯逻辑模块建立测试，例如：

* 地址栏输入 → URL / Search 判断
* PageSnapshot 数据规范化
* Tab 状态管理中的纯逻辑部分

Electron 本身难以单元测试的部分不必强行 mock 成复杂系统。

重点测试核心业务逻辑。

---

# 十四、第一阶段验收标准

最终必须满足（**T5 收尾已逐项核对并通过，2026-08-13**；证据摘要见本节末尾）：

### 浏览器

* [x] 应用能够正常启动
* [x] 能够打开网页
* [x] 可以输入 URL
* [x] 地址栏可以搜索
* [x] 支持多个 Tab
* [x] 可以切换 Tab
* [x] 可以关闭 Tab
* [x] 可以新建 Tab
* [x] 后退有效
* [x] 前进有效
* [x] 刷新有效
* [x] Tab 标题会随网页变化

### Session

* [x] Cookie 使用持久 Session
* [x] 重启应用后普通网站登录状态具备保持能力

### PageSnapshot

* [x] 可以读取当前网页
* [x] 返回 URL
* [x] 返回标题
* [x] 返回主要文本
* [x] 返回 heading
* [x] 返回 link
* [x] 返回 button
* [x] 可以识别常见 table
* [x] 为交互元素生成 elementId
* [x] 调试面板能够显示 PageSnapshot JSON

### Architecture

* [x] BrowserController 独立
* [x] TabManager 独立
* [x] PageReader 独立
* [x] SessionManager 独立
* [x] React UI 不直接滥用 Electron privileged API
* [x] 类型定义清晰

### Security

* [x] nodeIntegration 未对远程网页开启
* [x] contextIsolation 开启
* [x] 不关闭 webSecurity
* [x] 远程网站无法直接调用 Node.js
* [x] IPC 暴露遵循最小权限原则

### Engineering

* [x] TypeScript 编译通过
* [x] lint 通过
* [x] 测试通过
* [x] README 包含启动方式
* [x] README 简短说明当前架构

---

**验收证据摘要（T5，2026-08-13，逐项对应）**：

- **浏览器**：全部由 T5 新增 UI 端到端冒烟（`src/main/smoke.ts` §7.7）机器验证——React DOM
  点击/键盘事件驱动真实链路（DOM 事件 → React → preload bridge → IPC → BrowserController →
  webContents → tabs:updated → DOM），无 Playwright。地址栏输入 URL（受控本地页）断言活动
  Tab 到达目标页；搜索词「hello world」断言真实发起 Bing 搜索导航；多 Tab 新建/切换/关闭
  断言主进程 Tab 列表与标签栏 DOM 同步；后退/前进断言 URL 往返；刷新断言 did-start-loading
  计数 + 回到 ready；标题断言 TabInfo.title 与标签栏文案随受控页标题变化。另：真实 URL
  加载（AIBROWSE_SMOKE_URL=https://www.bing.com/）与生产产物冒烟均退出码 0。
- **Session**：AIBROWSE_SESSION_SMOKE=set/check 两个独立应用进程 + 同一临时 userData
  （AIBROWSE_USER_DATA_DIR，测试后清理）：进程 A 经受控页 Set-Cookie（HttpOnly）写入
  persist:aibrowse 分区后完整退出；进程 B 重新启动后从持久分区读回同一 Cookie——跨进程
  持久化证据（单进程读取不构成重启保持证据）。双进程均退出码 0。
- **PageSnapshot**：保留 T4 真实采集断言（受控页 L0 heading/link/button/table/visibleText/
  elementId 一一对照、L1 跨域 iframe 跳过警告、L3 未知 tabId null），T5 新增：调试面板
  「读取当前网页」真实点击 → 界面显示合法 JSON + L0/L1 徽标 + warnings 列表（§7.7.9）；
  敌对页面 elementId 审查（重复/畸形/超大/负数/冲突烙印 → id 唯一、1–10 位数字、
  无歧义对应活 DOM 真实元素、跨快照稳定，§7.5）；远程页面隔离探针（window.aibrowse/
  process/require/electron 均为 undefined，§7.7.10）。
- **Architecture / Security**：按 detailed-design §11 安全基线清单逐项审计实际代码
  （T5，结论见 doc/tasks/progress.md「最近验证结果」）：Tab/UI 安全默认值显式声明、
  webSecurity 未关闭（全仓库 grep）、Tab 无 preload、IPC sender+主帧校验、preload 白名单、
  window.open 一律 deny、Tab will-navigate + will-redirect 白名单（R-02 关闭）、UI 窗口
  导航保护、persist Session 双权限处理器默认拒绝、监听器创建时注册/关闭时逐一移除、
  dispose 幂等。模块边界与依赖方向同 First_stage §四（UI → BrowserController →
  TabManager/PageReader/SessionManager → Electron APIs）。
- **Engineering**：test 89/89 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅；
  README 已按 T5 现状同步（启动方式/架构/安全边界/PageSnapshot/已知限制）。

---

# 十五、你现在应该怎么执行

请直接开始工作，不要只给我教程或者示例代码。

首先：

1. 检查当前工作区状态。
2. 给出一个非常简短的实施计划。
3. 初始化或整理项目。
4. 开始实现第一阶段。
5. 持续运行测试和实际构建验证。
6. 修复发现的问题。

如果过程中存在不影响总体设计的小问题，请自行做合理决定，不需要频繁询问我。

只有以下情况才需要停下来询问：

* 会导致数据丢失
* 需要删除大量已有代码
* 存在两个会显著影响长期架构且无法轻易迁移的方案
* 需要我提供密钥、账号或其他外部凭据

完成之后，不要继续擅自开发第二阶段。

请停在本阶段，并向我报告：

1. 已实现内容
2. 项目结构
3. 测试和构建结果
4. 已知限制
5. 下一阶段最适合做什么

然后等待我的下一条指令。
