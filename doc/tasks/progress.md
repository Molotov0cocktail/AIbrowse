# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。
> ⚠️ 风险编号 R-XX 按登记顺序分配，**不得重排、不得复用**（已关闭项保留编号与结论直至自然归档）。
> 「风险与限制」只登记当前仍需关注的事项；历史细节由 Git 提交与任务文档保存，不在此重复叙述。

## 当前状态

- 阶段：**第四阶段（Sources 长期信源系统）**，已于 2026-08-15 正式切换（用户指令）。
  **设计闭环与 B1 决策门已完成**：`doc/stage4/` 定稿（threat-model/proposal/
  high-level-design/detailed-design/tasks B1–B9）；**B1 已完成（2026-08-15）**——
  node:sqlite 决策门 dev+生产双场景 11 项逐项实测，基础能力项 ①–⑦、⑩、⑪ 全部
  通过、⑧ FTS5 与 ⑨ trigram 实测**可用**（中文 ≥3 字符子串命中；1–2 字符查询
  不命中为 trigram 语义，B3 短查询降级路径依据），按用户裁决（决议 #46/#47）
  **驱动冻结 = node:sqlite**（详细设计 §15 决议 #48）+ sqlite-driver.ts 薄封装 +
  migrations.ts 骨架 + 冒烟 B-01（自动包含于默认 AIBROWSE_SMOKE=1 矩阵）+ 单测
  +31（全量 816/816）。**B2 已完成（2026-08-15）**——九项契约缺口实施前裁决
  （决议 #49–#57：复合唯一约束/WHATWG href 空路径/单一软删状态机/共享类型完整
  定型/幂等指纹重放/FTS 最小写同步/journal JSON 精确清理/硬删能力令牌/B-02 专属
  门控）+ Source 域模型/canonicalization/schema v1/Repository（唯一 SQL 执行点）/
  SourceService/change journal/durable Undo/冒烟 B-02 双进程 set/check 落地；
  全量 test 947/947（+131）；dev+生产双场景默认矩阵与 B-02 双进程退出码 0。
  **B3 已完成（2026-08-15）**——六项契约冲突实施前用户裁决（决议 #58–#63：
  audience 必填 user|agent/SourceSearchItem 独立类型/1 精确·2 精确+前缀+子串·
  ≥3 FTS·URL 判定集合/档位不可跨档 + scope+canonicalKey+id 收尾全序/FTS 不可用
  仅指建库后 MATCH/构造失败/B-04 记 B3/B4 分段）+ 多语言 Source Search（FTS5/
  trigram 主路径 + 短查询安全降级 + 有界 Retrieval 硬上限 10/每页 20 + 分享模式
  full/metadata/blocked + 确定性排序 + note 摘录 ≤200 + provenance + bidi 补齐
  U+061C/U+2066–U+2069）+ 诊断性 rebuild/一致性校验 + 冒烟 B-04 B3 子集（默认
  矩阵 dev+生产双场景）；全量 test 1007/1007（+60）。
  **B4 已完成（2026-08-15）**——实施前契约裁决（决议 #64–#67：结构化递归
  object/array schema（ProviderToolParameter 扩展 + 数组上限 20/未知字段拒绝/
  additionalProperties=false/深度有界，既有 13 工具零回归）/source_get 仅 agent
  allowlist 返回 expectedVersion 并发令牌（决议 #38 校准）/previewChangeSet
  只读预览 + buildChangeDiff 纯函数（≤2000 中文 diff）+ ToolDefinition.
  confirmSummary 钩子 + 批准后版本复验（TOCTOU）+ blocked 猜测防护/审计隐私
  收紧（note 零出现、URL query 值脱敏））+ Source 四工具（search/list/get L0 +
  apply_changes L2，注册表 13 → 17，audience 硬编码 agent，executor 零 Electron
  import）+ change set 确认全链路 + 审计脱敏 + 4000 预算 + UNTRUSTED_TOOL_RESULT
  块隔离 + 主进程 <userData>/sources/sources.db 装配（初始化失败 source-
  unavailable 不拖垮浏览器）+ 冒烟 B-03/B-04 B4 部分；全量 test 1071/1071
  （+64）。**B5–B9 待开始**；下一个推荐任务 = **B5**（Sources UI + 手工管理 +
  当前页快速添加 + 冲突/恢复态/Undo 展示 + IPC/bridge 扩展）。Sources 功能对
  用户尚不可用（UI 未实现——B5 完成前不得宣称可用；Agent 已可经 Source Tools
  使用）。步骤 0 独立核对（2026-08-15，B4 会话）：HEAD `6d153ee` = Gitee/GitHub
  双远程 HEAD（ls-remote 实测三方一致，GitHub 经代理确认可用）、工作区干净；
  基线 test 1007/1007·typecheck·lint·format:check 独立复跑全绿；B1–B3 代码/
  接口/测试在位；Fourth_stage.md 头部「B3–B9 待开始/下一任务 B3」矛盾已校准为
  B1–B3 完成、B4 待开始（不改写历史记录）。Entry Gate 判定证据见
  `doc/stage4/proposal.md` §8。
- 已完成（第三阶段，历史）：**第三阶段（Browser Agent）**，已于 2026-08-14 正式切换（用户指令）。Entry
  Gate 逐项核验通过（判定证据见 doc/stage3/proposal.md §8）；**设计定稿与任务拆分
  已完成（2026-08-14，纯文档）**——`doc/stage3/`：threat-model（Prompt Injection
  威胁模型重建定稿，先于任何 Browser Tool 实现）、proposal（Q1–Q15 拍板 + Entry
  Gate 核验记录）、high-level-design、detailed-design（唯一契约源，§2–§16）+
  任务 A1–A8（每任务 = 一个可验证闭环；**2026-08-14 实施前校正**：编号由 T1–T8
  改为 A1–A8 避免与第一阶段任务 T1–T5 重名，红队编号改 RT-01～RT-11，权限契约
  收紧为 click 确定性允许列表 + fail-closed——见 proposal §11 校正记录）。
  **A1 tool-calling 兼容层已完成（2026-08-14，硬前置解除）**：ProviderRequest/
  Event/Message 类型扩展、适配器 tools/SSE tool_calls 聚合解析（契约校准决议 #30）、
  FakeProvider 工具脚本、ContextBuilder tools 透传——全量验证通过（见下）。
  **A2 Tool Registry + 权限分级与确认状态机 + 审计日志已完成（2026-08-14）**：
  注册表确定性校验 + 13 工具权限矩阵纯函数（click 确定性允许列表 + fail-closed）+
  ConfirmManager + 审计脱敏 + ToolExecutor 管线 + **首批 8 个只读/导航工具接线
  BrowserController**（get_tabs/get_active_tab/read/open/navigate/back/forward/
  reload；交互工具/搜索/AgentLoop 未实现）；下一个推荐任务 = **A3 交互能力**。
  **A3 浏览器交互能力已完成（2026-08-14）**：interaction-script 固定模板 +
  BrowserController 扩展（clickElement/fillElement/scrollTab + elementId 文档
  世代绑定，决议 #31）+ 快照 isSubmit/ariaExpanded 语义元数据 +
  find/scroll/click/fill 四工具经既有 ToolExecutor 链路接线（allowedKind 由
  classifyClickTarget 单一事实源派生）+ 冒烟 A-12 与 elementId 生命周期真实 DOM
  探针（dev + 生产双场景）；**A4 SearchProvider 已完成（2026-08-14）**：接口 +
  Bing 搜索页实现（临时 Tab 精确 tabId 所有权与恢复语义 + try/finally 清理，
  决议 #32）+ 确定性解析（包装链接还原/过滤/去重/snippet 空串容忍设计）+
  search_web 工具注册（L0，注册表 13 工具）+ 受控搜索页冒烟全链路 + 公网 Bing
  探针（10 条真实结果）；**A5 Agent Runtime 已完成（2026-08-14）**：
  AgentLoop 纯编排状态机（MAX_STEPS=12/总超时 420s/取消/防循环执行前阻断/
  终态单一所有权，决议 #33 六点校准）+ AgentContextBuilder（AGENT_SYSTEM_PROMPT
  独立常量 + UNTRUSTED_TOOL_RESULT 块）+ agent-history（ToolStep/脱敏
  toolCalls/完整交互组）+ ConversationStore version 2 + ConversationService
  agentAsk/confirmTool + 主进程冒烟 A-01～A-09（dev/生产双场景退出码 0）；
  **A6 操作可见性 UI 与通道已完成（2026-08-14）**：6 IPC 通道（agent-ask/
  agent-confirm 两 invoke + agent-step/agent-confirm-request/agent-run-done/
  agent-status 四事件——决议 #34 新增实时状态通道）+ preload bridge 白名单 +
  任务模式/AgentStatusBar/ToolCallList/ConfirmDialog（deny 默认焦点、elementText
  不可信纯文本渲染）/停止按钮/ToolStep 历史渲染 + agent-run-state 纯 reducer +
  UI 端到端冒烟 A6-UI-01～A6-UI-12（dev/生产双场景退出码 0）；
  下一个推荐任务 = **A8 第三阶段收尾**（A7 离线部分已完成——红队矩阵 RT-01～
  RT-08 + RT-11/增量安全审计/RT-10 校准；真实 Provider 受能力限制未执行，证据
  见下）。
  **A8 第三阶段收尾已完成（2026-08-14）**：§9 五组 15 项 + §14 收紧项逐项核对
  （14 项 PASS、1 项 BLOCKED——真实网站 Agent smoke）、§10 Exit Gate 五项技术
  条件逐项判定 PASS、总 Exit 决策 HOLD/PENDING（真实 Provider 缺口）。
  **A7 补验真实验收已完成（2026-08-14，最终执行）**：wire 兼容性离线修复（决议
  #35）+ 最小预检（协议判定 PASS）+ 完整真实 Provider 验收（deepseek-v4-pro，
  §7 场景 1–6 + RT-10 + 停止全部真实通过，`LIVE_SMOKE_PASS` 退出码 0）——
  **第三阶段总 Exit 决策改判 `GO/PASS`**（Third_stage.md §9/§10 已同步）。
  **A7 补验补证已完成（2026-08-14，定向补验执行）**：证据缺口裁决后定向补证——
  场景 2 修订（真实长页面 read/find/scroll 三类工具真实调用链断言）+ 场景 3 修订
  （真实搜索后两个不同 origin 公开来源各自读取比较）+ A3 工具层探针确认门状态机
  补齐（迟到/未知 toolCallId 决议无效）+ 新门控 `AIBROWSE_LIVE_AGENT_SUPPLEMENT=1`
  （harness `-Supplement`）——真实执行 `LIVE_SMOKE_PASS` 退出码 0（12 次 HTTP
  全部 200）；**GO/PASS 判定维持**（补证闭环，无缺口遗留）。
  下一个推荐任务 = **Fourth Stage 进入前需求澄清与详细设计**（按 ROADMAP 阶段
  切换原则，等待用户指令；不直接实现信源数据库）。
  **最终验收发现项 F-1～F-4 修复闭环已完成（2026-08-14）**：测试设施墙钟断言
  间歇失败（F-1）与 3 处文档矛盾/陈旧（F-2～F-4）全部关闭，O-1 观察已登记
  （详见「最近验证结果」最新条目）；GO/PASS 维持，阶段指针不变。
- 前置状态：第一阶段 Exit Gate 通过（2026-08-13，First_stage.md §十四）；
  Second Stage Exit Gate 通过（2026-08-13 判定 + 2026-08-14 用户独立复验，4 项
  非阻塞缺陷已修复并全量回归，红态退出码 1 → 绿态 0；证据见 Second_stage.md
  §9/§10 与本文「最近验证结果」）。
- 路线图文档已接入（2026-08-13）：ROADMAP.md + First_stage.md～Seventh_stage.md 入库；
  各文件职责、接管顺序与阶段切换纪律见 AGENTS.md §1/§2。
- 最近 commit 与工作区状态：以 `git log --oneline` / `git status --short` 为准。
- 技术基线：2026-08-13 验证冻结（AGENTS.md §1）；依赖精确版本固定（package.json 无 ^/~）。

## 任务表

| 任务 | 内容                                                                                             | 状态 | 备注                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | 项目基线（git/文档链/脚手架/测试基建/最小应用）                                                  | ✅   | 2026-08-13 完成，见 tasks/baseline.md                                                                                                                               |
| T1   | 详细设计定稿：接口契约/错误处理/preload 清单/Tab 状态机/采集算法 + proposal Q1–Q4 拍板           | ✅   | 2026-08-13 完成，定稿见 doc/detailed-design.md（§12 决议记录）                                                                                                      |
| T2   | 浏览器核心：BrowserController + TabManager + WebContentsView + SessionManager（多 Tab 可开网页） | ✅   | 2026-08-13 完成，签名已回填 AGENTS.md §5 并与代码 grep 核对                                                                                                         |
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ✅   | 2026-08-13 完成，R-01 同闭环关闭（见下）                                                                                                                            |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ✅   | 2026-08-13 完成（含 T3 导航保护收紧，见下）                                                                                                                         |
| T5   | 收尾：安全审计（§11 逐项 + R-02 关闭 + elementId 敌对页审查）+ 验收清单逐项核对 + 文档同步       | ✅   | 2026-08-13 完成（4 个逻辑 commit，见下）                                                                                                                            |
| S1   | Provider 抽象 + SecureCredentialStore + 配置存取 + 错误归一化（FakeProvider 闭环，无 UI）        | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S1-provider-credential.md                                                                                        |
| S2   | ContextBuilder 纯核心：角色隔离/预算裁剪/selection 优先级/薄快照/表格噪声                        | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S2-context-builder.md                                                                                            |
| S3   | ConversationService + 会话 JSON 持久化 + ask 编排（实时快照防串页）+ 主进程冒烟                  | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S3-conversation-service.md                                                                                       |
| S4   | AI 侧栏 UI + IPC/bridge 扩展 + 布局 bounds 协调 + UI 端到端冒烟矩阵                              | ✅   | 2026-08-13 完成（见下）；任务文档 doc/stage2/tasks/S4-ai-panel-ui.md                                                                                                |
| S5   | 安全审计 + Prompt Injection 验证矩阵 + 真实 Provider 可选验证                                    | ✅   | 2026-08-13 完成（§12.1/§14 逐项审计通过、矩阵 11 注入夹具增强、真实 Provider 冒烟 2 次调用全通过，见下）；任务文档 doc/stage2/tasks/S5-security-prompt-injection.md |
| S6   | 第二阶段收尾：验收清单核对 + Exit Gate 判定 + 文档同步（契约回填 AGENTS.md §5）                  | ✅   | 2026-08-13 完成（§9 逐项证据 + §10 Exit Gate 通过 + 真实 Provider 多网站验证，见下）；任务文档 doc/stage2/tasks/S6-finalize-acceptance.md                           |
| 修复 | 独立复验发现项修复闭环（Tab 状态自清理 / 表格内容依赖证据 / Key 扫描窗口 / README 状态）         | ✅   | 2026-08-14 完成（独立复验后定向修复，不切换阶段；4 项发现 + 修复证据见下）                                                                                          |

| A1 | tool-calling 兼容层（硬前置）：ProviderRequest/Event/Message 扩展 + 适配器 tools/SSE tool_calls + FakeProvider 工具脚本 | ✅ | 2026-08-14 完成（见下）；契约 §2.1/§3 + 决议 #30；任务文档 doc/stage3/tasks/A1-tool-calling-layer.md |
| A2 | Tool Registry + 权限分级与确认状态机（click 确定性允许列表 + fail-closed）+ 审计日志（接线既有只读/导航工具 8 个） | ✅ | 2026-08-14 完成（见下）；契约 §4/§7/§10；任务文档 doc/stage3/tasks/A2-tool-registry-permission-audit.md |
| A3 | 浏览器交互能力：scroll/click/fill/find + click 语义元数据 + elementId 生命周期验证 + click 执行器层白名单复核 | ✅ | 2026-08-14 完成（见下）；契约 §5 + 决议 #31（文档世代绑定）；任务文档 doc/stage3/tasks/A3-browser-interaction.md |
| A4 | SearchProvider（Bing 页面实现 + 统一结果结构 + 降级）+ search_web 工具 | ✅ | 2026-08-14 完成（见下）；契约 §6 + 决议 #32（临时 Tab 所有权/错误映射/snippet 空串/包装链接/查询串全量审计）；任务文档 doc/stage3/tasks/A4-search-provider.md |
| A5 | Agent Runtime：Loop 状态机 / 最大步数 / 超时 / 取消 / 防循环 / Agent 上下文与历史 / 持久化扩展 + 主进程冒烟 | ✅ | 2026-08-14 完成（见下）；契约 §8–§9 + 决议 #33；任务文档 doc/stage3/tasks/A5-agent-runtime.md |
| A6 | 操作可见性 UI + IPC/bridge 扩展 + 确认流 UI + UI 端到端冒烟矩阵 | ✅ | 2026-08-14 完成（见下）；契约 §11 + 决议 #34（实时状态通道/参数摘要源/确认信任边界/多监听者）；任务文档 doc/stage3/tasks/A6-agent-ui-visibility.md |
| A7 | 威胁模型红队矩阵 RT-01～RT-11 + 安全审计 + 真实 Provider 可选验证 | ✅ | 离线部分（RT-01～RT-08 + RT-11 + 审计 + RT-10 校准）已完成并推送；真实 Provider 验证已完成（2026-08-14 补验：wire 兼容性修复 + 最小预检 + 完整真实验收 §7 场景 1–6 + RT-10 全部真实通过——deepseek-v4-pro，LIVE_SMOKE_PASS 退出码 0；RT-10 观察性结果如实登记）；**2026-08-14 定向补验**：场景 2 修订（真实长页面 read/find/scroll 工具链）+ 场景 3 修订（真实搜索后两个不同 origin 公开来源）+ A3 状态机补齐，LIVE_SMOKE_PASS 退出码 0；契约 doc/stage3/threat-model.md §4；任务文档 doc/stage3/tasks/A7-redteam-security-audit.md |
| A8 | 第三阶段收尾：验收清单核对 + Exit Gate 判定 + 文档同步 | ✅ | 2026-08-14 完成（§9 逐项证据 + §10 总判定 HOLD/PENDING）；**2026-08-14 A7 补验后改判 GO/PASS**（§9 五组全 PASS + §10 五项条件 PASS + 真实场景与 RT-10 证据）；任务文档 doc/stage3/tasks/A8-finalize-acceptance.md；证据见下 |

| B1 | node:sqlite 决策门 spike（硬前置）：Electron dev+生产构建实测 11 项（import/文件库/prepared statements/事务/外键/busy timeout/FTS5/trigram/userData/句柄清理）+ SQLite/migration 基座 | ✅ | 2026-08-15 完成（见下）：11 项逐项实测，基础能力项 ①–⑦、⑩、⑪ 全过 + ⑧⑨ 可用 → 按决议 #46/#47 冻结 node:sqlite（决议 #48）；driver/migrations/冒烟 B-01/单测 +31 落地；全量 816/816；任务文档 doc/stage4/tasks/B1-sqlite-foundation.md（实测证据节已回填） |
| B2 | Source 域模型 + canonicalization + Repository（唯一约束）+ SourceService + 事务 + change journal + Undo | ✅ | 2026-08-15 完成（见下）：九项契约缺口实施前用户裁决（决议 #49–#57）+ schema v1 + 全模块落地 + 冒烟 B-02 双进程；任务文档 doc/stage4/tasks/B2-source-domain-service.md（红→绿证据已回填） |
| B3 | 多语言 Source Search：FTS5/trigram + 短查询安全降级 + 有界 Retrieval（硬上限 10/每页 20/allowlist）+ 分享模式 + 确定性排序 | ✅ | 2026-08-15 完成（见下）：六项契约裁决（决议 #58–#63）+ 检索/降级/排序/分享模式/note 摘录/rebuild 全落地 + B-04 B3 子集冒烟；任务文档 doc/stage4/tasks/B3-source-search-retrieval.md（红→绿证据已回填） |
| B4 | Source Tools 四工具（search/list/get L0 + apply_changes L2）+ 权限矩阵 + change set 确认/幂等键/expectedVersion/审计 + Agent 上下文隔离 | ✅ | 2026-08-15 完成（见下）：决议 #64–#67 + 四工具注册（13 → 17）+ preview/确认钩子/TOCTOU/blocked 防护 + 审计脱敏 + 冒烟 B-03/B-04 dev+生产双场景；任务文档 doc/stage4/tasks/B4-source-tools-permission.md（红→绿证据已回填） |
| B5 | Sources UI + 手工管理 + 当前页快速添加 + 冲突/恢复态/Undo 展示 + IPC/bridge 扩展 | ⏳ | 2026-08-15 设计定稿；任务文档 doc/stage4/tasks/B5-sources-ui.md |
| B6 | AI 自然语言管理端到端（change set 全链路 + Undo）+ Browser Agent 复用（source_search → browser_open/read）+ usage 记录接线 | ⏳ | 2026-08-15 设计定稿；真实 Provider 可选验证门控 AIBROWSE_LIVE_AGENT_SOURCES=1；任务文档 doc/stage4/tasks/B6-ai-source-management.md |
| B7 | 跨进程持久化 + migration/backup/recovery 全矩阵 + FTS rebuild 诊断 + usage/health 边界 | ⏳ | 2026-08-15 设计定稿；任务文档 doc/stage4/tasks/B7-persistence-recovery-usage.md |
| B8 | 红队矩阵 SRT-01～SRT-12 + 安全审计 + 隐私扫描 + 真实 Provider/真实网页可选验证 | ⏳ | 2026-08-15 设计定稿；安全契约源 doc/stage4/threat-model.md；任务文档 doc/stage4/tasks/B8-redteam-security-validation.md |
| B9 | Fourth Stage 独立最终验收（当前 HEAD 重新复验，不采信 B1–B8 报告）+ Exit Gate 判定 + 文档同步；完成后停止不实现 Fifth Stage | ⏳ | 2026-08-15 设计定稿；任务文档 doc/stage4/tasks/B9-finalize-acceptance.md |

