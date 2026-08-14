# Third_stage.md — Browser Agent 与受限工具系统

> 前置阶段：`Second_stage.md`  
> 核心目标：让 AI 可以通过受限、可审计、可撤销的 Tool Layer 自主完成低风险浏览任务。

## 1. 阶段定位

本阶段从：

**AI 能读当前网页**

升级为：

**AI 能安全地搜索、打开、阅读和操作网页**

核心原则：

> AI 决定“需要做什么”；确定性程序决定“是否允许、如何执行、执行结果是什么”。

AI 不得直接获得 Electron API、webContents、Node.js、shell 或任意 JavaScript 执行权限。

---

## 2. Entry Gate

进入前要求：

- Second Stage 当前网页共读稳定；
- LLM Provider 抽象支持 tool calling，或已有可靠的兼容层；
- ContextBuilder 已将网页内容视为不可信；
- BrowserController 第一阶段接口已证明可扩展；
- API Key 与日志安全无阻塞问题。

---

## 3. 本阶段目标

### 3.1 Tool Registry

建立统一 Tool Registry。

首批只允许低风险 Browser/Search 工具，概念上包括：

- `browser.get_tabs`
- `browser.get_active_tab`
- `browser.open`
- `browser.navigate`
- `browser.back`
- `browser.forward`
- `browser.reload`
- `browser.read`
- `browser.find`
- `browser.scroll`
- `browser.click`
- `browser.fill`
- `page.extract`
- `search.web`

最终参数 schema 在本阶段详细设计中根据实际 BrowserController 定稿。

### 3.2 SearchProvider

建立独立 SearchProvider。

第一版可以采用浏览器搜索页实现，也可以接一个搜索 API，但必须：

- 不把搜索实现写死在 Agent；
- 返回统一结构；
- 可保留搜索结果标题、URL、摘要、来源；
- 允许以后替换供应商。

### 3.3 Browser Action Element Binding

PageSnapshot 中的 elementId 需要正式服务于浏览动作。

要求：

- elementId 只能在明确生命周期内使用；
- 页面导航/刷新后旧 elementId 失效；
- click/fill 前重新验证目标；
- 找不到、失效、不可交互时安全失败；
- 不允许 AI 直接构造任意 DOM JavaScript。

### 3.4 Agent Runtime

实现最小可控 Agent Loop：

用户目标
→ 模型选择 Tool
→ Tool Registry 校验
→ Permission Policy
→ 执行
→ 结构化 Tool Result
→ 模型继续
→ 最终回答

必须有：

- 最大步骤数；
- 超时；
- 取消；
- 重复操作检测或最小防循环机制；
- Tool 调用日志；
- 页面变化后的状态刷新。

### 3.5 权限分级

建议至少：

#### Level 0 — 自动
- read
- search
- open public page
- find
- scroll
- switch tab

#### Level 1 — 自动但显著展示
- click ordinary navigation/expand
- fill ordinary search/filter fields
- create/close task tabs

#### Level 2 — 必须确认
- submit form
- send message
- upload file
- download potentially risky file
- modify remote data

#### Level 3 — 强确认/当前阶段原则上禁止
- purchase/payment
- password/security changes
- account deletion
- public publishing
- financial actions

具体分类进入本阶段后以测试和产品体验调整。

---

## 4. AI 操作可见性

用户必须能够知道 AI 在做什么。

至少提供：

- 当前 Agent 状态；
- 正在访问的网页；
- 最近 Tool 调用；
- 等待用户确认的动作；
- 停止按钮。

不要求把模型内部思维过程展示给用户。

只展示确定性的操作事实和简短说明。

---

## 5. 安全要求

### 5.1 网页 Prompt Injection

恶意网页内容不得直接：

- 改写 Tool Policy；
- 申请更高权限；
- 读取密钥；
- 访问本地文件；
- 向第三方发送用户数据；
- 触发高风险动作。

### 5.2 Tool 参数校验

所有 Tool 必须：

- schema 校验；
- URL 校验；
- tabId/elementId 生命周期校验；
- 权限校验；
- 错误归一化；
- 输出长度限制。

### 5.3 禁止万能工具

本阶段禁止提供：

- `shell.exec`
- `eval`
- 任意 JavaScript 执行
- 任意文件系统读写
- 任意 HTTP POST
- 任意 Electron IPC
- 任意数据库 SQL

---

## 6. 非目标

本阶段不做：

- 长期信源数据库；
- AI 自动添加收藏；
- 多源 Research 报告；
- 图表/复杂结果渲染；
- RSS；
- Watch；
- 定时任务；
- 自动支付/购买/发布；
- 浏览器扩展生态。

---

## 7. 关键真实场景

阶段结束时至少应通过：

1. “搜索 Electron WebContentsView 官方文档，并打开最相关结果。”
2. “在当前网页里找到 security 部分。”
3. “打开搜索结果中的两个页面并总结差异。”
4. “在一个普通筛选框里输入关键词并读取更新后的结果。”
5. 遇到需要提交/发送的动作时停止并请求确认。
6. 恶意网页中出现 Tool 指令时不执行网页指令。

