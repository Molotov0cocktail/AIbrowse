# AIbrowse 第五阶段 Proposal — 多源 Research、证据链与结构化展示

> 需求源：根目录 `Fifth_stage.md`（阶段总任务）。本文档把总任务收敛为可验收的
> 阶段提案（纯文档设计闭环，2026-08-16；**不含任何产品代码、不安装任何依赖**）。
> 前置：第四阶段总 Exit 判定 = `GO/PASS`（2026-08-16，第五轮真实 Provider 验收
> 通过后改判，证据见 `Fourth_stage.md` §10 与 B9 任务文档）+ 用户正式下达
> Fifth Stage 切换指令（2026-08-16，本提示）。
> 里程碑 C1–C10 由本提案配套的 `doc/stage5/tasks/C1–C10` 任务文档单独管理。
> 任务编号采用 **C1–C10**（避免与第一阶段 T0–T5、第二阶段 S1–S6、第三阶段
> A1–A8、第四阶段 B1–B9 重名）；威胁编号 **FT-01～FT-17**、红队编号
> **FRT-01～FRT-12**（不与历史 T-XX / ST-XX / SRT-XX / RT-XX / R-XX 混淆）。
> 与既有文档的关系：`doc/stage2/`、`doc/stage3/`、`doc/stage4/` 为第二、三、
> 四阶段定稿（不改写、不覆盖）；本阶段契约源为 `doc/stage5/detailed-design.md`，
> 安全契约源为 `doc/stage5/threat-model.md`（先于任何 Research 实现定稿）。

## 1. 目标

把 Browser Agent + Sources 组合成**可靠、可审计、可验证展示的多源信息研究系统**：

- **ResearchTask**：用户目标驱动的显式任务（状态机 + 进度 + 停止 + 终态），
  与普通 Chat/AgentLoop 明确分离（Fifth_stage.md §4）；
- **Source Selection**：Sources 检索 + Web Search 候选合并（同 URL 合并身份、
  保留双发现路径）+ provenance 继承 + 确定性排序（Fifth_stage.md §3.2）；
- **多源获取**：task-owned Tab 隔离（与用户手动浏览 Tab 明确隔离）+
  有界并发 + 读取失败标记继续（Fifth_stage.md §3.3）；
- **Evidence Model**：每条重要结论可追踪 URL/标题/主进程 access time/
  documentId/受控 locator/有限 excerpt/验证状态（Fifth_stage.md §3.4）；
  模型只能**提出引用**，确定性程序**验证引用**；
- **Cross-check**：多源覆盖、厂商自述/第三方区分、冲突显式保留、「不确定」
  正式输出；禁止来源数量代替质量、禁止虚构可信度百分比（Fifth_stage.md
  §3.5/§5）；
- **Structured Rendering**：统一 Result Schema（闭合判别联合 + 字段白名单），
  确定性 Renderer 渲染 Markdown/Table/Cards/Ranking；模型不生成任意
  HTML/CSS/JS（Fifth_stage.md §3.6）；
- **Data Table**：排序/基础筛选/来源详情/复制 + CSV 导出（经主进程安全通道，
  公式注入防护）（Fifth_stage.md §3.7）；
- **全程确定性预算**：来源数/候选数/并发 Tab/页读取/Evidence/上下文/模型轮次/
  工具步数/时长/结果字节/持久化字节全部有界（Fifth_stage.md §10）。

核心原则（继承第三/四阶段）：**AI 决定「需要做什么」；确定性程序决定「是否允许、
如何执行、执行结果是什么」**。第五阶段新增：**模型只能提出引用与结论，来源存在
性、捕获归属、摘录真实性、schema 合法性全部由确定性程序验证；引用未经验证不得
渲染为证据。**

## 2. 非目标（本阶段明确不做）

- 多 Agent 编排 / Planner-Worker 架构（v1 单一专用 ResearchRuntime，接口
  预留替换点）；
- 持续监控、RSS、Watch、Diff、后台定时任务（Sixth Stage）；
- Timeline、Chart/图表系统（本阶段后半或独立闭环再评估；Fifth_stage.md §3.6
  仅「Chart 可作为本阶段后半部分」的许可，v1 任务拆分不含）；