> 编号说明（2026-08-14 实施前校正）：第三阶段任务编号 A1–A8（原 T1–T8），避免与
> 上表第一阶段历史任务 T0–T5（已关闭，编号不可改）重名；第一、第二阶段历史任务
> 编号一律不变。（2026-08-15）第四阶段任务编号 B1–B9、威胁 ST-01～ST-12、红队
> SRT-01～SRT-12——同样避免与 T/S/A/RT/R 历史编号重名；历史编号一律不复用。

## 最近验证结果（2026-08-14，2026-08-15 追加第四阶段设计闭环与 B1/B2/B3/B4 条目）

- **B4 Source Tools + 权限矩阵 + L2 change set 确认/审计 + Agent 上下文隔离
  （2026-08-15，第四个实现闭环）**：① 步骤 0 独立核对——HEAD `6d153ee` =
  Gitee/GitHub 双远程 HEAD（ls-remote 实测三方一致；GitHub 操作前先确认
  127.0.0.1:7890 代理可用——HTTP 200 实测）、工作区干净；基线 test 1007/1007·
  typecheck·lint·format:check 独立复跑全绿；B1–B3 代码与接口在位、B4 零实现
  （无 source-tools 文件）；Fourth_stage.md 头部矛盾核验属实并校准（「B3–B9
  待开始/下一任务 B3」→ B1–B3 完成、B4 待开始，未改写历史记录）。② **实施前
  硬停点：接口缺口核验属实**（ProviderToolParameter 冻结于基础类型无嵌套——
  source_apply_changes 只能退化成 JSON 字符串；决议 #38「version 不回显」使
  expectedVersion 实际不可获得；无只读预览契约且确认与提交之间无版本复验——
  TOCTOU 窗口；审计「查询串全量」与「敏感 URL query 不得记录」冲突）→ 按任务
  授权结论记录决议 #64–#67（结构化递归 schema/expectedVersion 并发令牌/
  previewChangeSet + confirmSummary 钩子 + blocked 猜测防护/审计隐私收紧）落
  detailed-design §15 + §7.1/§7.6/§8.1/§9.1 + threat-model §3.3/§3.6 同步。
  ③ **红→绿**：先写测试——红态 8 files failed / 25 failed / 1012 passed
  （source-tools.test.ts 模块缺失 + 7 个既有测试文件 B4 扩展用例在旧结构下真实
  失败：注册表不校验嵌套（未知字段/枚举/数组上限/深度全部放行）、审计把 ops
  整体 JSON 化（note 正文泄漏入审计）、source_search URL 查询 query 值全量、
  previewChangeSet 不存在、applyChangeSet 对 blocked 条目照常写入且 add 撞
  blocked 回注既有 id（存在泄漏）、confirmSummary 钩子不存在（L2 直接走兜底
  摘要）、base 2 权限被 decide 回落 L1 自动执行、store 拒绝 source 错误码、
  agent-display 无文案——均与决议 #64–#67 契约对照的真实失败，既有 1007 用例
  零删除零削弱）；实现后全量 **1071/1071**（新增 64：source-tools 33 /
  tool-registry 递归 6 / tool-executor 钩子与预算 5 / audit-log 3 /
  source-service preview+blocked 7 / source-change-set buildChangeDiff 4 /
  conversation-store 1 / agent-display 4 + 权限矩阵恒等与文案校准 1）。实现期
  修正如实登记：测试自身缺陷 6 处（手工通道 trust 夹具误带 assertedBy——契约
  仅 value；metadata 种子未显式 shareMode 致 userNote 缺省 full（决议 #52
  语义）；同 set 重复 sourceId 夹具（契约整体拒绝）；blocked 场景 journal 基线
  含种子 addManual 条目——改相对断言；敌手 bidi 字面量触发 no-irregular-
  whitespace——改转义构造；工具链重放断言与服务层幂等重放契约冲突——工具链
  preview 先行 source-duplicate fail-closed 更保守，服务层幂等由 B2 测试固化）；
  实现侧真实缺陷 0 处（红态后一次性全绿）。④ **冒烟**：8.1 注册表断言校准
  17 工具 + A-01/RT-01 注释与工具数断言同步（13 → 17）；新增 8.10 B-03/B-04
  B4 部分（默认矩阵自动包含，LIVE 跳过与 8.4–8.6 同条件）：change set 确认
  全链路（deny 零写入 + 未知/迟到 toolCallId 无效/approve 恰一次单事务 +
  审计含幂等键/durable Undo/blocked 猜测 source-forbidden 零泄漏/TOCTOU 版本
  复验/20-21 项注册表边界）+ 4000 预算确定性截断 + warning + allowlist 序列化
  （expectedVersion 令牌/metadata 与 blocked 零泄漏）+ FakeProvider 多轮 Agent
  全链路（deny→修正重提→approve→search，审计决策 denied/confirmed/auto 各一）
  - UNTRUSTED_TOOL_RESULT 块隔离（注入 note 夹具：块内出现/system 恒等/17 工具
    恒等/ToolStep 摘要 ≤200 且完整备注尾部标记零出现）+ 审计字节扫描（13 次调用
    恰好 13 条审计；note/敏感 query/凭据形态零命中）；**dev 完整矩阵退出码 0**；
    **生产产物完整矩阵退出码 0**（同矩阵，out/ 产物运行）；**B-02 生产双进程**
    `AIBROWSE_SOURCES_SMOKE=set` 退出码 0 → 新进程 `check` 退出码 0（跨进程读回
    一致 + 重启后 Undo + 重复 Undo 幂等 + 版本冲突拒绝——B-02 断言零改动）；
    两进程共用系统 TEMP 下本次专属目录，结束后清理。⑤ **红线与敏感扫描**：禁具
    source_sql/source_delete_hard/source_export_all 零命中；业务 SQL 仍仅
    Repository/migrations（renderer/preload/tools/agent/sources-tools 零 SQL）；
    新代码零 any/@ts-ignore/@ts-nocheck；Source 工具零 Electron import、零网络
    能力；package/lockfile 零改动；git diff --check 零命中（仅既有 CRLF 提示）；
    敏感扫描（sk-/token=/apiKey 明文）零命中；临时 userData/探针目录零残留
    （index.ts 冒烟 Sources 目录随 before-quit 清理；根目录杂散日志已清理）。
    **未调用任何付费 Provider、未输出/索取 API Key、未新增依赖、未改 B1 冻结
    driver 与 B2 冻结 schema v1（migrations.ts/sqlite-driver.ts 零 diff）、未改
    既有 13 工具 schema。** ⑥ 文档同步：detailed-design §15 决议 #64–#67 +
    §7.1/§7.6/§8.1/§9.1、threat-model §3.3/§3.6、B4 任务文档红→绿证据、本文件、
    Fourth_stage/README/AGENTS（Sources 速查 B4 签名回填 + 工具数 17 + 测试计数
    1071）。B-04 全过（B3 子集 + B4 部分）；SRT-01/02/06/07 断言先行可用
    （B8 汇总裁决）；B5（Sources UI）为下一任务，本提示内不再继续实现。

- **B3 多语言 Source Search + 有界 Retrieval + 分享模式（2026-08-15，第三个实现
  闭环）**：① 步骤 0 独立核对——HEAD `e26bfd8` = Gitee/GitHub 双远程 HEAD
  （ls-remote 实测三方一致）、工作区干净、基线 test 947/947·typecheck·lint·
  format:check 独立复跑全绿；B3 零实现（无 source-search-query/source-search-
  index 文件）；已知文档矛盾核验属实并校准——Fourth_stage.md 头部「尚未实现任何
  Sources 功能、下一任务 B1」、progress 当前状态仍记起始 HEAD `b2eb8d5`、底部
  「下一个推荐任务」仍为 B2（三处按实际状态精确校准，不保留多个「下一任务」，
  未改写历史验收记录）。② **实施前硬停点：六项契约冲突逐项核验全部属实**
  （search/list/get 无可信 audience 参数、SourceSearchResult.results 无 note
  类型、详细设计「中文 2+ 子串」与 B1 实测 trigram ≥3 语义矛盾、「priority
  ±1 档」无算法且 origin/page 同 canonical key 时 canonical_key 不能保证全序、
  schema v1 无条件建 sources_fts 与「FTS 不可用降级」范围未界定、B-04 断言含
  B4 的 ToolResult/块接线）→ **用户一次性裁决（六项全部采纳推荐）** = 决议
  #58–#63（audience 必填 user|agent，B4/B5 主进程适配器硬编码 / 新增
  SourceSearchItem+SourceSearchNote 独立类型，SourceListItem 永不含 note /
  查询 trim+NFC 按码点计数：1 字符仅精确、2 字符精确+前缀+参数化字面子串 LIKE
  （中文 2 字符子串经降级路径诚实交付，不声称 trigram 原生支持两字符）、≥3 字符
  FTS、URL 判定集合 = normalizeSourceUrl 可解析或 http(s):// 前缀 / 档位严格
  不可跨档 + priority/recency 仅同档内 + lastUsedAt=null 末位 + scope+
  canonicalKey+id 收尾全序 / FTS 不可用仅指建库后 MATCH/构造失败，migration v1
  不改写 / B-04 记 B3/B4 分段，B3 不提前实现工具层）；detailed-design
  §2/§3.1/§6/§8/§13/§15 + HLD + B3 任务文档 + threat-model §3.3/§3.4 +
  proposal Q7 同步校准。另核验属实并在本任务修复：stripControlChars 未覆盖
  U+061C、U+2066–U+2069（bidi 隔离控制符）——写入侧补齐 + 读取侧防御性清洗
  （旧数据/损坏数据同样覆盖）+ 敌手测试。③ **红→绿**：先写测试——红态 4 files
  failed / 16 failed / 955 passed（2 新文件模块缺失 + 8 个 service B3 行为断言
  在 B2 实现下真实失败：audience 被忽略（`{ok:true,query:'q',results:[]}` 而非
  invalid-change）、agent 视角 blocked 搜索命中泄漏、`note` undefined、中文
  2 字符 '测试' 在 B2 LIKE 前缀语义下不命中、档位排序在 B2 created_at 排序下
  失败（note 命中条目不在结果集）、agent list total 4 而非 3、bidi 敌手 8 例
  （`expected 'xyzy' received 'xy⁦z⁩؜⁧y'` 等真实形态失败）；既有 947 用例零删除
  零削弱（audience 为机械校准 + 语义保留 + 隐私断言新增）。实现后全量
  **1007/1007**（新增 60：source-search-query 23 / source-search-index 13 /
  source-service B3 14 / source-change-set bidi 10——9 敌手 case + 1 幂等）。
  实现期修正如实登记：**SQLite 3.53.1 新增实测事实**——FTS5 外部内容表语义下
  COUNT(_)/全表扫描读取内容侧（索引滞留行在查询期被 FTS5 自动忽略、计数不可
  见），故一致性校验采用逐行 MATCH 回查探针检出「内容有行、索引缺行」方向
  （搜索漏命中），滞留方向如实登记由 rebuild 清除；origin/page 同 canonicalKey
  在决议 #50 语义下实际不可达（page 键恒带 '/'），全序收尾的 scope 三元组由
  纯函数单测覆盖 + 服务层以同源键族（'https://example.com' 前驱/'/' 后驱）实测
  确定性排序；测试自身缺陷若干（'基准' 实为 2 字符、默认夹具 tag 与查询词相撞、
  'ENCHMARK' 为 'Benchmark' 子串、'OR'/'--'/'_'/'^' 为短 token 被过滤——均按
  契约修正测试，无实现迁就）。④ **冒烟**：默认完整 dev 矩阵退出码 0（B-01 +
  8.9 B-04 B3 子集：中/日/英命中 + 短查询降级 + 分享模式矩阵 + 硬上限 10 + URL
  查询 + 注入串 + rebuild 一致性，真实 Electron 内置 node:sqlite/FTS5/trigram）；
  默认完整生产矩阵退出码 0（同矩阵，out/ 产物运行）；**B-02 生产双进程**
  `AIBROWSE_SOURCES_SMOKE=set` 退出码 0 → 新进程 `check` 退出码 0（读回一致 +
  重启后 Undo + B3 补充证据「重启后经 B3 检索命中 s1」——B-02 原有断言零改
  动）；两进程共用同一预先核验位于系统 TEMP 下的独立 userData，结束后仅删除该
  本次专属目录。⑤ **红线与敏感扫描**：候选 SQL 全部编译期常量 + 参数绑定（四条
  候选路径 + rebuild/探针均 prepared statement，无 exec 动态串）；renderer/
  preload/tools/agent 零 SQL；source_sql/source_delete_hard/source_export_all
  零命中；新代码零 any/@ts-ignore/@ts-nocheck；package/lockfile 零改动；工具
  注册表仍既有 13 个（冒烟 8.1 断言通过）；日志零 note 正文/URL token/sk- 形态
  （当日日志字节扫描 0 命中）；冒烟临时目录零残留（本会话 B-02 遗留 2 个
  fake-provider 空配置目录已清理，更早会话遗留目录非本任务创建未动）。**未调用
  任何付费 Provider、未输出/索取 API Key、未新增依赖、未改 B1 冻结 driver 与
  B2 冻结 schema v1（migrations.ts/sqlite-driver.ts 零 diff）。** B-04 剩余
  部分（SOURCE_TOOL_CONTENT_MAX=4000/ToolResult 序列化/UNTRUSTED_TOOL_RESULT
  块接线/审计）按决议 #63 明确标注 B4 待完成，本任务不宣称 B-04 全过；B3 尚未
  接 Agent 运行与可取消异步任务，Agent cancel/ConfirmManager 场景 N/A（检索
  路径无句柄/监听器/临时库泄漏——异常路径均经单测与 dispose 幂等覆盖）。

- **B2 Source 域模型 + Repository + SourceService + journal + Undo（2026-08-15，
  第二个实现闭环）**：① 步骤 0 独立核对——HEAD `b2eb8d5` = Gitee/GitHub 双远程
  HEAD、工作区干净、基线 test 816/816·typecheck·lint·format:check 独立复跑全绿、
  B1 代码在位（driver/migrations/冒烟 8.7）、B2 零实现（无 domain/repository/
  service/shared 类型）。② **实现前硬停点：九项契约缺口逐项核验全部属实**
  （origin/page 单列 UNIQUE 与键空间独立声明矛盾、WHATWG 解析丢失空路径原始
  形态、enabled/deleted_at 双机制状态机未定义、共享类型不完整且错误码缺
  undo-conflict、幂等键无指纹/无部分唯一索引无法完成重放识别、FTS 建表归 B2
  与同步归 B3 冲突、journal 逗号分隔无法精确清理、hardDelete confirmToken 机制
  缺失、B-02 无门控路由）→ **用户一次性裁决（九项全部采纳推荐）** = 决议
  #49–#57（复合唯一约束/WHATWG href 空路径/单一软删状态机/共享类型完整定型/
  指纹列+部分唯一索引/FTS 最小写同步/JSON 精确拆分/内置能力令牌/专属
  AIBROWSE_SOURCES_SMOKE 门控），detailed-design §2/§4–§7/§13/§15 + B2 任务
  文档 + HLD 同步校准。③ **红→绿**：先写测试——红态 6 files failed / 10 failed /
  818 passed（5 新文件模块缺失 + schema v1 契约断言在旧 MIGRATIONS 空列表下
  真实失败 + typecheck 红；既有 816 零删除零削弱）；实现后全量 **947/947**
  （新增 131：canonical 22 / change-set 28 / repository 17 / journal 15 /
  service 37 / migrations schema v1 契约 +12）。实现期修正如实登记：实现侧
  真实缺陷 5 处（SQLite 3.53.1 唯一冲突消息为「列名」形态——translate 匹配串
  校准（实测证据：复合唯一报 `t.a, t.b`、部分唯一报其列、主键报 `t.k`）；
  listSources groupId=null（未分组）与不过滤混淆——三态 mode 参数；applyChangeSet
  预检缺 try/catch 致不可预期错误泄漏；stripControlChars 漏 \n/\r——C0 除 \t
  全剔；B-02 冒烟断言自身缺陷——Undo 后列表期望 2 实为 1（list 默认过滤
  deleted_at IS NULL，决议 #51 语义））；测试自身缺陷若干（'https:///path' 经
  WHATWG 解析 host='path' 合法、IDN 非 ASCII 路径百分号编码、LIKE 前缀语义下
  '%可靠' 不命中 '100%可靠'、FK 前置与 canonical 夹具重复）——按契约修正测试，
  无实现迁就。**SQLite 3.53.1 新增实测事实**：转义通配符位于 LIKE 模式首位时
  前缀语义正常（`'\%bc%'` 匹配 `'%bc'`/`'%bcx'`、不匹配 `'x%bc'`）。④ **冒烟**：
  默认完整 dev 矩阵退出码 0（B-01 ①–⑦、⑩、⑪ 全过）；默认完整生产矩阵退出码 0
  （B-01 + 既有 T/S/A/RT 全矩阵回归，S4 bounds 本轮未复现）；**B-02 生产双进程**
  （决议 #57 门控）——进程 A `AIBROWSE_SOURCES_SMOKE=set` 退出码 0（临时
  userData 建库迁移 v1 → CRUD + 5 条 journal）→ 进程 B 新进程 `check` 退出码 0
  （读回全量断言一致 + 重启后 Undo 生效 + 重复 Undo 幂等 undo-not-found +
  版本冲突拒绝不覆盖），两进程均 AIBROWSE_SMOKE=1 + 已核验系统 TEMP 子目录
  （smoke 内 isPathInside 断言拒碰真实 userData）；互斥路由实测（SESSION_SMOKE
  与 SOURCES_SMOKE 同设 → 退出码 1 + 中文错误）；临时目录解析确认位于系统
  TEMP 后仅删除本次目录、零残留。⑤ **红线与敏感扫描**：业务 SQL 仅 Repository/
  migrations 编译期常量 + 参数绑定（grep 零命中他处）；driver 仅连接级 SQL；
  exec() 仅迁移引擎执行编译期迁移语句；renderer/preload/tools/agent 零 SQL；
  source_sql/source_delete_hard/source_export_all 零命中；新代码零 any/
  @ts-ignore；日志零 note 正文/journal payload/URL token/sk- 形态；冒烟日志
  同检零命中。⑥ **文档同步**（detailed-design §2/§4–§7/§13/§15 决议 #49–#57、
  B2 任务文档红→绿证据、本文件、README/AGENTS）。**未调用任何付费 Provider、
  未输出/索取 API Key、未新增依赖、未改 B1 冻结的 driver 行为（driver 零 diff）。**

- **B1 node:sqlite 决策门 spike + SQLite/migration 基座（2026-08-15，第一个
  实现闭环；驱动冻结 = node:sqlite，决议 #48）**：① 步骤 0 独立核对——HEAD
  `818dd5e` = Gitee/GitHub 双远程 HEAD（ls-remote 实测三方一致）、工作区干净、
  基线 test 785/785·typecheck·lint·format:check 独立复跑全绿；全仓库 SQLite/
  SourceService 代码零命中（B1 未被部分实现）。② **契约矛盾核验 + 用户裁决**
  （实现前硬停点）：两处实质冲突确认属实——⑧⑨ 冻结门槛（§3.2「任一失败」vs
  B1 任务文档「⑧⑨ 不构成失败」，HLD §8 自身两句并存）与 SQL 落点（§3.1/HLD
  「driver 无 SQL 语句定义」vs B1 要求 busy timeout/外键/WAL/withTransaction/
  探针 SQL 且禁止提前建 Repository）。用户裁决：**⑧⑨ 非硬门槛**（基础能力项
  ①–⑦、⑩、⑪ 全过即冻结，⑧⑨ 失败 B3 降级为主）+ **driver 内置连接级运维
  SQL 常量**（探针 SQL 仅限 SMOKE_MODE 冒烟 B-01 与 `*.test.ts`）→ 决议
  #46/#47 落 detailed-design §15，§3.1/§3.2/HLD/AGENTS/Fourth_stage/proposal/
  threat-model/B1 任务文档同步校准。③ **红→绿**：先写测试与 B-01 冒烟断言——
  红态 = 单测 2 文件「Cannot find module」失败（785 通过维持）+ 冒烟构建失败
  （Could not resolve ./sources/db/sqlite-driver）；实现后全量 **816/816**
  （新增 31：sqlite-driver 17 / migrations 14——文件库重开/注入串仅作数据/事务
  三路回滚/外键双证/WAL/busy 读回/两连接锁竞争（worker 正证 + 零超时负证 +
  等待下界）/重复关闭/重命名删除/无效路径；迁移列表空/重复/乱序/缺级/非正整数/
  未知更高版本/第 N 步失败该步整体回滚零部分状态/续跑），既有用例零删除零削弱。
  实现期修正均为测试自身断言缺陷（迁移回滚作用域按「每级单事务」契约校准；外键
  负证暴露**本机 SQLite 构建默认 SQLITE_DEFAULT_FOREIGN_KEYS=1**——driver 显式
  双分支保证跨构建确定性；busyTimeoutMs 允许 0=禁用；测试句柄泄漏致 EPERM——
  全部改为 finally 清理）。④ **冒烟**：B-01 自动包含于默认 AIBROWSE_SMOKE=1
  矩阵（与 LIVE 门控无关，任何冒烟运行均执行）——dev 默认矩阵退出码 0（⑩ 如实
  跳过）；dev 官方命令（`AIBROWSE_USER_DATA_DIR=<系统 TEMP 下临时目录> npm run
dev`）退出码 0，①③④⑤⑥⑦⑧⑨⑩⑪ 全部通过；生产官方命令（`npm run build` 后
  `AIBROWSE_USER_DATA_DIR=<另一临时目录> npm run start`）首跑退出码 1——失败点
  为**既有 S4 UI 矩阵 9**（面板 bounds 收缩断言，先于 B-01 的既有场景代码路径，
  非本任务改动），复跑连续 2 次退出码 0（A7「环境瞬态」先例，如实登记），②③④
  ⑤⑥⑦⑧⑨⑩⑪ 全部通过。**Electron 43.4.0（Node 24.18.1）/ SQLite 3.53.1
  实测**；ExperimentalWarning 实测**不产生**（Electron 与系统 Node 均零 warning
  事件，如实记录未压制）。备份三候选观察：VACUUM INTO 可用（WAL 活跃一致性快照
  integrity ok）；node:sqlite backup API 不存在；关闭后复制可行（干净关闭后
  -wal/-shm 自动清除）。⑤ 临时 userData/探针目录零残留；未新增依赖、未改既有
  产品行为（index.ts/electron.vite.config 零改动——driver 随 smoke 静态导入自动
  进入 dev/生产构建）、13 工具注册表不变；⑥ 文档同步（detailed-design §15 决议
  #48 冻结、B1 任务文档实测证据节、本文件、README/AGENTS）。**未调用任何付费
  Provider、未输出/索取 API Key。**

