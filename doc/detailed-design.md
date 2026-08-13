# AIbrowse 第一阶段 详细设计（定稿）

> ✅ 状态：**定稿**（2026-08-13，任务 T1）。本文件是浏览器核心的**唯一契约源**，
> 取代此前草案；实现任务：T2（§2–§7 除 PageReader）、T3（§3 UI 侧接入）、T4（§8 PageReader/采集）。
> T2/T4 实现后，所有签名必须用 `grep -n "^export"` 与实际代码核对回填到 AGENTS.md §5。
> 需求源：First_stage.md §五/§七/§八/§九/§十；决议记录见本文 §12。

## 1. 文件布局（基线实际状态 + T2/T4 新增）

```
src/
├── main/
│   ├── index.ts                 # 入口（基线已有）：窗口创建、IPC 装配（T2/T3 扩展）
│   ├── logger.ts                # 日志（基线已有）
│   └── browser/                 # （T2 新增，除标注外）
│       ├── browser-controller.ts  # 浏览器能力统一入口 + 错误兜底 + dispose
│       ├── tab-manager.ts         # WebContentsView 创建/销毁/bounds/事件→TabInfo
│       ├── tab-state.ts           # 纯逻辑（零 Electron 依赖）：状态迁移 + 激活选择
│       ├── session-manager.ts     # persist:aibrowse 分区（多 Profile 预留）
│       ├── page-reader.ts         # （T4）快照编排：注入 + 降级阶梯
│       ├── snapshot-script.ts     # （T4）注入脚本源（自安装 IIFE 字符串，保持 TS 检查）
│       └── snapshot-normalize.ts  # （T4）脚本输出校验纯函数（页面视为敌手）
├── preload/index.ts             # bridge 扩展（T3）：tabs/nav/page/ui 白名单方法
├── renderer/                    # React UI（T3/T4）：顶部工具栏/标签栏/地址栏/调试面板
└── shared/
    ├── types/
    │   ├── app.ts               # 基线已有：AppInfo / AibrowseBridge（T3 扩展 bridge）
    │   ├── browser.ts           # （T2 新增）TabInfo/TabState/TabsState/PageSnapshot/meta
    │   └── ipc.ts               # （T2 新增）IPC channel 常量 + payload 类型
    └── url.ts / url.test.ts     # 基线已有：地址栏输入判断（15 用例）
```

分层方向不变（不可反向或跳跃）：`UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`。

## 2. 接口契约（定稿）

### 2.1 BrowserController（浏览器能力统一入口）

```ts
// src/main/browser/browser-controller.ts
export interface BrowserController {
  createTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  navigate(tabId: string, url: string): Promise<boolean>;
  goBack(tabId: string): Promise<boolean>;
  goForward(tabId: string): Promise<boolean>;
  reload(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
  dispose(): void; // 窗口关闭前全量清理（销毁全部 view 与监听器，不触发「最后 Tab 自动新建」）
}
```

定稿语义（与草案的差异见 §12 变更记录）：

- **失败语义可观测**：动作类方法返回 `boolean`（成功 `true`；tabId 不存在 / 无法执行 → `false`，
  不抛异常——越界安全返回）。未来 AI Tool Layer 可直接据此判断动作是否生效。
- `navigate` 的 `url` 必须是**已规范化** URL（main 侧 IPC handler 统一调用 `shared/url`，
  见 §9）；controller 对空串/明显非法输入仍做防御性 `false` 返回。
- `createTab` 不因 URL 无效而失败：URL 无效时创建空白 Tab（`about:blank`）+ warn 日志；
  仅未预期内部异常才 reject（明确豁免，由 IPC 层兜底记录）。
- `getPageSnapshot` 返回 `null` 仅一种情况：tab 不存在 / 页面已销毁（降级阶梯 L3，§4）。
- `dispose()`：应用退出路径统一调用；实现须保证重复调用幂等（防重复清理）。

### 2.2 PageSnapshot（结构化快照，First_stage.md §七 + meta 定稿）

