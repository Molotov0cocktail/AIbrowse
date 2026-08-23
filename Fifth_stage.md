# Fifth_stage.md — 多源 Research、证据链与结构化展示

> 前置阶段：`Fourth_stage.md`（第四阶段总 Exit 判定 = `GO/PASS`，2026-08-16）。
> 核心目标：把 Browser Agent + Sources 组合成可靠的多源信息研究系统，并以可验证、可交互的形式展示结果。
> **阶段状态（2026-08-23）**：Fifth Stage 已完成，独立 Stage Auditor 已在
> 批准产品 HEAD 上逐项复验 §9 与 §10，结论为 `GO/PASS`。Entry Gate 证据表见
> `doc/stage5/proposal.md` §7；最终验收证据与判定见本文 §10、
> `doc/stage5/tasks/C10-finalize-acceptance.md` 和 `doc/tasks/progress.md`。
> 当前停止在 Fifth Stage，等待用户明确指令；不直接设计或实现 Sixth Stage。
> **真实 Provider 已于 2026-08-16 获
> 用户长期授权（决议 #117）**：C9/C10 真实验收无需逐次申请授权——凭据可用
> 即执行（仍须严格保护凭据，走仓库外 DPAPI/harness 受控流程）；凭据不可用
> 如实记录「凭据不可用」，不得写「未获授权」。
> **契约与安全契约源**：本文保留阶段需求源职责（目标/验收标准/Exit Gate），
> 具体接口、schema、状态机、预算与决议以 `doc/stage5/detailed-design.md` 为
> **唯一契约源**；威胁与红队以 `doc/stage5/threat-model.md` 为**安全契约源**。
> 任务里程碑 C1–C10 见 `doc/stage5/tasks/`。本文 §9/§10 需求边界不被详细
> 设计削弱（§9 验收与 §10 Exit Gate 保持原文，证据回填由 C10 实施）。

## 1. 阶段定位

这是产品从“AI 浏览器”真正升级为“AI 信息工作台”的阶段。

典型任务：

> “比较 GPT、Gemini、Claude 当前 Agent 能力，优先参考我的 AI Benchmark 信源，同时搜索必要的官方资料。”

系统应能够：

Sources
+ Web Search
+ Browser Agent
→ Source Selection
→ Read / Extract
→ Cross-check
→ Synthesis
→ Evidence
→ Structured Render

---

## 2. Entry Gate

要求：

- Browser Agent 的工具接口稳定；
- Sources 可可靠检索；
- 信源用户备注能参与选择；
- Tool 权限和 Prompt Injection 防护稳定；
- Source/Browser 数据都能产生可追踪来源标识。

---

## 3. 本阶段目标

### 3.1 Research Task

建立 ResearchTask 概念。

至少记录：

- 用户目标；
- 状态；
- 已使用 Sources；
- 搜索得到的候选来源；
- 成功/失败读取；
- 关键提取结果；
- 证据引用；
- 最终产物。

具体持久化粒度在本阶段详细设计中确定。

### 3.2 Source Selection Strategy

优先级建议：

1. 与用户任务高度匹配的已收藏 Sources；
2. 用户备注中明确“优先”的来源；
3. 官方/primary sources；
4. 搜索补充；
5. 必要的社区/论坛观点。

不得把“收藏”自动等同于“可信”。

### 3.3 多源获取

Research 可以：

- 搜索；
- 打开多个 task tabs；
- 读取多个网页；
- 从表格/正文提取结构化字段；
- 标记读取失败；
- 在结果冲突时保留冲突而不是强行平均。

需要明确 Research 使用的 Tab 与用户手动浏览 Tab 的隔离策略。

### 3.4 Evidence Model

每个重要结论应尽量能关联：

- source title
- URL
- access time
- 页面/字段/文本证据
- extract result
- source type / note（必要时）

UI 至少允许用户点击结论查看来源。

不得只输出：

> “AI 查到……”

### 3.5 Cross-check

建立最小交叉核验规则：

- 高影响事实尽可能多源；
- 厂商自述与第三方 benchmark 区分；
- 来源冲突明确展示；
- 没有足够证据时允许回答“不确定”。

不要用“来源数量”机械代替来源质量。

### 3.6 Structured Rendering

建立统一 Result Schema，由确定性 Renderer 负责 UI。

第一批建议：

- Markdown / rich text
- Table
- Cards
- Ranking
- Timeline

Chart 可作为本阶段后半部分或独立闭环加入。

AI 输出结构化 schema，不直接生成任意 HTML/CSS。

### 3.7 Data Table

表格至少支持：