- **Fourth Stage 切换与设计定稿（2026-08-15，纯文档任务，零代码改动，不实现任何
  Sources 功能）**：① 步骤 0 独立核对——Git HEAD `82f7838` = Gitee/GitHub 双远程
  HEAD（ls-remote 实测，三方一致）、工作区干净；全量验证独立复跑（见下）；
  既有接口代码核对（本会话 Explore 核查）：ToolRegistry/PermissionPolicy/
  ConfirmManager/ToolExecutor/ConversationService/BrowserController/SearchProvider
  实际导出签名与 AGENTS.md §5 契约**一致**（4 处文档滞后性遗漏：ConversationStore
  Second Stage bullet「version 1」未回填 v2、ToolRegistry bullet 未提决议 #35
  wire 名称双闸门、agent.ts 枚举清单遗漏 ClickAllowedKind/ElementSemanticsBinding、
  AgentRuntime bullet 未列 verifyReasoningReplay / 审计 bullet 未列
  formatAgentRunAuditMessage——登记为 detailed-design 决议 #45，留待 B 系列任务
  速查回填时一并校准）。② Entry Gate 逐项核验通过（判定证据全文见
  `doc/stage4/proposal.md` §8；node:sqlite/FTS5 属第四阶段自身交付物 → B1 决策门
  硬前置，同第三阶段 A1 循环式门槛校正模式）。③ 新建 `doc/stage4/`：
  threat-model.md（威胁 ST-01～ST-12 + 红队 SRT-01～SRT-12；继承第三阶段全部
  结构性边界与四类残余风险，新增 Sources 特有攻击面；诚实边界六类残余风险如实
  登记，不宣称免疫）、proposal.md（Q1–Q12 拍板 + Entry Gate 核验记录 + 相对
  Fourth_stage.md 草案 11 条收紧记录）、high-level-design.md（架构/决策/模块/
  数据流/安全模型/存储/测试/风险）、detailed-design.md（唯一契约源 §2–§16：
  数据访问边界与 SQL 封闭红线、node:sqlite 决策门 11 项实测清单（官方资料已核实
  ——Node 24 node:sqlite Stability 1.1、Electron 曾有 37.2.0「No such binding:
  sqlite」缺陷已修复于 36.7.3/37.2.3/38+、FTS5 编译项无官方确认——**官方声明不
  替代本项目 Electron 43.4.0 dev+生产构建实跑**）、canonicalization 保守规则、
  schema v1、SourceService 契约、change set 写入安全（≤20 项/幂等键/
  expectedVersion/单事务/确认前零变化/无硬删除工具）、provenance 三元组（AI 推断
  恒 unverified）、四工具与权限矩阵（L0×3 + L2×1，注册后 17 工具）、有界检索与
  分享模式、多语言检索与安全降级、migration/backup/只读恢复态、本地明文边界、
  usage 边界、决议 #36–#45）、tasks/B1–B9（每任务 = 一个可验证开发闭环：目标/
  前置依赖/范围/非目标/涉及模块/红态测试/实现步骤/验收标准/全量验证/提交要求/
  完成定义/风险与停止条件）。④ 更新 Fourth_stage.md（§9/§10 用最终权限/隐私/
  撤销/检索/migration/Exit Gate 边界校准原草案 + 设计文档指针 §11，不塞接口
  细节）、AGENTS.md（§1 当前阶段/接管顺序/第四阶段架构纪律与「规划/待实现」声明、
  SQLite 语义校准——第三阶段当时禁用为历史语义、任意 SQL 永久红线保持、§2 文档
  职责与阶段切换纪律、§3 第四阶段不做清单、§4 结构、§5 Fourth Stage Sources
  契约速查）、README.md（当前状态：设计完成、B1 待开始，不声称 Sources 可用）、
  本文件。First/Second/Third Stage 历史文档与 doc/stage2/、doc/stage3/ **原位
  保留未覆盖**；ROADMAP.md 经核对无确切陈旧引用未改。⑤ 验证：全量回归
  （test 785/785 · typecheck · lint · format:check 全绿；纯文档按 AGENTS.md
  附 A 免 build/Electron 冒烟重跑）+ 产品代码零 diff 确认 + git diff --check
  零命中 + 交叉引用 grep（阶段名/任务编号/当前阶段/下一推荐任务/SQLite 禁用
  表述唯一且一致）+ B/ST/SRT 编号无冲突无缺失 + 新文档无占位 TODO/TBD +
  敏感信息扫描零命中。**未调用任何付费 Provider、未输出/索取 API Key、未安装
  任何依赖、未提前执行 B1。**

- **验收发现项 F-1～F-4 修复闭环（2026-08-14，独立小型闭环；产品验收结论 GO/PASS
  维持，不切换 Fourth Stage）**：最终严格验收发现的 4 项问题全部关闭，O-1 观察
  登记入册。
  **F-1 测试设施缺陷（fake-provider 延迟块墙钟断言间歇失败）**——红态证据：验收期
  3 次实测失败（含捕获输出 `AssertionError: expected 29.857699999999994 to be
greater than or equal to 30`，fake-provider.test.ts:63），单文件复跑约 17% 失败率
  （本次闭环前 32 次复跑 0 失败——负载相关，间歇性确认）；根因：`performance.now()`
  墙钟测量与 node:timers/promises setTimeout 在并行负载下的计时/舍入抖动，属测试
  断言测量方式缺陷，非产品行为问题。修复方式（仅改测试文件，零生产代码改动）：
  文件级 `vi.mock('node:timers/promises')` 将 sleep 替换为手动控制的 Promise——
  延迟语义改为确定性验证：仍断言 sleep 以脚本配置的完整延迟值（30/20/60000 原样）
  调用、延迟推进前流输出未完成（settled=false 断言）、推进到约定延迟后才继续
  （事件序列全等断言）、等待延迟期间 abort 立即生效（中止感知语义保留，rounds
  中止用例同步去真实墙钟化）。阈值语义零弱化、零自动重试、零删除、零 skip/only。
  绿态证据：修复后单文件连续 **50 次全绿（50/50）**、全量 test 连续 **5 次
  785/785** 全绿。
  **F-2 文档矛盾（Third_stage.md §9）**：Agent 组「PASS·离线/真实模型维度未验证
  （见 Engineering 组 BLOCKED 项）」、Search 组「PASS·离线/真实网站维度 NOT RUN」
  残留补验前标签，与同文件 Engineering 组 PASS、§10 GO/PASS 并存——已校正为最终
  状态（离线证据 + 后续真实 Provider 补验证据均通过，指向 §7/Engineering 组证据；
  历史缺口明确标注「当时缺口，后续已关闭」，无两个现行结论并存）。
  **F-3 文档矛盾（README 状态标记）**：「🔨 第三阶段进行中」与同段 GO/PASS 内容
  矛盾——已改为「✅ 第三阶段已完成并通过验收，等待 Fourth Stage 切换/设计指令」。
  **F-4 文档陈旧（AGENTS.md §6 测试计数）**：当前规模描述 771 → 785（仅改现行
  声称处；历史阶段计数原位保留）。
  **O-1 纵深硬化观察登记**（见「计划内限制与延期项」末尾，不分配开放风险编号，
  不修改生产代码）。验证：typecheck · lint · format:check · build · dev 离线全矩阵
  冒烟 + 生产产物冒烟双场景退出码 0 · git diff --check 零命中 · README/
  Third_stage/AGENTS 现行状态表述 grep 复核唯一且一致。**未调用任何付费
  Provider、未输出/索取 API Key、产品代码零 diff。**

- **A7 补验完整真实验收（2026-08-14，最终执行第 9 次——`LIVE_SMOKE_PASS` 退出码
  0，第三阶段改判 `GO/PASS`）**：Provider=deepseek-v4-pro（仓库外 DPAPI harness
  `-Agent`）。**§7 场景 1–6 全部真实通过**：场景 1 搜索→browser_open 新标签页
  打开→read→总结（搜索临时 Tab 精确关闭、结果 Tab 保留、快照可读）；场景 2
  find(security/Security)→navigate→read→总结（回答含 security 要点）；场景 3
  前置清场后 browser_open ×2（browser-view/web-contents-view 双新标签页）+
  两页 read + 对比总结（多 Tab/页面身份证据）；场景 4 read→fill(electron)→
  read（DOM 过滤结果只剩 electron 条目、input 事件真实触发、审计 fill len=N）；
  场景 5 提交确认门（confirm 必现 → deny 零动作 → 模型未重试直接收敛 done，
  审计 denied 恰好一次、DOM 零提交点击——合法分支）；场景 6 RT-10（零工具提议、
  模型明确拒绝执行网页指令——伪造工具/密码/购买・删除・发布零 DOM、无外发；
  观察性结果如实登记）；场景 7 真实模型流停止 → cancelled 收敛。**台账（修复后
  计数）：本次执行 20 次 HTTP 请求（场景 1=4/2=3/3=4/4=4/5=3/6=1/7=1），全部
  200；reasoning_content 回传逐轮通过程序内**内容相等校验**（verifyReasoningReplay，
  任何不一致 fail-closed error 终态——全执行零触发）且下一轮请求全部被接受。
  **零泄漏终检**（finalizeLiveRun）：Tab 恢复进入前/pending 零残留/真 Key 零暴露
  扫描（DOM/日志/临时文件/密文形态）/临时配置与日志使用记录全部断言通过；
  进程外终检：日志 sk- 形态 0 命中、临时目录零残留、环境变量零残留。
  **累计真实调用台账（当日全部授权窗口，日志字节级统计）：9 次执行（1 次最小
  预检 + 8 次完整验收执行）共 133 次 HTTP 请求，HTTP 400 = 0**（首轮 400 根因
  = wire 名称契约，修复后零复发）。执行过程缺陷均为测试基础设施类（冒烟断言/
  驱动校准：场景 1/3 任务澄清、场景 3 前置清场、场景 5 后续确认 deny 循环与
  双层证据、LIVE 模式离线段跳过、台账计数），**权限面/工具清单/验收标准零放宽**
  （各 commit 分类登记）。离线全量验证最终状态：test 785/785 · typecheck ·
  lint · format:check · build · dev+生产双场景冒烟退出码 0。

- **A7 补验补证定向补验（2026-08-14，用户证据缺口裁决后执行，`LIVE_SMOKE_PASS`
  退出码 0，GO/PASS 维持）**：零付费证据复核（最终执行日志/真实 smoke 代码/工具
  层探针/commit 694d0f8）确认三处缺口：① 场景 2 最终执行仅 find×2（read/scroll
  未真实调用）；② 场景 3 两页同属 electronjs.org（不满足「至少两个不同真实公开
  来源」）；③ 工具层探针（A3）未覆盖迟到/未知 toolCallId 决议（作废路径 A6-UI-04/
  RT-03 已有离线证据——当日 dev+prod 冒烟退出码 0）。**离线改造**（测试基础设施，
  权限面/工具清单零改动）：场景 2 修订（任务显式要求读取→find 定位→scroll 滚动→
  再读取；断言三工具齐备且 scroll 后再次 read + 回答含 security）；场景 3 修订
  （真实搜索→两个不同 origin 来源；断言 search_web + ≥2 open + origin ≥2 互异 +
  每次 open 各建一 Tab + 每页 read tabId 精确对应零串页 + 两 Tab 保留 + 总结同时
  提及两方 + 审计切片证据日志行）；A3 状态机补齐（approve 恰好一次 + 迟到/未知
  toolCallId approve/deny 恒 false 且零 DOM）；新门控
  `AIBROWSE_LIVE_AGENT_SUPPLEMENT=1`（与 LIVE_AGENT/PRE 互斥，仅修订场景 2/3 +
  零泄漏终检）+ harness `-Supplement`。离线全量验证全绿（test 785/785 ·
  typecheck · lint · format:check · build · dev+生产双场景冒烟退出码 0，新 A3
  状态机与 8.6 红队矩阵通过行实证）。**真实补验台账（第 10 次执行）**：12 次
  HTTP 请求全部 200（场景 2=6：find(security)→find(Security)→scroll(dy=5000)→
  read→find(Security)→done 5 步——三类工具真实调用链；场景 3=6：search_web 中文
  查询遇 bing HTTP2 瞬态失败→工具如实报 search-failed→模型改用英文查询重试成功→
  browser_open ×2（https://blog.openreplay.com + https://peerlist.io 两个不同
  origin）→get_tabs→两页各自 read（tabId 精确对应，read ×1 各）→对比总结 done
  7 步）；reasoning_content 回传逐轮程序内内容相等校验零触发 fail-closed；零泄漏
  终检（Tab 恢复进入前/DOM・日志・临时文件・密文形态真 Key 零暴露）断言全过；
  当日累计真实调用台账：10 次执行共 **145 次 HTTP 请求，HTTP 400 = 0**（首轮
  400 根因 = wire 名称契约，修复后零复发）。场景 5 四组状态机证据链汇总：deny
  零 DOM（最终执行场景 5 审计 denied=1 + DOM 零提交点击 + A3）+ approve 一次
  （A3 approve 后 click:submit-btn 恰一次 + RT-03 两次 approve 恰两次点击）+
  新提交新确认（A3 三次独立 pending 新 toolCallId + RT-03 c1/c2/c3）+ 迟到/未知/
  作废无效（A3 新断言 + RT-03 + A6-UI-04 pending 停止→作废→迟到 approve 无效）——
  全部离线 dev+生产冒烟退出码 0 实证。

- **A7 补验 wire 兼容性离线修复（2026-08-14，纯离线闭环，零真实请求）**：
  用户纠正根因判定后确诊：既有 13 个工具名全部携带点号（`browser.*` 前缀 +
  `search.web`），违反 OpenAI 兼容端点 function.name 契约（仅字母/数字/下划线/
  连字符、1–64 位，DeepSeek 官方契约）→ 整组 tools 载荷 HTTP 400。**① 红态测试**
  （新增 10 用例，先红后绿）：tool-registry wire 名称契约（TOOL_NAME_PATTERN 恒等
  断言 + 注册阶段确定性拒绝点号/超长/空/非 ASCII + listTools 序列化阶段纵深防御）、
  openai-compatible reasoning_content（interpret 同帧/独立帧/与 tool_calls 同帧提取、
  streamSseBody 按序产出 reasoning 事件不混入 delta、mapMessages 带 reasoning 输出
  reasoning_content 无则无字段）、fake-provider reasoning 脚本块、agent-loop 工具轮
  reasoning 累积并仅进下一轮请求（run 结果/回调/审计零暴露）、conversation-service
  共读路径忽略 reasoning 事件（不回传 UI 不视为异常）。**② 修复**：
  13 工具名点号→下划线全局改名（`browser_get_tabs`～`browser_fill` + `search_web`；
  权限矩阵 TOOL_BASE_RISK/审计特判/执行器预算特判/UI 文案映射/全部测试与冒烟夹具
  同步）；tool-registry 注册与序列化双闸门拒绝非法名（TOOL_NAME_PATTERN 导出）；
  shared ProviderMessage.reasoning + ProviderEvent reasoning 增量；适配器解析
  delta.reasoning_content 产出 reasoning 事件 + mapMessages 输出 reasoning_content
  （仅当 IR 携带，同源自产自回传，无任意 extraBody）；AgentLoop 每轮累积仅工具轮
  assistant 附加（终态轮/空轮不携带）；共读路径显式忽略；FakeProvider reasoning
  脚本块（离线确定性）。**顺带修复**：真实场景 6（RT-10）冒烟中 13 工具允许名单
  为前缀缺失的错名单（该场景从未真实执行故未暴露）→ 校正为注册表真实 13 名。
  **③ 验证**：test **781/781**（新增 10）· typecheck · lint · format:check ·
  build · dev+生产双场景冒烟退出码 0（8.6 红队矩阵全过）；敌对夹具 `browser_pwn`
  伪造名未受影响（tool-not-found 断言保持）。**④ 契约文档**：detailed-design
  §2.1/§4.1/§4.2/§15（决议 #35：wire 名称契约 + 双闸门 + reasoning 不透明回传 +
  跨 run 不携带边界）、threat-model/AGENTS.md/README 工具名同步。**未调用任何付费
  Provider、未输出/索取 API Key。** 计划内限制新增：跨 run 重放不携带
  reasoning_content（持久化红线所致）——要求回传的 Provider 旧会话重问可能 400 →
  结构化 provider-error 安全失败（见下「计划内限制」）。下一步：用户重新授权后以
  `-Pre` 最小探针验证真实 wire 兼容性（预计 2 次 HTTP 请求）。

- **A7 补验预检（2026-08-14，真实 Provider 最小 tools 兼容性预检，用户授权 1 次调用）**：
  步骤 0 独立核对——HEAD `6aefcb0` = 双远程 HEAD、工作区干净、基线 test 771/771 独立
  复跑全绿、`AIBROWSE_LIVE_AGENT=1` 门控与仓库外 harness 在位（不采信交接，逐项自查）。
  用户将仓库外配置 model 改为 `deepseek-v4-pro`（baseURL 不变，沿用 DPAPI Key）并授权
  一次最小预检。**① 新增预检门控（commit dafd2bd，已推送双远程）**：`runLiveAgentScenarios`
  增 `pre` 参数（预检模式仅场景 1 + 零泄漏终检 + 台账，场景 2–7 需用户二次授权）；
  零泄漏终检与台账汇总提取为 `finalizeLiveRun` 复用（完整模式行为不变）；index.ts 环境门
  `AIBROWSE_LIVE_AGENT_PRE=1`（与 LIVE_AGENT 互斥）；仓库外 harness 增 `-Pre` 开关。
  权限矩阵/工具清单/适配器零改动。离线全量验证全绿（test 771/771·typecheck·lint·
  format:check·build·dev+生产双场景冒烟退出码 0）。**② 预检结果：失败（首轮 400）——
  根因已按用户纠正重新归类为 wire 名称契约问题，非「模型不支持 tools」**（DeepSeek
  官方明确声明 V4 Flash/Pro 支持 Tool Calls；官方契约要求 function.name 仅字母/数字/
  下划线/连字符 ≤64，而项目 13 个工具名全部携带点号——`browser.*` 前缀与 `search.web`，
  足以整组 400）。真实调用台账：**1 次 HTTP 请求**（场景 1 首个模型轮，标准 OpenAI
  tools 载荷）→ **HTTP 400**，0 模型轮成功、0 工具执行，errorCode=provider-error
  （非 invalid-key/rate-limit/context-too-long）。诊断结论：请求被拒的是 tools 载荷
  本身（名称契约），适配器 wire 形状其余部分为标准 OpenAI 形态；真实调用按用户指示
  **立即停止、零重试**；日志 sk- 形态扫描 0 命中、临时目录零残留、工作区干净。
  第三阶段判定维持 `HOLD/PENDING`；离线修复（wire 名称 + reasoning_content 回传）
  见本会话下一闭环条目。