- 跨重启续跑（resume）：运行中任务重启后标 `interrupted`，可重新开始；
- 无限上下文/无限 Agent steps（Fifth_stage.md §10 明确禁止；独立有界
  ResearchRuntime，不改 AGENT_MAX_STEPS）；
- 云同步、多设备、账号系统；embedding/向量数据库；
- 任意 SQL、任意文件系统、任意 HTTP POST、任意 shell/eval/JS（永久红线
  保持）；CSV 导出仅经主进程 dialog 安全通道，不新增 Agent 工具；
- 把「收藏/优先级/用户备注」自动等同「可信」（Fifth_stage.md §3.2）；
- 静态加密承诺（Research 库与 Sources 库同为 v1 本地明文，如实说明）；
- Sixth Stage 代码。

## 3. 用户与场景（Fifth_stage.md §7 关键体验验收 + §1 典型任务）

1. 「只查看我的 AI Benchmark 分组，比较其中主流模型。」→ 分组过滤候选 →
   读取 → Table 结果 + Evidence 下钻；
2. 「优先用收藏来源，再补充官方资料。」→ 排序档位（收藏命中 > 官方 >
   搜索补充，但不虚构可信度）；
3. 「这几个来源说法冲突在哪里？」→ Conflict 数据模型 + 冲突视图；
4. 「整理成表格。」→ Table 块（排序/筛选/复制/CSV）；
5. 「切成卡片/排行榜展示。」→ Cards / Ranking 块；
6. 点击表格某个关键结论能看到对应来源 → Evidence 下钻（URL/时间/摘录/验证态）；
7. 某个网页读取失败时，Research 继续并明确记录失败 → 读取失败标记 +
   失败继续（failedReadCount 统计与进度展示）。

典型任务（Fifth_stage.md §1）：「比较 GPT、Gemini、Claude 当前 Agent 能力，
优先参考我的 AI Benchmark 信源，同时搜索必要的官方资料。」

## 4. 输入 / 输出

- **输入**：用户研究目标（goal，≤2000 字符确定性截断）；Sources 库（经既有
  `SourceService.search/list/get`，audience='agent' 有界检索）；Web Search
  （经既有 `SearchProvider.search`）；网页内容（经既有
  `BrowserController.getPageSnapshot` / browser_read 语义，实时采集）；
  LLM 结构化提议（候选选择意图、证据引用、Result Schema 草案）。
- **输出**：ResearchTask 状态与进度事件；验证后的 Evidence 集合（含
  verification 状态）；ResearchResult（Result Schema，确定性验证通过）；
  Renderer 渲染的结构化视图（Markdown/Table/Cards/Ranking）；CSV 导出文件
  （用户选定路径）；审计条目（脱敏）；Research 库持久化（有界字节预算）。

## 5. 外部依赖

- 既有技术基线（AGENTS.md §1 冻结）不变；**本设计闭环不新增任何 npm 依赖**。
- 决策 9 渲染库官方资料核查结论（2026-08-16，本会话只读评估）：
  - `react-markdown` v10：MIT；raw HTML 默认禁用/转义（`rehype-raw` 需显式
    开启且官方标注危险）；`urlTransform` 自定义实现不当会开 XSS；依赖
    unified/remark/rehype 生态（约 10 个传递依赖）。
  - `marked`：MIT；**官方明确声明不净化输出 HTML**（需自行接 DOMPurify 等
    净化库），2026 年多起真实 XSS 事件与净化顺序错误相关。
  - **结论：本阶段不引入任何渲染库**——自实现受控 Markdown 子集渲染器
    （纯函数解析 + React 组件，零新依赖；模型输出视为敌手，渲染前必经
    ResultValidator）。备选迁移路径保留在案（渲染器接口隔离，若未来需求
    超出子集再评估 react-markdown）。
- Research 存储复用第四阶段冻结的 `node:sqlite` driver 模式（决议 #48）：
  独立 `research.db` + 独立 migration 列表（不修改 sources.db 的 schema v1）。
- 真实 Provider 验证沿用既有凭据流程（仓库外 DPAPI harness + 环境变量注入 +
  真 Key 零暴露扫描；不设固定调用次数）——C9 门控与 harness 扩展。

## 6. 约束与假设

