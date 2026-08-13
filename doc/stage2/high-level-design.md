# AIbrowse 第二阶段 高层设计

> 状态：初稿（随 Second Stage 切换建立，2026-08-13）。接口契约定稿由
> `doc/stage2/detailed-design.md`（本阶段唯一契约源）承担；实现任务 S1–S6。
> 第一阶段契约不变，见 `doc/detailed-design.md`。

## 1. 架构总览

```
┌─ 渲染进程：React UI（浏览器外壳 + AI 侧栏）────────────────────────────┐
│  依赖方向：UI → BrowserController / ConversationService（仅经 preload    │
│  bridge + IPC 白名单；AI 面板不接触 API Key，只写不读）                  │
└──────────────────────────────┬────────────────────────────────────────┘
                     contextBridge（最小权限 IPC，类型化 channel）
┌──────────────────────────────┴────────────────────────────────────────┐
│ 主进程（Node 全权限，仅限程序自身代码）                                  │
│   AI 子系统（Second Stage 新增）                                        │
│     ConversationService ──► ContextBuilder（纯函数）                    │
│          │                      ▲ 输入含实时快照                        │
│          ├──► LLMProvider 适配器（fetch+SSE，Key 仅在此层）             │
│          │        └──► SecureCredentialStore（safeStorage/DPAPI）       │
│          └──► BrowserController.getPageSnapshot（提问时刻实时采集）      │
│  浏览器核心（第一阶段，不变）：BrowserController → TabManager /          │
│     PageReader / SessionManager → WebContentsView（远程网页，           │
│     安全默认值全开，Tab 无 preload）                                     │
└────────────────────────────────────────────────────────────────────────┘
```

- **渲染进程**：React UI 增加 AI 侧栏（会话列表/消息流/输入/设置）。经 preload 白名单与主进程
  通信；**API Key 只写不读**（写入走 `config.providers.setKey`，读取仅返回 `hasKey` 布尔）。
- **主进程**：AI 子系统与浏览器核心同进程但模块隔离；LLM 网络请求只在主进程发起
  （Key 不跨 IPC）；ContextBuilder 为纯函数（零 Electron 依赖）。
- **远程网页**：完全隔离不变（无 preload、无 IPC、无 Node）；网页内容只有一条进入 AI 的路径：
  PageReader 采集 → PageSnapshot → ContextBuilder 标记块。

## 2. 关键技术决策

| 决策点        | 选项                                                             | 选择                                                                    | 理由                                                                                                            |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider 实现 | 厂商 SDK（openai/anthropic）/ OpenAI-compatible 自实现 / 双实现  | **OpenAI-compatible 自实现（原生 fetch + SSE 手写解析）+ FakeProvider** | 覆盖面广（OpenAI/DeepSeek/Ollama 等兼容端点）；零新依赖（技术基线冻结友好）；`LLMProvider` 接口为未来适配器预留 |
| API Key 存储  | 明文配置文件 / **Electron safeStorage（DPAPI）** / 第三方 keytar | **safeStorage + 可替换接口**                                            | Electron 内置、Windows 走 DPAPI（CryptProtectData）、无新依赖；接口可替换为 Windows 凭据管理器等                |
| 会话持久化    | SQLite / **JSON 文件（userData）** / 仅内存                      | **JSON 文件 + 原子写 + 上限裁剪**                                       | SQLite 属本阶段非目标；最小化持久化：只存消息与 ContextSource 摘要，不存快照正文                                |
| 上下文注入    | system 拼接 / **user 消息内标记块**                              | **user 消息内 `UNTRUSTED_WEB_CONTENT` 块 + 闭合转义**                   | 角色隔离可机器验证：system 恒为应用常量；网页文本无法逃逸标记块改变角色                                         |
| 流式传输      | invoke 整包返回 / **invoke 受理 + send 事件流**                  | **invoke 受理 + send 事件流**                                           | 流式体验；与既有 tabs:updated 推送模式一致；chunk 单向无回执                                                    |
| 面板布局      | 悬浮覆盖 / **停靠挤压内容区**                                    | **停靠挤压**                                                            | 复用并升级既有 `ui:content-bounds` 机制（改测内容容器两维），证明 bounds 机制跨布局变化可用                     |
| 快照时机      | 面板打开时缓存 / **提问时刻实时采集**                            | **提问时刻实时 `getPageSnapshot(activeTabId)`**                         | 防串页核心（Entry Gate 审查约束①）；capturedAt 主进程盖章，不信任任何缓存快照                                   |