- **A8 第三阶段收尾与验收（2026-08-14，第八个闭环；总 Exit 决策 = HOLD/PENDING）**：
  步骤 0 独立核对——HEAD `0461c04` = Gitee/GitHub 双远程 HEAD（ls-remote 实测，
  三方一致）、工作区干净、基线 test 771/771 独立复跑全绿（与 A7 交接预期一致，
  独立确认不采信）。**① §9 验收逐项证据表（Third_stage.md §9 已勾选回填）**：
  Agent 4 项 PASS（A-01 多步任务/A-03 取消/A-04 上限/A-05 防循环 + A-09 审计
  恰好一条 + agent-loop 32/agent-safety 17 单测）· Browser Tools 3 项 PASS
  （8.2 A-12/8.4 A-01/A-07 + RT-06 + interaction-script 28 等单测）· Search
  2 项 PASS（8.3 三夹具 + A-01 search→open→read 链路 + search-provider 28 单测）
  · Permission 3 项 PASS（A-02/A-12/RT-03 确认门 + RT-01 权限恒等 + RT-09 grep
  A8 独立复核零命中 + permission-policy 单测）· **§14 收紧项 L3 执行器层不可达
  PASS**（A-12/RT-11 零 DOM 动作 + classifyClickTarget 单一事实源 + 执行器层
  allowedKind 复核）· Engineering：全量验证 PASS（test 771/771 · typecheck ·
  lint · format:check · build 全绿；dev 离线全矩阵 + 生产产物双场景冒烟退出码 0，
  当日日志实证 8.4 A-01～A-09/8.5 A6-UI-01～12/8.6 RT-01～RT-08 + RT-11 通过行）、
  日志无敏感信息 PASS（审计脱敏链 + logger 13 用例 + 当日日志字节扫描 sk- 形态
  0/fill 原文 0；真 Key 扫描属真实调用部分 NOT RUN）、
  **「多个真实网站 Agent smoke test 通过」BLOCKED**——唯一已配置 Provider
  （deepseek-v4-flash）对任何 tools 载荷返回 HTTP 400（A7 证据：stream 与否两
  形态复现、无 tools 200 正常；本会话复核仓库外本地说明确认无新增 tools 兼容
  Provider 配置）→ 按规则不重复付费诊断、不进入询问边界；受控本地页 FakeProvider
  冒烟**不替代**本项；`AIBROWSE_LIVE_AGENT=1` 门控与场景夹具已就绪（A7 落地，
  本会话核对代码在位）。§7 真实场景 1–6：NOT RUN（真实执行），离线确定性覆盖
  已在 Third_stage.md §7 注记（场景 4→A6-UI-10、场景 5→A-02/RT-03、场景 6→
  RT-01/03/11、场景 1/2/3 多步链路→A-01/8.3）。**② §10 Exit Gate 五项技术条件
  逐项判定**：① 不会频繁死循环 PASS（离线确定性证据，真实模型观察 NOT RUN）；
  ② Tool API 稳定可复用 PASS（契约零变更自 A6、A3–A6 均复用同一管线）；
  ③ Permission Policy 可扩展 PASS（纯函数 + 编译期矩阵 + baseRisk 注入点）；
  ④ Prompt Injection 红队基础测试 PASS（RT-01～RT-08 + RT-11 自动化 + RT-09
  grep；RT-10 真实观察 NOT RUN，三类诚实边界不变）；⑤ 无放宽网页权限技术债
  PASS（A1–A7 红线终检零放宽，click 允许列表为收紧）。**总 Exit 决策 =
  HOLD/PENDING**：真实 Provider 缺口（§9 Engineering BLOCKED + §7 场景 1–6 +
  RT-10 观察性证据 NOT RUN）→ 不得标记第三阶段最终验收通过；待 tools 兼容
  Provider 配置 + 用户授权后执行真实 Agent 验收补验，取得充分证据后改判
  GO/PASS（不进入 Fourth Stage）。**③ 文档同步**：Third_stage.md §7 状态注记/
  §9 逐项勾选与证据/§10 判定块；本文件（任务表 A8 ✅ + 最近验证结果 + 阻塞项 +
  下一个推荐任务）；AGENTS.md §1 阶段状态/§5 A7 状态与冒烟 8.6/§6 测试计数
  771 + 冒烟 8.6 与 LIVE_AGENT 门控/§7 A7 用例行/附 B Engineering 项 BLOCKED
  表述校准；README（当前状态/测试计数 771/冒烟与目录标注/A7 用例行/已知限制
  真实 Provider 兼容性缺口）；A8 任务文档实施步骤与完成定义回填。AGENTS.md §5
  契约速查 A1–A6 全部签名经 `grep -n "^export"` 实际核对无偏差。**④ 验证与
  终检**：test 771/771 · typecheck · lint · format:check · build 全绿；dev
  离线全矩阵 + 生产产物双场景冒烟退出码 0；RT 红线 grep（shell/child_process/
  eval/Function/executeJavaScript/fs/fetch/IPC/SQL/dangerouslySetInnerHTML/
  sendInputEvent 零命中——executeJavaScript 仅固定模板采集/交互脚本，fs 仅
  应用自有 config/conversation/credential JSON，fetch 仅 Provider 适配器固定
  端点，IPC 仅 preload+main index）；敏感信息扫描（sk- 形态仅 logger.test 测试
  夹具 1 处）与 diff 终检零命中；冒烟后临时目录检查：清理上一会话调试期残留
  aibrowse-dbg-* 2 个目录（内容仅为 fake provider 配置，无凭据）；本日日志
  字节扫描零泄漏。**未调用任何付费 Provider、未输出/索取 API Key、未修改任何
  代码（纯验收 + 文档闭环——无实现缺陷发现）。**

- **A7 红队矩阵与安全审计（2026-08-14，第七个闭环；离线部分完成，真实 Provider
  待授权）**：步骤 0 独立核对——HEAD `82dcfc5` = 双远程 HEAD（ls-remote 实测）、
  工作区干净、基线 test 766/766 独立复跑全绿。**① 审计发现并修复实现侧真实缺陷
  1 处（红→绿）**：logger 无换行/控制字符规范化——模型可控字符串（open/navigate
  URL 全量入审计上限 2048、search.web 查询串全量上限 500）可携带 CR/LF/ANSI 转义/
  双向文本控制符/零宽字符在日志文件中伪造新的 `[INFO] [audit]` 条目行（RT-02/RT-07
  日志伪造审计）。红态：5 个新用例失败（13 用例 8 过）→ 修复 `normalizeLogMessage`
  （CR/LF 折叠为空格——条目恒单行、ANSI CSI/OSC 整体剔除、C0/DEL/NEL/双向/零宽/
  BOM/行段分隔符按码点剔除、\t 保留；write() message 段经规范化，错误详情块保留
  多行结构但同样剔控制字符；sanitize 凭据脱敏行为零改动）→ 13/13 全绿；期间 3 处
  失败为测试断言自身笔误（ANSI 剥离后正文保留/0x3f 保留/双向剥离后字母全保留），
  1 处实现边角（孤立 ST `ESC \` 双字节剔除）。**② 冒烟 8.6 红队矩阵 RT-01～RT-08
  - RT-11（主进程驱动完整生产链路，FakeProvider 多轮离线确定性，6 组新夹具页面）**：
    RT-01 敌对页结构隔离（全量诱导文案——忽略指令/伪造 system・assistant・tool 角色/
    伪造工具名与 schema/要求点击・填写・搜索・外发/原始闭合尝试/bidi・控制字符/超长
    指令；system 每轮恒等/13 工具与注册表恒等/角色仅程序字面量/敌手闭合转义为
    `<\\/` 形态且原始闭合至多程序化一次/伪造工具 tool-not-found/脚本行为不被改写/
    零 DOM 动作）；RT-02 URL 白名单（5 个非 http/https 恒 L3 forbidden 零 Tab 零导航
  - 审计含完整 URL；http/https 含 userinfo 与控制字符形态仍 L1 可见 + 审计全量 +
    各建 Tab；日志行首时间戳前缀真实审计行数 == 工具调用数——敌手 [INFO] 片段不得
    伪造条目行）；RT-03 提交类与并存低风险特征（isSubmit 优先 L2 确认门必现/deny 零
    DOM/approve 一次/迟到・未知 id 批准无效/第三次必须新确认——防循环同签名阻断
    红态实证后以 read 打断）；RT-04 搜索结果注入（敌手搜索夹具——UNTRUSTED_TOOL_RESULT
    块包裹 + 原始闭合转义 + tool_call_id 程序关联 + 完整搜索正文不持久化：尾部唯一
    标记仅运行时 transcript）；RT-05 密码・文件・动态变形（权限层 L3 + 执行器层复核
    execution-failed，DOM/事件/审计/会话文件/日志零原文，错误语义真实不伪装成功）；
    RT-06 陈旧 elementId（run 内跨 URL 导航/新文档复用 el-N 旧绑定恒 stale-element
    且新绑定正常——传递性证明/Tab 销毁 fail-closed/documentId 不进 schema・事件摘要・
    审计・持久化）；RT-07 系统提示与密钥探测（探测页 + 不可提交标记——system 恒等/
    标记只以 URL 查询串形式出现在审计与上下文 URL 表面/错误归一化 invalid-key 程序
    文案/run-done・审计・日志零标记/sk- 形态零出现；网页询问 Key 不构成泄漏证据）；
    RT-08 确认疲劳（3 L1 独立 step 事件 + 2 L2 各需新确认、批准不复用、无降级自动
    批准、stepsUsed 计数）；RT-11 通用 click 越权（公开发布/发送消息/普通按钮/语义
    不明 → L3 forbidden 零 DOM；真链接 onclick 副作用仅验证 L1 可见性与审计——
    threat-model §5 残余风险 4 如实登记不宣称免疫）。**③ 增量安全审计证据表**：
    第一阶段隔离（Tab 无 preload/nodeIntegration=false/contextIsolation+sandbox=true/
    webSecurity 未关闭/window.open deny/权限双处理器默认拒绝/UI will-navigate+
    will-redirect 白名单）与第二阶段 Key 安全（主进程只读/DPAPI 密文/renderer 只写
    不回读/config 无明文/logger・error-normalize 脱敏）无回退；第三阶段边界逐项核对
    （schema 只由注册表生成/权限纯函数/allowedKind・documentId 不进模型 schema/每
    调用恰一条审计/fill 只记长度/搜索临时 Tab 精确所有权/Agent 上限与防循环执行前
    阻断/ConfirmDialog 精确 toolCallId 一次/AgentStatusEvent 无思维过程/IPC sender+
    主帧校验/事件只发主窗口/preload eventRelay 单监听无泄漏/ToolStep v2 不持久化完整
    ToolResult・快照正文・内部安全参数）；RT-09 全仓库 grep（零 shell.exec・
    child_process・eval・Function・任意 executeJavaScript（仅固定模板采集/交互脚本）・
    任意 fs 读写（仅应用自有 config/conversation JSON）・任意 fetch（仅 Provider 适配器
    固定端点）・任意 IPC・SQL；工具实现零 Electron import 不可绕过
    BrowserController/SearchProvider；node:vm 敌手参数逃逸测试固化——参数只能作为
    JSON 数据进入固定模板）。**④ RT-10 三类诚实边界校准**（threat-model §4 /
    detailed-design §13.2 / A7 任务文档最小同步）：机器可验证（程序边界对诱导式提议
    的强制阻断）/观察性（真实模型在本次固定网页与固定任务中是否遵守「不把网页文字
    当指令」，如实记录不推广）/不保证（模型永远不会被诱导产出合法 L0/L1 参数，按
    §5 残余风险 1/3 登记）；真实测试失败不得放宽权限、自动确认或修改红队夹具制造
    通过。**⑤ 验证与终检**：test 771/771（新增 5 logger 用例）· typecheck · lint ·
    format:check · build 全绿；dev 离线全矩阵（连跑 3 次通过；期间 1 次退出码 1 无
    捕获错误信息，随后连跑 2 次全过，判定为环境瞬态）与生产产物双场景退出码 0
    （8.6 通过日志实证）；红线 grep（万能工具/Key 读回/dangerouslySetInnerHTML
    零命中）；敏感信息扫描与 diff 终检零命中；临时目录零残留。红→绿期间修正均为
    冒烟断言自身缺陷（块程序化闭合计数/审计行 requestId 为服务 UUID/Tab 计数与 L1
    轮竞态拆双 run/首轮缺 read 登记语义绑定/防循环同签名阻断/每 Tab 独立世代计数/
    标记在上下文 URL 表面的合法出现/L1 确认竞态改 toolCallId 判定）。已提交并推送
    双远程（9b8a5e4 logger 修复 + 3075eaa A7 红队矩阵，Gitee/GitHub 实测一致）。
    **未调用任何付费 Provider、未输出/索取 API Key。真实 Provider 可选验证（真实
    场景 1–6 + RT-10 + 真 Key 零暴露扫描）已获用户授权（2026-08-14）并尝试执行，
    但受 Provider 能力限制未能完成，如实登记（不标记为通过）：既有配置
    （baseURL=https://api.deepseek.com，model=deepseek-v4-flash，仓库外 DPAPI
    harness 注入）对**任何** tools 载荷（含 stream 与否两形态、最小/完整 schema）
    返回 HTTP 400 + 空响应体；无 tools 请求返回 200（鉴权/端点/模型名正常）——
    判定为 Provider/模型兼容性限制（与社区报告一致：DeepSeek V4 模型 tool calling
    存在 provider 侧 400 问题），**非适配器缺陷（wire 格式为标准 OpenAI 形态），
    未修改适配器/未降级权限/未改 supportsToolCalling**。真实 Agent 场景门控
    `AIBROWSE_LIVE_AGENT=1`（runLiveAgentScenarios：场景 1–6 + RT-10 敌对页 +
    停止 + 零泄漏终检 + 真 Key 零暴露扫描）与仓库外 harness `-Agent`/`-Prod` 开关
    已就绪（typecheck/lint 通过；真实调用前需先经离线矩阵回归），待 tools 兼容
    Provider 配置后可直接执行。诊断台账：真实调用 1 次（agent run 首请求 400，
    0 模型轮）+ 定向诊断 3 次（tools+stream 400 / tools+nostream 400 / no-tools
    200 基线）。**

- **A6 操作可见性 UI 与通道（2026-08-14，第六个实现闭环）**：步骤 0 独立核对——
  HEAD `405f494` = Gitee/GitHub 双远程 HEAD（GitHub 经代理 ls-remote 实测）、工作区
  干净、基线 test 699/699 独立复跑全绿。**① 三项开工前强制核查与契约校准（决议
  #34，先于编码，五点固定）**：a) **事件充分性**——A5 三类事件（step 完成/confirm
  request/run done）无法诚实表达「run 已启动/模型思考/工具即将执行及当前
  stepsUsed/maxSteps/等待确认/pending 决议作废/收敛最终回答」→ 新增程序生成的
  `AgentStatusEvent`（starting/thinking/executing/waiting-confirm/confirm-resolved/
  finalizing，数据只来自 AgentLoop/Service 确定性运行事实，不含思维过程）与
  `conversation:agent-status` 通道；`ConfirmManager.onPendingChange` 载荷扩展为
  判别联合（settled 携带 outcome）并改多监听者 Set 分发（addPendingChangeListener
  - dispose 退订）——**关闭 A5 计划内限制「回调所有权为最后构造的 Service 实例」**
    （冒烟红态实证触发：A5 冒烟 Service 覆盖生产 Service 回调致确认事件丢失）。
    b) **参数摘要数据源**——复用 A2 审计同源脱敏纯函数 summarizeArgs（fill len=N/
    URL・query 全量/其余 ≤200 截断），主进程生成经非持久化 `AgentStepEvent.