- **架构纪律**（第五阶段依赖方向，不可反向或跳跃，详细设计 §1）：
  ```
  Research UI → ResearchService → ResearchRuntime
    → SourceSelector / ResearchWorkspace / EvidenceValidator / ResultValidator
    → SourceService / BrowserController / SearchProvider / LLMProvider
    → ResearchRepository（独立 research.db）
  Renderer 只消费已验证 Result Schema；不得访问 BrowserController、
  SQLite、Electron 或 Provider。
  ```
- **Research 工具只经受限服务执行**：不新增 shell/eval/任意 JS/任意文件/
  任意网络/任意 SQL 工具；读取复用既有 browser_read 语义（L0），打开复用
  browser_open（L1 既有权限）；无「关闭用户 Tab」工具（任务 Tab 由
  ResearchWorkspace 按所有权清理，用户 Tab 永不关闭）。
- **安全红线**（全部保持 + 本阶段新增）：第三/四阶段 threat-model 结构性边界
  与六类残余风险全部继承；`doc/stage5/threat-model.md` 为安全契约源；
  Evidence 确定性验证；Result Schema 白名单；渲染 raw HTML 关闭；
  CSV 公式注入防护；Research 库字节预算。
- **TypeScript / 质量门槛 / 提交纪律**：与既往阶段相同（AGENTS.md §3）；
  技术基线冻结延续。
- **假设**：单窗口单用户；Research 任务串行执行（同一时刻至多 1 个 running
  任务，v1）；Sources 库 normal 态才可启动 Research（恢复态拒绝并中文诊断）；
  确认等待计入 Research 总超时；Research 库由主进程单连接持有。

## 7. Entry Gate 核验记录（2026-08-16，本会话独立核验，按 Fifth_stage.md §2 五项）

证据基线：本地 HEAD `6d730a6` = Gitee main = GitHub main（`git ls-remote`
实测三方一致，GitHub 经 127.0.0.1:7890 代理确认可用）；工作区干净；基线
test 1255/1255（单 worker）· typecheck · lint · format:check 独立复跑全绿；
第四阶段 §10 八项全部 PASS（2026-08-16 第五轮真实 Provider 验收：场景 1a–8
全部真实通过 + 真 Key 零暴露扫描通过，总 Exit = GO/PASS）。

| #   | Fifth_stage.md §2 要求                  | 核验结论 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Browser Agent 工具接口稳定              | ✅ 通过  | 17 工具注册表（8 只读导航 + 4 交互 + search_web + 4 Source 工具）自 A6 起契约零变更，B 系列仅新增零破坏；本会话 `grep -n "^export"` 核对 tool-registry/tool-executor/browser-tools/interaction-tools/search-tool/source-tools 签名与 AGENTS.md §5 一致；第三阶段 GO/PASS + 第四阶段真实 Provider 验收场景 1a–8 通过（34 次 HTTP 全部 200）；AGENT_MAX_STEPS=12 / AGENT_TOTAL_TIMEOUT_MS=420s 为第三阶段冻结契约（agent-loop.ts:37-38） |
| 2   | Sources 可靠检索                        | ✅ 通过  | B3 已实现 FTS5 trigram 主路径 + 短查询安全降级 + 硬上限 10/每页 20/allowlist/分享模式（source-service.ts / source-search-query.ts 在位）；第四阶段真实 Provider 场景 5（source_search → browser_open → browser_read → usage=reachable）真实通过                                                                                                                                                                                        |
| 3   | 信源用户备注能参与选择                  | ✅ 通过  | note 参与检索命中（FTS/LIKE 路径）与排序（决议 #61：note 为最低档位、档位内有限度）；shareMode=full 时命中附 ≤200 摘录 + provenance；真实 Provider 场景 2（改组与备注 shareMode=full）真实通过                                                                                                                                                                                                                                         |
| 4   | 权限与 Prompt Injection 防线稳定        | ✅ 通过  | 五层防线（结构/能力/决策/审计/运行时）+ 权限矩阵编译期常量（decide 纯函数）；SRT-01～SRT-12 机器断言 dev+生产通过 + RT-01～08+RT-11 回归通过 + 真实 SRT-01/02 与 RT-10 观察场景实际到达（2026-08-16 第五轮，结构断言全部通过）                                                                                                                                                                                                         |
| 5   | Source/Browser 数据能产生可追踪来源标识 | ✅ 通过  | Source 有 id/scope/canonicalKey/url/provenance 三元组；Browser 数据有 PageSnapshot meta（capturedAt/readyState/documentId 主进程盖章）+ TabInfo.url/title                                                                                                                                                                                                                                                                              |

