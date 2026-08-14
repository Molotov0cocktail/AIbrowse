# AIbrowse — AI 信息浏览器

> 第三阶段目标：**Browser Agent 与受限工具系统**——AI 通过受限、可审计、可撤销的
> Tool Layer 自主完成低风险浏览任务：tool-calling 兼容层（A1 硬前置）、Tool Registry、
> SearchProvider、scroll/click/fill/find 交互能力（elementId 生命周期）、最小可控
> Agent Loop（最大步数/超时/取消/防循环）、确定性权限分级与确认状态机（L0 自动 /
> L1 自动显著展示 / L2 用户确认 / L3 禁止）、操作可见性与审计日志。契约源
> `doc/stage3/detailed-design.md`；安全契约源 `doc/stage3/threat-model.md`
> （Prompt Injection 威胁模型已重建定稿，先于任何 Browser Tool 实现）。
> **A1 tool-calling 兼容层 + A2 Tool Registry/权限分级与确认状态机/审计日志 +
> A3 浏览器交互能力（find/scroll/click/fill + elementId 文档世代绑定）+
> A4 SearchProvider 与 search.web + A5 Agent Runtime 已实现（2026-08-14）；
> A6–A8 待实现**
> （任务编号 2026-08-14 实施前校正：T1–T8 改为 A1–A8 避免与第一阶段任务
> T1–T5 重名、红队编号改 RT-01～RT-11、权限契约收紧为 click 确定性允许列表，
> 见 `doc/stage3/proposal.md` §11）。
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
- 🔨 **第三阶段（Browser Agent）进行中（2026-08-14）**：Entry Gate 逐项核验通过
  （「tool calling」项经循环式门槛判定记录校正——该能力属第三阶段自身交付物，校正为
  A1 硬前置，判定证据见 `doc/stage3/proposal.md` §8）；Prompt Injection 威胁模型
  重建定稿（`doc/stage3/threat-model.md`）；契约定稿 `doc/stage3/detailed-design.md`。
  **A1 tool-calling 兼容层已完成**（Provider 类型扩展 + SSE tool_calls 聚合解析 +
  FakeProvider 工具脚本 + ContextBuilder tools 透传，全量验证通过，硬前置解除）；
  **A2 Tool Registry + 权限分级与确认状态机 + 审计日志已完成**（注册表确定性校验/
  listTools、13 工具权限矩阵纯函数（click 确定性允许列表 + fail-closed）、
  ConfirmManager 单 pending 状态机、审计参数脱敏（fill 只记长度）、ToolExecutor
  管线（校验→权限→确认→执行→审计，每次调用恰好一条）、首批 8 个只读/导航工具
  接线 BrowserController——冒烟工具层探针通过，审计日志实证）；
  **A3 浏览器交互能力已完成**（interaction-script 固定模板 + click 确定性允许
  列表单一事实源 classifyClickTarget + BrowserController 扩展（clickElement/
  fillElement/scrollTab）+ elementId 文档世代绑定（决议 #31：导航世代计数 +
  快照 meta.documentId 主进程盖章 + 执行前校验，旧 id 不因新文档复用相同 el-N
  而命中新元素）+ find/scroll/click/fill 四工具经既有 ToolExecutor 链路接线——
  冒烟 A-12 与 elementId 生命周期真实 DOM 探针通过，dev/生产双场景）；
  **A4 SearchProvider 与 search.web 已完成**（接口 + Bing 搜索页实现——临时 Tab
  精确 tabId 所有权与恢复语义（决议 #32）+ 确定性解析（ck/a 包装链接还原/过滤/
  去重/snippet 空串容忍设计）+ 错误诚实映射（合法空结果 vs 结构无法识别/L2/L3）
  - search.web 注册（L0，注册表 13 工具，查询串全量审计）——受控搜索页冒烟
    全链路 + 公网 Bing 探针 10 条真实结果通过，dev/生产双场景）；
    **A5 Agent Runtime 已完成**（AgentLoop 纯编排状态机（MAX_STEPS=12/总超时
    420s/取消/防循环执行前阻断/终态单一所有权，决议 #33 六点校准）+
    AgentContextBuilder（AGENT_SYSTEM_PROMPT 独立常量 + UNTRUSTED_TOOL_RESULT
    块）+ agent-history（ToolStep/脱敏 toolCalls/完整交互组）+ ConversationStore
    version 2 + ConversationService agentAsk/confirmTool + 主进程冒烟 A-01～A-09
    ——dev/生产双场景退出码 0）；
    任务 A6–A8 待实现（**下一个推荐任务：A6 操作可见性 UI 与通道**）。

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
A2/A3 工具层探针与交互场景 → A4 搜索生命周期场景（受控搜索页夹具三形态 + 临时 Tab
精确所有权与恢复 + 审计恰好一条；可选公网 Bing 探针 `AIBROWSE_SMOKE_LIVE_SEARCH=1`）→
自动退出，退出码 0 即通过；矩阵见 `doc/stage2/detailed-design.md` §13.2 +
`doc/stage3/detailed-design.md` §13.2）：

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
| `npm test`                        | Vitest 全量测试（当前 699 用例）                    |
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
│   ├── browser/   # BrowserController / TabManager（A3 ✅ 导航世代计数）/ SessionManager /
│   │              #   PageReader（A3 ✅ 交互编排）/ snapshot-script + snapshot-normalize /
│   │              #   interaction-script + interaction-normalize（A3 ✅ 固定模板交互注入与
│   │              #   结果形状校验）/ tab-state / permission-policy
│   └── ai/        # （第二阶段已实现）ConversationService / ConversationStore /
│                  #   ContextBuilder + budget / CredentialStore / ConfigStore /
│                  #   provider（LLMProvider/OpenAI-compatible/FakeProvider/error-normalize；
│                  #   A1 ✅ tool-calling 兼容层：tools/SSE tool_calls 聚合/工具脚本）
│                  # （第三阶段）tools/（A2 ✅ tool-types/tool-registry 校验/tool-executor
│                  #   管线/browser-tools 首批 8 只读导航工具 + A3 ✅ interaction-tools
│                  #   find/scroll/click/fill、interaction-semantics 语义存储+世代绑定 +
│                  #   A4 ✅ search-tool search.web 注册与序列化）+
│                  #   permission/（A2 ✅ permission-policy + A3 ✅ classifyClickTarget）+
│                  #   confirm-manager（A2 ✅ 确认状态机 + A5 ✅ onPendingChange 可见性回调）+
│                  #   audit-log（A2 ✅ 审计参数脱敏 + A4 ✅ search.web 查询串全量记录 +
│                  #   A5 ✅ decision 单一事实源（ToolStepDecision 别名）+ agent-run 条目）；
│                  #   agent/（A5 ✅ agent-loop 纯编排状态机 + agent-context-builder +
│                  #   agent-history + agent-safety 防循环纯函数，零 Electron import）+
│                  #   search/（A4 ✅ search-provider：接口 + Bing 页面实现 + 确定性解析，
│                  #   临时 Tab 精确所有权零 Electron import）
├── preload/       # UI bridge（contextBridge，白名单 IPC：tabs/nav/page/ui + conversation/config；
│                  #   第三阶段 A6 规划 agent 通道）
├── renderer/      # React UI：chrome（Toolbar/TabBar/AddressBar/DebugPanel）+ ai/（AI 侧栏；
│                  #   第三阶段 A6 规划 Agent 模式/状态栏/确认对话框）
└── shared/        # 共享类型（app/browser/ipc/conversation + agent——A2 ✅ ToolCall/ToolResult/
                   #   权限级别/ElementSemantics）+ 纯逻辑（url.ts）