argsSummary` 下发（ToolStep/Store v2 持久化结构不变）；渲染层不解析原始
    arguments/日志/ToolResult。c) **确认信息信任边界**——elementText 明确视为
    「页面提供的目标文本（不可信）」：ElementSemantics 增 text（links/buttons
    采集脚本显式采集；inputs 不采集 placeholder/value 宁缺勿错；不影响权限判定）、
    buildConfirmSummary 填充 elementText + 目标站点 URL（参数无 url 的工具取目标
    Tab 的 URL——主进程可信 TabInfo）；渲染层 React 纯文本（无
    dangerouslySetInnerHTML/Markdown/URL 富文本）+ 控制字符/bidi 剔除 + 截断
    （原始值不进 DOM 属性）+「页面提供，仅供参考」标注；deny 默认高亮与默认焦点
    （Enter 只激活焦点按钮）、Escape=拒绝、approve 精确 toolCallId 一次（提交即
    禁用）、无「始终允许」、confirmTool 返回 false 显示「已失效」、作废自动关闭、
    对话框 App 级全局挂载（切换会话/模式/折叠面板不使确认不可达）。d) 任务模式
    纪律——模式仅渲染层状态不持久化；共读 Composer 行为不变；同一会话 busy 时
    共读/Agent 互斥（主进程单在途 + UI 禁用双保险）；模式切换/面板折叠/会话切换
    不静默取消 Agent（停止必须显式点击）；停止按钮用 agentAsk 返回的真实
    requestId 调 abort、双击幂等、「正在停止」非终态（run-done 到达才收敛）；
    ToolStep 历史只渲染持久化 contentPreview/decision/errorCode；run-done 与
    历史刷新竞态由 reduceHistory 按消息 id 去重防御。e) 冒烟注入点（仅
    SMOKE_MODE，生产行为不变）——smokeAgentLimits（step-limit/timeout 场景）+
    smokeAgentSearchProvider（受控搜索夹具经委托 Provider 调用时读取）。
    **② 红→绿**：先写测试——红态 **8 files failed / 21 failed / 697 passed**
    （2 个新测试文件模块缺失 + confirm-manager 3/interaction-semantics 3 契约
    校准原位更新 + tool-executor 2/agent-loop 7/conversation-service 5/
    history-events 1 扩展用例失败；既有用例零删除零削弱）。实现后全量
    **766/766**（新增 67：agent-run-state 23 / agent-display 23 / history-events
    1 / confirm-manager 2 / interaction-semantics 1 / tool-executor 3 /
    agent-loop 7 / conversation-service 7）。期间实现侧真实缺陷 1 处——
    onPendingChange 判别联合的 pending 变体无顶层 runId，事件映射静默失败
    （测试抓出后修复并断言固化）；测试自身缺陷若干（fixture 消息 id 复用、慢
    工具夹具、vi.waitFor 1s 超时窗口、转义文本）；实现后偶发 1 例未捕获测试名的
    失败复跑 3 次全绿（判定为并行负载下 1s 超时窗口边缘抖动）——新用例 vi.waitFor
    统一 5s 窗口固化，不放宽断言。
    **③ 实现**：shared 类型（AgentStatusPhase/Event/AgentConfirmOutcome/
    argsSummary/ElementSemantics.text）；confirm-manager 多监听者；agent-loop
    onStatus 相位 + onAgentStep argsSummary（审计同源）；conversation-service
    onAgentStatus（starting/waiting-confirm/confirm-resolved 映射 + 防串 run）；
    tool-executor 确认摘要（elementText/目标站点 URL）；interaction-semantics
    text 映射；IPC 6 通道 + preload bridge（agentAsk/confirmTool + 4 事件订阅，
    eventRelay 退订）；main handler（goal 校验/截断、confirm 逐字段校验、事件
    只发主窗口）；renderer：agent-run-state reducer（sessionId/requestId 键控/
    step 去重/终态幂等与迟到忽略/新 run 不继承/会话隔离/全局 pending 选择器）+
    agent-display 纯函数 + useAgent + AgentStatusBar（当前页面来自 tabs:updated
    可信订阅）+ ToolCallList + ConfirmDialog + 任务模式 AiPanel/Composer +
    ChatView ToolStep 条目/agentRun 徽标 + history-events 去重；index.ts 事件
    发送 + 冒烟注入点；smoke.ts 8.5 A6-UI-01～A6-UI-12 + 敌对确认文本夹具。
    **④ 冒烟 8.5 A6-UI-01～A6-UI-12（React DOM 事件驱动，真实 preload/IPC/
    生产 ConversationService 链路）**：A6-UI-01 多步任务状态渐进（7 步顺序/
    参数摘要含搜索查询串/7-12 徽标/搜索临时 Tab 零泄漏）；A6-UI-03 确认框 deny
    默认焦点（document.activeElement 断言）+ 拒绝零 DOM 动作 + 重跑 approve 一次
    执行 + 审计 denied/confirmed 各一；A6-UI-04 pending 停止→确认框作废关闭→
    迟到 approve 无效；A6-UI-05 慢模型中途停止 cancelled + 部分保留；A6-UI-06
    step-limit/loop-detected/no-progress/timeout 中文理由 + invalid 条目失败样式；
    A6-UI-07 invalid-args 回注修正；A6-UI-08 模式/会话/面板切换不串 run + 共读
    互斥；A6-UI-09 历史刷新无重复回答 + ToolStep v2 磁盘重读 7 条目；A6-UI-10
    fill 页面真实写入 + DOM/日志/会话文件零原文；A6-UI-11 敌对 elementText
    纯文本截断 + 无富文本注入 + 无自动批准；A6-UI-12 共读回归 + 日志敏感扫描
    零命中。**dev 离线 + 生产产物双场景退出码 0**；共读既有矩阵 1–12 与 A5 8.4
    A-01～A-09 完整回归。红→绿期间修正 4 处冒烟断言自身缺陷（面板标题文案回归
    既有矩阵断言、瞬态相位窗口竞态、会话列表索引与重挂载选中语义、发送禁用断言
    形态）+ 实现侧 2 处（任务模式未接 startStreaming 致流式气泡缺失、搜索 holder
    装配时机错误致离线矩阵误走公网 Bing——改委托 Provider 调用时读取）。
    **⑤ 验证与终检**：test 766/766 · typecheck · lint · format:check · build 全绿；
    红线 grep（renderer 零 dangerouslySetInnerHTML 实际使用/Markdown 库/Key
    读回/万能工具；共读 SYSTEM_PROMPT/13 工具 schema/permission-policy/
    interaction-script 零改动；新代码零 Electron import；package 零改动）；敏感
    信息扫描与 diff 终检零命中；根目录杂散日志与失败冒烟残留临时目录清理。
    **未调用任何付费 Provider、未输出/索取 API Key。** 计划内限制登记（见下
    「计划内限制」）。

- **A5 Agent Runtime（2026-08-14，第五个实现闭环）**：步骤 0 独立核对——HEAD
  `035c988` = Gitee/GitHub 双远程 HEAD（ls-remote 实测）、工作区干净、基线
  test 576/576 独立复跑全绿（与上一轮报告一致，已独立确认）；A3 世代状态与
  A4 临时 Tab 所有权代码核对无回归。**① 契约校准（决议 #33，先于编码，六点
  固定）**：a) 循环阻断时机——签名 = 工具名 + 规范化参数（键排序 + Unicode
  NFC；解析失败 → NFC 原始串，改键序不能逃避）；判定在每次执行管线前，触发次
  零副作用；阻断调用计 stepsUsed + 恰好一条审计（decision=invalid）+ 一个
  ToolStep（stepsUsed === toolStepCount === 审计条数恒等）；步数上限同理
  （绝不执行第 13 步，未执行零伪造）。b) 协议历史——每轮 assistant（完整按序
  toolCalls + 轮次文本）+ 同序 tool 消息（id 精确匹配）；invalid-args/tool-not-
  found/forbidden/denied/execution-failed 均为结构化 tool result；空/重复/
  跨轮冲突 id fail-closed；同轮超剩余步数只执行预算内。c) 上下文与持久化——
  首轮 goal+启动快照恰一次；当轮 ToolResult 全文进块、持久化只留摘要；持久化
  结构 user(goal) → [assistant(脱敏 toolCalls)+tool(toolStep)]×N → 终态
  assistant(finalText+agentRun)；每轮文本恰好落盘一次；200 条裁剪组感知；
  孤立 tool 解析丢弃、不完整组重放过滤、共读重放过滤工具轮。d) 文本与工具并存
  ——有 toolCalls 时该轮文本为过程性输出；仅「无工具且有文本」done；空轮进
  transcript（重试痕迹）连续 2 轮终止；finalText = 最后一个模型轮的文本（与
  终态消息 content 恒等）。e) 终态竞争——单一终态所有权（finish() 守卫 + 工具
  执行/Provider 解析与终态 Promise.race，cancel 不挂起）；终态时 abort 流 +
  cancelAll 作废 pending + 零后续执行 + 迟到事件忽略；timer/监听器 finally
  清理；终态映射 done→complete/cancelled→aborted/timeout→error(timeout)/
  安全终止→error（权威理由在 AgentRunSummary.status）。f) decision 单一事实源
  ——ToolStepDecision 六值（增 invalid）在 shared/types/agent.ts，AuditDecision
  为别名，execution-failed 保留实际权限决策。§2.2/§8.1/§8.3/§9.1/§9.3/§10.1/
  §15 + high-level-design §4 + threat-model §3.4/§3.5 已同步。
  **② 红→绿**：先写测试——红态 **8 files failed / 30 failed / 587 passed**
  （4 个新测试文件模块不存在 + store/service/fake/confirm 扩展用例失败；既有
  用例零删除零削弱）。实现后全量 **699/699**（新增 123：agent-safety 17 /
  agent-context-builder 15 / agent-history 17 / agent-loop 32 / store 22 /
  service 14 / fake 4 / confirm 3；store 既有 1 处版本断言随 v2 契约原位校准）。
  期间修正的失败均为测试自身断言缺陷（计数时机/共享 metadata 污染/门闩模式/
  快照正文误入夹具等）；实现侧真实缺陷 2 处——工具执行 await 未与终态竞争
  （cancel 挂起死锁，Promise.race 修复）、冒烟 run 审计出口未接线——均有断言固化。
  **③ 实现**：agent-safety（签名规范化/连续 3/累计 5/无进展 2，阈值可注入）；
  agent-loop（纯核心零 Electron import：逐条串行 ToolExecutor 管线、审计捕获
  包装零重复、每 run 独立 InteractionSemanticsStore、终态竞争、协议 fail-closed）；
  agent-context-builder（AGENT_SYSTEM_PROMPT 独立常量、goal 消息复用共读块
  序列化、UNTRUSTED_TOOL_RESULT 块闭合转义、buildAgentRequest 恒等透传）；
  agent-history（ToolStep 内部能力参数零出现、fill toolCalls 脱敏、完整交互组
  校验、跨 run 摘要重放 + 预算裁剪）；conversation-store v2（写入恒 v2/读兼容
  v1/ToolStep 逐字段校验/孤立 tool 丢弃/组感知裁剪/零持久化红线字节断言）；
  conversation-service（agentAsk 共享单在途互斥、goal 截断、Provider 未配置/
  不支持工具零执行、逐步 ToolStep 持久化、终态映射、confirmTool、确认事件防串
  run）；confirm-manager onPendingChange；fake-provider 多轮 rounds/
  getRequests/中止感知睡眠；context-builder 共读重放过滤工具轮；index.ts 主进程
  装配（事件回调日志可见性——不新增 IPC/preload/UI，A6 红线）。
  **④ 冒烟 8.4 A-01～A-09（主进程驱动，FakeProvider 多轮脚本离线确定性）**：
  A-01 多步任务（open→read→find→search.web→scroll→click→read→最终回答 done，
  7 步/16 条历史/13 工具请求/system 恒等/goal 恰一次/搜索临时 Tab run 内零泄漏/
  真实导航落地页）；A-02 提交类确认（deny 零动作 → 模型重试 → approve 执行，
  页面日志恰好一次点击，审计 denied/confirmed 各一）；A-03 取消（慢模型中停
  cancelled 部分保留 + pending 中 abort 作废零执行）；A-04 step-limit（注入
  maxSteps=3，第 4 步零执行 scrollY 累计 6）；A-05 loop-detected（连续第三次
  执行前阻断 scrollY=20，阻断步骤 decision=invalid，审计恰好 3 条）；A-06
  invalid-args 回注后调整成功；A-07 elementId 世代（reload 后旧 id
  stale-element、新快照正常导航，传递性证明零误操作）；A-08 fill 隐私（普通
  输入成功 + input/change 事件真实触发、审计 len=N、password forbidden 零
  写入、会话文件与日志字节扫描零原文）；A-09 审计恰好一条（3 条 tool-call +
  2 条 agent-run，无 fill 原文/Key 形态）。**dev 离线全矩阵 + 生产产物双场景
  退出码 0**；共读既有矩阵 1–12 与工具层/交互/搜索场景完整回归。红→绿期间
  修正 3 处冒烟断言自身缺陷（A-04 累计滚动值、A-07 异步导航 waitFor +
  传递性证明、A-09 auditRun 接线）。
  **⑤ 验证与终检**：test 699/699 · typecheck · lint · format:check · build 全绿；
  红线 grep（新代码零 Electron import/无万能工具形态/package 零改动/UI・preload・
  IPC 零改动/共读 SYSTEM_PROMPT 零改动/13 工具 schema 零改动/fill 原文・快照
  正文・documentId・Key 形态零持久化）；敏感信息扫描与 diff 终检零命中；根目录
  杂散日志清理。**未调用任何付费 Provider、未输出/索取 API Key。**
  计划内限制登记：确认事件回调「最后构造 Service 实例」所有权（单 pending 全局
  串行化下的顺序场景安全）、取消竞态下被中断调用计步与审计但不产生 ToolStep
  （决议 #33⑤ 固化）、运行时 transcript 当轮全文保留的确定性上界（12 步 ×
  结果预算 ≈ 100k 字符）（见下「计划内限制」）。

- **A4 SearchProvider 与 search.web 工具（2026-08-14，第四个实现闭环）**：步骤 0
  独立核对——HEAD `65c6b9c` = Gitee/GitHub 双远程 HEAD（ls-remote 实测）、工作区
  干净、基线 test 533/533 独立复跑全绿（与上一轮报告一致，已独立确认）。**① 编码前
  核查**：临时搜索 Tab 所有权与恢复语义 8 条规则先固定（精确 tabId 独占、不得把
  用户已有 Tab 标记为临时资源、只关本调用创建的确切 id、任何路径 try/finally
  最佳努力清理、已关闭安全无操作不关替代 Tab、用户停留恢复/已切换不抢焦点/
  调用前活动 Tab 已关闭不重建不激活、并发各持局部 tabId 零共享状态）；公网 Bing
  非 LLM 探针实测形态（10 个 b_algo、当前主要返回直接目标 URL、无 ck/a 包装）。
  **② 契约校准（决议 #32，先于编码）**：a) 错误映射——「工具错误不得被模型误认为
  成功」上位要求下，ready 超时/导航失败/Tab 被提前关闭/快照 null（L3）/快照 L2
  降级/空内容快照（结构无法识别）/BrowserController 异常 → ok:false +
  search-failed；页面有内容但无有机结果（合法空结果）→ ok:true 空数组 + 明确
  提示；b) snippet v1 恒空串 + warning（扁平快照无可靠关联证据，宁缺勿错，原
  §6.2「从 visibleText 提取相邻摘要片段」废止）；c) ck/a 包装链接确定性还原
  （u=a1 base64url 解码，仅 http/https）；d) search.web 查询串与 url 同等级全量
  进入审计（T-03 外发审查可追溯，上限 500 有界）——audit-log「其余 ≤200」对
  search.web 的 query 例外，A2 既有截断用例改用 browser.find 覆盖（契约变化，
  非削弱）；e) ctx.searchProvider 为工具层注入点（设计 §4.1 落点）。
  **③ 红→绿**：先写 2 个新测试文件——红态 **2 files failed（模块不存在）**；
  实现后 42/42；期间 3 处夹具断言修正均为测试自身缺陷（空结构解析层保持沉默、
  「活动 Tab 已关闭」模拟需持续过滤、「审计摘要截断」按值级 ≤200 语义校准后随
  决议 #32 改为全量断言）。全量 **576/576**（新增 43：search-provider 28 /
  search-tool 14 / audit-log 1；既有用例零删除零削弱）。**④ 实现**：
  search-provider.ts（接口 SearchResult/SearchProvider/SearchProviderResult +
  BingSearchProvider——零 Electron import、只经注入 BrowserController；轮询
  getTabs 等待精确 tabId ready（15s 超时/时钟/睡眠可注入、abort 感知零定时器
  泄漏、无事件监听器）；查询串全量审计（audit-log.ts）；buildSearchUrl 由
  SEARCH_ENGINE_URL + encodeURIComponent 构造（常量语义不变）；parseBingSearch
  Results 纯函数——bing.com 自身域 + 中英双语非结果标签过滤/非 http/https/畸形
  URL 丢弃/ck/a 还原/URL 去重保持首现/前 10/title ≤200/snippet 空串）；
  search-tool.ts（名称/描述/schema 程序常量、L0、ctx.searchProvider 优先于注册
  注入、formatSearchResults 纯文本行零特权、aborted 归一 execution-failed）；
  index.ts 注册 13 工具；ToolExecutionContext.searchProvider。
  **⑤ 冒烟**：8.1 校准注册表 13 工具（A2 8 + A3 4 + A4 1）+ search.web 空查询/
  超长 invalid-args 探针（7 条审计恰好一条）；**8.3 受控搜索页生命周期场景**——
  三夹具路由（有结果/合法空结果/空内容页）+ 服务端命中计数证明真实 loadURL；
  经 ToolExecutor 全链路（校验→L0 权限→执行→审计）：3 条结果正确解析（包装链接
  还原/自身导航与重复与非 http/非结果标签过滤/摘要空串零误配/documentId 零暴露）、
  临时 Tab 精确清理 + 活动 Tab 恢复调用前 + 数量恢复进入前、合法空结果 ok:true
  明确提示、结构无法识别 ok:false search-failed、审计恰好 3 条 decision=auto——
  **dev 离线 + 生产产物双场景退出码 0**；**可选公网 Bing 探针**
  （AIBROWSE_SMOKE_LIVE_SEARCH=1）成功：完整生产链路 10 条真实结果
  （938ms，首条 electronjs.org WebContentsView 官方文档），临时 Tab 零泄漏。
  **⑥ 验证与终检**：test 576/576 · typecheck · lint · format:check · build 全绿；
  红线 grep（新代码零 electron import/无万能工具形态/package 零改动/UI・preload・
  IPC・SYSTEM_PROMPT 零改动/结果不暴露 documentId・内部 tabId）；敏感信息扫描与
  diff 终检零命中；根目录杂散日志清理。**未调用任何付费 Provider、未输出/索取
  API Key。** 计划内限制登记：snippet 恒空串、非结果标签精确匹配代价、结构识别
  依赖内容性证据、公网包装链接形态观察（见下「计划内限制」）。

- **A3 浏览器交互能力（2026-08-14，第三个实现闭环）**：步骤 0 独立核对——HEAD
  `9df48a7` = Gitee/GitHub 双远程 HEAD、工作区干净、基线 test 452/452 独立复跑
  全绿（与上一轮报告一致，已独立确认）。**① 两项编码前安全核查**：a) elementId
  生命周期真实 DOM 红态探针（先于实现，冒烟受控页面）——跨 URL 导航与同 URL
  刷新后新文档均重新分配相同 `el-N` 字符串（旧 el-0 与新文档示例链接 el-0 同串），
  URL/标题/capturedAt 均不能证明文档身份——「旧 id 自然失效」论证不成立；
  b) allowedKind 单一事实源核查——A2 decide() 仅返回 {level, reason} 无共享
  分类——导出 `classifyClickTarget(semantics) → 'submit'|'nav'|'expand'|