**结论：Entry Gate 五项全部通过，无阻塞项。** Research 自身能力（候选合并、
Evidence 验证、Result Schema、Renderer）属第五阶段交付物，由 C1–C10 按
「威胁模型先于实现定稿」+「C1 契约基座先行」纪律落地。

## 8. 遗留风险分级（2026-08-16，按 ROADMAP.md 阶段切换原则第 3 条重新评估）

### 8.1 阻塞 Fifth Stage 的项

**无**（Entry Gate 五项全过；§7 证据表）。

### 8.2 Fifth Stage 必须吸收的项（本阶段设计/威胁模型必须纳入）

| 项                                                         | 吸收方式                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-3 ConversationStore 无字节上限                          | **不得机械延期**：Research 的 Evidence/运行记录/Result 一律不进入会话 JSON——独立 ResearchRepository（research.db）承载，独立字节预算（单任务持久化 ≤500k 字符、保留任务 ≤30 个、清理策略），详细设计 §9；会话侧仅挂任务 id 引用 |
| 第四阶段六类 Prompt Injection/长期资料污染残余风险         | 全部继承并扩展为第五阶段威胁模型（FT-01～FT-17）：网页/Source note 对**研究规划与综合结论**的注入成为真实攻击面（威胁模型 §2/§3）；红队矩阵 FRT-01～FRT-12（C9 实施）                                                           |
| AgentLoop 固定 12 步/420s 不适合直接扩成 Research 无限循环 | 决策 D2：独立有界 ResearchRuntime；AgentLoop 契约（12/420s）**保持不变**（回归断言），Research 有自己的预算集合（详细设计 §6）                                                                                                  |
| SearchProvider snippet 恒空                                | 候选排序与预览**不依赖 snippet**（排序键 = 来源档位 + 确定性键）；需要摘要时由 C4 读取页面后在 capture 阶段生成受控摘要（宁缺勿错原则延续）                                                                                     |
| CitationCard 只有会话轮次级来源，无结论级 Evidence         | 本阶段新 Evidence 数据模型 + 结果画布 Evidence 下钻（C1/C8）解决；CitationCard 保持既有语义不重写                                                                                                                               |
| ConversationStore 不持久化快照正文                         | 正面沿用：Research capture 正文**同样不持久化**——只持久化内容哈希 + 摘要元数据；Evidence 验证在运行期内存内完成（详细设计 §5）                                                                                                  |
| PageSnapshot 主文档/扁平结构限制                           | Research 提取沿用既有快照采集（不新建采集通道）；表格坐标/字段路径 locator 以快照结构为准；限制在 threat-model §6 与 README 已知限制如实登记                                                                                    |

### 8.3 可延期至 Seventh Stage 的项

| 项                          | 判定                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-2 日志无大小/保留上限    | 通用基础设施硬化，仍归 Seventh Stage；但 Research 侧日志纪律（不记正文/Evidence 摘录/URL query 值/结果全文，仅元数据）作为 threat-model FT-16 防线在本阶段落地 |
| P2-4 Vitest 未固化单 worker | 验证基础设施；不命中本阶段 Exit Gate；验证纪律显式 `--maxWorkers=1` 延续；若任一 C 系列实现任务顺手固化（vitest.config 一行）须在其任务闭环内单独验证          |
| P3 冒烟耗时                 | 效率非正确性；但 C 系列冒烟必须**不显著加重默认矩阵**（新场景编号独立、断言不重复完整运行既有矩阵，延续决议 #93 纪律）                                         |

### 8.4 纯文档/环境卫生项（本轮闭环内处置）

- progress.md「当前阶段」仍为 Fourth Stage、「下一个推荐任务」仍是已完成的
  场景 6/7 修复 → 本轮同步（任务表增 C1–C10、下一推荐任务唯一 = C1；历史
  记录保留）；
- AGENTS.md 阶段指针/接管顺序/步骤链 Third・Fourth 表述/Sources 契约标题
  「B9 未实现」→ 本轮同步；