```ts
// src/shared/types/browser.ts
export type SnapshotDegradation = 'none' | 'partial' | 'main-process-only';

export interface SnapshotMeta {
  capturedAt: number; // 主进程侧盖章（epoch ms），不信任页面时钟
  readyState: 'loading' | 'interactive' | 'complete' | 'unknown';
  degraded: SnapshotDegradation; // 降级阶梯：L0 none / L1 partial / L2 main-process-only
  warnings: string[]; // 中文警告（iframe 跳过、截断、部分采集失败等）
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport?: { scrollX: number; scrollY: number; width: number; height: number };
  selection?: string;
  visibleText?: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ id: string; text: string; href: string }>;
  buttons: Array<{ id: string; text: string }>;
  inputs?: Array<{ id: string; type: string; placeholder?: string; value?: string }>;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  meta: SnapshotMeta; // 必填：调试面板与未来 Tool Layer 都依赖 degraded/warnings
}
```

- 不返回完整 DOM；过滤 script/style/noscript/隐藏元素（§8）。
- `elementId` 在一次快照生命周期内对应真实 DOM 元素（Q1 决议，§8.4）。
- `meta` 为定稿新增必填字段（草案无此字段）：错误/降级信息结构化而非散落空集合，
  调试面板能区分「页面确实没有链接」与「采集失败所以没有链接」。

### 2.3 TabInfo / TabsState（定稿）

```ts
// src/shared/types/browser.ts
export type TabState = 'idle' | 'loading' | 'ready' | 'error';

export interface TabInfo {
  id: string; // crypto.randomUUID()，程序内唯一；与 webContents.id 解耦（避免 id 复用）
  title: string; // 页面标题；空串时 UI 显示兜底「新标签页」
  url: string;
  active: boolean;
  state: TabState;
}

export interface TabsState {
  tabs: TabInfo[];
  activeTabId: string | null;
}
```

- 草案的 `isLoading` 由 `state === 'loading'` 派生，不再单独存（单一事实源）。
- `destroyed` 不是 TabInfo 状态：关闭即从列表移除并销毁 view（§5）。

### 2.4 SessionManager（Q3 决议）

```ts
// src/main/browser/session-manager.ts
export interface SessionManager {
  // 本阶段仅 'main'；未来多 Profile（Personal/School/Work）时按 profile 名映射 persist: 分区
  getSession(profile?: string): Session;
}
```

- 分区常量 `PERSIST_PARTITION = 'persist:aibrowse'`；所有 Tab view 的
  `webPreferences.partition` 使用该常量；实现内部用 `session.fromPartition(...)` 懒加载单例。
- 本阶段不实现多 Profile、不做 Cookie 管理 UI；持久化由 persist: 分区默认行为保证。

### 2.5 PageReader（T4 实现，编排职责）

```ts
// src/main/browser/page-reader.ts
export class PageReader {
  // 前置守卫（tab 存在、webContents 未销毁）由 BrowserController 完成；
  // PageReader 只管「给定一个活的 webContents，产出快照」，L2 降级内部处理（§4/§8.5）
  snapshot(webContents: WebContents): Promise<PageSnapshot>;
}
```

### 2.6 纯逻辑模块（零 Electron 依赖，可单测）

```ts
// src/main/browser/tab-state.ts —— 状态机纯函数（§5；T2 实现 + 测试）
export type TabStateEvent =
  | { type: 'start-loading'; isMainFrame: boolean }
  | { type: 'finish-load'; isMainFrame: boolean }
  | { type: 'fail-load'; isMainFrame: boolean; errorCode: number };

export function transition(state: TabState, e: TabStateEvent): TabState;
export function selectNextActive(
  tabs: readonly TabInfo[],
  activeTabId: string | null,
  closedTabId: string,
): string | null;

// src/main/browser/snapshot-normalize.ts —— 输出校验纯函数（§8.6；T4 实现 + 测试）
export function normalizeSnapshot(
  raw: unknown,
  fallback: { url: string; title: string },
): PageSnapshot;
```

## 3. IPC 与 preload bridge 最小权限清单（定稿）

### 3.1 Channel 常量与 payload（shared 单一事实源）