```

完整结构与职责见 `AGENTS.md` §4；第二阶段契约与任务见 `doc/stage2/`（定稿）；
第三阶段契约与任务见 `doc/stage3/`。

## 日志

每次运行生成详尽日志（启动/退出、关键路径、错误堆栈、环境信息）：项目根目录 `log/`（按日轮转，已 gitignore）。
打包后写入用户数据目录下 `log/`。

## 测试

Vitest（node 环境）测核心纯逻辑（当前 699 用例）：地址栏输入判断（15）、Tab 状态机（14）、
网页权限策略（4 组）、UI 导航保护（10）、PageSnapshot 数据规范化（51，页面视为敌手；A3 扩展 click 语义元数据）；
第二阶段（S1–S4）新增：错误归一化状态码矩阵与脱敏、FakeProvider 确定性行为、
credential/config 校验（81）、上下文预算确定性裁剪、ContextBuilder 角色隔离与注入夹具
（system 恒等/块闭合转义/selection 独占）（72）、会话消息校验与编排（57）、
UI 纯 reducer 与徽标文案（22）、logger 脱敏密钥专项用例；
第三阶段 A1 新增（35）：SSE tool_calls 聚合解析（分槽累积/收尾顺序/非法帧与非法
arguments → provider-error）、mapMessages tool 与 tool_calls 重放、FakeProvider
工具脚本、ContextBuilder tools 恒等透传。
第三阶段 A2 新增（91）：工具注册表（重复注册拒绝/listTools 恒等/校验矩阵——JSON 解析/
必填/类型/enum/未知键/长度/tabId UUID/elementId el-N）、权限矩阵全表（13 工具 ×
条件判定：click 确定性允许列表各分支与特征冲突/isSubmit 优先升级 L2/ariaExpanded
true 与 false 均为展开控件/语义缺失 fail-closed/fill password・file 恒 L3/URL
scheme L3）、ConfirmManager 状态机（单 pending/approve/deny/作废/幂等/无自动批准）、
审计脱敏（fill len=N 原文零出现/URL 全量/截断确定性/Key 形态零暴露链）、ToolExecutor
管线（成功/校验失败/L3/deny/执行失败/审计恰好一条/结果截断）、8 个只读导航工具的
BrowserController 注入调用与失败安全返回、logger 审计形态脱敏回归。
第三阶段 A3 新增（81）：交互脚本模板（node:vm 假 DOM 真实执行——模板编译期固定/
JSON 字面量往返恒等/敌手参数引号・反斜杠・闭合片段・脚本字符串不能逃逸/click
allowedKind 四类复核与拒绝路径/fill 原生 setter + input/change 事件与禁填目标/
scroll 整数边界）、交互结果形状校验（页面视为敌手逐字段验证）、快照语义映射与
存储（世代绑定）、find 确定性匹配（多章节/无命中空结果）、scroll/click/fill
executor（派生参数透传/无派生 fail-closed/fill 内容零原文）、classifyClickTarget
与 decide 同源双表对照、paramRules（dy ±50000 整数/text 长度差异化）、
ToolExecutor derived 派生（allowedKind+documentId）、快照 click 语义元数据
（isSubmit/ariaExpanded 严格布尔）、meta.documentId 主进程盖章。
第三阶段 A5 新增（123）：agent-safety 签名规范化（键排序/Unicode NFC/非法 JSON
原始串）与循环判定（连续 3 与累计 5 在执行前阻断/触发次计步/read 无白名单例外/
被拒与失败同样计签/no-progress 连续 2，阈值可注入）、agent-loop 状态机全路径
（多步任务/协议历史合法序（assistant toolCalls → tool 消息同序精确关联）/文本+
工具同轮为过程性输出/goal 恰一次/四种工具错误结构化回注后继续/execution-failed
保留实际权限决策/L2 deny・approve・取消・超时/step-limit 边界（13 调用只执行
12，未执行零伪造）/防循环执行前阻断（触发次零副作用，阻断步骤 decision=invalid

- 恰好一条审计）/no-progress 两轮/Provider 错误直传/用户取消部分保留/终态竞态
  （先到先得、迟到 abort 与工具结果忽略、工具挂起不阻塞 run）/重复与空 toolCallId
  fail-closed）、agent-context-builder（AGENT_SYSTEM_PROMPT 恒等且与共读互不
  混用/goal + 启动快照块闭合转义/UNTRUSTED_TOOL_RESULT 块属性与敌手闭合转义/
  tools 恒等透传）、agent-history（ToolStep 组装内部能力参数零出现/contentPreview
  ≤200/decision 六值单一事实源/FILL_MASK 脱敏/完整交互组校验——孤立 tool 丢弃・
  不完整组整组丢弃/跨 run 只回摘要 + 完整组预算裁剪）、conversation-store v2
  （写入恒 v2/读兼容 v1/ToolStep 逐字段 fail-closed/孤立与重复 tool 消息解析丢弃/
  组感知 200 条裁剪/真实文件字节断言 fill 原文・快照正文・Key 形态・documentId
  零落盘）、conversation-service agentAsk（goal 校验与截断/共读与 Agent 双向在途
  互斥/Provider 未配置与不支持工具零执行/多步 ToolStep 持久化协议序/事件恰好一次/
  ephemeral 不落盘/重启恢复/abort 部分保留/deleteSession 不复活/confirmTool 转发
  与防串 run 事件映射）、FakeProvider 多轮 rounds 脚本与中止感知睡眠、
  ConfirmManager onPendingChange 回调。
  第三阶段 A4 新增（43）：搜索解析矩阵（正常组装/去重保持首现/非 http・https 与畸形
  URL 丢弃/bing 自身域与非结果标签过滤/ck/a 包装链接 base64url 还原/前 10/title 200
  截断/snippet 空串容忍设计/空与 null 安全降级）、临时搜索 Tab 所有权与恢复语义
  （精确 tabId 独占/只关本调用创建的确切 id/提前关闭安全无操作/活动 Tab 恢复与
  不抢焦点/并发隔离/超时・取消・异常全路径零泄漏——注入时钟确定性）、search.web
  工具（常量 schema/L0 管线决策/序列化纯文本零特权/4000 截断/空结果明确提示/
  结构无法识别 search-failed/取消归一/每次调用恰好一条审计/查询串全量审计）。
  Electron 行为由冒烟自检真实启动验证（见上）。 约定见 `AGENTS.md` §7。

## 已知限制

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（设计决议，点时刻尽力采样）。
- 地址栏不支持中文/国际化域名（IDN，走搜索兜底）；搜索引擎暂硬编码 Bing（SearchProvider
  接口隔离已落地，v1 为 Bing 搜索页实现，未来 API 供应商实现同接口即可替换）。
- 无 CI / 打包配置（第一阶段验收不要求；打包属 Seventh Stage）。
- 冒烟中的搜索验证在离线环境断言「发起 Bing 搜索导航」而非页面加载完成（联网冒烟变体可验证）。
- Prompt Injection 边界：第二阶段结构性隔离保证网页内容不能取得权限、读取密钥、调用写
  操作或改变消息角色（机器可验证）；第三阶段引入 Browser Tool 前**威胁模型已重建定稿**
  （`doc/stage3/threat-model.md`：五层防线 + 红队矩阵 RT-01～RT-11）。仍**不承诺**模型在
  语义层完全不受网页文本诱导——第三阶段四类残余风险（诱导式工具参数/确认疲劳/低风险
  动作累积/click 允许列表目标的页内 JS 副作用）如实登记，不宣称免疫。
- 详细清单见 `doc/tasks/progress.md`「计划内限制与延期项」。