> 状态（2026-08-14 A8 判定）：场景 1–6 真实执行 **NOT RUN**——A7 已获用户授权并
> 尝试，但唯一已配置 Provider（deepseek-v4-flash）对任何 tools 载荷返回 HTTP 400
> （无 tools 200 正常），判定为 Provider/模型兼容性限制；场景门控
> `AIBROWSE_LIVE_AGENT=1` 与本地安全夹具已就绪，待 tools 兼容 Provider 后补验。
> 离线确定性覆盖（不能替代真实场景）：场景 4 筛选输入 → 冒烟 A6-UI-10（fill
> 真实写入 + input/change 事件）；场景 5 提交确认 → 冒烟 A-02/RT-03（L2 确认门
> deny/approve）；场景 6 恶意网页指令 → 冒烟 RT-01/RT-03/RT-11（诱导文案零 DOM
> 动作）；场景 1/2/3 的多步搜索阅读链路 → 冒烟 A-01/8.3/8.4。

---

## 8. 测试重点

- Tool Schema；
- elementId 失效；
- tab 销毁；
- 导航竞争条件；
- Agent 最大步数；
- Agent cancel；
- 重复点击/循环；
- Permission Policy；
- Prompt Injection；
- Tool Result 过长；
- Tool 错误不会被模型误认为成功；
- 搜索提供商失败时的降级。

---

## 9. 验收标准

> 验收核对于 2026-08-14 A8 收尾执行（证据来源：单测/冒烟场景/审计日志/源码核对，
> 完整证据表见 doc/tasks/progress.md「最近验证结果 A8 条目」；冒烟日志实证见
> log/aibrowse-2026-08-14.log 当日 8.4/8.5/8.6 场景通过行）。

### Agent
- [x] 可完成多步低风险网页任务（PASS·离线）——冒烟 8.4 A-01 多步任务
  （open→read→find→search.web→scroll→click→read→最终回答，7 步真实执行）+
  A6-UI-01 UI 链路 + agent-loop 单测 32 用例；真实模型维度受 Provider 限制
  未验证（见 Engineering 组 BLOCKED 项）
- [x] 有最大步骤/超时/取消（PASS）——AGENT_MAX_STEPS=12 / 总超时 420s 编译期
  常量（agent-loop.ts）+ 冒烟 A-03（取消含 pending 作废）/A-04（step-limit
  第 4 步零执行）+ agent-loop/agent-safety 单测
- [x] Tool 调用全程可审计（PASS）——ToolExecutor 单出口每次调用恰好一条审计
  （tool-executor.ts）+ 冒烟 A-09/A6-UI 审计断言 + audit-log 单测 14 用例
- [x] 失败能安全停止而非无限重试（PASS）——防循环连续 3/累计 5/no-progress 2
  执行前阻断（agent-safety.ts）+ 冒烟 A-05（触发次零 DOM 副作用）+
  agent-safety 单测 17 用例

### Browser Tools
- [x] read/find/scroll/open/click/fill 等核心工具稳定（PASS·离线）——冒烟 8.2
  A-12 允许列表四类点击/fill 隐私/scroll 边界/find 多章节 + 8.4 A-01 真实执行
  + browser-tools/interaction-tools/interaction-script 单测
- [x] elementId 生命周期正确（PASS）——决议 #31 文档世代绑定（导航世代计数 +
  documentId 主进程盖章 + 执行前校验）+ 冒烟 A-07/A-12 + RT-06 +
  interaction-semantics 单测
- [x] 页面刷新后不会误操作旧元素（PASS）——冒烟 A-07 跨导航/同 URL 刷新后旧
  绑定恒 stale-element、新绑定正常（传递性证明零误操作）+ RT-06

### Search
- [x] AI 可通过统一 SearchProvider 查询（PASS）——search.web 经 13 工具注册表
  与 ToolExecutor 全链路 + 冒烟 8.3 受控搜索页三夹具 + search-provider 单测
  28 用例（临时 Tab 精确所有权/错误诚实映射）
- [x] 搜索结果可继续交给 Browser Agent 打开读取（PASS·离线）——冒烟 8.4 A-01
  search.web→open→read 链路真实执行；真实网站维度见 Engineering 组（NOT RUN）

### Permission
- [x] 高风险动作无法无确认执行（PASS）——L2 确认门（isSubmit 优先升级、deny
  零动作、approve 一次）+ 冒烟 A-02/A-12/RT-03 + confirm-manager 单测
- [x] 网页文本无法提升 Tool 权限（PASS）——权限判定为确定性纯函数
  （TOOL_BASE_RISK 编译期矩阵）+ 冒烟 RT-01（system/13 工具/权限矩阵恒等）+
  RT-09 grep + permission-policy 单测
- [x] 无万能 shell/eval/filesystem 工具（PASS）——RT-09 全仓库 grep（A8 复核
  零命中：无 shell/child_process/eval/Function/任意 executeJavaScript/任意
  fs/任意 fetch/任意 IPC/SQL；工具实现零 Electron import）