```ts
// src/shared/types/ipc.ts —— 通道名常量 + payload 类型（renderer/main 共用）
export const IPC = {
  // renderer → main（invoke）
  TabsList: 'tabs:list',
  TabsCreate: 'tabs:create', // payload: { url?: string }（原始地址栏输入，main 侧规范化）
  TabsClose: 'tabs:close', // payload: { tabId }
  TabsActivate: 'tabs:activate', // payload: { tabId }
  NavNavigate: 'nav:navigate', // payload: { tabId, input }（原始输入）
  NavBack: 'nav:back',
  NavForward: 'nav:forward',
  NavReload: 'nav:reload',
  PageSnapshot: 'page:snapshot', // payload: { tabId }
  AppGetInfo: 'app:get-info', // 基线已有
  // renderer → main（send，单向无回执）
  UiContentBounds: 'ui:content-bounds', // payload: { x, y, width, height }（§6）
  AppRendererReady: 'app:renderer-ready', // 基线已有
  // main → renderer（事件推送）
  TabsUpdated: 'tabs:updated', // payload: TabsState（全量）
} as const;

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

### 3.2 UI bridge（window.aibrowse，白名单扩展自基线）

```ts
// src/shared/types/app.ts（AibrowseBridge 扩展）+ src/preload/index.ts 实现
export interface AibrowseBridge {
  getAppInfo(): Promise<AppInfo>; // 基线已有
  notifyRendererReady(): void; // 基线已有
  tabs: {
    list(): Promise<TabInfo[]>;
    create(url?: string): Promise<TabInfo | null>;
    close(tabId: string): Promise<boolean>;
    activate(tabId: string): Promise<boolean>;
    onUpdated(listener: (state: TabsState) => void): () => void; // 返回退订函数
  };
  nav: {
    navigate(tabId: string, input: string): Promise<boolean>;
    back(tabId: string): Promise<boolean>;
    forward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<boolean>;
  };
  page: {
    snapshot(tabId: string): Promise<PageSnapshot | null>;
  };
  ui: {
    reportContentBounds(bounds: ContentBounds): void;
  };
}
```

最小权限定稿：

- **远程网页不挂载任何 preload**：Tab 的 WebContentsView 不配置 preload（`nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`），PageReader 采集走 `executeJavaScript` 只读注入（§8），
  与 bridge 完全无关。
- `tabs:updated` **全量推送**（整个 `TabsState`）而非增量事件：渲染层幂等更新，
  避免增量事件乱序/丢失导致 UI 与主进程状态漂移。
- `onUpdated` 返回退订函数；preload 内部对同一通道只注册一次 ipcRenderer 监听、
  由 JS 侧管理 listener 列表（防重复注册；渲染层卸载时退订）。
- **sender 校验**：main 侧每个 IPC handler 校验 `event.sender` 为主窗口 webContents 且为主帧，
  否则拒绝并 warn（纵深防御：UI 是唯一合法调用方）。
- 原始 `ipcRenderer` 永远不暴露给 renderer（基线约定保持）。

## 4. 错误处理契约与快照降级阶梯（Q4 决议）

统一原则（AGENTS.md §3「越界安全返回」）：**参数/状态问题一律安全返回，不抛异常**；
只有未预期内部异常走「IPC 兜底 catch + error 日志 + 失败语义返回」，进程不崩。

| 类别                                                | 契约行为                                              | 日志                     |
| --------------------------------------------------- | ----------------------------------------------------- | ------------------------ |
| 参数无效（未知 tabId、空规范化 URL、非法 bounds）   | `false` / `null` / 忽略；不抛异常                     | warn（含方法名 + tabId） |
| 页面销毁/导航竞态（关闭后调用、快照时正在导航）     | `false` / `null` / 尽力快照                           | info / warn              |
| 采集受限（跨域 iframe、页面未加载完、渲染进程崩溃） | 降级快照（L1/L2，meta.degraded + warnings）           | warn + 分类计数          |
| 未预期异常                                          | IPC 层兜底 catch → error 日志（含堆栈）→ 返回失败语义 | error                    |

### 快照降级阶梯（`getPageSnapshot` 返回 `PageSnapshot | null`）

| 级别 | 触发条件                                             | 返回内容                                                         | meta.degraded         |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------- | --------------------- |
| L0   | 脚本执行成功且 `readyState === 'complete'`           | 完整快照                                                         | `'none'`              |
| L1   | 脚本成功但页面仍在加载 / 存在被跳过的 iframe         | 完整快照 + warnings                                              | `'partial'`           |
| L2   | `executeJavaScript` 失败（页面冻结/崩溃/上下文失效） | 仅主进程侧 url/title + 空集合 + warnings（明确写出采集失败原因） | `'main-process-only'` |
| L3   | tab 不存在 / webContents 已销毁 / 渲染进程已退出     | `null`                                                           | （无快照）            |

- `render-process-gone` 发生后：该 Tab 立即降级为 L2 语义（TabInfo.state → error，
  快照走 L2/L3 路径），并记 error 日志。
- 调试面板对 L1/L2 快照必须展示 warnings（用户能看出「少了内容是因为采集受限」）。

## 5. Tab 状态机与关闭策略（定稿）

```
createTab(无 URL) ──► idle ──loadURL(about:blank)──► loading ──► ready
createTab(有 URL) ──────────────loadURL───────────► loading ──► ready
ready ──reload/navigate──► loading        loading ──fail-load(主框架)──► error
error ──reload/navigate──► loading        任意状态 ──closeTab──► 从列表移除 + view 销毁
```

纯函数 `transition(state, e)`（§2.6）语义：

- `!isMainFrame` 的事件一律返回原状态（子框架加载不影响 Tab 状态）。
- `start-loading` → `'loading'`；`finish-load` → `'ready'`。
- `fail-load`：`errorCode === -3`（`ERR_ABORTED`，被新导航取代）→ 原状态（忽略）；
  其余主框架失败 → `'error'`。
- 事件→状态迁移仅上述三条；`TabInfo.title` 由 `page-title-updated` 更新、
  `TabInfo.url` 由主框架 `did-navigate` / `did-navigate-in-page` 更新；任一变化 → 推送 `tabs:updated`。

`selectNextActive(tabs, activeTabId, closedTabId)` 策略（纯函数，T2 测试）：

- 关闭的不是活动 Tab → 返回原 `activeTabId`；`closedTabId` 不在列表 → 返回 `activeTabId`（无操作）。
- 关闭的是活动 Tab → 右邻优先，无右邻取左邻；列表只剩它一个 → 返回 `null`。
- 返回 `null` 时 controller 执行**最后 Tab 策略**：自动新建空白 Tab（`about:blank`）。
  窗口常驻、不退出应用（单窗口多标签桌面应用形态；`dispose()` 路径跳过该策略）。

监听器与清理（生命周期纪律，First_stage.md §十二）：

- 每个 Tab 的 webContents 监听器在创建时注册、在 closeTab/dispose 时**逐一移除**；
  TabManager 维护 `tabId → { view, info, cleanupFns }` 单一登记表。
- 事件清单：`did-start-loading` / `did-finish-load` / `did-fail-load` /
  `page-title-updated` / `did-navigate` / `did-navigate-in-page` / `render-process-gone` /
  `destroyed` / `setWindowOpenHandler` / `will-navigate`（§9）。
- 应用退出路径：`before-quit`/窗口 `closed` → `browserController.dispose()`（幂等）。

## 6. WebContentsView 管理（Q2 决议）

窗口结构：主 BrowserWindow 承载 React UI（chrome）；每个 Tab 一个 `WebContentsView`，
全部 `win.contentView.addChildView(view)`（追加序即 z 序，**保持稳定**）。

- **可见性切换用 `setVisible`，不用 removeChildView**：`setVisible(false)` 即不渲染不遮挡，
  避免重挂载开销、焦点抖动与 z 序变化。活动 Tab：`setVisible(true)` + 应用最新 bounds +
  `webContents.focus()`；其余全部 `setVisible(false)`。
- **bounds 上报**：渲染进程用 ResizeObserver 测量 chrome（工具栏+标签栏）高度，
  防抖 50ms 后经 `ui:content-bounds`（send）上报内容区矩形 `{x:0, y:chromeH, width, height-chromeH}`；
  main 收到后应用到**当前活动** view（全量覆盖式，切换标签时用最近一次值）。
  窗口首次显示前 view 先按窗口尺寸兜底设 bounds，收到上报后校正。
- **生命周期**：view 随 Tab 创建/销毁；closeTab → `removeChildView` → `webContents.close()` →
  移除全部监听器 → 删除登记表条目。窗口关闭 → `dispose()` 全量清理。
- **单窗口假设**：本阶段仅一个 UI 窗口；BrowserController 不处理多窗口（未来扩展点）。

## 7. Session 分区（Q3 决议）

- 所有 Tab view 的 `webPreferences.partition = 'persist:aibrowse'`。
- **理由**：显式 persist: 前缀语义明确（重启后 Cookie/登录状态持久，满足 First_stage §九）；
  defaultSession 虽默认持久但语义隐式、未来切多 Profile 需迁移，显式命名分区
  就是多 Profile（Personal/School/Work）接口落点（§2.4 `getSession(profile?)`）。
- **权限安全默认值（2026-08-13 安全补丁，§11）**：分区首次创建时由 SessionManager 统一注册
  `setPermissionRequestHandler` + `setPermissionCheckHandler`（官方要求两者同时实现才是完整权限
  处理），策略委托 `permission-policy.ts` 纯函数——v1 一律拒绝（默认拒绝，未知权限/畸形来源
  同样安全拒绝）；未来所有 profile 派生分区自动获得同一默认值。
- 本阶段不做 Cookie 管理 UI / 清空会话功能（非第一阶段范围）。

## 8. PageSnapshot 采集算法（Q1 + 采集细节定稿；T4 实现）

### 8.1 流程

1. BrowserController 守卫：tabId → 登记的 view/webContents 存在且未销毁 → 否则 L3 `null`。
2. 主进程侧兜底数据：`webContents.getURL()` / `getTitle()`（L2 时使用；`isCrashed()` 检查）。
3. `webContents.executeJavaScript(SNAPSHOT_SCRIPT_SOURCE, false)` 注入主文档 main world
   （脚本源为 `snapshot-script.ts` 导出的自安装 IIFE 字符串，与 preload 无关）。
4. 脚本只读遍历 DOM 采集（§8.2–§8.4），返回**纯 JSON**（结构化克隆，不含函数/节点引用）。
5. 主进程 `normalizeSnapshot(raw, fallback)` 校验/强制转换（§8.6）→ 组装 meta → 返回。

### 8.2 采集内容与过滤

- 基础：`location.href` / `document.title` / `document.readyState` /
  viewport（`window.innerWidth/innerHeight` + `scrollX/scrollY`）/
  selection（`window.getSelection().toString()`，≤ 10 000 字符）。
- `visibleText`：`document.body?.innerText`（布局感知，天然跳过 display:none 文本），
  空白折叠后 ≤ 100 000 字符截断。
- headings：`h1`–`h6`；links：`a[href]`（href 取解析后的绝对 URL `el.href`）；buttons：`button`、
  `input[type=button|submit|reset]`、`[role="button"]`（input 类按钮取 `value` 为可见文案）；
  inputs：`input:not([type="hidden"])`、`textarea`、`select`（value 取当前值、
  **`type=password` 除外——敏感信息不进快照**，select 取选中项文本）；tables：`table` 与 `[role="table"]`。
- **可见性粗筛**（逐个元素，O(n) 且零副作用）：`offsetParent === null` 且
  `getClientRects().length === 0` → 跳过；`aria-hidden="true"`、`hidden` 属性 → 跳过；
  script/style/noscript/svg 内文、不可见 input 类型不采集；文本一律 `textContent.trim()`（空白折叠）。
- **限额**（防超大页面打爆内存，超限截断 + warnings）：headings ≤ 1 000；links/buttons ≤ 2 000；
  inputs ≤ 500；tables ≤ 100（每表 ≤ 500 行）；单元格文本 ≤ 1 000 字符；href ≤ 2 000 字符。
- **iframe**：v1 仅采集主文档（同源 iframe 递归留未来扩展）；统计 iframe 总数，
  无法读取内容的记 warnings（如「跳过 3 个 iframe（其中 2 个跨域）」），对应 L1。
- **表格**：表头取首行 `th`/`[role=columnheader]`（缺失则以空串占位、列数对齐；该行不再重复计入
  数据行）；行取每 `tr` 的 `td/th/[role=gridcell]/[role=columnheader]` 文本，`:scope` 限定
  直接行/单元格（嵌套表格不混入）；行列对齐由 normalize 补齐/截断。

### 8.3 只读与不污染承诺（First_stage §七.5）

- 脚本不注册事件、不触发任何页面回调、不修改页面数据；唯一写操作是
  **幂等**地写 `data-aibrowse-el` 属性（§8.4）。
- 脚本被页面世界隔离：无 preload、无 Node 集成、无 IPC 通道，页面无法借快照执行
  Node.js / Electron 特权 API（First_stage §七.7）。

### 8.4 elementId 映射（Q1 决议：双层映射）

- 扫描交互元素（links/buttons/inputs）时：已有 `data-aibrowse-el="n"` 属性则**复用**其 n；
  否则分配文档级递增计数器 n 并写回该属性。id 字符串格式 `el-<n>`（如 `el-42`）。
- 注入上下文维护 `Map<number, Element>`（`window.__aibrowsePage` 内）：
  **每次快照重建 Map，仅包含本次快照元素** → Map 有界（等于本次快照元素数）、无泄漏；
  快照生命周期 = 交付后至下一次快照/导航（页面世界重置时 Map 随世界销毁，自动释放）。
- 同导航生命周期内回查：`Map` 直接取元素；跨导航（世界重置）后：经 `data-aibrowse-el`
  重扫描可找回同一 id（DOM 未变时）。
- **页面是敌手**：页面 JS 可清除 `window.__aibrowsePage` 或篡改属性——只影响快照内容
  （不可信输入，§8.6 兜底），不构成权限问题；未来 AI 点击/填写工具执行前必须
  重新校验元素存在性（后阶段职责，此处记录为约束）。

### 8.5 降级与失败（Q4 决议，阶梯见 §4）

- `executeJavaScript` reject（页面冻结/崩溃/导航竞态导致上下文失效）→ L2：
  主进程侧 url/title + 空集合 + warnings（写明失败原因）+ `readyState: 'unknown'`。
- 导航竞态说明：快照是**点时刻尽力采样**，导航中的快照返回当时文档（可能 L1），
  不追求与导航事件的强一致。

### 8.6 normalize 校验（T4 单测重点）

- **脚本输出视为不可信数据**：逐字段类型校验/强制转换；非法条目（类型错、elementId
  格式非 `el-N`、层级错）丢弃；限额二次截断；warnings 合并去重后与 `capturedAt`
  （主进程盖章）、`degraded` 一起组装 meta。任何输入都返回合法 `PageSnapshot`，不抛异常。

## 9. 导航与地址栏（URL 判断接入，T3）

- **规范化位置定稿**：renderer 把**原始输入**交给 `nav:navigate` / `tabs:create`，
  main 侧 IPC handler 统一调用 `shared/url.resolveAddressBarInput`；
  返回 `''` → 动作返回 `false`（navigate）或创建空白 Tab（create），warn 日志。
  BrowserController 只接受规范化 URL（§2.1）。UI 不做 URL 判断（First_stage §十「不要散落在 UI」）。
- **导航白名单**：每个 Tab webContents 的 `will-navigate` 仅放行 `http:`/`https:`/`about:`，
  其余（`file:`、自定义协议等）`preventDefault` + warn 日志（First_stage §八「对导航做好合理处理」）。
- **window.open**：每个 Tab webContents 的 `setWindowOpenHandler` 一律 `deny` + warn（与基线主窗口一致）。
- **UI 窗口自身导航保护**（T3，安全红线；**是 tabs/nav/page/ui bridge 扩展的硬前提**——导航保护
  必须先于或与 bridge 扩展同闭环落地，不得先暴露 bridge 再补保护）：React UI 所在窗口的 preload 会随
  该窗口的**任何**导航加载——若 UI 窗口主框架被导航到远程页面，远程页面将获得 `window.aibrowse`
  bridge（含 `page.snapshot`，可读取任意 Tab 内容）。保护覆盖两条路径，事件选择经
  Electron 43.4.0 实测定稿（2026-08-13，见 §12 补丁决议）：
  1. **页面发起的导航** → `will-navigate`：实测覆盖 `window.location.href`、`location.replace`、
     链接点击（均触发，`preventDefault()` 可阻止）；程序化 `loadURL`/`back` 与子框架导航不触发
     （无需额外按帧过滤）；不触发于页内导航（hash/pushState，不换文档、无风险）。
  2. **服务器重定向** → `will-redirect`：实测在页面发起与程序化导航两条路径下都会对 302 目标触发，
     `preventDefault()` 阻止整次导航（不单是重定向）。这是程序化导航遇到重定向时唯一的拦截点。
     两处 handler 共用同一「自身来源」判定：开发模式仅放行 `ELECTRON_RENDERER_URL` 的 origin
     （重定向目标同样过该判定）；生产仅放行 `file:` 入口文件 URL 精确匹配——scheme+pathname 相等，
     hash/query 变体视为同一文档放行；同目录其他文件、`..` 路径穿越、大小写变体一律拒绝
     （失败关闭。注意 file: 的 origin 在 Chromium 中恒为 'null'，绝不能用 origin 比较——
     那会把所有本地文件视为同源）。
     不采用 `will-frame-navigate`：对「主框架被导航走」这一威胁无增量覆盖（UI 窗口无远程子框架；
     子框架导航不影响主框架 preload），且其 isMainFrame 需按位置参数读取、易错。
     实现注意：TS 监听器首参 `details` 已并入 params（读 `details.url` / `details.isMainFrame`），
     位置参数已标 `@deprecated`。

## 10. 测试规格（T2/T4 规划，红→绿纪律）

| 测试文件                                      | 用例要点                                                                                                                                      | 任务 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/shared/url.test.ts`                      | 基线已有（15 用例）                                                                                                                           | T0   |
| `src/main/browser/tab-state.test.ts`          | `transition` 全事件表（子框架忽略 / -3 忽略 / fail→error / 再加载→loading）；`selectNextActive`（关闭非活动/活动/首/末/唯一 Tab、未知 tabId） | T2   |
| `src/main/browser/snapshot-normalize.test.ts` | 不可信输入（非对象/错误类型/字段缺失）→ 合法快照且不抛；限额截断 + warnings；表格行列补齐/截断对齐；elementId 格式过滤；文本修剪/空白折叠     | T4   |