- README.md 顶部当前阶段 → 本轮同步；
- package.json.description 仍写「第一阶段」→ 改为不含阶段号的产品级描述
  （避免每阶段漂移）；
- 根目录 `aibrowse-2026-08-15.log`（74,823 字节，2026-08-15 23:51）：
  核验为测试/冒烟运行生成的 CWD 杂散日志（内容含 vitest runner 堆栈与
  冒烟假 ID；sk-/Bearer 形态扫描零命中；`.gitignore` 已有
  `/aibrowse-*.log` 模式），属过期残留 → 本轮按项目清理纪律**精确删除
  该单一文件**并报告（不动 `log/` 中仍可能用于排障的日志）。

## 9. 验收标准映射（Fifth_stage.md §9 → 本阶段测试落点）

完整清单见 Fifth_stage.md §9（设计定稿后由 C10 逐项勾选回填证据）；映射见
`doc/stage5/detailed-design.md` §13 测试规格与 §14 验收核对清单（C10 实施）：

- **Research**：可组合 Sources + Web Search → C3/C4/C9；可读取多个来源 →
  C4；可处理来源失败 → C4/C5；可显示进度和停止 → C5/C8；
- **Evidence**：重要结论可追踪来源 → C1/C4/C6；冲突不静默抹平 → C6；
  可查看 URL/时间/证据 → C7/C8；
- **Rendering**：Markdown/Table/Cards → C7/C8；结构化 schema 渲染 → C7；
  不执行模型提供的任意 HTML/JS → C7/C9（FRT 红队）；
- **UX**：快速 Chat 与 Research 模式区分 → C8；Research Tabs 不严重干扰
  用户手动浏览 → C2/C8；
- **Engineering**：全量测试/构建/冒烟 → 每个任务闭环；真实多源任务验收 →
  C9（需用户另行授权真实 Provider）。

## 10. 决策表（2026-08-16 定稿；选项 / 推荐 / 理由 / 影响）