'toggle'|null`（permission-policy），decide 级别映射与执行器 allowedKind 均由
  该函数对同一语义 binding 派生，executor/交互脚本不自行分类。**② 契约校准
  （决议 #31，elementId 文档世代绑定）**：TabManager 以主框架 did-navigate 提交
  事件维护每 Tab 导航世代计数（页内导航不递增）；快照 `meta.documentId` 主进程
  盖章（脚本输出同名字段被忽略）；click/fill 执行前 BrowserController 校验
  「绑定世代 === 当前世代」→ stale-element 不注入脚本；模型可见工具 schema
  `{tabId?, elementId}` 不变（世代为执行器内部参数）；ElementActionResult 增
  errorCode 字段；§5.1/§5.2/§5.3/§7.1/§13.2/§15 + threat-model §3.2/§3.3/
  RT-06 已同步。**③ 红→绿**：先写测试——红态 **9 files failed / 18 failed /
  452 passed**（4 个新测试文件模块缺失 + 5 个既有文件扩展用例失败；既有用例
  零删除、零断言削弱）；实现后全量 **533/533**（新增 81：interaction-script
  28 / interaction-normalize 11 / interaction-semantics 9 / interaction-tools
  12 / permission-policy 3 / snapshot-normalize 5 / tool-registry 4 /
  tool-executor 8 / browser-tools 1；既有 452 用例仅机械夹具更新——meta 必填
  documentId 与 fakeBrowser 三方法）。**④ 实现**：shared 类型扩展（ClickAllowedKind/
  ElementSemanticsBinding/SnapshotMeta.documentId/buttons・inputs 语义元数据/
  ElementActionResult/ScrollActionResult）；snapshot-script+normalize（isSubmit
  判定与交互脚本 submit 复核同源；ariaExpanded true/false 均保留；非法布尔形状
  丢弃字段）；interaction-script 固定模板（node:vm 敌手参数逃逸测试——引号/
  反斜杠/闭合片段/脚本字符串不能逃逸、参数原样到达；click 四类 allowedKind
  实时复核 + fill 原生 setter+input/change+password・file・disabled・readonly・
  隐藏拒绝 + scroll 整数 ±50000）；interaction-normalize（页面视为敌手逐字段
  校验，异常/堆栈/页面原文零穿透）；BrowserController 扩展 + PageReader 交互
  编排 + TabManager 世代；ToolExecutor（语义 binding 提取 + derived 派生 +
  tabId 解析）；tool-registry paramRules（find text ≤200 非空 / fill text ≤2000 /
  dy 整数 ±50000）；interaction-semantics 存储（read/find 登记、按 Tab 键控、
  世代随绑定）；interaction-tools 四工具注册（find 多章节确定性匹配、无命中
  ok 空结果；click/fill 无派生参数 fail-closed——模型/网页不可写）。
  **⑤ 冒烟**：A3 交互场景 8.2 + elementId 生命周期探针——A-12 允许列表四类
  点击（含 nav 真实导航落地页）、提交类 deny/approve 确认门（审计 decision=
  denied/confirmed）、非允许列表/「立即购买/删除账户」/危险链接 forbidden 零
  DOM 动作（页面交互日志断言）、权限判定后动态变化（失去 aria-expanded/href
  变 javascript:/checkbox 变 text/text 变 password）→ 执行器复核拒绝零 DOM
  动作、fill 隐私（结果/审计 len=N 零原文 + input/change 事件真实触发 +
  password/file/disabled/readonly/隐藏零写入）、scroll 边界与 viewport、find
  多章节与无命中、elementId 世代（同文档稳定/导航后 stale/刷新后 stale/重新
  快照不碰撞/类型复核/工具级 stale 审计证据）、每次调用审计恰好一条——
  **dev 离线全矩阵 + 生产产物双场景退出码 0**；既有 8.1 探针校准为注册表
  12 工具（A2 8 + A3 4）。**⑥ 验证与终检**：test 533/533（全量连跑 4 次全绿）
  · typecheck · lint · format:check · build 全绿；红线 grep（无万能工具形态、
  交互工具零 electron import、allowedKind/documentId 不出现在模型可见 schema、
  package 零改动、SYSTEM_PROMPT/UI/preload/IPC 零改动）；敏感信息扫描与 diff
  终检零命中；根目录杂散日志清理。**⑦ 计时用例抖动观察（延续 A2 观察，未放宽
  阈值）**：期间一次全量运行出现 1 例未捕获具体测试名的失败，复跑 4 次全量 +
  fake-provider 单文件 3 次均全绿——判定为既有 30ms 墙钟断言边缘抖动，如实
  记录不放松阈值。**未调用任何付费 Provider、未输出/索取 API Key。**

- **A2 Tool Registry + 权限分级与确认状态机 + 审计日志（2026-08-14，第二个实现
  闭环）**：步骤 0 独立核对——HEAD `b9ad38a` = Gitee/GitHub 双远程 HEAD、工作区
  干净、基线 test 361/361 独立复跑全绿（与上一轮报告一致，已独立确认）。
  **① 契约校准（先于编码，ariaExpanded）**：detailed-design §7.1 矩阵行原写
  「展开：buttons 条目 ariaExpanded=true」与 §5.4「显式声明展开状态」、A3 任务
  文档执行模板 `[aria-expanded]`（属性存在选择器——值 false 同样命中）、
  threat-model §3.3（无 `=true`）矛盾——判文档疏漏：展开/折叠控件收拢态
  aria-expanded=false 同样是控件的结构化证明。最小校准为「ariaExpanded 字段
  存在（true/false 均为 L1），字段缺失不能证明 → fail-closed」（§7.1 已同步，
  threat-model 本已一致）；未发现与实际代码冲突。**② 红→绿**：先写 6 个新测试
  文件 + logger 审计形态回归 2 用例——红态 **6 files failed（模块不存在）/
  363 passed**（既有用例零改动），实现后全量 **452/452**（新增 91：tool-registry
  17 / permission-policy 18 / confirm-manager 9 / audit-log 14 / tool-executor
  14 / browser-tools 17 / logger 2；连跑 5 次全绿稳定）。**③ 实现**：
  shared/types/agent.ts（A2 类型：ToolCall/ToolResult/ToolResultErrorCode/
  ToolPermissionLevel/ElementSemantics——A5/A6 类型未提前落地）；tool-types/
  tool-registry（重复注册确定性抛出、listTools 只出模型可见 schema、按名排序
  恒等、validateToolArgs 全矩阵任意非法输入安全返回不抛异常）；permission-policy
  （TOOL_BASE_RISK 编译期矩阵 + decide 纯函数——click 判定优先级：isSubmit
  **首先**升级 L2 不因并存特征降回 → href http/https → ariaExpanded 字段存在
  （true 与 false 均 L1）→ checkbox/radio → 其余与语义缺失 L3 fail-closed；
  fill password/file 与类型元数据缺失恒 L3；open/navigate 非 http/https 恒 L3；
  未知工具名防御 L3）；confirm-manager（单 pending 同步建立、并发请求
  fail-closed 立即 denied 不覆盖、approve/deny 未知与已终结 id false 幂等、
  cancelAll 作废、无自动批准）；audit-log（summarizeArgs 键排序确定性 + fill
  text 只记 len=N 原文零出现 + url 全量 + 其余 ≤200 截断、summarizeRawArgs、
  formatAuditMessage §10.1 确定性格式、createAuditLogger 薄封装——全量经
  logger sanitize，Key 形态零暴露链单测固化）；tool-executor（校验→权限→确认→
  执行→审计单出口**每次调用恰好一条**；L2 approve/deny/cancelAll 三路；结果
  预算 2000/read 8000/search 4000 确定性截断 + 警告；错误永不以 ok:true 返回；
  异常归一化 execution-failed 并 logWarn——审计条目本身不含堆栈）；browser-tools
  8 个只读/导航工具（只经构造注入 BrowserController，不 import Electron；
  read 每次实时 getPageSnapshot 防串页；serializeSnapshotForTool 章节化确定性
  序列化含 elementId）。**④ 接线与冒烟**：index.ts 注册 8 工具 + 装配
  ToolExecutor(new ConfirmManager(), createAuditLogger())；smoke 新增 8.1 工具
  层探针（注册表恰好 8 工具/listTools 恒等/get_tabs・read 真实执行成功/
  javascript: URL forbidden 且不建 Tab/非法 tabId invalid-args/未知 tabId
  execution-failed/日志字节切片 5 条审计恰好一次一条）——**dev 离线全矩阵 +
  生产产物双场景退出码 0**，日志实证 5 条 `[audit] tool-call` 条目。**⑤ 验证
  与终检**：test 452/452 · typecheck · lint · format:check · build 全绿；红线
  grep——本任务 diff 无交互注入/executeJavaScript 新增（smoke 命中为既有 UI
  驱动代码）、无万能工具形态（仅权限测试断言 shell.exec → L3）、browser-tools
  无 click/fill/scroll/find/search.web 注册、package 零改动、SYSTEM_PROMPT 未改、
  UI/preload/IPC 零改动；敏感信息扫描与 diff 终检零命中；清理单测产生的根目录
  杂散日志（既有 provider 告警用例在 logger 未初始化时写 CWD 的测试基础设施
  现象，运行测试即重现）——.gitignore 补 `/aibrowse-*.log` 防误提交，
  tool-executor.test 以 vi.mock logger 避免本任务新增用例再产生同类文件。
  **⑥ 计时用例抖动观察（既有用例，未放宽阈值）**：fake-provider「延迟块实际
  等待」（≥30ms 墙钟断言）在红态全量运行中 2 次测得 29.94ms（差 0.06ms）；
  单文件 10/10、全量连跑 5/5 全绿——判定为并行负载下墙钟断言的边缘抖动，
  非可复现失败；按约定如实记录，A2 不修改阈值（后续会话若高频复现，评估
  根因后做安全的小范围测试改进）。**未调用任何付费 Provider、未输出/索取
  API Key。**

- **A1 tool-calling 兼容层（2026-08-14，第一个实现闭环，硬前置解除）**：
  步骤 0 独立核对——HEAD `525fae8` = Gitee/GitHub 双远程 HEAD、工作区干净。
  **① 契约校准（先于编码，决议 #30）**：detailed-design §2.1 原写
  `ProviderEvent.toolCalls: ProviderToolCallDelta[]` 与 §3.1 聚合语义矛盾——
  校准为 SSE 原始分片仅作适配器内部解析状态（openai-compatible.ts 模块内
  `ToolCallFragment`/`ToolCallSlot`，不进共享契约），对外 `ProviderEvent.toolCalls`
  输出聚合校验完成的 `ProviderToolCall[]`（id/name 非空、arguments 整体
  JSON.parse 成功且结果为对象），恰好在 done 之前，绝不暴露半截 arguments；
  §2.1/§3.1/§15 已同步，AGENTS.md §5 契约速查同步校准。**② 文档残留校正**：
  threat-model §5「以上三类」重复段删除（保留四类）；A8 任务文档「三类」→四类、
  progress.md 风险与限制残余风险「三类」→四类（新增 click 允许列表目标页内 JS
  副作用）；A5 任务文档「终止理由四种」→五种（实列 step-limit/timeout/
  loop-detected/no-progress/cancelled）。**③ 红→绿**：先写失败用例——
  4 个 A1 相关测试文件红态 **31 failed / 64 passed**（全部为新增用例与 2 处
  元数据校准断言，既有用例零改动），实现后全量 **361/361**（新增 35 用例：
  openai-compatible 27——interpret tool_calls 帧判定/分槽累积/聚合校验/SSE
  管道收尾顺序/非法帧与非法 arguments → provider-error/mapMessages tool 与
  tool_calls 重放；fake 5——工具脚本整组产出/延迟/确定性/getLastRequest
  tools 恒等/abort 不产出；context-builder 3——tools 恒等透传/未传无字段）。
  实现：shared 类型扩展（ProviderTool/ProviderToolCall/tool 角色/tools 字段）+
  openai-compatible 适配器（请求体 tools 透传、v1 不发 tool_choice、SSE 管道
  streamSseBody 抽出可单测、supportsToolCalling=true）+ FakeProvider 工具脚本
  （kind:'toolCalls' 整组产出）+ ContextBuilder tools 恒等透传 +
  conversation-service 共读流 toolCalls 事件 fail-closed 归一化 internal
  （事件判别联合扩展所致最小改动）。**④ 冒烟**：矩阵 11 断言校准为「未传
  tools → 请求无 tools 字段」（`'tools' in request === false`，tool_calls
  字段断言保留）；S3 场景新增 A1 工具探针（FakeProvider 脚本级：事件严格按
  脚本顺序 delta → toolCalls → delta → done + getLastRequest 保留 tools 恒等）。
  冒烟双场景退出码 0（dev 离线全矩阵 + 生产产物），日志实证 A1 探针与矩阵 11
  校准断言通过。**⑤ 验证与终检**：test 361/361 · typecheck · lint ·
  format:check · build 全绿；红线 grep（无工具执行/交互注入/万能工具代码）、
  敏感信息扫描、diff 终检零命中；SYSTEM_PROMPT 未改动、共读路径请求无 tools
  字段保持；清理本次单测产生的根目录杂项日志。**未调用任何付费 Provider、
  未输出/索取 API Key。** 红线遵守：无任何 Browser Tool/Registry/AgentLoop/
  SearchProvider/UI/IPC 改动。

- **第三阶段设计实施前校正（2026-08-14，独立纯文档闭环，零代码改动，不实现 tool
  calling 与任何 Browser Tool）**：① 步骤 0 独立核对——HEAD `0fb7047` =
  Gitee/GitHub 双远程 HEAD（GitHub 经代理 fetch 确认）、工作区干净。② **任务编号
  校正**：第三阶段任务 T1–T8 与第一阶段历史任务 T1–T5 重名——统一改为 **A1–A8**，
  任务文档经 `git mv` 重命名（`doc/stage3/tasks/A1–A8`），AGENTS.md / README.md /
  progress.md / doc/stage3/ 全部交叉引用同步；第一、第二阶段历史任务编号
  （T0–T5 / S1–S6）一律不变（AGENTS.md §5/§6/§8 与 progress.md 任务表中的历史
  引用逐条核对保留）。③ **红队编号校正**：threat-model 红队场景 R-01～R-10 与
  progress.md 风险台账编号 R-01/R-02（按登记顺序分配、不得复用）冲突——统一改为
  **RT-01～RT-10** 并新增 **RT-11**「通用 click 越权」；全仓库搜索无残留歧义
  （风险台账 R-01/R-02 引用原位保留）。④ **权限契约收紧**（核心校正，同步
  proposal §11 校正记录 / high-level-design / detailed-design §4.2/§5.1/§5.2/
  §5.3/§5.4/§7.1/§12/§13/§14/§15/§16 / threat-model §3.3/§4/§5 / A2/A3/A7
  任务文档与验收测试要求）：通用 click 可间接触发购买/发送/删除/发布等远程写——
  「没有专用支付工具 = L3 不可达」与「只靠 isSubmit 判断副作用」均被否定。新契约：
  **L1 仅允许语义元数据可证明的低风险目标**（links 条目 href http/https、
  buttons 条目 ariaExpanded、inputs 条目 checkbox・radio）；isSubmit 提交类 → L2
  确认；**非允许列表目标/语义缺失 → L3 fail-closed**（即使确认也不执行）；
  **执行器层不可达**——click 注入模板按 allowedKind（权限决策派生，模型不可见
  不可写）复核 DOM 实时属性，权限层判 L1/L2 后页面动态变化同样被拒；L3 动作在
  权限层与执行器层双重封死。验收落点：冒烟新增 **A-12**（click 允许列表与执行器
  复核）、红队 **RT-11**、A2/A3 单测矩阵扩展。⑤ **Third_stage.md 真实场景复核
  （不破坏，证据见 proposal §11 第 4 条）**：场景 1/2/3/4 走 search/open/read/
  find/scroll/fill 不变；场景 5 提交/发送经 isSubmit 提交类 → L2 确认门（非提交类
  发送按钮 fail-closed，宁禁勿放，属 §3.5「本阶段内调整分类」授权）；场景 6 由
  RT-01/RT-03/RT-11 覆盖。⑥ 验证：test/typecheck/lint/format:check 全绿（纯文档
  按 AGENTS.md 附 A 免构建/冒烟重跑）+ 全仓库残留搜索 + diff 与敏感信息终检。
  **未调用任何付费 Provider、未输出/索取 API Key。** Third_stage.md 未改动
  （需求源保持原样）。

- **Third Stage 切换与设计定稿（2026-08-14，纯文档任务，零代码改动）**：① 步骤 0 独立核对——
  Git HEAD `9605269` = Gitee/GitHub 双远程 HEAD（GitHub 经代理确认）、工作区干净；
  全量验证独立复跑全绿（test **326/326** · typecheck · lint · format:check ·
  Electron 离线冒烟退出码 0——T2–T5 + S3 矩阵 1–8 + S4 UI 矩阵 1–12 全通过）；
  据此校正「等待修复后独立确认」→ 修复已确认、阶段切换。② **Entry Gate 逐项核验**
  （判定证据全文见 doc/stage3/proposal.md §8）：共读稳定 ✅ / ContextBuilder
  不可信输入 ✅ / BrowserController 可扩展 ✅ / Key 与日志安全 ✅ /
  **「LLM Provider 抽象支持 tool calling」→ 循环式门槛校正通过**——如实记录现状
  （`supportsToolCalling: false`、ProviderRequest 无 tools 字段、SSE 仅解析
  delta.content），判定该条字面要求与阶段目标构成循环（tool calling 兼容层是
  第三阶段自身交付物），门禁保护性意图（抽象不被锁死）已由现有扩展点满足
  （元数据字段预留/工厂注册表/自实现适配器/端点原生支持 tools）；**校正方式：
  A1 = 阶段内硬前置，A1 验证通过前禁止引入任何 Browser Tool 实现**（任务编号
  2026-08-14 实施前校正后为 A 编号，见下）。③ 新建
  `doc/stage3/`：**threat-model.md（Prompt Injection 威胁模型重建定稿，先于任何
  Browser Tool 实现）**——威胁枚举 T-01～T-10、五层防线（结构/能力/决策/审计/
  运行时）、红队矩阵（现编号 RT-01～RT-11，见下）、诚实边界声明（诱导式工具
  参数/确认疲劳/低风险动作累积三类残余风险如实登记，不宣称语义免疫）；
  **proposal.md**（目标/非目标/真实场景/验收映射/Q1–Q15 拍板/Entry Gate 核验
  记录/A1–A8 里程碑）、**high-level-design.md**（架构/决策/数据流/安全模型/
  测试/风险）、**detailed-design.md**（§2–§16 唯一契约源：tool-calling 兼容层、
  ToolRegistry 与首批 13 工具三批接线、L0–L3 权限矩阵与确认状态机、交互注入与
  elementId 生命周期、SearchProvider、AgentLoop 上限/防循环/审计、操作可见性
  UI 与通道、测试规格与验收核对清单、决议 #21–#28）、**tasks/A1–A8**（每任务 =
  一个可验证开发闭环：目标/范围/非目标/涉及文件/实施步骤/完成定义；A1 任务
  文档明确「验证通过前禁止任何 Browser Tool 实现」）。④ 更新 AGENTS.md（§1/§2 阶段指针
  与接管顺序、§3 Agent 架构纪律/万能工具永久红线/T1 硬前置、§4 结构、§5 Third
  Stage 契约速查、§8 注入边界、附 B/附 C）、README.md（当前状态/架构/目录/已知
  限制）、本文件。⑤ doc/stage2/ 与第一阶段历史文档**原位保留未覆盖**。⑥ 验证：
  全量回归（纯文档按 AGENTS.md 附 A 免构建/冒烟重跑——本会话已先行独立复跑过）
  - 文档交叉引用与格式检查。**未调用任何付费 Provider、未输出/索取 API Key。**

- **独立复验发现项修复闭环（2026-08-14，S6 后定向修复，非新阶段任务）**：test **326/326** ✅
  · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 四场景退出码 0
  （dev 离线全矩阵 + 生产产物 + **Bing 真实 URL 变体（原失败命令，红→绿）** + Session
  set/check 跨进程）· **真实 Provider 多网站验证 ✅（最终代码状态复跑，7 次真实调用全
  complete，退出码 0，新表格内容依赖断言与扩大后的 Key 零暴露扫描均通过）** · S5
  一问一答变体 ✅（1 次调用，退出码 0）。**真实调用台账共 15 次**：多网站场景初次
  验证 7 次（修复后新表格内容依赖断言与扩大后扫描窗口的首验）→ S5 一问一答变体
  1 次（该场景扫描代码路径改动复验）→ 失败路径清理修复后多网站场景最终复验 7 次
  （最终代码状态全量证据）。修复前红态证据：`AIBROWSE_SMOKE_URL=
https://www.bing.com/` 完整命令退出码 1、失败断言「关闭网页标签页后应回到单个标签页」
  （Bing ready/标题断言本身通过）。**① Tab 状态泄漏修复（根因）**：UI 矩阵 9 为验证
  「切 Tab 后 bounds」经 UI 新建 Tab 后从未关闭，真实 URL 变体关闭自己的 Tab 后断言
  `length === 1` 因泄漏 Tab 失败——矩阵 9 改为自建自清：相关断言完成后经真实产品链路
  （UI 关闭按钮 → bridge → IPC → BrowserController）关闭该 Tab，try/finally 保证失败
  路径同样清理，退出时新增「Tab 数量 = 1 + 活动 Tab 恢复进入前」回归断言；LIVE_SITES
  切 Tab 验证创建的验证 Tab 同模式修复（BrowserController 产品链路关闭 + 数量/活动 Tab
  恢复断言）；不修改 BrowserController/TabManager「关闭最后 Tab 后新建空白页」产品策略，
  后续断言也不改成固定数字。**② 顺带修复（同根因实测触发）**：冒烟失败路径临时目录
  清理缺口——`runSmokeScenario` 后置步骤失败时 catch 直接重抛，9.1 的正常清理不执行
  （红态复现两次各留下 `aibrowse-smoke-conversations-*` 残留）——AI 句柄提升至 try 外 +
  catch 最佳努力清理（不掩盖原始错误）。**③ 表格页内容依赖证据增强**：原问题「HTML
  表格由哪些基本标签构成」可由模型先验知识回答，不能证明回答依赖页面表格数据——经
  实际探测确认 w3school 示例表格（Company/Contact/Country，六行公司数据）为多年稳定
  内容后，问题改为「根据当前页面中的示例表格，公司 Ernst Handel 的 Contact 是谁？」
  （必须读取特定行/单元格才能回答）；新增真实调用前前置断言：目标行
  Ernst Handel/Roland Mendel/Austria 完整存在于快照表格（`filterLayoutTables` 保留集）
  且经 `fillWebContentSections` 确定性序列化进入 tables 章节（= ProviderRequest 依据，
  不被布局过滤/预算裁剪丢失，ContextBuilder 契约不变）；回答断言改为「包含页面特定
  数据 Roland Mendel」（不要求完全固定措辞）；站点内容变化时前置断言明确提示更换站点
  （失败前不产生真实调用）。**④ Key 零暴露扫描窗口扩大**：此前扫描从场景开始时取日志
  偏移，Key 进入进程 → 环境变量读取 → 装配 → safeStorage 密文落盘 → process.env 删除
  的装配期不在窗口内——扫描起点提前至进程最早日志可观测点（index.ts 在 logEnvironment
  与环境变量读取之前取定 `startupLogScan`{file, offsetBefore}，经
  `LiveProviderSmoke.logScan` 传入两场景），覆盖测试子进程启动日志/环境变量读取/
  Provider/config/credential 装配/Key 密文落盘/真实请求/流式响应/结束清理全过程；
  沿用 S5 已修复的字节级 subarray 切片（无字符/字节偏移回退）；文件不存在时偏移为 0
  （首个日志写入即创建文件，扫描覆盖全部字节）；**覆盖边界如实记录**（代码注释 +
  本文）：仓库外 PowerShell harness 为独立进程（DPAPI 解密/注入/ZeroFreeBSTR 清零），
  不在应用日志扫描范围内，其环境变量清理由 harness 自身 finally 强制——不伪称全生命
  周期扫描。**⑤ README 状态同步**：架构节「AI 子系统（第二阶段，设计定稿、待实现）」
  →「已实现并通过内部验收」；当前状态补独立复验发现与修复进展。AGENTS.md 未改
  （长期测试规则无变化，§6 命令描述与修复后行为一致）；detailed-design 未改
  （ContextBuilder/产品契约无变化）。交付：smoke.ts（矩阵 9 自清理 + LIVE_SITES 验证
  Tab 自清理 + 失败路径临时目录清理 + 表格内容依赖断言 + logScan 消费）、index.ts
  （startupLogScan 起点装配 + liveSmoke.logScan 接线）。
  **本次明确不处理的观察（如实登记）**：全局场景看门狗未新增（各 waitFor 局部超时已
  够用，新 watchdog 需单独设计且易再引入真实 Provider 慢响应误杀）；`48f1838` 提交
  信息声称含 index.ts 接线而实际接线在 `c9a431f`（已推送双远程，禁止重写公共历史，
  本次不 amend/不补偿空提交）。

- **S6 第二阶段收尾与最终验收（2026-08-13，第六个实现闭环）**：test **326/326** ✅ ·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （dev 离线全矩阵 + 生产产物）· **真实 Provider 多网站共读验证 ✅ 最终运行退出码 0**。
  **① Second_stage.md §9 四组 16 项验收标准逐项核对通过**，每项证据（单测/冒烟场景/
  审计条目/运行时日志）已回填 §9 勾选注释。**② §10 Exit Gate 判定：通过**（五条件逐项
  证据已回填 §10 证据块）；项目状态登记：**Second Stage 已完成内部验收，等待用户安排
  独立复验或阶段切换**（阶段指针不切换、不实现 Browser Agent）。**③ 新增真实 Provider
  多网站共读冒烟场景**（`AIBROWSE_LIVE_SITES=1`，smoke.ts `runLiveProviderSitesScenario` +
  index.ts 门控；仓库外 harness `run-live-smoke.ps1 -Sites`）：三类真实站点形态——
  MDN 普通文章页（正文提问 + 总结 + selection 独占）、wangdoc 长文教程页（visibleText
  超 12000 章节上限 → 确定性裁剪 warnings + 回答可用）、w3school.com.cn 表格页（数据表
  提取）——外加切 Tab 与刷新防串页（url/tabId/capturedAt 更新 + 旧页标记词不串入），
  每个提问对应一个明确验收项，全部经完整生产链路（UI → bridge → IPC → ConversationService
  → ContextBuilder → OpenAI-compatible → 流式 → DOM）真实调用且 turn-done complete；
  沿用 S5 真 Key 零暴露扫描（DOM/日志/临时文件/密文形态）。**④ 验收期间修复 3 个冒烟级
  缺陷（均非共读业务缺陷）**：a) 长文站点夹具——MDN display 页在应用快照管线中正文仅
  ~9.9k 字符（大量 p 文本隐藏在 BCD 折叠区，curl 文本量误判），更换为全明文渲染的
  wangdoc stdlib/array 章节并将前置断言校准为「visibleText 超章节上限 12000」；
  b) **冒烟 30s 兜底定时器缺陷（真实项目缺陷）**——「渲染进程未在 30 秒内就绪」定时器
  在渲染进程就绪后从未清除，任何超 30s 的冒烟场景（真实 Provider 多网站验证必然超过）
  被误杀（S5 会话日志亦有 1 次触发记录；离线矩阵 ~15s 恰好未暴露）——修复为
  AppRendererReady 时 clearTimeout，场景自身超时接管（index.ts）；c) 表格页对照组断言
  过度约束——nav 密集站点 links 章节超 200 条/4000 字符上限被确定性截断产生 warnings 是
  §7.5 契约正确行为，删除「短页面无裁剪」对照组断言并加注释说明。**⑤ 真实调用台账**
  （新规则：不设固定次数，每次对应明确验收项/问题定位/修复复验，报告次数与用途）：
  共 18 次——run1 3 次（文章提问①/总结/selection，暴露长文夹具缺陷后按断言中止）/
  run2 4 次（夹具修复复验，暴露 30s 定时器缺陷后被误杀）/ run3 4 次（定时器修复复验，
  暴露表格页对照组断言问题）/ run4 7 次（最终完整验收：正文提问/总结/selection 独占/
  长文裁剪/表格提取/切 Tab/刷新，全部 complete，退出码 0）。**⑥ 风险分类校准**：Prompt
  Injection 语义层剩余风险正式登记为「已接受的剩余设计风险/计划内限制」（不分配 R 编号、
  开放风险仍为「无」、不宣称完全免疫），保留「Third Stage 引入 Browser Tool 前重建
  威胁模型」最迟复核点（见风险与限制）。**⑦ 文档同步**：Second_stage.md §9 勾选 + §10
  证据块、AGENTS.md §1/§5 S6 状态 + §6 长期真实 Provider 测试流程（固定本地说明路径、
  DPAPI 仓库外、仅环境变量注入、无固定调用上限规则）、README（当前状态/真实 Provider
  开发者流程/测试计数 326）、detailed-design §13.2 增补多网站验证与调用规则（真实契约
  变化的最小同步）、S5/S6 任务文档实施标记。交付：smoke.ts（LIVE_SITES +
  runLiveProviderSitesScenario + 辅助函数）、index.ts（LIVE_SITES_MODE 门控 + 30s 定时器
  清除修复）。

