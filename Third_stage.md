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

### Agent
- [ ] 可完成多步低风险网页任务
- [ ] 有最大步骤/超时/取消
- [ ] Tool 调用全程可审计
- [ ] 失败能安全停止而非无限重试

### Browser Tools
- [ ] read/find/scroll/open/click/fill 等核心工具稳定
- [ ] elementId 生命周期正确
- [ ] 页面刷新后不会误操作旧元素

### Search
- [ ] AI 可通过统一 SearchProvider 查询
- [ ] 搜索结果可继续交给 Browser Agent 打开读取

### Permission
- [ ] 高风险动作无法无确认执行
- [ ] 网页文本无法提升 Tool 权限
- [ ] 无万能 shell/eval/filesystem 工具

### Engineering
- [ ] 全量验证通过
- [ ] 多个真实网站 Agent smoke test 通过
- [ ] Agent 操作日志无敏感信息

---

## 10. Exit Gate

进入 Fourth Stage 前：

- Agent 在常见搜索/阅读任务上不会频繁死循环；
- Tool API 已稳定到足以被 Sources/Research 复用；
- Permission Policy 可扩展；
- Prompt Injection 红队场景至少有基础测试；
- 没有通过放宽网页权限获得“成功率”的技术债。

完成后停止，不直接实现信源数据库。
