# AIbrowse 第一阶段 详细设计（草案）

> ⚠️ 状态：**草案**。本文件当前只承载基线已确定的内容 + 浏览器核心的契约草案；
> 浏览器核心的最终契约（错误处理、preload 清单、Tab 状态机、采集算法）由任务 **T1「详细设计定稿」** 完成。
> 实现后所有签名必须用 `grep -n "^export"` 与实际代码核对回填。

## 1. 文件布局（基线实际状态，2026-08-13）

```
d:\AIbrowse\
├── AGENTS.md / First_stage.md / README.md
├── .agents/skills/…（规则 + references/prompt-templates.md）
├── .gitignore / .editorconfig / .prettierrc.json / .prettierignore
├── electron.vite.config.ts / vitest.config.ts
├── tsconfig.json / tsconfig.node.json / tsconfig.web.json
├── eslint.config.mjs / package.json / package-lock.json
├── doc/（proposal / high-level-design / detailed-design / tasks/）
├── log/（运行时生成，gitignore）
└── src/
    ├── main/
    │   ├── index.ts          # 入口：生命周期、窗口创建、IPC 装配
    │   ├── logger.ts         # log/ 文件轮转日志
    │   └── browser/          # （待建）BrowserController/TabManager/SessionManager/PageReader/types
    ├── preload/index.ts      # UI bridge（contextBridge，白名单 IPC）
    ├── renderer/             # React UI（index.html + src/）
    └── shared/
        ├── types/            # 共享类型（TabInfo/PageSnapshot/IPC channel）
        └── url.ts            # 地址栏输入 → URL/搜索 纯函数（基线已建 + 已测）
```

## 2. 接口契约（草案，T1 定稿）

### 2.1 BrowserController（浏览器能力统一入口）

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

草案说明（可改进，不机械复制）：

- 错误语义 T1 定稿：不存在的 tabId 如何安全返回（`null`/降级 vs 抛错）——倾向安全返回。
- `navigate` 输入是否要求已规范化 URL：T1 定稿（倾向 main 侧统一用 shared/url 规范化）。

### 2.2 PageSnapshot（结构化快照，First_stage.md §七）

```ts
interface PageSnapshot {
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
}
```

- 不返回完整 DOM；过滤 script/style/隐藏内容。
- elementId 在一次快照生命周期内对应真实 DOM 元素（映射方案 = proposal Q1，T1 定稿）。

### 2.3 TabInfo / 共享类型（草案）

```ts
interface TabInfo {
  id: string; // 程序内唯一 id（与 webContents.id 解耦，避免 id 复用）
  title: string;
  url: string;
  active: boolean;
  isLoading: boolean;
}
```

### 2.4 preload bridge 最小权限清单（草案，T1 定稿）

UI 渲染进程（React UI 专用 preload，与远程网页完全隔离）：

- `tabs:list` / `tabs:create` / `tabs:close` / `tabs:activate` / `tabs:updated`（事件推送）
- `nav:navigate` / `nav:back` / `nav:forward` / `nav:reload`
- `page:snapshot`（读取当前网页结构化信息）
- `app:get-info`（基线已有：版本信息）
  远程网页 **不挂载任何 preload 暴露的 Node/Electron 能力**；PageReader 采集走独立只读注入脚本。

## 3. 错误处理（草案，T1 定稿）

| 类别                                  | 处理方式                                    | 日志级别        |
| ------------------------------------- | ------------------------------------------- | --------------- |
| 参数无效（非法 tabId/URL）            | 安全返回（undefined/空结果/降级），不抛异常 | warn            |
| 页面销毁/导航竞态（tab 已关闭后调用） | 安全返回并记录                              | info/warn       |
| 采集执行失败（跨域 iframe、页面冻结） | 返回带 `error` 字段的部分快照或空结果       | warn + 分类计数 |
| 未预期异常                            | 顶层兜底记录堆栈，进程不崩                  | error           |

## 4. Tab 状态机（草案，T1 定稿）

```
创建 → idle →(loadURL)→ loading →(did-finish-load)→ ready
                 │                     │
                 └──(did-fail-load)─► error ──(reload)──► loading
ready/loading/error ──(close)──► destroyed（WebContentsView 销毁 + 监听器全部移除）
```

- 事件监听随 view 创建注册、销毁时移除（防重复注册/内存泄漏，First_stage.md §十二）。
- 最后一个 Tab 关闭时的策略（退出 vs 新建空 Tab）T1 定稿。

## 5. PageSnapshot 采集算法（草案，T1 定稿 + T4 实现）

1. 主进程向目标 webContents 注入只读脚本（`webContents.executeJavaScript` 或注入 context）。
2. 脚本遍历 DOM：取 url/title/视口/选区；过滤 script/style/noscript/隐藏元素（offsetParent/display/visibility/aria-hidden）。
3. 提取 headings/links/buttons/inputs/tables（常见表结构识别：`<table>` + role=table）。
4. 交互元素分配 elementId：注入上下文内顺序计数 + Map 缓存，供「快照生命周期内」回查；
   快照交付后缓存保留策略 T1 定稿。
5. 返回纯 JSON（结构化克隆），不返回函数/节点句柄，远程网页无法借此执行特权代码。

## 6. 测试规格（基线已建 + 规划）

| 测试文件                                      | 用例要点                                                                                              | 状态                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `src/shared/url.test.ts`                      | `https://…` 直开 / 裸域名规范化 / 搜索词 → 搜索引擎 URL / 空输入与异常输入安全返回 / 非法 scheme 处理 | ✅ 基线已建（15 用例） |
| `src/main/browser/tab-state.test.ts`          | Tab 状态机纯逻辑：activeTabId 选择、关闭后激活策略、事件归并                                          | 规划（T2）             |
| `src/main/browser/snapshot-normalize.test.ts` | PageSnapshot 数据规范化（文本修剪、空值、表格行列对齐）                                               | 规划（T4）             |

## 7. 待定问题（同 proposal §8 Q1–Q6，T1 集中定稿）

Q1 elementId 映射方案；Q2 WebContentsView 生命周期与遮挡管理；Q3 session 分区实测；
Q4 快照降级粒度；Q5 已解决（代理实测可用）；Q6 首次推送时实测。
