# Second_stage.md — AI 共读与当前网页对话

> 前置阶段：`First_stage.md`  
> 核心目标：在不破坏浏览器安全边界的前提下，让用户可以与 AI 围绕当前网页可靠地“共同阅读”。

## 1. 阶段定位

第一阶段已经解决：

**Browser → PageSnapshot → Browser Tool Interface**

第二阶段只解决：

**PageSnapshot / Selection → AI Context → Conversation**

阶段结束后，用户应可以：

- 正常浏览网页；
- 打开 AI 侧栏；
- 对当前网页提问；
- 对当前选中文字提问；
- 让 AI 总结、解释、比较当前页面内容；
- 看清 AI 回答使用了当前网页的哪些信息；
- 配置至少一种 LLM Provider；
- 安全保存 API Key。

本阶段**不实现自主浏览 Agent**。AI 可以读取当前页面，但不能自己连续搜索、点击、填写和跨网页执行任务。

---

## 2. Entry Gate

进入本阶段前，First Stage 至少满足：

- BrowserController、TabManager、SessionManager、PageReader 的稳定边界已经存在；
- PageSnapshot 在常见静态页和动态页上可稳定获取；
- elementId 生命周期和页面销毁错误处理已经明确；
- 远程网页与应用 UI 的权限隔离经过实际冒烟验证；
- 第一阶段全量 test / typecheck / lint / build / Electron smoke 通过；
- `progress.md` 无阻塞级浏览器核心缺陷。

若 PageSnapshot 实际效果不足以支撑 AI 共读，应先修复第一阶段，不得用“把整个 HTML 全塞给模型”绕过。

---

## 3. 本阶段目标

### 3.1 AI Side Panel

实现可收起的 AI 侧栏，至少支持：

- 新建/继续当前会话；
- 输入用户问题；
- 流式显示回答；
- 中止生成；
- 明确显示当前上下文模式：
  - 当前网页；
  - 当前选中文本；
  - 无网页上下文。

### 3.2 LLM Provider 抽象

建立供应商无关接口，例如概念上：

- provider id
- model id
- streaming
- tool-calling capability metadata
- context limit metadata
- request / response normalization

本阶段推荐只落地：

- 一个主要 Provider；
- 一个 OpenAI-compatible Provider（若实现成本合理）。

不得把业务逻辑绑定到某一家 SDK。

### 3.3 API Key 安全

要求：

- API Key 不写入源码、日志、prompt；
- API Key 不暴露给 renderer 中的远程网页；
- 使用 Windows 合理的安全存储方式，或建立可替换 SecureCredentialStore；
- 日志仅记录 provider / model / request id 等非敏感元数据；
- 错误信息不得把完整请求头或密钥打印出来。

### 3.4 Context Builder

建立确定性的 ContextBuilder：

输入可以包括：

- 用户问题；
- 当前 PageSnapshot；
- 当前 selection；
- 页面标题和 URL；
- 必要的附近文本；
- 对话历史。

输出为经过预算和裁剪的模型上下文。

必须：

- 对网页内容标记为 `UNTRUSTED_WEB_CONTENT`；
- 明确区分 System / User / Tool / Web Content；
- 不把网页文本当作系统指令；
- 有上下文长度预算；
- 对超长网页采用确定性裁剪或分块，而不是无限发送。

### 3.5 当前网页共读

至少支持典型场景：

- “总结这个页面。”
- “作者这里是什么意思？”
- “解释我选中的这段。”
- “这个表格主要说明什么？”
- “根据当前页面，列出关键数据。”
- “这段内容与页面前文是否矛盾？”

---

## 4. 非目标

本阶段不做：

- AI 自动搜索互联网；
- AI 自动创建/关闭大量标签页；
- AI 自动点击、填写、提交表单；
- 多步 Browser Agent；
- 收藏/信源库；
- SQLite 业务数据层（若仅为必要配置存储，不得借机扩展）；
- Research；
- RSS / Watch；
- 图表系统；
- 自动网页 Diff；
- 多 Agent 编排；
- 后台定时任务。

---

## 5. 建议模块边界

具体文件名进入本阶段后再定稿，但依赖方向建议为：

UI Chat
→ ConversationService
→ ContextBuilder
→ LLMProvider
→ SecureCredentialStore

其中网页上下文：

ContextBuilder
→ BrowserController.getPageSnapshot(...)
→ PageReader

禁止：

- LLMProvider 直接访问 webContents；
- React Chat UI 直接访问 API Key；
- 网页内容直接拼接进 system prompt；
- renderer 任意 IPC 调主进程。

---

## 6. Prompt Injection 基线

本阶段开始正式建立网页内容的信任边界。

至少要求：

- 网页正文明确标注为不可信数据；
- system prompt 明确声明网页文本不能覆盖系统/用户指令；
- 网页内出现“忽略之前指令”“调用工具”“发送数据”等内容时，只按被阅读文本处理；
- 当前阶段 AI 无浏览器写操作 Tool，因此网页内容不能触发真实操作；
- 为第三阶段 Browser Agent 预留安全事件日志和风险分类。

---

## 7. 对话与隐私

需要在详细设计阶段确定：

- 对话是否默认仅本地保存；
- 保存哪些消息；
- 是否保存网页快照；
- 是否支持“不保存当前会话”。

默认原则：

- 最小化持久化；
- 不为未来功能提前囤积网页内容；
- 用户明确删除后应可删除本地会话数据。

---

## 8. 测试重点

至少覆盖：

- ContextBuilder 对网页内容、用户内容、系统内容的角色隔离；
- 超长页面裁剪；
- selection 优先级；
- Provider 错误归一化；
- 流式中断；
- API Key 不出现在日志和错误；
- 页面销毁/切 Tab 时上下文不会串页；
- 恶意网页 Prompt Injection 文本不能提升权限。

---

## 9. 验收标准

### AI 配置
- [ ] 可配置至少一种 LLM Provider
- [ ] API Key 不进入源码、日志、网页或 prompt
- [ ] Provider 抽象不绑定业务逻辑

### 共读
- [ ] AI 可回答当前网页问题
- [ ] AI 可回答当前选中文本问题
- [ ] AI 可总结当前页面
- [ ] 切换 Tab 后上下文正确更新
- [ ] 页面刷新/销毁不会导致旧快照错误复用
- [ ] 超长页面有明确裁剪策略

### 安全
- [ ] 网页内容按不可信输入处理
- [ ] 网页 Prompt Injection 不能覆盖系统/用户指令
- [ ] 当前阶段 AI 不具备自主浏览写操作
- [ ] Renderer/远程网页无法读取 API Key

### Engineering
- [ ] test / typecheck / lint / build 全绿
- [ ] Electron 实际共读冒烟通过
- [ ] 日志可用于定位 Provider / Context 问题且无敏感信息

---

## 10. Exit Gate

只有以下条件满足后才进入 Third Stage：

- 当前网页共读在多个真实网站上稳定；
- API Key 安全方案已稳定；
- ContextBuilder 与 PageSnapshot 的边界明确；
- Prompt Injection 基线测试存在；
- 没有需要通过“给 AI 更多权限”才能掩盖的共读缺陷。

阶段完成后停止，更新 `progress.md`，提出 Third Stage 的详细设计任务，不直接实现 Browser Agent。