- Electron 胶水层（view 创建/bounds/IPC）不强 mock；纯逻辑与壳分层（§2.6）。
- T2 后扩展冒烟：多 view 创建/切换/销毁、最后 Tab 关闭自动新建、退出 dispose 无泄漏
  （复用 AIBROWSE_SMOKE 机制扩展场景，具体以 T2 任务为准）。

## 11. 安全基线核对清单（First_stage §八 → 落实位置，T5 逐项核对）

| 红线                                   | 落实位置                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 远程网页 nodeIntegration=false         | Tab view webPreferences 显式声明（T2）                                                                                                                      |
| contextIsolation=true                  | 同上（显式声明，不依赖默认值）                                                                                                                              |
| sandbox=true                           | 同上（显式声明）                                                                                                                                            |
| webSecurity 不关闭                     | 不设置 webSecurity（默认开启）                                                                                                                              |
| 远程网页无 Electron API / 文件系统访问 | Tab view 无 preload；无 Node 集成                                                                                                                           |
| ipcRenderer 不整体暴露                 | preload 仅白名单 bridge（§3.2）；远程页面无 preload                                                                                                         |
| window.open 限制                       | 每个 Tab + UI 窗口 setWindowOpenHandler deny                                                                                                                |
| 导航处理                               | Tab will-navigate 白名单 http/https/about；UI 窗口 will-navigate + will-redirect 仅自身来源（§9）                                                           |
| 网页权限请求不得默认放行               | persist Session 注册 setPermissionRequestHandler + setPermissionCheckHandler，v1 默认拒绝（§7，permission-policy.ts 纯函数决策，未知权限/畸形来源安全拒绝） |
| UI 与远程网页安全边界                  | UI 渲染进程 ≠ Tab WebContentsView（独立 webContents + preload 隔离）                                                                                        |
| IPC 最小权限                           | sender 校验 + 通道白名单（§3）                                                                                                                              |