- 排序；
- 基础筛选；
- 来源列/来源详情；
- 复制；
- CSV 导出（如果实现成本合理）。

XLSX 导出可留待后续，不作为本阶段硬要求。

---

## 4. Research 模式与普通对话区分

普通 Chat：

- 当前页共读；
- 少量 Tool；
- 快速回答。

Research：

- 明确任务状态；
- 允许多源；
- 更长时间和更多 Tool steps；
- 更严格 Evidence；
- 有失败/进度展示；
- 最终生成结构化结果。

两者不要共用一个无限复杂 Agent Loop。

---

## 5. 结果可信度表达

可以显示：

- 来源覆盖情况；
- 官方/第三方/社区构成；
- 是否存在冲突；
- 哪些字段来自单一来源；
- 数据获取时间。

避免生成虚假的数值型“可信度百分比”，除非未来有严谨定义。

---

## 6. 非目标

本阶段不做：

- 持续监控；
- RSS；
- 定时任务；
- 系统级后台服务；
- 自动购买/交易；
- 云端 Research 队列；
- 多用户协作；
- 大规模网页爬虫平台。

---

## 7. 关键体验验收

至少通过：

1. “只查看我的 AI Benchmark 分组，比较其中主流模型。”
2. “优先用收藏来源，再补充官方资料。”
3. “这几个来源说法冲突在哪里？”
4. “整理成表格。”
5. “切成卡片/排行榜展示。”
6. 点击表格某个关键结论能看到对应来源。
7. 某个网页读取失败时，Research 继续并明确记录失败。

---

## 8. 测试重点

- Research 状态机；
- task cancel/resume 边界（若支持 resume）；
- 多 Tab 隔离；
- Evidence 关联；
- 来源冲突；
- Renderer schema validation；
- 恶意模型输出不能注入任意 HTML；
- Tool failure；
- Source duplicate；
- 超长 Research context；
- 用户手动关闭 task tab；
- 导出内容与 UI 数据一致。

---

## 9. 验收标准

### Research
- [x] 可组合 Sources + Web Search
- [x] 可读取多个来源
- [x] 可处理来源失败
- [x] 可显示 Research 进度和停止

### Evidence
- [x] 重要结论可追踪来源
- [x] 来源冲突不会被静默抹平
- [x] 能查看 URL/时间/证据

### Rendering
- [x] 至少支持 Markdown/Table/Cards
- [x] 数据通过结构化 schema 渲染
- [x] 不执行模型提供的任意 HTML/JS

### UX
- [x] 快速 Chat 与 Research 模式区分清楚
- [x] Research Tabs 不严重干扰用户手动浏览

### Engineering
- [x] 全量测试/构建/冒烟通过
- [x] 真实多源任务验收通过

---

## 10. Exit Gate

进入 Sixth Stage 前：

- Research 在若干真实主题上能稳定完成；
- Evidence 已成为数据模型的一部分而非 UI 装饰；
- Sources + Search 的选择逻辑经过实际反馈；
- Renderer schema 稳定；
- Research 不依赖无限上下文或无限 Agent steps。

完成后停止，不直接实现持续监控。

**Exit Gate 判定（2026-08-23，独立 Stage Auditor）**：`GO/PASS`。

- Research 在 3 个真实主题上均稳定完成；真实 Provider 共 28 次 HTTP 调用，
  真 Key 九个检查表面零命中。
- Evidence 是 research.db、Result Schema、下钻视图和确定性校验链中的正式数据，
  不是 UI 装饰。
- Sources + Search 选择逻辑已由真实主题、聚焦测试和端到端场景共同复验。
- Renderer Schema、Markdown 安全子集、Table/Cards/Ranking 与 Evidence 下钻已稳定，
  任意 HTML/JS 仍被结构性拒绝。
- ResearchRuntime 保持有限预算；ToolRegistry 仍为 17 个工具、Research 仍为
  六工具只读子集，AgentLoop 仍为 12 步/420 秒。
- 独立复验结果：聚焦 2 files / 34 tests、全量 97 files / 2226 tests、
  typecheck/lint/format:check/build、默认 dev/production 冒烟、Session/Sources/
  Sources UI/Research 四组跨进程 set/check、8.13/B-05/8.19-B/8.20
  FRT-01～FRT-12 与离线隐私扫描全部通过。

真实主题 `conflicts=0` 仅是本次模型语义行为的观察，不证明系统能识别所有语义冲突，
也不构成 Prompt Injection 或综合正确性的完全免疫声明。Fifth Stage 至此完成并停止；
等待用户下一步指令，未进入 Sixth Stage。