## 3. 模块职责

- **AI Side Panel（renderer/src/ai/，S4）**：会话列表/新建/删除/「不保存」开关；消息流渲染
  （delta 追加）；中止按钮；上下文模式徽标（当前网页/选中文本/无网页上下文 + 薄快照/降级提示）；
  追溯卡片（ContextSource）；Provider 设置（baseUrl/model/API Key 只写不回显）。
- **ConversationService（main，S3）**：会话生命周期（create/list/history/delete/setEphemeral）；
  `ask` 编排（实时快照 → ContextBuilder → Provider 流 → 事件转发 → 持久化）；中止管理；
  `previewContext`（面板徽标预览，只回摘要不含快照正文）。
- **ContextBuilder + context-budget（main，纯函数，S2）**：快照/selection/历史 → Provider 请求 IR
  （角色隔离、`UNTRUSTED_WEB_CONTENT` 块序列化、确定性预算裁剪、模式推导、薄快照判定、
  表格噪声过滤）。零 Electron 依赖。
- **LLMProvider（main，S1）**：`LLMProvider` 接口 + 事件类型 + 注册表；OpenAI-compatible 适配器
  （fetch + SSE + 超时/中止 + usage）；FakeProvider（确定性脚本，测试/冒烟）；
  error-normalize（纯函数：HTTP/异常 → 归一化错误，脱敏）。
- **SecureCredentialStore（main，S1）**：safeStorage 加解密 + `userData/credentials.json`
  （仅密文）；`isAvailable/set/get/has/delete`；不可用时 fail-closed（不落盘）。
- **config-store（main，S1）**：Provider 配置（providerId/baseUrl/model，非机密）JSON 读写与校验
  （baseUrl 仅 http/https、model 非空、加载时形状校验）。
- **共享类型（shared/types/conversation.ts，S1）**：会话/消息/上下文模式/错误码/IPC payload 单一事实源。

## 4. 数据流（关键路径）

```
用户提问：
1. AI 面板 → bridge conversation.ask {sessionId, question} → IPC（sender 校验）
2. ConversationService：会话/在途校验 → question 长度上限
3. 实时采集：getPageSnapshot(activeTabId)（L0–L3；L3 → null）
4. ContextBuilder.build({question, snapshot, history, system}) → ProviderRequest + meta
   （模式推导：selection 优先 → snapshot → none；网页内容进 UNTRUSTED 块）
5. 先持久化 user 消息（content + ContextSource 卡片数据），保证引用链先于生成落地
6. provider.stream(request, signal)（main 进程 fetch+SSE；Key 从 SecureCredentialStore 取，仅此一处）
7. 事件流：conversation:stream-chunk {requestId, delta} ×N → conversation:turn-done
   {requestId, status, message, error?} → 渲染进程增量渲染
8. 结束后持久化 assistant 消息（complete / aborted 保留部分 / error 记错误码）；
   ephemeral 会话全程不落盘

中止：面板 conversation:abort {requestId} → AbortController.abort() → 流以 aborted 终态结束
上下文预览：面板打开/切 Tab（防抖）→ conversation:preview → 实时快照摘要
  {tabId,url,title,hasSelection,thin,degraded,mode}（不含快照正文）
```

## 5. 安全模型

- **API Key 路径**：renderer 输入 → IPC（只写）→ 主进程 safeStorage 加密 → `credentials.json`
  （密文）；请求时主进程解密 → fetch 头；**任何读取路径不出主进程**（`config.providers.list`
  只回 `hasKey`）。日志 sanitize（logger 已有 token/secret/key 模式脱敏，S1 补密钥专项用例）；
  错误归一化只取状态码，不含响应体/请求头。