## 12. 定稿决议记录（Q1–Q4 + 草案变更点 + 安全补丁）

### proposal Q1–Q4 拍板

| #   | 决议                                                                                                                                                                                                   | 理由                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Q1  | elementId 双层映射：`data-aibrowse-el` 属性烙印 + 注入上下文 Map（每次快照重建，有界无泄漏）                                                                                                           | 同导航生命周期内回查最快（Map）；跨导航可经属性找回；Map 重建保证生命周期语义与内存有界；页面篡改仅影响数据不构成权限问题 |
| Q2  | 全部 view 常驻 contentView，`setVisible` 切换可见性；bounds 由渲染层 ResizeObserver 上报（`ui:content-bounds`，防抖 50ms）；closeTab → removeChildView + close + 清监听器；窗口关闭 → dispose 幂等全清 | setVisible 避免重挂载/焦点抖动/z 序变化；chrome 高度是 React 布局结果，渲染层测量是唯一事实源                             |
| Q3  | 显式 `persist:aibrowse` 分区（SessionManager 持有，多 Profile 预留）                                                                                                                                   | persist: 语义明确（重启保登录态）；命名分区是多 Profile 接口落点；defaultSession 隐式语义不利迁移                         |
| Q4  | 四级降级阶梯 L0/L1/L2/L3 + 必填 meta.degraded/warnings                                                                                                                                                 | 「空集合」与「采集失败」必须可区分（调试面板与未来 AI 工具都依赖）；参数/状态问题安全返回不抛异常                         |