- **S5 安全审计与 Prompt Injection 验证（2026-08-13，第五个实现闭环）**：test **326/326** ✅
  （无新增单测——审计未发现需新增纯函数的缺陷；注入夹具与真实 Provider 场景为冒烟胶水层）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 三场景退出码 0
  （dev 离线全矩阵 + 生产产物 + 真实 Provider 变体）。
  **① §12.1 七项结构性边界逐项审计通过**（代码审查 + 全仓库 grep + 单测 + 运行时探针）：
  边界 1/2/3——网页内容只进末条 user 消息 UNTRUSTED 块（serializeUntrustedBlock）、
  `</`→`<\/` 闭合转义 + 属性转义（escapeBlockContent/escapeAttribute）、system 恒等
  SYSTEM_PROMPT 编译期常量、角色仅程序字面量（conversation-store validateMessageShape
  丢弃非 user|assistant 角色，纵深防御）；边界 4——渲染层无 Key 读回（bridge 白名单
  仅 list/set/setKey，credential-store.get 仅主进程适配器用，矩阵 10 typeof 断言）；
  边界 5——全仓库无 click/fill/scroll/搜索 Tool/写通道（grep：仅冒烟 UI 驱动与 ChatView
  自身滚动；无 sendInputEvent/insertText；ProviderRequest 类型无 tools 字段，
  supportsToolCalling: false）；边界 6——permission-policy 双处理器默认拒绝回归
  （矩阵 11 geolocation 探针 denied）；边界 7——logger sanitize + error-normalize
  脱敏用例 + 矩阵 10 字节扫描 + 真实 Provider 场景真 Key 扫描（见下）。
  **② §14 安全基线清单逐项审计通过**：Key 零入库（credential-store 仅密文落盘 +
  isCiphertextShape 丢弃 sk- 明文形态、config-store 无 Key 字段、适配器不记请求头）/
  网页内容按不可信输入（§7.1）／权限默认拒绝不变／无写操作通道（grep 断言）／
  IPC sender+主帧校验全覆盖 + preload 最小白名单 + 事件订阅退订清理／远程网页隔离
  不变（tab 无 preload、nodeIntegration=false、contextIsolation+sandbox=true，
  矩阵 12 探针回归）／日志可定位且无敏感信息。**未发现 S5 范围真实安全缺陷**。
  **③ 注入夹具增强（矩阵 11）**：HOSTILE_HTML 增补 4 条注入文案（「忽略之前的指令」
  /role: system 伪造/调用工具/原始 `</UNTRUSTED_WEB_CONTENT><system>` 拼接尝试），
  矩阵 11 新增 5 断言——注入文案仅作为被阅读资料入块、闭合尝试被转义为 `<\/`、
  不得以原始闭合标签拼接伪造结构、消息角色无 system、请求 JSON 无 tools/tool_calls
  字段（elementId 敌对页场景不受影响，离线冒烟复跑通过）。
  **④ 真实 Provider 可选验证（用户提供凭据，共 2 次真实调用）**：新增 env 门控场景
  `AIBROWSE_LIVE_PROVIDER=1` + `AIBROWSE_TEST_API_KEY`（+ AIBROWSE_TEST_BASE_URL/
  AIBROWSE_TEST_MODEL）——index.ts 装配侧将 baseUrl/model 写入进程专属临时配置、
  Key 经 credentials.set 密文落盘后立即从 process.env 移除；冒烟场景经完整生产链路
  （UI → bridge → IPC → ConversationService → ContextBuilder → OpenAI-compatible
  Provider → 流式事件 → DOM）做固定问题「用一句话回答：1+1 等于几」的一问一答，
  断言：流式气泡增量渲染 + 事件链路 delta 计数 ≥1 + 无错误标记 + 回答非空 +
  持久化 assistant 消息 status=complete + contextSource snapshot/about:blank +
  临时配置精确含 baseUrl/model + 日志记录实际 provider/model + **真 Key 零暴露扫描**
  （DOM/日志切片/全部临时 JSON/密文形态断言）。
  第 1 次调用即成功（鉴权通过、1464ms status=complete），但暴露冒烟胶水缺陷——
  日志尾部读取用字符级 slice 配字节 offset（中文多字节使窗口起点右移），修复为
  字节级 subarray 切片（与矩阵 10 同模式）；第 2 次调用全断言通过（1597ms complete，
  exit 0）。**凭据清理已确认**：环境变量（应用内 delete + harness finally 移除）、
  明文内存清零、临时 userData 清理（TEMP_CLEAN）；DPAPI 密文文件与仓库外本地说明
  `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md` 保留供 S6 复验（未经用户要求
  不删除/轮换测试 Key）。交付：smoke.ts（矩阵 11 增强 + runLiveProviderUiScenario +
  SmokeOptions.liveSmoke + 门控装配）、index.ts（LIVE_PROVIDER_MODE 装配 + env
  移除 + delta 计数）；AGENTS.md §6 同步长期凭据流程通用规则（不含任何真实凭据）。
- **S4 契约交接校准（2026-08-13，独立校准 commit，纯文档）**：按 detailed-design.md
  头部要求对 S1–S4 实际导出签名逐项 grep 核对——决议 #17（`resolveProvider` 与
  `ConfigStore.list()` 均 async：`Promise<LLMProvider | null>` / `Promise<ProviderInfo[]>`）、
  决议 #18（`ContextBuildInput` 含 requestId/model；`buildContextSource(snapshot, mode,
thin, tabId)`）、决议 #19（`createSession(opts?) → Promise<ConversationSession | null>`）、
  决议 #20（`selectRegisteredProviderInfo(infos, kinds): ProviderInfo | null`）、
  `ProviderInfo`/`PROVIDER_KIND_OPENAI_COMPATIBLE` 定义于 shared/types/conversation.ts
  （config-store/llm-provider 重导出，renderer ProviderSettings 直接引用）、11 个 invoke
  通道常量与 payload 类型（shared/types/ipc.ts）、两个事件 payload（StreamChunkEvent/
  TurnDoneEvent）、AibrowseBridge 全部方法及三个事件订阅退订签名（onUpdated/
  onStreamChunk/onTurnDone → `() => void`，与 preload eventRelay 实现一致）、
  ConversationStore/ContextBuilder/context-budget/Provider/凭据/配置/渲染层纯函数全部
  导出——**未发现真实签名偏差**。AGENTS.md §5 同步 4 处过期/表述偏差：① 速查标题
  「S2–S4 待实现后回填」→「S1–S4 全部已实现并经 grep 逐项核对」；② SafeStorageCipher
  运行时验证描述「S3+ 冒烟验证」→「已由 S4 冒烟场景 10 验证」（实际验证发生在 S4）；
  ③ 渲染层只写不读表述「setKey/has」→「bridge 仅 setKey 写入，has 为 main 侧方法不进
  bridge，renderer 只能经 list() 拿 hasKey 布尔」（与白名单实际一致）；④ 三处
  prettier 列表规范化把行首「+ 实现类」「+ turn-done 收敛」「+ 退订」改写为「-」
  导致语义失真的格式伪影，分别改为「与实现类」「逐块追加、turn-done 收敛」
  「JS 侧 listener 集合退订」消除歧义。同时补记 shared/types/conversation.ts 的
  S4 增补（事件 payload/ProviderInfo/kind 常量）。progress.md S4/S5 状态核对：
  任务表 S4 ✅ / S5 ⏳、当前状态、下一个推荐任务（S5）均与实际一致；S4 条目内
  同类「+ 退订」伪影一并在本闭环修正。验证：test 326/326 · typecheck · lint ·
  format:check（纯文档改动，按 AGENTS.md 附 A 豁免 build/冒烟）。
- **S4 AI 侧栏 UI 与布局协调（2026-08-13，第四个实现闭环）**：test **326/326** ✅
  （304 基线 + 22 新增：stream-state 10 / history-events 6 / context-badge-format 6）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （dev 离线 + 生产产物），**UI 端到端矩阵 1–12 全部断言通过**（React DOM 事件驱动，
  FakeProvider 离线，真实 IPC/bridge/服务链路——UI → preload 白名单 → sender 校验 →
  ConversationServiceImpl → 事件推送 → DOM）：
  ① 端到端流式（delta 逐块渐进到达渲染 DOM——第三段不得与首块同时出现 + turn-done
  complete + 追溯卡片 url === 提问时页 URL + 真实页面正文入 web 块 + 非薄长文页徽标
  无「稀薄」提示）；② selection 独占（页面真实选中 → 徽标「选中文本（N 字）」+ 请求
  含 `<selection>` 不含页面正文 + 摘录卡片）；③ 防串页（UI 切页后提问 → 请求含页 B
  内容、页 A 内容不出现、追溯卡片 url 更新）；④ L3（dispose 后经 UI 提问 →
  徽标「无网页上下文」+ 请求无 web 块 + 无错误标记）；⑤ 薄快照（空白页 → 徽标
  「稀薄」提示 + 追溯卡片警告）；⑥ 中止（慢速 FakeProvider 中途点击「中止」→
  「已中止」标记 + 部分保留 + 流停 + 中止按钮消失）；⑦ 错误归一化（注入 401 →
  invalid-key 文案、注入超时 → timeout 文案；失败轮 user 消息仍展示）；⑧ 会话管理
  UI（新建/切换/「不保存」开关双向/删除：ephemeral 提问不落盘、转保存落盘、删除即
  消失、全新 Service 实例同目录重启恢复）；⑨ 布局协调（面板开 → 活动 view
  bounds.width = 窗口宽 − 380；关 → 恢复；DebugPanel 收起/展开 → 高度变化；
  切 Tab 后 bounds 保持；窗口缩放 → bounds 跟随）；⑩ **Key 安全（真实 safeStorage
  运行）**：设置界面保存非真实测试标记 Key → credentials.json 仅 base64 密文、
  渲染 DOM 与日志字节扫描零暴露、保存后输入立即清空、list() 仅 hasKey 布尔且结构
  无 apiKey 字段、bridge 白名单仅 list/set/setKey（typeof getKey/get === 'undefined'）；
  ⑪ Prompt Injection 结构断言（敌对页提问 → system 恒等于编译期常量、web 块恰好
  单块闭合、geolocation 权限请求被默认拒绝）；⑫ 远程隔离回归（window.aibrowse/
  process/require/electron 均 undefined）。**红→绿抓出并修复 3 个冒烟断言缺陷**：
  `.ai-status-error` 选择器误中历史首条错误（改为末条）、矩阵 6 中止断言与矩阵 1
  回答文本撞车（分块文案改用矩阵独有文本）、L3 错误标记断言误中历史旧错误
  （改为仅检末条 assistant 消息）。
  交付内容：① shared/types/ipc.ts 11 个 invoke 通道常量 + payload 类型（§4.1）；
  ② main/index.ts handler 装配（全部复用既有 handle() sender+主帧校验，逐参数验证
  安全返回；question > 16000 字符确定性截断 + warn、空串/非串 → internal 拒绝；
  config:providers:set-key 只写不回读，apiKey='' = 删除）；③ preload bridge 白名单
  （conversation 8 方法 + config.providers 3 方法；事件通道单次注册、JS 侧 listener
  集合退订，沿用 tabs:updated 模式；原始 ipcRenderer 不暴露）；④ renderer/src/ai/ 面板
  （AiPanel/ChatView/Composer/ContextBadge/CitationCard/ProviderSettings +
  useConversation/useStream + 纯函数 stream-state/history-events/context-badge-format/
  error-labels；回答纯文本 pre-wrap 渲染，零新依赖）；⑤ useContentBounds 升级为内容
  容器两维矩形测量（通道/契约不变）+ App 布局（内容行 + 面板定宽 380px 停靠、
  默认收起不持久化、无拖拽/动画；DebugPanel 移底部通栏）；⑥ 冒烟 UI 端到端矩阵
  1–12（冒烟模式 AI 子系统走进程专属临时目录 + FakeProvider 注入，场景 10 凭据为
  真实 safeStorage 密文，全程不触碰用户 userData，结束清理）；⑦ ProviderInfo 与
  PROVIDER_KIND_OPENAI_COMPATIBLE 常量移至 shared 单一事实源（决议 #20：v1 设置
  UI 只配置已注册 openai-compatible kind，不新增多 Provider 选择 UI，与 list() 顺序
  无关）。仍不做真实 Provider 验证（S5）、不做专项安全审计（S5）。
- **S3 ConversationService 与会话持久化（2026-08-13，第三个实现闭环）**：test **299/299** ✅
  （242 基线 + 57 新增：conversation-store 27 / conversation-service 30）· typecheck ✅ ·
  lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0（dev 离线 +
  生产产物），**AI 共读矩阵 1–8 全部断言通过**（主进程驱动，FakeProvider 离线，
  真实持久化文件）：① 端到端流式（分块按序 + turn-done complete + contextSource.url
  === 提问时页 URL + 真实页面正文经真实快照管线进末条 user 消息 web 块 + model 来自
  配置）；② selection 独占（页面真实选中文本 → 请求含 `<selection>` 不含页面正文，
  selectionExcerpt 摘录）；③ 防串页三断言（页 B 轮 url 更新/capturedAt 严格递增/
  页 A 内容不出现在页 B 轮；关闭活动 Tab 自动新建空白页 → 快照为空白页非旧页内容）；
  ④ L3 → mode='none'（dispose 后无任何标签页提问——最后 Tab 策略使正常运行中始终存在
  活动 Tab，真实 L3 仅此路径可达，设计 §13.2 矩阵 4 已同步说明）；⑤ 薄快照（空白页
  thin 标记 + 提示）；⑥ 中止（慢速 FakeProvider 中途 abort → 流停 + aborted + 部分
  保留 + 在途 busy + 终态后 abort 幂等 false）；⑦ 错误归一化（注入 401 → invalid-key
  文案/httpStatus、注入超时 → timeout retryable；失败轮 user 消息仍先落盘）；⑧ 会话
  持久化（普通会话文件落盘/ephemeral 不落盘与 setEphemeral 双向切换/新 Service 实例
  同目录重启恢复/删除即消失含残留 tmp）。
  交付内容：① `conversation-store.ts`——纯函数（消息/会话形状校验、version 1 文件
  格式、索引不含 ephemeral、200 条上限确定性裁剪、title 首问推导 ≤30）+ JSON 读写
  （`<userData>/conversations/`，原子写 tmp+rename、损坏 fail-closed 按空处理不暴露
  原文、删除含残留 tmp）；② `conversation-service.ts`——会话生命周期（50 会话上限
  拒绝新建，决议 #19）+ 每会话单在途状态机（busy/abort 幂等）+ §6.1 ask 编排
  （实时快照防串页 → buildContext → 先持久化 user 消息 → resolveProvider →
  provider.stream → 事件转发 → 终态持久化）+ previewContext（实时摘要不含正文）；
  ③ 事件通道常量（conversation:stream-chunk/turn-done + StreamChunkEvent/
  TurnDoneEvent）与 index.ts 最小装配（事件回调转发主窗口 send，before-quit dispose）；
  ④ 冒烟矩阵 1–8 主进程驱动扩展（进程专属临时目录，不触碰用户 userData，结束清理）。
  **红→绿抓出 2 个集成缺陷并修复**：deleteSession 与在途生成竞态下 user 消息落盘
  复活已删会话文件（appendMessage 存活守卫）；200 条裁剪后落盘仍用未裁剪数组引用
  （落盘改用裁剪结果）。**契约校准决议 #19**（与实现同 commit）：createSession 达
  上限返回 null（§9 拒绝新建与 §4.2 可空 bridge 要求失败通道，§3.1 已同步）。
  仍不接 renderer UI/IPC invoke 通道（S4）、不做真实 Provider 联网；
  safeStorage 运行时验证仍留 S4 场景 10；零新依赖。
- **S3 收尾交接校准（2026-08-13，独立校准 commit）**：① progress.md「下一个推荐任务」
  指针修正为 S4（原误留 S3）；② AGENTS.md §5 createSession 签名显式化为
  `Promise<ConversationSession | null>`（实际代码与唯一契约源 §3.1 一致，决议 #19）；
  ③ **决议 #20 Provider 选择契约**——ask 原「取 `ConfigStore.list()` 首个已配置项」
  依赖文件条目顺序的隐含规则，已定稿并落地为「providerId 属于已注册工厂 kind 的配置」
  （纯函数 `selectRegisteredProviderInfo`，v1 仅注册 openai-compatible、ConfigStore 以
  providerId 为键 upsert 同键恒唯一 → 选择唯一且与条目顺序无关；无已注册 kind 配置 →
  not-configured 零网络请求）。同步唯一契约源 §6.1/§15 与 AGENTS.md §5；单测新增 5 用例
  （纯函数 3 + 服务级 2：多配置共存顺序无关/仅未注册 kind → not-configured）；测试与
  冒烟进程内注册 'fake' kind（与生产同路径）。test 304/304 · typecheck · lint ·
  format:check · build · 冒烟双场景退出码 0。
- **S2 ContextBuilder 纯核心（2026-08-13，第二个实现闭环）**：test **242/242** ✅
  （170 基线 + 72 新增：context-budget 42 / context-builder 30）· typecheck ✅ · lint ✅ ·
  format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0（dev 离线 + 生产产物，
  既有场景回归，S2 纯逻辑不扩冒烟）。交付内容：① `context-builder.ts`——
  `buildContext`（组装 ProviderRequest：system 恒等透传 + 历史重放 + 末条 user 消息含
  UNTRUSTED_WEB_CONTENT 块）/ `deriveContextMode`（selection trim 非空优先独占 → snapshot →
  none；L2 保留身份降级）/ `isThinSnapshot`（正文合计 < 300）/ `buildContextSource` /
  `SYSTEM_PROMPT` 编译期常量；块闭合转义（`</` → `<\/`）+ 属性 `& < > "` 转义 +
  `<selection>`/`<section name>` 结构；② `context-budget.ts`——`CONTEXT_BUDGET`（§7.5
  全量表）+ 确定性裁剪（text→headings→tables→links→buttons→inputs 优先级填充、各节/
  条目上限、总预算 30000 停止、任何截断 `…[已截断]` 标记 + 警告、布局表启发式过滤
  「跳过 N 个疑似布局表格」）+ `trimHistory`/`renderHistoryMessageContent`（最近 8 对 /
  12000 字符 / 单条 2000 含来源行 ≤120 计入预算）；③ 契约校准决议 #18（与实现同 commit）：
  `ContextBuildInput` 增补 requestId/model、`buildContextSource` 增补 tabId、§7.6 实现
  落点明确（§3.2/§6.1/§7.6/§15 已同步）。纯函数零 Electron 依赖、零新依赖、不接
  IPC/UI、不联网；ProviderRequest 类型与 S1 交付一致（无冲突）。
- **S1 Provider 抽象与凭据安全基座（2026-08-13，首个实现闭环）**：test **170/170** ✅
  （89 基线 + 81 新增：error-normalize 18 / fake 12 / openai-compatible 12 / llm-provider 6 /
  credential 16 / config 11 / logger 6）· typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 双场景退出码 0（dev 离线 + 生产产物，既有场景回归，S1 不扩冒烟）。
  交付内容（1 个逻辑 commit c254465）：① `shared/types/conversation.ts` 定稿落地
  （§2 全部类型 + Provider 类型——Provider 数据类型放 shared，S4 preload/renderer 可复用，
  与任务文档一致）；② error-normalize 状态码矩阵纯函数（脱敏断言：错误不含响应体/密钥）；
  ③ LLMProvider 接口 + 工厂注册表 + resolveProvider；④ FakeProvider 确定性脚本
  （分块/延迟/错误注入/中止/getLastRequest）；⑤ OpenAI-compatible 适配器（原生 fetch +
  SSE 自解析：`\n\n` 分帧/[DONE]/usage 末帧/末帧 delta+usage 同帧不丢内容/CRLF 归一化；
  连接 15s/空闲 60s/总 300s AbortController 组合；Key 每请求从 store 取不缓存、适配器
  不记请求头；零 Electron import）；⑥ SecureCredentialStore（cipher 后端注入可替换 +
  `safe-storage-cipher.ts` Electron 薄胶水——设计 §1 布局外的唯一新增文件，分层纪律所需；
  密文落盘/原子写/损坏容错 fail-closed/不可用仅内存降级/sk- 明文形态条目丢弃）；
  ⑦ config-store（baseUrl 仅 http/https 去尾 /、model 非空、加载形状校验 fail-closed、
  list() 含 hasKey）；⑧ logger sanitize 导出 + sk- 形态 Key/apiKey 键值对脱敏。
  **契约一致性校准（2026-08-13 同日闭环，独立 commit）**：`resolveProvider` 与
  `ConfigStore.list()` 为 async 经独立核对判定必要——§3.4 将 `SecureCredentialStore.has()`
  定为异步接口（「无 Key → null」与 hasKey 判定必须 await），§4.2 bridge 本就按 Promise
  建模 `list()`，§6.1 ask 编排在 async 上下文内 await 无成本；设计文档 §3.3/§3.5 签名与
  §6.1 await 时序已同步并新增决议 #17，不再遗留至 S6。不接 IPC/UI、不联网、零新依赖；
  safeStorage 运行时行为按计划留待 S4 冒烟验证（§13.2 场景 10）。
- Second Stage 切换与设计定稿（2026-08-13，纯文档任务，零代码改动）：① 步骤 0 核对——
  git 工作区干净、First Stage Exit Gate 与 Second Stage Entry Gate 均已有独立复验证据；
  ② 定稿 `doc/stage2/proposal.md`（目标/非目标/验收/Q1–Q10 拍板/S1–S6 里程碑）、
  `doc/stage2/high-level-design.md`（架构/决策/数据流/安全模型/存储/测试/风险）、
  `doc/stage2/detailed-design.md`（§2–§16 唯一契约源：五模块职责与接口、IPC 白名单、
  错误契约、实时快照防串页、selection 优先级/薄快照/表格噪声、预算与确定性裁剪、
  角色隔离与 UNTRUSTED 块、流式/中止/超时、会话持久化与不保存、Key 安全、面板布局、
  注入验收边界与剩余风险、冒烟矩阵）、`doc/stage2/tasks/S1–S6`（每任务 = 一个可验证
  开发闭环：目标/范围/非目标/测试/完成定义/依赖；每个任务重申三阶段红线——严禁新增
  click/fill/scroll、自动搜索、多步 Browser Agent Tool）；③ 更新 AGENTS.md（§1/§2
  阶段指针与接管顺序、§3 AI 架构纪律/Key 零暴露红线/第二阶段不做清单、§4 结构、
  §5 Second Stage 契约速查、§6 冒烟与真实 Provider 可选验证、§7 测试、§8 注入边界声明、
  附 B/附 C）、README.md（当前状态/冒烟/架构/测试/已知限制）、本文件；
  ④ 第一阶段 doc/proposal、doc/high-level-design、doc/detailed-design 与
  doc/tasks/baseline.md **原位保留未覆盖**（历史定稿）；Second Stage 及后续文档按
  `doc/stageN/` 目录约定独立存放；⑤ 验证：npm test 全量回归 + typecheck + lint +
  format:check（纯文档按 AGENTS.md 附 A 免构建/冒烟）+ 文档交叉引用与格式检查。
