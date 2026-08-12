# AIbrowse 后续阶段路线图

> 本文件描述 `First_stage.md` 之后的稳定产品路线。  
> 原则：**阶段目标、边界、验收标准现在固定；具体接口签名、数据库 schema、Tool 参数、UI 细节在进入对应阶段后，根据上一阶段实际运行结果再定稿。**

## 总体产品目标

AIbrowse 是一个 Windows 桌面「AI 信息浏览器 / AI Information Browser」：

- 用户在内置 Chromium 浏览器中正常浏览互联网；
- AI 与用户共享同一个浏览器会话、页面状态和登录状态；
- AI 可以读取当前网页的结构化信息，与用户边读边讨论；
- AI 只能通过受限 Tool Layer 操作浏览器，不拥有任意系统权限；
- AI 可以使用搜索引擎和用户长期维护的信源库进行多源研究；
- 信源可分组、打标签、设置优先级并附带用户自然语言备注；
- 用户可通过自然语言让 AI 自动添加、修改或整理信源；
- Research 结果必须保留证据链，并可结构化展示为表格、卡片、时间线、图表等；
- 后续支持 RSS、网页 Diff、监控、通知和摘要；
- 最终形成可长期使用、可发布的 Windows EXE 产品。

---

## 阶段总览

| 阶段 | 核心目标 | 阶段结束后的关键能力 |
|---|---|---|
| First Stage | Browser → PageSnapshot → Browser Tool Interface | 安全可运行的浏览器核心，可结构化读取当前网页 |
| Second Stage | AI Co-reading | 用户可与 AI 围绕当前网页、选中文本进行可靠共读 |
| Third Stage | Browser Agent | AI 可通过安全 Tool Layer 自主搜索、浏览和执行低风险网页操作 |
| Fourth Stage | Sources | 建立长期信源库，AI 可通过自然语言管理、分类、检索信源 |
| Fifth Stage | Research & Rendering | AI 可完成多源研究、交叉核验、证据引用和结构化展示 |
| Sixth Stage | Watch / RSS | 信源可持续更新，支持 RSS、网页 Diff、监控规则和摘要 |
| Seventh Stage | Product Hardening & Release | 安全、性能、稳定性、安装包、升级与发布闭环 |

---

## 阶段切换原则

1. 不因“上一阶段基本能用”就自动进入下一阶段。
2. 每一阶段必须满足自己的 Exit Gate。
3. 进入新阶段前必须：
   - 阅读 `AGENTS.md`、当前阶段 md、`doc/tasks/progress.md`；
   - 核对 Git、代码、测试和实际运行状态；
   - 对上一阶段遗留风险分级；
   - 只有不阻塞下一阶段的风险才允许延期。
4. 如果实际运行证明原路线某个假设错误：
   - 可以修改后续阶段文档；
   - 必须记录理由和影响；
   - 不得为了遵守旧文档而保留明显错误设计。
5. 后续阶段文档是“需求和边界”，不是提前写死的详细设计。

---

## 横贯所有阶段的固定红线

- 远程网页始终是不可信输入。
- 远程网页不得直接获得 Node.js、Electron、文件系统、数据库、密钥或 AI Tool 权限。
- AI 不得获得任意 shell、任意 JavaScript、任意文件系统写入等无限能力。
- LLM API Key 不进入 prompt，不暴露给网页。
- Tool 权限按风险分级；高风险行为必须由确定性程序拦截并要求用户确认。
- 不以关闭 Electron 安全机制、放宽 TypeScript、删除测试、吞掉错误等方式换取“能跑”。
- 所有 AI 结论应尽可能保留来源和可追溯证据。
- 数据库、日志、快照不得无控制收集敏感用户数据。
- 一个新对话约等于一个可验证开发闭环。

---

## 关于未来细节的约束

以下内容**不应在当前路线图阶段提前固定**，必须等进入对应阶段后根据实际工程状态定稿：

- Browser Tool 的最终 JSON Schema；
- PageSnapshot 的最终字段集合；
- Agent planner / executor 的具体实现方式；
- LLM SDK 与供应商适配细节；
- SQLite 的最终表结构与 migration；
- Source ranking 的具体算法；
- Research 多 Agent / 单 Agent 方案；
- 页面 Diff 算法与调度策略；
- 图表库和富文本渲染器的最终选择；
- 自动更新框架、签名和发布渠道。