### 相对草案的变更点（定稿后生效，T2/T4 按此实现）

1. 动作方法 `void` → `boolean`（失败语义可观测，供未来 AI Tool Layer 判断）。
2. 新增 `dispose()`（生命周期纪律，幂等）。
3. `getPageSnapshot` 返回 `PageSnapshot | null`（L3 安全返回）。
4. `PageSnapshot` 新增必填 `meta`（capturedAt/readyState/degraded/warnings）。
5. `TabInfo.isLoading` → `state` 字段（单一事实源，可派生）。
6. `tabs:updated` 全量推送（幂等，避免增量事件乱序）。
7. 地址栏规范化位置定稿：main 侧 IPC handler（renderer 传原始输入）。
8. 新增 `ui:content-bounds` 通道（WebContentsView bounds 上报）。
9. 新增 UI 窗口自身 will-navigate 白名单（防 UI 窗口被导航到远程页面获得 preload bridge）。
10. `did-fail-load` 的 `errorCode === -3`（ERR_ABORTED，被新导航取代）忽略规则。
11. 最后 Tab 关闭 → 自动新建空白 Tab（窗口常驻不退出）；dispose 路径跳过。
12. 采集输出主进程 normalize 校验（页面视为敌手，不可信输入）。
13. 快照 v1 仅主文档；跨域 iframe 无法读取 → L1 降级 + warnings（明确限制）。
14. 单窗口假设写入设计（多窗口为未来扩展点）。