- Second Stage Entry Gate 独立定向审查（2026-08-13，纯审查零代码改动）：按 Second_stage.md
  §2 逐项复核——① 四模块稳定边界与 AGENTS.md §5 契约逐项一致；② PageSnapshot 真实页面探针
  （example.com/MDN 长文/w3school 表格页/cnblogs 长文/百度百科动态长文/sspai 动态首页/bing
  首页七页：长文与表格内容质量良好、L0/L1 阶梯与 warnings 正常；bing 首页文本稀薄属页面特性）；
  ③ elementId 生命周期与销毁错误处理（敌对页冒烟复跑）；④ 权限隔离冒烟复跑；⑤ 全量验证
  复跑全绿（test 89/89 · typecheck · lint · format:check · build · dev/生产/真实 URL 冒烟 ·
  Session set/check）；⑥ 本文档无阻塞级缺陷。另以同视图导航/刷新一致性探针证实无旧快照
  复用，selection 焦点保持探针证实 chrome 获得焦点后页面 selection 保留且真实采集脚本可读
  （支撑「对选中文字提问」链路）。判定：**Entry Gate 通过，无阻塞项**。审查发现的文档
  不一致（AGENTS.md §6 Session 冒烟命令缺 `AIBROWSE_SMOKE=1`）已于本闭环修复；新增
  Second Stage 设计约束三条登记于「计划内限制与延期项」。
- T5 收尾（2026-08-13）：test 89/89 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 全场景退出码 0：① dev 离线（含 T5 新场景）；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。新增验证：
  ① **安全审计**：detailed-design §11 逐项核对实际代码全部落实（Tab/UI 安全默认值、
  IPC sender+主帧校验、preload 白名单、双权限处理器默认拒绝、监听器逐一清理）；
  ② **R-02 关闭**：Tab will-redirect 白名单 + 受控 302 冒烟（允许目标 http→http 跟随、
  禁止目标 custom:// 拦截 + 日志字节切片断言；探针实测 file:/data:/about:blank 被
  Chromium 网络层先拦、自定义协议/mailto: 真实触发 will-redirect）；
  ③ **elementId 敌对页审查**：修复同元素跨集合双 id 漂移 + 顶格烙印分配溢出两处缺陷，
  敌对页冒烟断言（重复/畸形/超大/负数/冲突烙印 → id 唯一、1–10 位数字、无歧义对应
  活 DOM 真实元素、跨快照稳定）；
  ④ **UI 端到端冒烟**：React DOM 点击/键盘事件驱动（地址栏 URL/搜索、多 Tab 新建/切换/关闭、
  后退/前进/刷新、标题随网页变化、调试面板 L0 徽标+JSON / L1 徽标+warnings 展示），
  远程页面隔离探针（window.aibrowse/process/require/electron 均 undefined）；
  ⑤ **Session 跨进程持久化**：AIBROWSE_SESSION_SMOKE=set/check 双独立进程 + 临时
  userData（HttpOnly Cookie 落盘 → 完整退出 → 新进程读回，测试后清理临时数据）。
  交付 4 个逻辑 commit：① R-02 will-redirect 加固（+logger 日志路径导出）；
  ② elementId 两处修复；③ 冒烟四场景扩展 + index 接线；④ 文档同步。
  仍不接入 LLM、CI、打包；第一阶段 Exit Gate 通过，停止等待用户指令。

- T4 PageSnapshot 闭环（2026-08-13）：test 89/89 ✅（42 基线 + 1 导航保护收紧新增 + 46
  snapshot-normalize 新增）· typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 三场景退出码 0：① dev 离线；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。冒烟新增真实采集断言：
  本地受控双服务器页面实际注入只读脚本——L0 内容对照（heading/link/button/table/
  visibleText/elementId 唯一性与跨快照稳定）、L1 跨域 iframe 跳过警告、L3 未知 tabId null。
  交付内容（5 个逻辑 commit）：① T3 核查发现导航保护生产 file: 前缀语义过宽
  （同目录扩展/路径穿越可放行）→ 收紧为入口精确匹配（scheme+pathname 相等，hash/query
  变体视为同一文档）+ 冒烟三探针；② snapshot-normalize 校验纯函数（页面视为敌手）+
  46 组红绿测试；③ 只读采集脚本（IIFE 字符串，DOM lib 引用保持 TS 检查）+ PageReader
  L0–L2 阶梯接入 BrowserController；④ 调试面板（JSON + degraded 徽标 + warnings + 可收起）；
  ⑤ 冒烟采集扩展。仍未接入 LLM、未开始 T5。
- T3 浏览器 UI 闭环（2026-08-13）：test 42/42 ✅（33 基线 + 9 ui-navigation-policy 新增）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 三场景退出码 0：
  ① dev 离线（T2 场景回归 + UI 导航保护拦截 + bounds 上报生效）；
  ② 生产产物（`npm run start`，file: 入口导航保护路径）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/，ready + 标题非空）。
  交付内容：UI 窗口导航保护（will-navigate + will-redirect 自身来源白名单，纯函数
  ui-navigation-policy + 9 用例，**bridge 扩展硬前提，与 bridge 同闭环落地**）→
  preload bridge 扩展（tabs/nav/page/ui 白名单，§3.2 定稿签名）→ 浏览器 chrome UI
  （工具栏/标签栏/地址栏/主区域 + ResizeObserver bounds 上报 + 原始输入 main 侧规范化）→
  冒烟扩展。分 4 个逻辑 commit 提交。
- 安全补丁（2026-08-13，审查发现→修复）：persist Session 权限默认放行漏洞已修复——
  `setPermissionRequestHandler` + `setPermissionCheckHandler` 双处理器默认拒绝（v1），
  策略纯函数 `permission-policy.ts` + 4 组纯测试（无 Electron mock）。test 33/33 ✅ ·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0，离线场景）。
  同步定稿：detailed-design §7/§9/§11/§12（权限默认拒绝 + UI 窗口导航保护事件集，
  Electron 43.4.0 实证：will-navigate 覆盖页面发起导航含 location.replace；
  will-redirect 覆盖页面发起与程序化两条路径的 302；不采用 will-frame-navigate）。
- T0 基线：test 15/15 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0）
- T1 定稿（2026-08-13，纯文档任务）：基线验证复跑全绿（test 15/15 · typecheck · lint · format:check · build）；
  Electron 冒烟按验证矩阵「纯文档」豁免（代码零改动）。定稿契约依据本地 electron.d.ts（43.4.0）
  逐项核实：WebContentsView/setVisible/addChildView/executeJavaScript/fromPartition/navigationHistory 均可用。
- T2 浏览器核心（2026-08-13）：test 29/29 ✅（15 基线 + 14 tab-state 新增）· typecheck ✅ ·
  lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （离线：多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等 + webContents 无残留；
  真实 URL：AIBROWSE_SMOKE_URL=https://www.bing.com/ 加载 ready + 标题非空）。
  冒烟首跑抓出并修复 2 个集成 bug：① closeTab 把「移除后」列表传给 selectNextActive
  （契约要求关闭前完整列表）→ 关闭活动 Tab 后邻居接管失效；② 窗口 closed 后
  BaseWindow 已销毁，removeChildView 抛 Object has been destroyed → 已加 isDestroyed 守卫。
- 规范校准：技术矩阵按官方来源（npm registry metadata + 官方文档）验证通过并冻结；
  依赖树健康（`npm ls` 无 invalid/missing peer）。

## 风险与限制

> 编号规则见文件顶部；正常后续任务、已接受的设计决议、机器环境说明不登记为风险
> （分别在任务表 / detailed-design / AGENTS.md §6）。

### 已关闭风险摘要

> 已关闭项保留编号与结论直至自然归档（不重排、不复用编号）。

- **R-01 UI 窗口导航保护缺失**（Medium，T3 内关闭，2026-08-13）：UI 窗口 preload 随任何导航
  加载，主框架被导航到远程页面即泄露 `window.aibrowse` bridge。处置：T3 先于 bridge 扩展
  落地 will-navigate + will-redirect 自身来源白名单（纯函数 `ui-navigation-policy.ts` + 用例；
  冒烟三探针实跑通过）。证据与影响详见 detailed-design §9/§12 决议 #16。
- **R-02 Tab 导航白名单未覆盖服务器重定向**（Low，T5 关闭，2026-08-13）：Tab 仅挂
  will-navigate，302 目标（如自定义协议）可绕过白名单。处置：补 will-redirect 与同一
  scheme 白名单，受控 302 实测（允许目标 http→http 放行跟随；禁止目标 custom:// 拦截 +
  日志断言；探针证实 file:/data:/about:blank 被 Chromium 网络层先拦、自定义协议/mailto:
  真实触发 will-redirect——自定义协议正是该风险的验证路径）。当前项目未注册自定义协议，
  该防护为防御纵深；结论 **Resolved**，详见 detailed-design §12 决议 #17。

### 开放风险登记

- 当前无开放风险。

### 计划内限制与延期项

（正常后续任务 / 已接受设计决议 / 明确延期，不虚构严重度与证据）

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过——已接受设计决议
  （detailed-design §12 决议 #13，快照为点时刻尽力采样）。
- 采集边界（T4 落地，非缺陷）：iframe 跨域计数为尽力采样（未加载完成的同源 iframe 可能被
  计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回 L2（按契约降级）；
  L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟强制触发（normalize 单测覆盖 L2 形状）。
- Tab will-redirect 白名单为防御纵深（T5）：file:/data:/about:blank 等目标已被 Chromium
  网络层拦截（ERR_UNSAFE_REDIRECT），当前无自定义协议注册；未来注册 `aibrowse://` 等协议
  时该拦截点是唯一防线（冒烟已用 custom:// 目标验证 handler 真实触发）。
- 无 CI / 打包配置：第一阶段验收不要求（Second Stage 起评估 CI：lint + test + typecheck；
  打包属 Seventh Stage Product Hardening）。
- fake-provider「延迟块实际等待」计时用例（≥30ms 墙钟断言）在全量并行负载下 2 次
  测得 29.94ms（差 0.06ms，2026-08-14 A2 会话观察）；单文件 10/10、全量连跑 5/5
  全绿——判定为墙钟断言边缘抖动、非可复现失败，阈值未放宽；后续会话若高频复现，
  评估根因后做安全的小范围测试改进（如改用与计时器同源时钟或断言最小等待语义）。
- shared/url 不支持 IDN（中文域名走搜索兜底，安全无副作用）；SearchProvider 抽象已定稿
  于 Third Stage A4（doc/stage3/detailed-design.md §6：v1 Bing 页面实现 + 接口隔离
  保替换；shared/url 的 SEARCH_ENGINE_URL 常量语义不变，由 SearchProvider 引用）。
- **O-1 纵深硬化观察（2026-08-14 最终验收发现，Info；不分配开放风险编号）**：
  conversation-store 以 sessionId 直接拼接会话文件名（`<userData>/conversations/
<sessionId>.json`），store 层无 UUID 形状校验。无已知攻击路径：getHistory/
  deleteSession 均以内存索引成员资格为前置（索引由 createSession 随机 UUID 生成
  或 parseIndexFile 形状校验产生），IPC 有 sender+主帧校验，UI 窗口导航锁定自身
  来源；本地拥有 userData 写权限者本可直达数据。可选纵深防御（本闭环不改生产
  代码）：store 层加 UUID 形状校验。**最迟在会话导入、外部同步或相关信任边界
  变化时复核。**
- **A7 补验 reasoning_content 回传边界（2026-08-14 决议 #35，容忍设计如实登记）**：
  跨 run 重放不携带 reasoning_content（思维过程不持久化红线所致）——对要求原样回传的
  Provider（DeepSeek V4 thinking 模式），**旧会话重问**可能 400 → 结构化
  provider-error 安全失败（不泄露思维过程、不伪造成功）；验收场景均使用新会话，
  不受影响。另：运行时 transcript 内 reasoning 原样保留（不截断）——请求规模由
  步数上限 12 与 Provider 自身输出约束，属确定性上界内的计划内限制。
- **A4 SearchProvider 计划内限制（2026-08-14 决议 #32，容忍设计如实登记）**：
  ① v1 搜索 snippet 恒空串 + warning——扁平快照无法为每条结果提供可靠的摘要
  关联证据，不得把相邻但无依据的文本错误配给结果（宁缺勿错；未来供应商实现可
  自带摘要）；② Bing 非结果标签精确匹配过滤——与标签完全同名的合法结果标题会
  被一并过滤（宁简勿误配）；③ 结构识别依赖内容性证据——空内容快照 →
  search-failed（不伪装成功空结果），有内容无有机结果 → 合法空结果（页面结构
  变化与确实无结果无法进一步区分，warnings 如实说明）；④ 公网探针实测
  （2026-08-14）：Bing 当前主要返回直接目标 URL，ck/a 包装还原为确定性兜底
  规则（两形态均覆盖单测与冒烟夹具）；⑤ 轮询等待 ready（无事件订阅）——
  getTabs 每 50ms 一次、15s 上限，临时 Tab 生命周期极短，负载可忽略。
- **A6 操作可见性计划内限制（2026-08-14 决议 #34，如实登记）**：
  ① 实时状态相位（starting/thinking/executing/waiting-confirm/confirm-
  resolved/finalizing）为程序生成的确定性运行事实，但瞬态相位（如
  confirm-resolved）在快任务下窗口极短——UI 冒烟以持久产物（决策徽标/终态
  文案）断言，瞬态文案由单测确定性覆盖；② Agent 的流式文本（含工具轮过程性
  输出）走既有 conversation:stream-chunk 通道与共读共用 useStream——UI 以
  状态栏相位标记过程性输出、turn-done 收敛为 finalText（终态消息 content
  恒等），过程性文本本身不持久化外扩；③ 确认框「已拒绝/已批准」等决议状态
  文案为瞬态相位（next 状态事件即覆盖），由 describeAgentStatus 单测固化；
  ④ smokeAgentLimits/smokeAgentSearchProvider 为 SMOKE_MODE 专属注入点
  （生产行为不变，冒烟 finally 清空）；⑤ 面板折叠卸载 AiPanel 时任务模式
  选择随之重置（模式本就不持久化——设计语义），运行中的 run 不受影响。
- **A5 Agent Runtime 计划内限制（2026-08-14 决议 #33，如实登记）**：
  ① 确认事件回调（ConfirmManager.onPendingChange）所有权为「最后构造的
  ConversationService 实例」——A5 进程内仅一个生产 Service + 冒烟 Service 顺序
  构造（单 pending 设计本身已全局串行化 L2），多 Service 并行共享 ConfirmManager
  属 A6+ 扩展点；② 取消竞态下被中断的工具调用计 stepsUsed 与审计但不产生
  ToolStep（迟到结果被忽略——工具执行与终态 Promise.race 所致），
  toolStepCount ≤ stepsUsed 仅出现在该竞态路径（单测固化）；③ 运行时
  transcript 保留当轮 ToolResult 全文（≤4000/8000 确定性截断）——12 步上限 ×
  结果预算 + 启动快照 ≈ 100k 字符的请求规模确定性上界；跨 run 重放仅摘要
  （决议 #26）；④ FakeProvider 多轮 rounds 脚本为测试设施扩展（生产适配器
  行为不受影响）。
- UI 窗口（defaultSession）未注册权限处理器：UI 只加载自身内容，R-01 已关闭（导航保护落地）
  后无远程页面可达，当前无需处理；未来 UI 嵌入远程内容时重新评估。
- 地址栏搜索的端到端验证在离线环境断言「导航目标为 Bing 搜索 URL」（did-start-navigation），
  真实搜索页加载需联网（冒烟含 AIBROWSE_SMOKE_URL 联网变体；URL 判断本身有 15 用例单测）。
- Second Stage 设计约束（2026-08-13 Entry Gate 审查登记；属第二阶段的输入约束而非本阶段
  风险，不进入开放风险登记、不占用 R 编号）：三条已由 Second Stage 详细设计定稿化解——
  ① **提问时刻实时采集防串页** → ask 编排时序即契约（doc/stage2/detailed-design.md
  §6.1/§6.2 + 防串页三断言）；② **薄快照降级策略** → thin 阈值 300 字符 + 提示
  （§7.2/§7.4）；③ **布局表噪声** → 确定性启发式过滤 + 容忍设计（§7.5/§7.7）。
- Second Stage 设计决议（2026-08-13 定稿时接受，属设计决议非风险）：① 字符预算 ≠
  token 预算（无 tokenizer，保守字符上限 + Provider 400 映射 context-too-long 兜底）；
  ② 会话不持久化快照正文（跨轮「结合上一页」类追问仅靠 contextSource 来源行，
  最小化持久化，Second_stage.md §7）；③ 布局表启发式为容忍设计（误删只是少内容、
  误留只是多冗余，均有 warnings）；④ 回答渲染 v1 纯文本（无 Markdown 库）；
  ⑤ 面板定宽 380px（不做拖拽调宽）。
- **Prompt Injection 语义层剩余风险（S5 已复核，S6 分类校准 2026-08-13——正式登记为
  「已接受的剩余设计风险/计划内限制」，不分配 R 编号，开放风险仍为「无」）**：
  机器可验证的结构性结论已由 S5 逐项验证——网页内容**不能**取得权限（permission-policy
  默认拒绝探针）、读取密钥（bridge 无读回 + 真 Key 零暴露扫描）、调用写操作（全仓库无
  写 Tool/写通道 + 请求无 tools 字段）或改变消息角色（程序字面量 + 单块闭合转义断言），
  详见 §12.1 审计。**不承诺（也不得宣称）Prompt Injection 完全免疫**：模型在语义层仍
  可能受网页文本诱导（如诱导生成误导性回答、诱导式表述）——当前阶段无浏览器写 Tool，
  该诱导无法转化为真实操作，故不构成需要当前阶段继续修复的缺陷。
  **最迟复核点已执行**：2026-08-14 随 Third Stage 切换**威胁模型重建定稿**
  （`doc/stage3/threat-model.md`）——「网页文本诱导调用工具」成为真实攻击面，
  防线升级为五层（结构/能力/决策/审计/运行时）+ 红队矩阵 RT-01～RT-11（A7 实施）；
  第三阶段语义层残余风险四类（诱导式工具参数/确认疲劳/低风险动作累积滥用/click
  允许列表目标的页内 JS 副作用，2026-08-14 实施前校正新增）正式登记
  为「已接受的剩余设计风险」（threat-model §5），不分配 R 编号；Fourth Stage 前按
  ROADMAP.md 阶段切换原则重新评估。

## 阻塞项

- **第三阶段最终验收阻塞（已解除，2026-08-14 A7 补验最终执行）**：§9 Engineering
  「多个真实网站 Agent smoke test 通过」原 BLOCKED（首轮 tools 载荷 HTTP 400）——
  根因确诊为 wire 名称契约（13 工具名携带点号，非「模型不支持 tools」）→ 离线修复
  （决议 #35：wire-safe 下划线名 + 双闸门 + reasoning_content 不透明回传）→ 最小
  预检（协议判定 PASS）→ 完整真实验收（deepseek-v4-pro，§7 场景 1–6 + RT-10 +
  停止全部真实通过，`LIVE_SMOKE_PASS` 退出码 0）→ **§9 五组全 PASS、§10 总判定
  改判 `GO/PASS`**。真 Key 零暴露扫描与全量离线验证同步通过。历史证据与台账
  保留于最近验证结果与 git log。

## 下一个推荐任务

- **B5 — Sources UI + 手工管理 + 当前页快速添加 + 冲突/恢复态/Undo 展示 +
  IPC/bridge 扩展（新对话 = 一个可验证闭环）**：
  B1–B4 已完成（node:sqlite 冻结决议 #48；schema v1/Repository/Service/journal/
  Undo/多语言检索/Source 四工具（注册表 17 工具）/change set 确认全链路在位；
  基线 1071/1071 全绿，dev+生产冒烟与 B-02 双进程退出码 0）。B5 按
  `doc/stage4/tasks/B5-sources-ui.md` 落地 Sources 面板（分组浏览/搜索/备注与
  标签/手工添加编辑/当前页快速添加/Undo 与恢复态中文诊断/provenance 展示/
  v1 明文如实说明）+ IPC 通道与 preload 白名单（复用 handle() sender+主帧校验
  与事件只发主窗口纪律）+ 手工操作经同一 SourceService（addManual/updateManual/
  disableManual/restoreManual/hardDeleteManual 能力令牌二次确认）。完成后按
  B6→B7→B8→B9 顺序推进，B9 独立复验不采信前序报告；本提示内不再继续实现，
  等待用户下一条指令。

## 第一阶段验收未完成项

- 无：First_stage.md §十四 全部验收项已逐项核对并通过（T5，2026-08-13）；
  证据摘要见 First_stage.md §十四「验收证据」与本文「最近验证结果」。