- **Prompt Injection 结构性边界**：
  - 网页内容只存在于 user 消息的 `UNTRUSTED_WEB_CONTENT` 块；块体闭合转义（`</` → `<\/`），
    敌意文本无法逃逸块结构；属性值转义 `&<>"`；
  - system 为编译期常量（测试断言恒等）；
  - 角色由程序字面量赋值，任何输入不含角色解析路径；
  - **本阶段 AI 无任何浏览器写工具**（click/fill/scroll/搜索均不存在——不存在的代码无法被注入触发）；
  - 结构性隔离 ≠ 模型语义免疫：恶意网页文本仍可能诱导模型输出误导性内容。剩余风险登记
    （detailed-design §12），Third Stage 引入工具前必须重建威胁模型。
- **IPC 最小权限**：新通道全部走既有 sender 校验（主窗口主帧）；事件只发主窗口；
  远程网页无 preload（第一阶段探针回归）。

## 6. 存储

- 会话：`userData/conversations/index.json`（会话索引）+ `<sessionId>.json`（消息）；
  原子写（tmp+rename）；上限：50 会话 / 每会话 200 条消息（超限确定性裁剪）；
  损坏文件 fail-closed（视为空 + warn）；ephemeral 会话不落盘、退出即弃；
  **不持久化 PageSnapshot 正文**（最小化持久化，Second_stage.md §7）。
- 凭据：`userData/credentials.json`（safeStorage 密文 base64）；safeStorage 不可用时不落盘。
- Provider 配置：`userData/providers.json`（非机密）。
- 以上均位于 userData（运行时目录，不在仓库内），不新增仓库内数据文件。

## 7. 测试策略

- **单测（Vitest，node 环境，纯逻辑）**：context-builder（角色隔离/裁剪/selection 优先级/
  薄快照/表格噪声/注入文案夹具）、context-budget（预算确定性）、error-normalize（状态码矩阵+
  脱敏断言）、会话消息校验与历史裁剪、title 推导、FakeProvider 行为、logger 脱敏密钥用例。
- **集成/冒烟（Electron 真实启动，FakeProvider，离线确定性）**：共读冒烟矩阵
  （端到端流式、selection 模式、防串页、L3 降级、薄快照、中止、超时/错误归一化、
  ephemeral 不落盘、删除、bounds 协调、Key 不可达断言、注入结构断言、远程隔离回归）——
  场景清单见 detailed-design §13。
- **真实 Provider 可选验证**：`AIBROWSE_LIVE_PROVIDER=1` + `AIBROWSE_TEST_API_KEY`
  （需用户提供 Key，询问边界）；未提供则跳过并记录，不阻塞验收。
- **静态检查**：typecheck / ESLint / Prettier（第一阶段规则不变）。

## 8. 风险与不确定性

| 风险                                       | 影响                     | 缓解                                                                  |
| ------------------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| 字符预算 ≠ token 预算（无 tokenizer）      | 超限请求被 Provider 拒绝 | 保守字符上限 + Provider 400 映射 `context-too-long`（用户可新开会话） |
| 供应商 SSE 差异（错误事件格式/usage 缺失） | 流解析脆弱               | error-normalize 归一 + 冒烟矩阵覆盖异常注入                           |
| safeStorage 不可用（非常规环境）           | Key 无法安全落盘         | fail-closed：仅内存 key（退出即弃）+ 用户提示                         |
| 布局表启发式误判                           | 噪声表格混入/数据表误删  | 容忍设计：误删只是少内容（有 warnings），误留只是多冗余文本           |
| 网页文本诱导模型（语义层注入）             | 误导性回答               | 结构性边界 + 无写工具 + 剩余风险登记；不承诺语义免疫                  |
| 面板挤压引起 view bounds 频繁变化          | 网页重排抖动             | ResizeObserver 防抖沿用（50ms）+ 面板定宽 380px                       |