- [x] （detailed-design §14 收紧）L3 动作执行器层不可达（PASS）——click 确定性
  允许列表 + fail-closed + 执行器层 allowedKind 白名单复核（权限层与执行器层
  双重封死）+ 冒烟 A-12/RT-11（零 DOM 动作）+ permission-policy/
  interaction-script 单测

### Engineering
- [x] 全量验证通过（PASS）——A8 独立复核：test 771/771 · typecheck · lint ·
  format:check · build 全绿；dev 离线全矩阵 + 生产产物双场景冒烟退出码 0
- [ ] 多个真实网站 Agent smoke test 通过（**BLOCKED**）——受真实 Provider 能力
  限制未执行：唯一已配置 Provider（deepseek-v4-flash）对任何 tools 载荷返回
  HTTP 400（stream 与否两形态复现），无 tools 请求 200 正常——判定为 Provider/
  模型兼容性限制（非适配器缺陷）。不重复付费诊断；FakeProvider 受控本地页面
  冒烟**不能替代**本项；场景门控 `AIBROWSE_LIVE_AGENT=1` 代码已就绪，待
  tools 兼容 Provider 配置并获用户授权后执行补验
- [x] Agent 操作日志无敏感信息（PASS·离线）——审计脱敏链（fill 只记 len=N/
  URL・查询串全量/其余截断）+ logger sanitize + normalizeLogMessage 日志行
  伪造防御（13 用例）+ 冒烟 A-09/A6-UI-10/A6-UI-12 字节扫描 + A8 当日日志
  字节扫描（sk- 形态 0 命中/fill 原文 0 命中）；真 Key 零暴露扫描属真实调用
  部分（NOT RUN，随真实 Provider 补验一并执行）

---

## 10. Exit Gate

进入 Fourth Stage 前：

- Agent 在常见搜索/阅读任务上不会频繁死循环；
- Tool API 已稳定到足以被 Sources/Research 复用；
- Permission Policy 可扩展；
- Prompt Injection 红队场景至少有基础测试；
- 没有通过放宽网页权限获得“成功率”的技术债。

**Exit Gate 逐项判定（2026-08-14 A8 收尾执行）**：

1. **不会频繁死循环 —— PASS（离线确定性证据）**：防循环三触发（连续 3/累计 5/
   no-progress 2）在执行前阻断 + 步数上限 12（agent-safety/agent-loop 单测 +
   冒烟 A-04/A-05/A6-UI-06）；真实模型的频繁循环行为观察属真实 Provider 验证
   （NOT RUN，见 §9 Engineering BLOCKED 项）。
2. **Tool API 稳定可复用 —— PASS**：接口契约定稿（§4/§5/§6 + 决议 #21～#34），
   A3–A6 均为其下游消费者（交互工具/SearchProvider/AgentLoop/可见性 UI 复用同一
   ToolRegistry/ToolExecutor 管线）；A6 后契约零变更。
3. **Permission Policy 可扩展 —— PASS**：确定性纯函数 + 编译期矩阵 + 单一事实源
   classifyClickTarget；扩展 = 修改 permission-policy 模块与测试（§7.1），
   已预留 ToolDefinition.baseRisk 注入点。
4. **Prompt Injection 红队基础测试 —— PASS（离线部分）**：RT-01～RT-08 + RT-11
   自动化断言落地（冒烟 8.6，dev/生产双场景退出码 0）+ RT-09 全仓库 grep 断言 +
   相关单测（interaction-script 敌手参数逃逸 28 用例等）；RT-10 真实模型观察性
   证据 NOT RUN（三类诚实边界：机器可验证部分已由离线矩阵覆盖，观察性/不保证
   部分待 tools 兼容 Provider）。
5. **无放宽网页权限技术债 —— PASS**：A1–A7 各闭环红线终检均零放宽
   （click 允许列表为收紧非放宽；权限矩阵/Electron 安全边界/Key 红线逐项
   核对无回退，A7 增量安全审计证据）。

**第三阶段总 Exit 决策：`HOLD/PENDING`（2026-08-14 A8 判定）**——§9 Engineering
「多个真实网站 Agent smoke test 通过」**BLOCKED**：唯一已配置 Provider
（deepseek-v4-flash）不支持 tools（任何 tools 载荷 HTTP 400，证据见 progress.md
A7/A8 条目），受控本地页面 FakeProvider 冒烟不能替代真实网站验证。已完成：
§7 真实场景 1–6 与 RT-10 的门控代码（`AIBROWSE_LIVE_AGENT=1`）与仓库外 harness
就绪；未完成：真实模型多轮 Agent 场景、真 Key 零暴露扫描、RT-10 观察性证据。
**不得将本阶段标记为最终验收通过**；待 tools 兼容 Provider 配置并获用户授权后
执行真实 Agent 验收补验，取得充分证据后方可改判 `GO/PASS`。

完成后停止，不直接实现信源数据库。