### 安全补丁变更点（2026-08-13 技术审查后补入，已实现/已定稿）

15. **网页权限默认拒绝**（已实现，本补丁）：Electron 官方安全文档明确「未注册 handler 时默认
    自动批准全部权限请求」。persist Session 现于分区首次创建时注册
    `setPermissionRequestHandler` + `setPermissionCheckHandler`（官方要求两者同时实现），
    决策委托 `permission-policy.ts` 纯函数，v1 一律拒绝；未知权限类型与畸形来源同样安全拒绝；
    配 `permission-policy.test.ts`（无 Electron mock 的纯策略测试）。T5 安全审计逐项核对。
16. **UI 窗口导航保护事件集定稿**（T3 实现，Electron 43.4.0 实证，2026-08-13）：
    实测矩阵（探针以本地 302 服务器 + 真实窗口驱动，结果如下）——

    | 导航场景                    | will-navigate | will-frame-navigate    | will-redirect                   |
    | --------------------------- | ------------- | ---------------------- | ------------------------------- |
    | 程序化 loadURL              | ✗             | ✗                      | ✗                               |
    | location.href（主框架）     | ✓             | ✓（isMainFrame=true）  | —                               |
    | location.replace（主框架）  | ✓             | ✓（isMainFrame=true）  | —                               |
    | 链接点击（主框架）          | ✓             | ✓                      | —                               |
    | 子框架导航                  | ✗             | ✓（isMainFrame=false） | —                               |
    | 页面发起导航 → 302 重定向   | ✓（初始 URL） | ✓                      | ✓（302 目标，isMainFrame=true） |
    | 程序化 loadURL → 302 重定向 | ✗             | ✗                      | ✓（302 目标，isMainFrame=true） |

    结论：`will-navigate`（页面发起导航，**含 location.replace**）+ `will-redirect`（服务器重定向，
    程序化导航遇到 302 时唯一拦截点）即可完整覆盖 UI 主框架威胁；`will-frame-navigate` 无增量
    覆盖且位置参数易错，不采用；三者 `preventDefault()` 均实测可阻止导航。§9 已按此定稿。

## 13. 实现顺序与范围边界（供 T2/T3/T4 参考）

- **T2**：§2（除 PageReader）/§3.1 IPC 常量与 main 侧 handler/§4 错误契约/§5 状态机/
  §6 view 管理/§7 session + `tab-state.test.ts`。
- **T3**：§3.2 bridge 与 UI 接入/§9 导航与地址栏（shared/url 接入）/§10 冒烟扩展。
- **T4**：§8 PageReader/采集脚本/normalize + `snapshot-normalize.test.ts` + 调试面板。
- 边界提醒：不提前实现 AI 工具、多 Profile、iframe 递归采集、收藏夹等（First_stage §十一）。
