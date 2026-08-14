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

> 状态：S6 最终验收（2026-08-13）逐项核对通过，证据见各条目注释与
> `doc/tasks/progress.md`「最近验证结果 · S6」。冒烟矩阵编号见
> `doc/stage2/detailed-design.md` §13.2。

### AI 配置
- [x] 可配置至少一种 LLM Provider——ProviderSettings UI + `config:providers:*` 通道（S4，矩阵 10）；
      真实 Provider（openai-compatible）经真实配置路径完成 S6 多网站验证 7 次真实调用
- [x] API Key 不进入源码、日志、网页或 prompt——§12.1 边界 7 + S5 审计 + S6 多网站场景真 Key
      零暴露扫描（DOM/日志/全部临时文件/密文形态断言）；全仓库 grep 无真实 Key 形态
- [x] Provider 抽象不绑定业务逻辑——LLMProvider 接口 + 工厂注册表 + 错误归一化（S1）；零厂商
      SDK（运行时依赖仅 react/react-dom；SSE 原生 fetch 自实现）

### 共读
- [x] AI 可回答当前网页问题——S6 多网站验证文章页提问①（真实调用 complete）+ 离线矩阵 1/3
- [x] AI 可回答当前选中文本问题——S6 selection 提问（mode=selection + selectionExcerpt 独占 +
      追溯卡片）+ 离线矩阵 2
- [x] AI 可总结当前页面——S6 文章页提问②与长文页总结（真实调用均 complete）
- [x] 切换 Tab 后上下文正确更新——S6 切 Tab 提问（url/tabId/capturedAt 更新 + 旧页标记词不串入）+
      离线矩阵 3
- [x] 页面刷新/销毁不会导致旧快照错误复用——S6 刷新后提问 capturedAt 严格递增 + 离线矩阵 3
      （刷新三断言 + 关闭活动 Tab 后快照为空白页）
- [x] 超长页面有明确裁剪策略——context-budget 42 用例确定性裁剪 + S6 长文页真实验证
      （visibleText 超 12000 章节上限 → 裁剪 warnings + 回答仍可用）

### 安全
- [x] 网页内容按不可信输入处理——UNTRUSTED_WEB_CONTENT 块 + `</` 闭合转义 + 常量 system
      （S2 30 用例 + 矩阵 11 注入夹具）
- [x] 网页 Prompt Injection 不能覆盖系统/用户指令——§12.1 七项结构性边界（S5 审计 + 注入夹具
      5 断言）；语义层剩余风险登记为已接受的剩余设计风险（progress.md，不宣称免疫）
- [x] 当前阶段 AI 不具备自主浏览写操作——全仓库 grep 无 click/fill/scroll/写 Tool/写通道；
      ProviderRequest 无 tools 字段（S5/S6 复验）
- [x] Renderer/远程网页无法读取 API Key——bridge 只写不回读（白名单无 get 通道）+ 远程隔离
      探针 + 矩阵 10（DOM/日志字节扫描 + credentials.json 密文）

### Engineering
- [x] test / typecheck / lint / build 全绿——S6 复跑：test 326/326 · typecheck · lint ·
      format:check · build 全部通过
- [x] Electron 实际共读冒烟通过——dev 离线全矩阵 + 生产产物冒烟 + 真实 Provider 多网站验证
      （全部退出码 0；冒烟期间修复 30s 兜底定时器缺陷，见 progress.md S6）
- [x] 日志可用于定位 Provider / Context 问题且无敏感信息——日志链含 requestId/provider/model/
      mode/url/耗时/status；logger 脱敏 + 错误归一化脱敏用例 + 真 Key 零暴露扫描

---

## 10. Exit Gate

只有以下条件满足后才进入 Third Stage：

- 当前网页共读在多个真实网站上稳定；
- API Key 安全方案已稳定；
- ContextBuilder 与 PageSnapshot 的边界明确；
- Prompt Injection 基线测试存在；
- 没有需要通过“给 AI 更多权限”才能掩盖的共读缺陷。

> **Exit Gate 判定：通过（2026-08-13，S6 最终验收）**。逐项证据：
>
> 1. **真实网站共读稳定**：S6 真实 Provider 多网站验证（`AIBROWSE_LIVE_SITES=1`，完整生产
>    链路 UI → IPC → ConversationService → ContextBuilder → OpenAI-compatible → 流式 → DOM）——
>    MDN 普通文章页（正文提问 + 总结）、wangdoc 长文教程页（visibleText 超章节上限 →
>    确定性裁剪 warnings + 回答可用）、w3school.com.cn 表格页（数据表提取）、selection 独占
>    （选中段落后提问）、切 Tab 与刷新（url/tabId/capturedAt 更新 + 旧页标记词不串入）。
>    7 次真实调用全部 complete（最终运行退出码 0；前三次运行分别暴露并修复长文站点夹具、
>    冒烟 30s 兜底定时器、表格页对照组断言三处冒烟级问题，均非共读业务缺陷）。
> 2. **API Key 安全方案稳定**：S5/S6 两次真实运行真 Key 零暴露扫描通过（DOM/日志/临时文件/
>    密文形态）；DPAPI 密文落盘、只写不回读、损坏容错与不可用降级均有单测与运行时证据。
> 3. **ContextBuilder 与 PageSnapshot 边界明确**：唯一契约源 detailed-design §3.2/§7/§12
>    （决议 #11–#13）；两模块纯函数零环境依赖、独立单测（72 + 46 用例），无跨层依赖。
> 4. **Prompt Injection 基线测试存在**：detailed-design §12.1 七项结构性边界全部自动化
>    （单测恒等断言 + 注入夹具 + 冒烟矩阵 11 五断言 + 全仓库 grep 断言），S5 审计 + S6 复验。
> 5. **无「给 AI 更多权限」才能掩盖的共读缺陷**：验收期间发现的缺陷均为冒烟夹具/时序问题
>    （修复不涉及任何权限变化）；无阻塞级缺陷。语义层注入剩余风险登记为已接受的剩余设计
>    风险（progress.md），Third Stage 引入 Browser Tool 前必须重建威胁模型（最迟复核点）。
>
> > Second Stage 已完成内部验收（2026-08-13）；用户独立复验（2026-08-14）发现的
> > 4 项非阻塞测试基础设施/文档缺陷已修复并全量回归（红态退出码 1 → 绿态 0）。
> > 2026-08-14 经用户指令正式切换至 Third Stage（Entry Gate 核验记录见
> > doc/stage3/proposal.md §8）。

阶段完成后停止，更新 `progress.md`，提出 Third Stage 的详细设计任务，不直接实现 Browser Agent。
（Third Stage 已按本节建议执行：设计定稿与任务拆分见 `doc/stage3/`，实现任务 A1–A8
——2026-08-14 实施前校正由 T1–T8 改编号，见 doc/stage3/proposal.md §11。）