| #   | 决策点                          | 选项                                                                                           | 推荐                                                                                                                                                                                                                                 | 理由                                                                                                                                                                                                                                                                                                             | 影响                                                                                                                                                |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Research 执行架构               | A 多 Agent 编排；B 单一专用 ResearchRuntime；C 复用 AgentLoop                                  | **B**                                                                                                                                                                                                                                | Fifth_stage.md §4 禁止共用无限复杂 Agent Loop；多 Agent 引入编排协调器/共享状态/成本爆炸，且 ROADMAP 明确「Research 多 Agent/单 Agent 方案」留待本阶段定稿——单 Agent 是最小可审计闭环；C 破坏 12/420s 契约                                                                                                       | ResearchRuntime 接口预留替换点（多 Agent 未来不需推翻数据模型）；v1 不做多 Agent                                                                    |
| D2  | Research 与 Chat/AgentLoop 边界 | A 提高 AGENT_MAX_STEPS 复用；B 独立有界 ResearchRuntime                                        | **B**                                                                                                                                                                                                                                | 禁止只提高步数后复用一个无限复杂循环（用户指令明令）；12/420s 是第三阶段验收契约                                                                                                                                                                                                                                 | AgentLoop 契约零改动（回归断言固化）；Research 预算集合独立（§6）                                                                                   |
| D3  | 持久化粒度/取消/崩溃恢复        | A 全量持久化支持跨重启续跑；B 元数据+Evidence+Result 持久化、v1 不承诺续跑；C 全内存           | **B**                                                                                                                                                                                                                                | 完整快照/模型思维/无限 transcript 不持久化（隐私 + P2-3 无界增长教训）；跨重启续跑需重建 Tab/浏览器态与 transcript，成本高；支持取消；运行中任务重启后标 interrupted 可重新开始                                                                                                                                  | research.db 只存任务元数据/验证后 Evidence/最终 Result；capture 正文不落盘                                                                          |
| D4  | Task Tab 所有权与隔离           | A 与用户共享 Tab 空间；B task-owned 专用 Tab + 精确 tabId 所有权                               | **B**                                                                                                                                                                                                                                | Fifth_stage.md §3.3 明确要求隔离；决议 #32 已建立精确 tabId 所有权模式；用户 Tab 永不关闭                                                                                                                                                                                                                        | ResearchWorkspace 管理 Tab 集合：并发 Tab ≤3、单 running 任务、finally 清理只关本任务创建的 Tab；用户关闭 task Tab → 读取失败继续                   |
| D5  | Evidence 锚点                   | 见详细设计 §5 字段集                                                                           | **确定性验证**：模型只提引用，程序验证来源存在/捕获属于当前任务/excerpt 与表格坐标确实来自捕获内容                                                                                                                                   | 引用未经验证不得渲染为证据；否则「AI 查到…」式无来源结论（Fifth_stage.md §3.4 明令禁止）                                                                                                                                                                                                                         | EvidenceValidator 纯函数 + capture 内容索引；excerpt 规范化子串匹配；表格坐标行列边界校验                                                           |
| D6  | 候选去重与 provenance           | A 按 URL 全量合并；B 同 URL 合并身份 + 保留两条发现路径                                        | **B**                                                                                                                                                                                                                                | 同一 URL 从 Sources 与 Search 同时出现时合并为一个候选、`discoveredVia: ['sources','search']`；收藏/priority/用户备注**不得自动等同可信**；official/primary 的 asserted/unverified 语义从 Source trust 三元组继承；Search 发现的候选无 trust 断言                                                                | SourceSelector 合并键 = normalizeSourceUrl；同 origin 不同 page 不合并（可标记 related）                                                            |
| D7  | Cross-check 与冲突模型          | 见详细设计 §7                                                                                  | Claim/Coverage/sourceTypes/Conflict/Uncertainty 进入数据模型；**禁止**来源数量代替质量、虚构百分比（Fifth_stage.md §5）                                                                                                              | 高影响事实多源覆盖、厂商自述/第三方区分、单源字段显式标注、冲突显式展示、「不确定」正式输出类型                                                                                                                                                                                                                  | C6 数据模型 + 合成提示词 + 冲突视图（C8）                                                                                                           |
| D8  | 结构化输出协议                  | 见详细设计 §8                                                                                  | Result Schema = 闭合判别联合 + 字段白名单；模型不得生成任意 HTML/CSS/JS；**Markdown/Table/Cards/Ranking 进 v1**（§9 Rendering 硬要求 Markdown/Table/Cards + §7 场景 5 排行榜）；**Timeline/Chart 非目标**（明确延期）                | 字段白名单让恶意输出无处遁形；Ranking 由体验验收要求；Timeline/Chart 无硬要求                                                                                                                                                                                                                                    | ResultValidator 逐块校验（结构/长度/evidenceId 存在性/URL 安全）；校验失败语义 fail-closed（详细设计 §8.4）                                         |
| D9  | Renderer 技术与安全             | A react-markdown；B marked+净化；C 自实现受控 Markdown 子集                                    | **C**                                                                                                                                                                                                                                | 官方资料核查（§5）：react-markdown 需 ~10 传递依赖（与四阶段零新依赖纪律冲突）；marked 官方不净化输出（历史 XSS 教训）；自实现子集（标题/强调/列表/引用/行内代码/代码块/链接白名单/表格）零依赖、转义完全自控、与 UNTRUSTED 块同族纪律一致；**raw HTML 关闭、URL 仅 http/https、纯文本渲染兜底**（任何选项共通） | C7 纯函数解析器 + React 组件；渲染器接口隔离（未来换库不推翻契约）；本轮不安装任何依赖                                                              |
| D10 | Research UI 位置                | A 380px 侧栏放全部；B 侧栏控制/进度 + 独立大结果画布                                           | **B（主窗口内全宽覆盖视图，不新开 BrowserWindow）**                                                                                                                                                                                  | 380px 侧栏不适合复杂表格（长期 UI 架构决策）；新开窗口引入多窗口 IPC 复杂度与 Tab 布局干扰；主窗口内 viewMode 切换可复用既有 IPC/bridge                                                                                                                                                                          | App 增 viewMode: 'browser' \| 'research-result'；侧栏 ResearchPanel（380px 同模式）承载控制/进度；结果画布承载 Table/Cards/Ranking 与 Evidence 下钻 |
| D11 | Data Table 与 CSV               | A 不含 CSV；B 排序/筛选/来源详情/复制 + CSV（防护）                                            | **B**                                                                                                                                                                                                                                | 排序/基础筛选/来源详情/复制为必做（§3.7）；CSV「实现成本合理」判成立：经主进程 `dialog.showSaveDialog` 安全通道（用户选定路径、主进程校验、不新增 Agent 工具/任意文件系统）；公式注入防护（=,+,-,@ 开头加 `'` 前缀）、CRLF 与引号转义、UTF-8 BOM                                                                 | C8 落地；导出内容与 UI 数据一致性断言（§8 测试重点）                                                                                                |
| D12 | 确定性预算                      | 全表定稿（详细设计 §6.8）                                                                      | 来源候选 ≤24 / 选定来源 ≤8 / 并发 Tab ≤3 / 单页 capture ≤60k 字符 / Evidence ≤60 条・摘录 ≤500 字符 / 模型轮 ≤24 / 工具步 ≤64 / 总时长 ≤30 分钟 / 请求上下文 ≤200k 字符 / Result ≤200k 字符 / 单任务持久化 ≤500k 字符 / 保留任务 ≤30 | 「有界」必须是编译期常量 + 可注入 + 测试断言，不得只写「有界」二字（用户指令明令）                                                                                                                                                                                                                               | 全部预算常量集中在 shared/types/research.ts + research-budget 纯函数模块                                                                            |
| D13 | 编号体系                        | 任务 C1–C10；威胁 FT-01～FT-17；红队 FRT-01～FRT-12；决议承接 #94 起；冒烟场景编号承接 8.16 起 | 与历史 T/S/A/B/ST/SRT/RT/R 编号零冲突；8.15 已被 B8 占用（决议 #93），不复用不覆盖                                                                                                                                                   | 新文档引用编号唯一可追溯                                                                                                                                                                                                                                                                                         |

## 11. 里程碑划分（每任务 = 一个可验证开发闭环，任务文档见 doc/stage5/tasks/）

| 任务 | 内容                                                                                                                             | 依赖       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C1   | ResearchTask/Evidence/Result 核心契约 + 状态机纯函数 + research.db 存储与服务基座（migration v1/Repository/research-store 装配） | 无         |
| C2   | ResearchWorkspace 与 task-owned Tab 隔离、数量上限、取消/异常清理（BrowserController 集成）                                      | C1         |
| C3   | Source Selection：Sources + Search 候选合并、provenance、确定性排序（SourceSelector 纯函数）                                     | C1         |
| C4   | 多源读取、结构化提取、capture 记录、Evidence 确定性验证（CaptureService/EvidenceValidator）                                      | C1、C2、C3 |
| C5   | 独立有界 ResearchRuntime：阶段化、进度、停止、失败继续、预算、终态（纯核心）                                                     | C1–C4      |
| C6   | Cross-check、冲突模型、带证据综合与「不确定」输出（Claim/Conflict/Uncertainty）                                                  | C1、C4     |
| C7   | ResultValidator + 安全 Markdown/Table/Cards/Ranking Renderer（零新依赖）                                                         | C1         |
| C8   | Research UI/IPC/bridge：侧栏控制/进度 + 大结果画布 + 证据下钻 + 表格排序/筛选/复制 + CSV 导出                                    | C5、C6、C7 |
| C9   | Sources+Search 端到端 + 红队矩阵 FRT-01～FRT-12 + 隐私扫描 + 真实 Provider/真实主题验收基础设施                                  | C1–C8      |
| C10  | 独立最终验收（不采信 C1–C9 完成报告）+ Fifth_stage.md §9/§10 逐项判定 + 文档同步                                                 | C1–C9      |

**红线（每个任务文档重申）**：威胁模型（doc/stage5/threat-model.md）先于任何
C 系列实现定稿（本闭环满足）；Research 工具只经受限服务执行——不新增 shell/
eval/任意 JS/任意文件/任意网络/任意 SQL 工具；AgentLoop 12/420s 契约与既有
17 工具权限矩阵零放宽；Electron 安全边界/Key 零暴露红线/第四阶段 SRT 边界
全部保持；Renderer 不接触 BrowserController/SQLite/Electron/Provider；
C10 通过后停止，不实现 RSS/Watch/Sixth Stage。
