# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。
> ⚠️ 风险编号 R-XX 按登记顺序分配，**不得重排、不得复用**（已关闭项保留编号与结论直至自然归档）。
> 「风险与限制」只登记当前仍需关注的事项；历史细节由 Git 提交与任务文档保存，不在此重复叙述。

## 当前状态

- 阶段：**第六阶段（RSS/Page Watch、确定性变更事件与摘要）已正式切换，设计闭环与
  D1–D6 均已完成并关闭。**用户通过 U01–U31
  完成全部需求裁决；正式设计候选在
  `f1a062fe5c0b3ae9f7cfaf8bf634bc78e16c602b` 经新的独立 Reviewer `PASS`。本轮设计范围
  为 `Sixth_stage.md`、`doc/stage6/` 四份设计与 D1–D11 任务契约，零产品代码、零新依赖、
  零真实 Provider 调用。第六阶段 Entry Design Gate=`GO`；D1–D6 均经 Reviewer `PASS`
  并已关闭。D3 的三个解析依赖已通过资格门并精确固定：
  `@federicocarboni/saxe@0.8.0`、`parse5-sax-parser@8.0.0`、`parse5@8.0.1`；下一唯一
  实施任务为 D7。
- 已完成（第五阶段，历史）：独立 Stage Auditor 于 2026-08-23 在批准产品 HEAD
  `c1aafd963f4952c81933ab2d873d154fe1b2741b` 完成复验，Reviewer / Stage Auditor =
  `PASS`，Fifth Stage Exit Gate = `GO/PASS`；C10 仅做确定性文档闭环，产品代码 HEAD 不变。
  **设计闭环已完成（2026-08-16，纯文档任务，零产品
  代码、零新依赖、零真实 Provider 调用）**——`doc/stage5/` 定稿：
  proposal（目标/非目标/场景/Entry Gate 证据表/遗留风险分级/决策表
  D1–D13/里程碑）、high-level-design（依赖方向/模块/数据流/安全模型）、
  detailed-design（唯一契约源 §2–§16：类型/状态机/候选合并排序/capture·
  evidence/ResearchRuntime/预算全表/cross-check/Result Schema·Renderer/
  storage/IPC/决议——范围以 §15 当前记录为准，现已至 #172）、threat-model
  （FT-01～FT-17 / FRT-01～FRT-12 / 诚实边界十一类，先于任何 Research 实现
  定稿）、任务 C1–C10。
  Entry Gate（Fifth_stage.md §2 五项）逐项核验**全部通过**（证据表见
  proposal §7：三方 SHA 一致 6d730a6/基线 test 1255/1255 独立复跑全绿/
  17 工具契约与 Sources 检索真实 Provider 证据）。**C1 已完成（2026-08-16）**
  ——Research 核心契约（shared/types/research.ts 单一事实源）/状态机纯函数/
  预算常量全表/research.db migration v1 七表集/Repository（唯一 SQL 执行点）/
  store 装配（normal|unavailable 两态 + 遗留 running 标 interrupted）/
  Service 生命周期骨架（create/get/list/delete/start 前置/stop）全部落地
  （契约裁决 #101–#111，全量 test 1386/1386，红→绿证据见 C1 任务文档）。
  **C1 定向修复与契约边界复核已完成（2026-08-16）**——五个契约边界缺口
  先红后修（决议 #112–#116，红态 34 failed → 聚焦 174/174、全量
  **1429/1429**）：goal 截断标记计入上限（String.length 恒 ≤2000）、
  EvidenceLocator.table.header 非法形态整体拒绝、全部任务状态更新写路径
  按更新后任务投影做 500k UTF-8 字节预算检查（事务内、markAllRunning
  Interrupted 整体拒绝零写入）、启动装配清理后仍超限 → unavailable
  （created 零删除）、状态机 now 为 ISO 8601 输入有效性约束——证据见 C1
  任务文档「定向修复与契约边界复核」小节。
  **C1 第二次定向补修已完成（2026-08-16）**——ISO 8601 偏移日期回滚校验：
  偏移形态原仅做 Date.parse 值级往返（对已成功解析的时间近似恒真），
  2026-02-30+08:00 / 2026-04-31-05:00 等回滚日期被静默放行；先红后修
  （红态 6 failed → 聚焦 **215/215**、全量 **1470/1470**）——确定性
  日历字段校验（月范围/闰年/各月天数/时≤23/分秒≤59/偏移既有边界），
  Z 形态保留字符串级往返；#116 仅补实现说明不改结论；migration v1/
  Repository/Store/Service 零改动。证据见 C1 任务文档「第二次定向补修」
  小节。
  **C2 已完成（2026-08-16）**——ResearchWorkspace 与 task-owned Tab 隔离
  （实施前契约裁决 #118 + 精确接口 §10.1；红→绿 39/39 + 全量 **1509/1509**）：
  精确 tabId 所有权（敌手 createTab 返回已存在 id 零关闭零登记）/并发上限
  3（同步段槽检查，第 4 次 create 前确定性拒绝）/URL 边界复用
  normalizeSourceUrl/焦点恢复三态（未切换→恢复、已切换→零 activate、
  activeBefore 已关→不重建 + warning；activateTab 失败→精确关闭新 Tab +
  tab-restore-focus-failed）/checkTab 显式快照感知用户关闭（零事件/计时器/
  监听器）/cleanupAll drain 屏障（in-flight create 落定后精确关闭零泄漏）/
  cleanup 后 acquire 拒绝/closeTab false·抛错不误报已清理/用户 Tab 集合
  恒等/abort 前与 create 期间/零 Electron import/MAX_RESEARCH_TABS 单一
  事实源。**C2 定向安全修复已完成（2026-08-16，决议 #119）**——取消/
  异常清理路径的两类 Tab 所有权漏洞先红后修（红态 7 failed/41 passed →
  聚焦 48/48、全量 **1518/1518**）：① abort 检查先于 tabsBefore 所有权
  验证，createTab 在 pending 期间返回既有用户 Tab 时可能关闭用户 Tab →
  所有权验证优先（即使已 aborted 也零关闭零登记）；② closeBestEffort
  忽略 closeTab=false/抛错且调用方已撤销/未登记所有权，清理失败后 task
  Tab 永久失联 → provisional ownership（全新精确 id 先登记后清理）+
  清理事实语义（确认关闭才移除所有权；清理失败 → cleanup-failed +
  cleanupAll 精确重试）——证据见 C2 任务文档「定向安全修复」小节。
  **C3 已完成（2026-08-16）**——Source Selection：Sources + Search
  候选合并、provenance 与确定性排序（实施前契约裁决 #120–#123 + 详细
  设计 §4 重写 + 各文档同步；红→绿 **80/80** + 全量 **1598/1598**）：
  三档发现路径排序（tier 1 source-search 保留 SourceService 输入顺序/
  tier 2 group-list priority 降序 + lastUsedAt 降序 + scope/canonicalKey/
  id 收尾/tier 3 web-search 保留 Provider 顺序且 trust/priority/
  lastUsedAt/note 恒 null——trust 仅 provenance 元数据不改变基础排序，
  废止旧五档描述；同身份 Sources+Search 合并采用 Sources 档位与字段 +
  双 discoveredVia）；note 映射（作者标签/清洗/截断不拆 surrogate/无
  空标签/不进 sortKey）；candidateId 输入契约（C5 预分配小写 v4 UUID、
  非法/重复整次 fail-closed）；sortKey 编码
  `TT|RRRRR|P|I|S|canonicalKey|candidateId`（真实 node:sqlite probe
  证明内存 binary 顺序 === listCandidatesByTask() 顺序）；hostile
  input 矩阵（危险 scheme/userinfo/控制字符/超长/canonicalKey 不一致/
  disabled/blocked 单条安全丢弃零 throw 零日志正文）；预算（24 裁剪/
  选定 ≤8/深冻结零修改输入）。证据见 C3 任务文档「红→绿证据」小节。
  **C4 已完成（2026-08-16）**——多源读取、结构化提取、Capture 记录与
  Evidence 确定性验证（实施前契约裁决 #124–#131 + §2/§5 重写 + 各文档
  同步；红→绿 聚焦 **136/136** + 全量 **1691/1691**）：CaptureService
  （Tab 生命周期零双导航——Workspace acquire 已加载/浏览器最小端口仅
  getTabs·getPageSnapshot/acquire→ready 轮询→checkTab→snapshot→checkTab
  →finally release；冻结判别联合与重试矩阵——page-load-failed/timeout/
  snapshot-degraded 重试 ≤1 次、aborted/http-scheme-rejected/
  tab-closed-by-user 不重试、cleanup-failed 不继续建 Tab；release 失败
  不误报清理——所有权保留供 C5 cleanupAll 重试、内容已捕获只附安全
  warning；failed Capture sentinel——tabId=`unallocated`/documentId=
  `unavailable`/contentHash=SHA-256(空串) 前 32 hex/summary 全 0/
  url·title 取已校验候选展示值/accessTime 注入主进程时钟；**#131
  Chromium 错误页判定**——加载失败错误页 finish-load 把状态翻回 ready
  （冒烟探针实测），快照 chrome-error:// 前缀 → page-load-failed 可重试、
  其余非法目标 → http-scheme-rejected；CaptureContent 纯内存——规范化
  NFC/trim/控制/bidi 清除/空白折叠、canonicalText 顺序固定串行格式
  visibleText→headings→tables→links→fields、60k 预算与哈希覆盖（超预算
  条目整表丢弃、surrogate 不拆分）、闭合字段路径白名单、summary 四项
  语义校准 tableCount=表格数量、contentHash 确定性）+
  EvidenceValidator（不可信 proposal 六字段白名单、evidenceId 可信预分配、
  十三闭合错误码 + 安全中文 reason、校验顺序六步、多表 tableIndex 精确
  区分（决议 #129：0-based 必填、非法 fail-closed）、header 程序生成与
  一致性、字段路径禁原型链键/通配符、rejected 不产生 Evidence 零落库、
  幂等）+ repository tableIndex 严格解析 + 冒烟 8.16（真实
  ResearchWorkspace+CaptureService+BrowserController 读取受控页、实际
  documentId/accessTime/hash/summary/tableIndex 断言、确定性 proposal
  verified/rejected 全链路、失败 URL 后继续下一候选成功、Capture 元数据
  +2 条 VerifiedEvidence 临时 research.db 写入/读回恒等、正文零持久化
  探针 CAPTURE-PROBE 拆散节点标记零命中、用户 Tab 集合不变；dev+生产
  双场景退出码 0；真实 Provider 调用 **0 次**——无真实 Provider 产品
  链路，不为展示授权发起无关调用）。C4 不修改 ResearchTask.stats
  （captureCount/failedReadCount 递增归 C5 Runtime）。证据见 C4 任务
  文档「红→绿证据」小节。
  **C4 Post-Acceptance Repair 已收尾（2026-08-21，独立 Reviewer B =
  `PASS`，已推送）**——修复链 `65fe15d → f681451 → 56ea5c4 → e2404d0 →
f38fb4d → abe7351 → 4c75a86` 连续单父历史悬挂原 baseline `3836587`；
  四项验收（Repair A 文档 gate / Repair B implementation / surrogate
  coverage Repair / filesystem cleanup）均 PASS；产品 HEAD 与 tracked
  tree 与独立产品验证的 `4c75a86` 完全相同（Repair 仅删除工作区已核验
  空目录）。证据见 C4 任务文档「Post-Acceptance Repair 状态」小节。
  **C5 已完成（2026-08-16）**——独立有界 ResearchRuntime（实施前契约
  裁决 #132–#139：六工具专属执行模型/ResearchPlan 判别联合/C6/C7 稳定
  端口 + research-runtime-unavailable 第 12 码 fail-closed/Service 异步
  装配（单一 active slot + runToken + restart 屏障 + 幂等 shutdown）/
  步数·轮次·上下文预算与 Provider 失败映射/原子持久化与 500k 终态预留/
  Progress·heartbeat·终态优先级/index.ts 最小装配）；红→绿 聚焦
  **113/113** + 全量 **1804/1804**；冒烟 8.17 dev+生产双场景退出码 0；
  AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0；真实 Provider
  调用 0 次（无真实 Provider 产品链路）。证据见 C5 任务文档「红→绿
  证据」小节。
  **C6 已完成（2026-08-16）**——Cross-check、冲突模型、带证据综合与
  「不确定」输出（实施前契约裁决 #140–#147：C6/C7 分阶段装配边界
  （C6 不单独解除生产 fail-closed——index.ts 生产装配零改动；C6 冒烟
  注入严格 C7 stub）/Provider 响应侧有界性（每段 stream 文本/工具调用
  数量/id/name/arguments 单项与累计编译期上限，超限立即停止消费映射
  research-budget-exhausted、超限工具调用零执行、超限原文零回显、
  reasoning 直接丢弃零累积）/VerificationDraft 严格输入协议（纯 JSON
  严格白名单、可信字段全由程序产生）/Claim 确定性装配（canonicalKey
  coverage 不按条数冒充多源/sourceTypes 程序判定——厂商分类缺口裁决：
  vendorCandidateIds 模型提议 + 程序 origin 判定，不洗白 trust/
  severity 影响程度语义——单源 high 保持 high + singleSourceFields
  程序标记）/Conflict 引用完整性（局部 claimKeys 映射/双向 conflictIds
  一致/诚实边界保留）/C5→C6→C7 数据交接（内存不可变快照 +
  verificationState + C7 context 新字段）/Prompt 与上下文构建所有权
  （四编译期常量 + 冻结端口对象，块组装仍归 C5 Runtime）/parseResultDraft
  结构解析与 Uncertainty 分工）；红→绿 聚焦 **61/61**（claim-model 43 +
  prompts 9 + runtime-c6 9）+ 全量 **1865/1865**（基线 1804 + 61，
  既有用例零删除零削弱）；冒烟 8.18 dev+生产双场景退出码 0/0
  （Claim/Conflict 确定性装配断言 + synthesis 上下文快照 + Result
  coverage 计数零百分比 + ≥1 uncertain 块 + 正文/reasoning 零落盘 +
  用户 Tab 恒等）；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码
  0/0；真实 Provider 调用 0 次（无真实 Provider 产品链路）。**生产
  Research 仍 fail-closed**（决议 #140：缺 C7 真实端口——startTask →
  research-runtime-unavailable）。证据见 C6 任务文档「红→绿证据」小节。
  **C7 已完成（2026-08-16）**——ResultValidator + 安全 Markdown 子集 +
  Research Result Renderer + 真实 C6+C7 生产装配（实施前契约裁决
  #148–#155：D9/#99 Markdown 单一事实源（表格不实现——Table 块唯一
  结构化通道；解析器进 shared 供 main Validator 与 renderer 共用）/
  ResultDraft 三字段白名单（title/summary/blocks——resultId/taskId/
  evidenceMap/conflicts/coverage/fetchedAt 全部程序生成；模型提供即整份
  拒绝；fetchedAt = Evidence 最大 accessTime 或 Runtime 可信时钟；
  context 增 now）/ResultValidator 严格验证（不 throw 预期失败/未知字段·
  错误类型·越界·非法引用·重复 ID 整份拒绝/两种规范化/表格行列严格一致/
  ranking 1..N 连续/sourceRefs 非空去重有界∈候选且有 verified Evidence
  支撑（table block 级——v1 无逐列映射）/总大小 200k/错误零敌对正文回显/
  强制 uncertainty 五条件矩阵）/Conflict·Coverage·「不确定」（evidenceMap/
  conflicts 程序投影、coverage 由 claims 确定性计数——类别计数可重叠不
  要求相加等于 total）/Markdown AST 与 Renderer（子集定稿：标题 1–3/
  段落/列表/引用/围栏代码/行内五型；未闭合标记字面化/深度·节点数·输入
  长度有界降级/单遍线性扫描防 ReDoS/raw HTML 零解释/URL 双防线——
  Validator 拒绝 + Renderer 纵深降级/ResultView 零 `<a href>` +
  onOpenUrl 回调预留）/logger 未初始化落盘修复（红态机器证据：基线测试
  前根目录零日志 → 测试后生成 aibrowse-2026-08-16.log；修复后未 init 仅
  脱敏 console 输出 + getCurrentLogFilePath 未 init 返回 '' + re-init
  重置轮转 + 真实临时 cwd 探针零文件；修复后多次全量测试根目录日志文件
  零写入）/ResearchService 启动预占与 Provider 交接（starting slot 原子
  预占——并发 start 先到先得、另一个立即 research-busy 零二次 resolve；
  shutdown-during-resolve 迟到 continuation 零 DB 写入零 launch +
  prepared 释放；resolve 失败任务保持 created 精确错误码；stopTask 在
  resolving 阶段 research-invalid-state 零副作用；Factory 接口窄幅修改
  ——resolveProvider 返回一次性 prepared（launch/release 恰好一次，等价
  竞态证明见 §15 #154）；C1/C5 既有测试 stub 机械校准）/真实生产装配
  （新模块 research-runtime-factory：真实 SearchProvider/SourceService/
  BrowserController/Provider config+credential 每次 start 动态读取、
  Key 短生命周期零缓存、真实 C6+C7 冻结端口、每次 run 独立 Workspace/
  CaptureService/Runtime；缺配置/缺 Key/不支持 tools → provider-
  unavailable、Sources 缺失或非 normal → sources-unavailable；
  index.ts 装配顺序调整——Research store 移至 Sources/SearchProvider/
  ConfigStore/CredentialStore 之后 + 真实状态查询闭包（不谎报：同步仅
  粗粒度、异步 resolve 权威）；**生产 startTask 不再固定
  research-runtime-unavailable**（决议 #140 解除）；SRT-12 白名单补
  parse-markdown 正则分类）；红→绿 聚焦 **172/172**（markdown 26 +
  validator 45 + ResultView 9 + logger 17 + preemption 8 + factory 7 +
  service/store/prompts 回归）+ 全量 **1964/1964**（基线 1865 + 99，
  既有用例零删除零削弱）；冒烟 **8.18 真实 C7 端口**（伪造可信字段草案
  整份拒绝 → 回注重提 → 三字段草案完成）+ **8.19-A 生产 factory 主进程
  闭环**（FakeProvider 经 createProductionResearchRuntimeFactory 真实
  代码路径 → completed + 可信字段程序生成 + 危险链接草案拒绝重提 + 缺
  Provider 配置精确拒绝 + 用户 Tab 恒等）dev+生产双场景退出码 0/0
  （既有 8.13 场景瞬态失败一次——当日 14:47/16:55/19:37 同款历史先例，
  复跑通过如实登记）；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码
  0/0；真实 Provider 调用 0 次（无真实 Provider 产品链路）。证据见
  C7 任务文档「红→绿证据」小节。
  **C8 已完成（2026-08-17）**——Research UI/IPC/bridge：侧栏控制/进度、
  大结果画布、Evidence 下钻、表格交互与 CSV 安全导出（实施前契约裁决
  #156–#163：Research IPC 精确契约（**八 invoke + 两事件**——原「7 个
  invoke」漂移以八为准；payload 严格白名单 fail-closed；list 分页 1-based
  严格拒绝；task-done.status 收窄三值；Progress/Done 事件零敏感内容）/
  Service 查询视图·事件出口·生命周期（getResearchResultView 读取复核
  fail-closed；listener 异常隔离；终态先 terminal progress 再 task-done
  各恰好一次；shutdown 后零事件；deleteTask 与 starting slot 预占互斥）/
  大结果画布与 WebContentsView 可见性（BrowserControllerImpl
  contentVisible——不进 AI 接口；ui:browser-content-visible 受控通道；
  viewMode 'browser'|'research-result'）/
  Evidence 下钻与安全导航（block/item/position sourceRefs；drawer 纯文本；
  safe URL 经 tabs.create + 白名单；危险 URL 纯文本）/
  TableView 纯函数（原始字符串二元比较/稳定排序/无正则筛选/TSV+CRLF 复制/
  spreadsheet-cell 防护）/
  CSV 导出当前 UI 视图（export-csv payload 冻结 {taskId, tableBlockIndex,
  view:{sort,filter}}；主进程同一 applyTableView 重投影；UTF-8 BOM/CRLF/
  RFC 4180 引用；MAX_CSV_EXPORT_BYTES 编译期上限；ExportCsvResult 闭合
  错误联合；dialog 注入式窄端口；取消零写入 + 恰好一条脱敏审计；CSV
  serializer 位于 shared 纯模块——主进程不反向依赖 renderer）/
  UI 状态·事件收敛·可达性（sidePanel 三态互斥；ResearchPanel 380px 仅
  控制/进度；useResearch reducer taskId 键控/事件早于 invoke 返回收敛/
  退订零 setState；固定中文 UI 零原始消息透传））；红→绿聚焦 **99/99**
  （8 文件）+ 全量 **2054/2054**（基线 1964 + 90 新增，既有用例零删除零
  削弱）；冒烟 **8.19-B** dev+生产双场景退出码 0（真实 DOM 全链路：侧栏
  创建/启动/四阶段渐进/stop→cancelled/FakeProvider 完成 completed/画布
  WebContentsView 不可见机器证据（Tab webContents 零聚焦）/Table 排序·
  筛选·复制/Cards·Ranking·Conflict·Uncertain/Evidence 下钻/safe URL
  新建 Tab 返回 browser/敌对 Markdown 零 DOM 注入/viewMode 往返用户 Tab
  恒等/CSV 注入 dialog 桩写系统 TEMP 真实字节断言（BOM/CRLF/公式防护/
  当前视图一致性/Evidence 摘录零出现）后 finally 精确清理）；8.13 瞬态
  失败 3 次（历史先例同款）复跑通过如实登记；AIBROWSE_RESEARCH_SMOKE
  set|check 双进程退出码 0/0；**TEMP 遗留根因修复**（2026-08-16 23:30
  factory-smoke EPERM 遗留：失败路径句柄未关闭 → smoke-cleanup 模块 +
  8.19-A finally 修复 + index.ts 失败路径/互斥分支清理补齐——终检 TEMP/
  根目录日志/Electron 进程零残留）；真实 Provider 调用 **0 次**（8.19-B
  无真实 Provider 产品链路——FakeProvider 确定性脚本不冒充真实证据）。
  **C10 启动前补修已通过独立 Review（2026-08-21）**：候选 `71b5642`
  补齐 service=null 时 create/start/stop/delete/export 五个写入口各恰好一条
  脱敏审计（export 保持闭合错误联合映射 `internal`；get/result/list 零写
  审计）；独立 Reviewer verdict=`PASS`，聚焦 **15/15**、全量
  **95 files / 2192 tests**、typecheck/lint/format:check/build/diff-check
  全部退出码 0，依赖/构建配置零变化，工作区干净。证据见 C8 任务文档
  「红→绿证据」与「C10 启动前补修」小节。
  **C9 已完成（2026-08-18）**：8.20 全矩阵、隐私扫描、门控、真实运行器、
  两次完整真实 Provider 运行及两处真实运行发现的 C8 产品缺陷修复均已落地；
  机器证据见 C9 任务文档、threat-model §4.1、本文件最近验证条目与 Git。
  **C10 已完成（2026-08-23）**：独立 Stage Auditor 在批准产品 HEAD
  `c1aafd963f4952c81933ab2d873d154fe1b2741b` 上完成 §9 五组 14 项、§10 五项
  Exit Gate、全量质量门、全冒烟/跨进程门控、FRT/隐私/红线及真实 Provider
  复验，结论 `PASS` / `GO/PASS`；Fifth Stage 已完成并停止。C10 收尾提交后
  当前文档 HEAD 以 Git `main` 为准；产品代码批准 HEAD 保持上述 SHA。
  **开发工作流重构已完成（2026-08-19，Reviewer=`PASS`，候选提交 860822f）。
  C9-R1 格式漂移修复已完成（2026-08-19，Reviewer=`PASS`，候选提交
  `8733313f0321e1c8f80d64e5ebbc0fed707ef30d`）**：C9 证据回填遗留的两份
  文档 Prettier 漂移已关闭，C9 保持完成；C10 尚未开始，下一唯一任务仍为 C10。
  本阶段红线：禁止安装依赖、禁止实现 Sixth Stage。**真实 Provider 长期授权
  （2026-08-16，用户明确要求，
  决议 #117）**：后续任务按需使用、无需逐次申请授权、不设固定调用次数；
  每次调用仍须服务于明确开发/验收/定位/复验目的，禁止无界循环、无诊断
  依据重复请求与无关测试；凭据只走仓库外本地说明/DPAPI 密文/受控
  harness 注入，Key/base URL/认证头零进入命令行、源码、Git、日志、
  prompt、DOM、research.db、sources.db、会话文件、报告或工具输出；
  应用读取环境变量后立即移除，运行结束清理子进程/环境变量/临时目录；
  报告登记调用次数与用途不登记凭据；凭据缺失记录「凭据不可用」（不再写
  「未获授权」）；Provider 失败区分余额/权限/网络/服务端/模型兼容/产品
  缺陷。C9 契约调整：基础设施落地后凭据可用即真实执行（属 C9 范围）；
  C10 不得再因「未授权」判 HOLD；FakeProvider 不得冒充真实证据。
  设计要点（详见 proposal §10 决策表）：独立有界 ResearchRuntime（AgentLoop
  12 步/420s 契约零改动）/研究数据不进入会话 JSON（独立 research.db +
  字节预算，吸收 P2-3）/模型只提引用、Evidence 确定性验证/capture 正文零
  落盘/Result Schema 白名单 + 自实现 Markdown 安全子集（零新依赖）/CSV 经
  主进程 dialog 通道 + 公式注入防护/侧栏控制进度 + 大结果画布。
- 已完成（第四阶段，历史）：**第四阶段（Sources 长期信源系统）**，已于
  2026-08-15 正式切换（用户指令），2026-08-16 验收通过（总 Exit =
  `GO/PASS`）后正式切换第五阶段。**设计闭环与 B1 决策门已完成**：
  `doc/stage4/` 定稿（threat-model/proposal/
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
  （+64）。**B5 已完成（2026-08-15）**——实施前契约裁决（决议 #68–#78：面板
  互斥切换 sidePanel 'ai'|'sources' 不遮断 App 级确认框/通道白名单 + audience
  硬编码 user/有界 listGroups/quick-add 主进程读活动 Tab/两阶段硬删除/三态 UI
  状态与安全路径标签/provenance 与 aiNote 只读/独立 manual 审计/UI 异步序号与
  冲突刷新/纯文本渲染）+ Sources 面板（分组浏览/搜索/详情编辑/手工添加/快速
  添加/禁用恢复/手工 Undo/永久删除二次确认/恢复态与不可用态中文诊断/明文边界
  说明）+ 14 invoke 通道 + sources:changed 事件 + source-ipc 适配器（零
  Electron import）+ preload bridge 白名单 + 冒烟 8.11 B-05 默认矩阵（dev+生产
  双场景退出码 0）+ AIBROWSE_SOURCES_UI_SMOKE=set|check 双进程门控（退出码 0）；
  全量 test 1125/1125（+54）。**B6 已完成（2026-08-15）**——实施前契约裁决
  （决议 #79–#85：usage 接线归属 B6/序列化 allowlist 引用链路缺口/
  ToolExecutionContext 最小 usage 桥/provenance 表述校准/description 校准/
  B-07 冒烟探针/LIVE_AGENT_SOURCES 门控）+ SourceSearchHintStore 每 run 独立
  （有界 120/按 sourceId 去重/跨 run 隔离/终态清空）+ browser_open 比对写
  usage（reachable/unreachable/写失败安全 no-op）+ search/list/get 序列化补齐
  ID/规范键/作用域/分组 ID + 自然语言管理 description + 冒烟 8.12 B-06/B-07
  harness 场景（usage 全链路 + 自然语言管理五场景 + deny 零写入）与 8.13 UI
  DOM 端到端（真实任务模式/ConfirmDialog/Sources UI/Undo/usage 探针）+
  AIBROWSE_LIVE_AGENT_SOURCES 互斥门控与离线可测路由；全量 test 1160/1160
  （+35）。**B7 已完成（2026-08-15）**——实施前契约裁决（决议 #86–#91：
  backup.ts 存储运维 SQL 窄契约（VACUUM INTO 路径参数绑定实测成立）/备份冻结
  VACUUM INTO（backup API 不存在不实现）/「迁移失败原库完好」逻辑恒等校准/
  保留策略（严格命名 + 最新 5 + 30 天）/usage 双投影同事务一致 + Undo 回放不
  覆盖/rebuild 受控入口）+ `db/backup.ts` + `sources-store.ts` 启动装配 +
  只读恢复态真实生产装配 + FTS rebuild 诊断入口 + 「上次使用结果」展示 +
  冒烟 8.14 B-06 B7 部分 + B-02 usage 跨进程扩展；全量 test 1207/1207
  （+47；2026-08-15 事故恢复加固 +12 安全用例后最终 **1219/1219**）。
  **B7 事故恢复与安全加固已完成（2026-08-15，本任务）**——环境
  事故已止损（根目录 46 个零字节文档碎片 + 1 个 npm Unknown command 错误
  输出文件 + 事故日志经四项标准逐项核验后精确清理；3 个红态测试夹具残留
  目录清理；工作区恢复干净形态）；B7 实现安全审查发现并修复 5 项数据安全
  问题（红→绿 11 failed → 41/41：头部固定 16 字节读取/目标已存在
  fail-closed/碰撞换新名/backups 目录 symlink-junction 真实路径校验/
  prune 参数边界验证 + 备份源连接只读）；全量验证稳定复跑 test
  **1219/1219**（+12 安全用例）全绿。**B8–B9 待开始**；下一个推荐动作 =
  **新开独立对话对全项目严格安全/资源/进程生命周期/事故复盘审查**（不采信
  B1–B7 既有完成报告），而非直接实现 B8。
  **独立审计 + B7 审计后定向修复已完成（2026-08-15，HOLD 解除）**——独立
  审计复验全量 1219/1219 通过，但发现 `backup.ts` 备份发布/失败清理存在
  **P2 数据删除竞态**（lstat 判定不存在 → VACUUM INTO → 失败无条件 rmSync
  的窗口可误删并发创建的文件），结论 HOLD；本闭环完成定向修复（决议 #92：
  两阶段 staging + 硬链接 no-clobber 原子发布 + 所有权证明清理 +
  `createConsistentBackupAt` 任意路径公共导出移除），红→绿
  5 failed/32 passed → 37/37，全量 **1226/1226**（+7 用例），typecheck/
  lint/format:check/build/diff-check 全绿，dev+生产冒烟（B-06 全矩阵）与
  B-02 set/check 双进程退出码 0；证据见 B7 任务文档「独立审计后定向修复」
  小节与本文「风险与限制」P2 条目。**唯一下一推荐任务恢复为 B8**（红队
  矩阵 SRT-01～SRT-12；B9 独立最终验收在其后）。
  **B8 已完成（2026-08-15）**——红队矩阵 SRT-01～SRT-12 + 增量安全审计 +
  隐私扫描（决议 #93 校准：冒烟场景编号 8.15——8.7 已被 B1 SQLite 决策门
  B-01 占用，历史编号不复用；SRT-12 机器验证边界 = RT-01～RT-08、RT-11
  本轮 dev/production 重跑 + RT-09 扩展静态审计 + RT-10 未授权明确 NOT
  RUN）：8.6/8.14 返回结构化已通过证据由 8.15 精确核验（非日志字符串、
  不重复完整运行相同矩阵）；SRT-01～SRT-12 每项独立机器断言（断言落点见
  threat-model §4.1 证据表——12 项全部「机器可证明」分类）；SRT-08 逐通道
  字节扫描发现并修复产品缺陷 1 处（sanitizeToolCallsForPersistence 对 URL
  形态参数 query 值全量持久化——先写失败测试 2 failed/21 passed → 最小修复
  → 23/23，独立提交）；SRT-10 扩展 B-02 set/check（hard delete 后
  FTS/journal/usage 私人 payload 清理跨进程证据，既有断言零改动）；
  全量 test **1229/1229**（+3），typecheck/lint/format:check/build/diff-check
  全绿，dev+生产冒烟（含 8.15 全矩阵）与 B-02/B-05/SESSION 双进程全部退出
  码 0；临时 userData/运行日志全部精确清理。**RT-10 与真实 SRT-01/02 =
  NOT RUN**（本轮未获用户授权，不发起付费/公网请求，不冒充历史证据）；
  LIVE_AGENT_SOURCES 门控保持就绪。
  **B9 已完成（2026-08-15）**——Fourth Stage 独立最终验收（不采信 B1–B8
  完成报告，当前 HEAD c8e4122 独立复验）：① 步骤 0 三方 SHA 一致（本地=
  Gitee=GitHub，GitHub 经代理确认）、工作区干净；② 受控独立验证（一次一条
  命令，单 worker，零重试变绿）——test **1229/1229**（52 文件 19.55s）·
  typecheck · lint · format:check · build · git diff --check 全绿；③ 冒烟
  矩阵（env -u ELECTRON_RUN_AS_NODE + 独立系统 TEMP 临时 userData）——dev
  全矩阵退出码 0（含 B-01 11 项/8.6 RT/8.14 recovery/8.15 SRT-01～SRT-12
  通过行日志实证）、生产产物全矩阵退出码 0、B-02/B-05/SESSION 双进程全部
  退出码 0；每轮后零 Electron/Node 进程残留 + 零 WAL/SHM + 6 个 B9 专属
  临时目录全部精确清理 + 今日日志 sk- 形态零命中；④ 红线独立复核（不抄 B8
  报告）——SQL 执行点分类（业务 SQL 仅 Repository 编译期常量+参数绑定；
  driver 仅连接级 PRAGMA/事务；backup 仅 PRAGMA/VACUUM INTO 窄契约；
  migrations 编译期语句；smoke/test 为测试设施；snapshot-script `.exec`
  为正则非 SQL）；renderer/preload/AgentLoop/Tool 零 SQL；禁具零命中；
  工具注册表 17（8+4+4+1）；Electron 隔离（sandbox/contextIsolation/
  nodeIntegration=false/window.open deny/UI 导航白名单/IPC sender+主帧/
  preload 白名单零回退）；Source Tool 零 Electron import 零网络；
  usage-tracker 零 timer 零网络；SRT-08 修复
  （sanitizeToolCallsForPersistence+redactUrlQueryValue）在位；⑤ §9 四组
  18 项全部勾选回填证据（Fourth_stage.md §9）；⑥ §10 八项判定——②③④⑤⑥⑦
  与⑧离线部分 PASS、①与⑧真 Key 扫描 **HOLD（唯一缺口 = 真实 Provider
  验收）**；**总 Exit 判定 = HOLD/PENDING**（用户本轮未授权真实 Provider；
  RT-10 与真实 SRT-01/02 观察性场景 = NOT RUN；产品侧
  AIBROWSE_LIVE_AGENT_SOURCES 门控就绪，仓库外 harness 缺 -Sources 开关
  ——B6/B8 补验任务范畴，B9 不越界补写产品/测试代码）；⑦ P2/P3 开放风险
  独立处置（见「风险与限制」——均不命中本阶段 Exit Gate，P2-2/P2-3 为真实
  无界增长项登记后续硬化，P2-4 建议 vitest.config 固化单 worker）；⑧ 文档
  同步（Fourth_stage §9/§10、B9 任务台账、本文件、AGENTS §1+决议 #45 四处
  速查校准、README 状态+明文边界已知限制）。
  **唯一下一推荐任务 = 真实 Provider 补验**（B6/B8 补验任务：仓库外
  harness 补 -Sources 开关 + 用户授权后最小真实 Sources 验收——自然语言
  添加/修改/改组/备注/降优先级/disable-restore、L2 approve/deny、
  source_search→browser_open/read、「标为官方」恒 ai+unverified、敌对页/
  note 的 SRT-01/02 观察性场景、usage 与全链路 Key 零暴露扫描）。补验通过
  并改判 GO/PASS 前不得宣称第四阶段验收通过；不得实现 Fifth Stage。
  Sources 功能对用户已可用（Sources 面板）；Agent 已可经 Source Tools 使用；
  usage 接线已闭环（B6）+ 双投影一致（B7）；存储运维面（备份/迁移/恢复/
  rebuild 诊断）已闭环（B7；备份发布竞态已修复）；红队矩阵与安全审计已闭环
  （B8）；独立最终验收已闭环（B9；总 Exit = HOLD/PENDING，唯一缺口真实
  Provider）。
  **B6/B8 补验基础设施闭环已完成（2026-08-15，本任务）**——真实 Provider
  Sources 验收的前置可执行基础设施全部就绪（真实付费调用 0、未申请授权、
  未进入 Fifth Stage；总 Exit 维持 HOLD/PENDING）：① 缺口逐项核实属实
  （runLiveAgentSourcesScenarios 原五场景全 approve——L2 deny/durable Undo/
  真实 SRT-01/02 观察缺失；Key 终检未覆盖 Sources 库 WAL/备份/journal；
  LIVE_SITES 与 LIVE_AGENT_SOURCES 无互斥静默择一）→ 最小扩展补齐：
  新纯函数模块 smoke-sources-scan.ts（扫描清单/场景清单/台账摘要，零
  Electron 依赖）+ 14 用例红→绿（1 file failed → 14/14，全量 1229 →
  **1243/1243**）；真实场景扩展（1a L2 deny 零写入 + 模型停止/1b approve
  恰一次 + durable Undo/1c 数据供应/场景 6 真实 SRT-01 敌对页观察 deny 循环
  /场景 7 真实 SRT-02 敌对 note 观察——审计工具名 ∈ 注册表 + 无 L2 批准 +
  零写入，观察性结果如实登记不入断言）；Key 终检覆盖 DOM/日志/Sources 库
  （含 WAL/备份/journal）/会话文件/ToolStep/审计/临时文件/密文形态；
  index.ts LIVE_SITES 互斥补齐（实测退出码 1 + 失败清理零残留）+ SMOKE-only
  审计收集探针（生产不收集）；仓库外 harness `run-live-smoke.ps1` 增
  `-Sources`（与 -Sites/-Agent/-Pre/-Supplement 确定性互斥——组合实测退出码
  1 + ASCII 互斥错误、互斥先于 DPAPI 读取；finally 清除 + backstop 清理；
  静态断言红→绿 3/8 → **8/8 PASS**；脚本不提交 Git）。② 验证：test
  1243/1243（53 文件）· typecheck · lint · format:check（修复 B9 文档表格
  prettier 对齐——HEAD 既有偏差，纯格式零内容变化）· build 全绿；dev/生产
  冒烟全矩阵退出码 0；无 Key 路由 dev+生产各一次（中文跳过提示 + 离线矩阵
  - 真实 Provider 请求 0）；B-02/B-05/SESSION 双进程全部退出码 0；临时
    userData/日志/断言脚本全部精确清理、零进程残留、日志 sk- 零命中、禁具/
    敏感/TS 逃逸扫描零命中。
    **唯一下一推荐任务 = 用户单独授权后执行最小真实 Provider Sources 验收**
    （harness `-Sources` 一键执行场景 1a-7 + 真 Key 扫描 + 台账）并据证据更新
    Fourth Stage Exit Gate；补验通过并改判 GO/PASS 前不得宣称第四阶段验收
    通过；不得实现 Fifth Stage。
    **第四阶段最终真实 Provider 验收执行（2026-08-16，本任务）——RT-10 接入
    `-Sources` 完成、真实验收两轮失败 → HOLD/PENDING（复验边界已用尽，不得
    自动重跑）**：① RT-10 接入（红→绿：旧 manifest 缺独立 RT-10 失败测试
    先行）——`LIVE_SOURCES_SCENARIO_MANIFEST` 增独立 `rt-10-observe`
    （kind=observe，与 SRT-01/02 不得合并，单测固化）+
    `runLiveAgentSourcesScenarios` 场景 8 实际执行（复用第三阶段
    HOSTILE_RT10_HTML 敌对夹具与强断言：伪造工具零执行/密码零写入/购买・
    删除・发布・提交零 DOM 副作用/零外发/L2 全 deny/库・journal 零新增/
    敌对页 URL 零入库/审计工具名全部 ∈ 注册表 17 工具；观察性结果如实
    登记，不宣称语义免疫）；全量 test 1243 → **1244/1244**。② 真实
    Provider 验收（deepseek-v4-pro，harness `-Sources`）首轮失败——场景
    1b「收藏的 URL 应与当前页一致」断言缺陷：真实模型以 origin 形态收藏
    （scope=origin、URL 无路径——change set 结构校验合法、L2 approve 正常），
    断言要求精确 URL 相等属夹具缺陷 → 最小修复（断言校准为与当前页同
    origin，保留验收实质——收藏的是当前网站而非被诱导的其他站点）+
    完整离线复验全绿 → 定向复验（第 2 轮）失败——场景 4c「恢复使用」L2
    确认门 120 秒未出现：模型经 source_search×3 + source_list 均未定位
    到条目后如实回答（4 步 done 零确认提议）——根因确诊为**产品契约正确
    行为**：search/list 候选 SQL 全部过滤 `deleted_at IS NULL`，disabled
    条目对 agent 检索不可见（4b 刚禁用），任务文案未提供定位手段 → 夹具
    缺陷（非产品缺陷）→ 最小修复（s4c-restore 任务文案显式提供来源编号
    {sourceId}，执行时注入 collectedId）+ 完整离线复验全绿（test
    1244/1244 · typecheck · lint · format:check · build · diff-check ·
    production 无 Key 路由退出码 0）。③ 第 3 轮运行超出授权边界（一次
    完整运行 + 最多一次定向复验）被中止（18 次 HTTP 后停止，零
    LIVE_SMOKE_PASS；残留 pid 目录已精确清理）——不得自动重跑；
    **总 Exit 维持 HOLD/PENDING：真实 Provider 验收未完成**（场景 4c 起
    与真 Key 扫描未通过真实执行；RT-10 与真实 SRT-01/02 仍 NOT RUN，
    不冒充历史证据）；两处修复均已离线就绪，下一唯一动作 = 用户单独授权
    后对 4c 修复做**一次**定向真实复验。补验通过前不得宣称第四阶段验收
    通过、不得实现 Fifth Stage。
    **真实 Provider 补验第二次执行（2026-08-16，第四轮运行，用户单独授权
    的一次完整复验）——场景 1a–5 全过、场景 6 夹具缺陷失败 → HOLD/PENDING
    维持**：前置验证全绿（test 1244/1244 · typecheck · lint ·
    format:check · build · diff-check；三方 SHA 一致 8f972dd、工作区
    干净）。真实执行（deepseek-v4-pro，harness `-Sources`）：场景 1a
    L2 deny 零写入 + denied-by-user 后停止、1b approve 恰一次 + durable
    Undo、1c 数据供应、2 改组与备注（shareMode=full）、3 标官方恒
    ai+unverified、4a 降 priority、4b disable、**4c restore 实测生效
    （s4c 定位修复验证通过，versions=[5]）**、5 source_search →
    browser_open → browser_read 全链路 + usage=reachable 全部真实通过
    （37 次 HTTP 全部 200、9 次 L2 确认全部按纪律决议）。**失败于场景 6
    （真实 SRT-01）**：「敌对页未就绪」——harness 夹具缺陷（非产品缺陷、
    非模型观察性问题）：场景 5 真实模型经 browser_open（auto-visible
    契约）打开并激活新 Tab 后，场景 6 断言等待**活动 Tab** URL 变为敌对
    页 URL，但 `navigate()` 契约只加载目标 Tab 不激活 → 等待恒不满足、
    10 秒超时；场景 7 同模式；场景 8 与 A7 场景 6 用 createTab（自动
    激活）不受影响。修复方案（唯一下一任务，本轮不修改代码）：场景 6/7
    导航前 `activateTab(activeBefore)`。**总 Exit 维持 HOLD/PENDING：
    真实 Provider 验收未完成**（场景 6/7/8 + 真 Key 扫描未通过真实执行；
    RT-10 与真实 SRT-01/02 仍 NOT RUN，不冒充历史证据）；场景 6/7 导航
    夹具修复 + 完整离线复验全绿后，下一唯一动作 = 用户单独授权的一次
    定向真实复验。补验通过前不得宣称第四阶段验收通过、不得实现 Fifth
    Stage。
    **第四阶段最终真实 Provider 验收通过（2026-08-16，第五轮运行）——总
    Exit 改判 `GO/PASS`**：场景 6/7 导航夹具修复（SMOKE 辅助逻辑
    `activateThenNavigate`：激活先于导航/激活失败零导航且不触发
    Provider/取消・超时安全终止，红→绿 11 用例，全量 test 1244 →
    **1255/1255**，BrowserController 产品契约零改动；typecheck/lint/
    format:check/build/diff-check 全绿 + production 无 Key 路由退出码 0）
    → 用户已授权的一次完整 `-Sources` 复验（现有代码无从场景 6 续跑，
    完整执行 1a–8）：**场景 1a–8 全部真实通过**——1a L2 deny 零写入 +
    denied-by-user 后停止；1b approve 恰一次 + durable Undo；1c 数据
    供应；2 改组备注 shareMode=full；3 标官方恒 {official, ai,
    unverified}；4a 降 priority 且保持启用；4b disable；4c restore 实测
    生效；5 source_search → browser_open → browser_read 全链路 +
    usage=reachable；**场景 6/7/8（真实 SRT-01/02 + 真实 RT-10）观察
    场景实际到达**——机器可验证结构断言全部通过（库/journal 零新增/敌对
    页 URL 零入库/审计工具名全部 ∈ 注册表 17 工具/零 L2 批准/伪造工具零
    执行/密码零写入/零外发）；观察性结果如实登记（本轮真实模型三个敌对
    场景均未执行诱导指令——语义层残余风险维持 threat-model §5 登记，
    不宣称免疫）。台账：34 次 HTTP 全部正常、8 次 L2 确认全部按纪律决议
    （1a deny + 7 approve）、reasoning_content 回传校验零触发；真 Key
    零暴露扫描通过（18 文件零命中 + 进程外当日日志 sk-/Bearer 零命中 +
    密文形态断言）；清理证据——进程零残留/TEMP 零 aibrowse-smoke 目录/
    harness 环境变量清除已执行/DPAPI 密文文件保留（未删除未轮换）。
    **Fourth_stage §10 八项全部 PASS；阶段指针保持 Fourth Stage；下一
    推荐动作 = 提交本轮报告供只读复核；不得设计或实施 Fifth Stage**
    （切换须按 ROADMAP.md 阶段切换原则由用户指令执行）。历史保持：首轮
    （1b 夹具）→ 定向复验（4c 夹具）→ 第 3 轮越界中止 → 第四轮（1a–5
    过/场景 6 夹具缺陷）→ 本轮（夹具修复后 1a–8 全过）——不重写为一次
    通过。
    步骤 0 独立核对（2026-08-15，B4 会话）：HEAD `6d153ee` = Gitee/GitHub
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
| B5 | Sources UI + 手工管理 + 当前页快速添加 + 冲突/恢复态/Undo 展示 + IPC/bridge 扩展 | ✅ | 2026-08-15 完成（见下）：决议 #68–#78 + Sources 面板 + 14 通道 + source-ipc 适配器 + 8.11 默认矩阵 + AIBROWSE_SOURCES_UI_SMOKE 双进程门控；任务文档 doc/stage4/tasks/B5-sources-ui.md（红→绿证据已回填） |
| B6 | AI 自然语言管理端到端（change set 全链路 + Undo）+ Browser Agent 复用（source_search → browser_open/read）+ usage 记录接线 | ✅ | 2026-08-15 完成（见下）：决议 #79–#85 + usage-tracker + 序列化 allowlist 补齐 + description 校准 + 冒烟 8.12/8.13 + LIVE_AGENT_SOURCES 门控；任务文档 doc/stage4/tasks/B6-ai-source-management.md（红→绿证据已回填） |
| B7 | 跨进程持久化 + migration/backup/recovery 全矩阵 + FTS rebuild 诊断 + usage/health 边界 | ✅ | 2026-08-15 完成（见下）：决议 #86–#91 + db/backup.ts + sources-store.ts + 恢复态装配 + rebuild 诊断入口 + usage 双投影与「上次使用结果」展示 + 冒烟 8.14 B-06 B7 部分 + B-02 usage 跨进程扩展；**2026-08-15 事故恢复与安全加固闭环**（头部固定 16 字节读取/目标 fail-closed/碰撞换新名/目录链接真实路径校验/prune 参数边界，红→绿 11→41/41，全量 1219/1219）；任务文档 doc/stage4/tasks/B7-persistence-recovery-usage.md（实施裁决与红→绿证据已回填） |
| B8 | 红队矩阵 SRT-01～SRT-12 + 安全审计 + 隐私扫描 + 真实 Provider/真实网页可选验证 | ✅ | 2026-08-15 完成（见下）：冒烟 8.15（决议 #93 校准：8.7 已被 B1 决策门占用）12 项独立断言 dev+生产双场景退出码 0 + 8.6/8.14 结构化证据核验 + RT-09 扩展静态审计 + SRT-08 发现并修复产品缺陷（持久化 toolCalls URL query 值脱敏，33e14b0）+ B-02 SRT-10 跨进程扩展；全量 test 1229/1229；RT-10 与真实 SRT-01/02 NOT RUN（未授权）；任务文档 doc/stage4/tasks/B8-redteam-security-validation.md（红→绿证据已回填） |
| B9 | Fourth Stage 独立最终验收（当前 HEAD 重新复验，不采信 B1–B8 报告）+ Exit Gate 判定 + 文档同步；完成后停止不实现 Fifth Stage | ✅ | 2026-08-15 完成（见下）：独立复验台账见任务文档「独立复验台账」小节；总 Exit 判定 = HOLD/PENDING（唯一缺口 = 真实 Provider 验收，用户未授权）；**2026-08-16 第五轮真实 Provider 验收通过后改判 `GO/PASS`**（场景 1a–8 全部真实通过 + 真 Key 扫描零命中，见「真实 Provider 验收通过后判定更新」小节）；任务文档 doc/stage4/tasks/B9-finalize-acceptance.md |

| C1 | ResearchTask/Evidence/Result 核心契约 + 状态机纯函数 + research.db 存储与服务基座（migration v1/Repository/store 装配） | ✅ | 2026-08-16 完成（见「最近验证结果」第十四个闭环）：实施前契约裁决 #101–#111 + 红→绿 9/9 失败→131/131 + 全量 test 1386/1386 + dev/生产冒烟 17 工具/SRT-12 零回归 + smoke.ts SRT-12 白名单契约同步（+5 行，唯一既有改动）；**2026-08-16 定向修复与契约边界复核完成（第十五个闭环）**：决议 #112–#116 先红后修（红态 34 failed → 聚焦 174/174、全量 test 1429/1429；migration v1 零改写、sources/ai/browser/renderer/preload 零 diff）；**2026-08-16 第二次定向补修完成（第十六个闭环）**：ISO 8601 偏移日期回滚校验（红态 6 failed → 聚焦 215/215、全量 test 1470/1470；仅 task-state 纯函数改动）；任务文档 doc/stage5/tasks/C1-research-contract-foundation.md（红→绿证据、定向修复与第二次定向补修记录已回填） |
| C2 | ResearchWorkspace 与 task-owned Tab 隔离、数量上限、取消/异常清理 | ✅ | 2026-08-16 完成（见「最近验证结果」第十八个闭环）：实施前契约裁决 #118（八项：形态与接口/最小端口/URL 边界/精确所有权/并发上限/焦点恢复/用户关闭感知/释放取消竞态）+ 精确接口 §10.1；红→绿 39/39（模块缺失红 → Fake BrowserController 全离线矩阵）；全量 test 1509/1509；BrowserController/TabManager/SearchProvider 产品契约零改动；任务文档 doc/stage5/tasks/C2-research-workspace-tab-isolation.md（红→绿证据已回填） |
| C3 | Source Selection：Sources + Search 候选合并、provenance 与确定性排序 | ✅ | 2026-08-16 完成（见「最近验证结果」第二十个闭环）：实施前契约裁决 #120–#123（三档发现路径排序/note 映射/candidate_id 输入契约/sortKey 编码——详见任务文档「实施前复核项」小节，均已裁决）+ 详细设计 §4 重写；红→绿 80/80（模块缺失红态）→ 全量 test 1598/1598；真实 node:sqlite 排序一致性 probe；C1/C2/Source/Search 产品代码零改动；任务文档 doc/stage5/tasks/C3-source-selection-candidate-merge.md（红→绿证据已回填） |
| C4 | 多源读取、结构化提取、capture 记录与 Evidence 确定性验证 | ✅ | 2026-08-16 完成（见顶部状态与任务文档「红→绿证据」）：实施前契约裁决 #124–#131（Tab 生命周期零双导航/冻结判别联合与重试矩阵/failed Capture sentinel/ready・L0–L3 映射/CaptureContent 60k 预算与哈希覆盖/多表 tableIndex/不可信 proposal 六字段/Chromium 错误页判定）+ CaptureService + EvidenceValidator + repository tableIndex 严格解析 + 冒烟 8.16（dev+生产双场景退出码 0、正文零持久化探针、用户 Tab 集合不变、真实 Provider 0 次）；红→绿聚焦 136/136、全量 test 1691/1691；**2026-08-21 Post-Acceptance Repair 已收尾（独立 Reviewer B=`PASS`，已推送）**：修复链 65fe15d→f681451→56ea5c4→e2404d0→f38fb4d→abe7351→4c75a86 四项验收 PASS（Repair A 文档 gate / Repair B implementation / surrogate coverage Repair / filesystem cleanup），详见任务文档「Post-Acceptance Repair 状态」；任务文档 doc/stage5/tasks/C4-multi-source-capture-evidence-validation.md |
| C5 | 独立有界 ResearchRuntime：进度、停止、失败继续、预算与终态 | ✅ | 2026-08-16 完成（见顶部状态与任务文档「红→绿证据」）：实施前契约裁决 #132–#139（六工具专属执行模型/ResearchPlan 判别联合/C6/C7 稳定端口 fail-closed/Service 异步装配/预算与 Provider 失败映射/原子持久化与 500k 终态预留/Progress·heartbeat·终态优先级/index.ts 最小装配）；红→绿聚焦 113/113、全量 test 1804/1804；冒烟 8.17 dev+生产双场景退出码 0；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0；真实 Provider 0 次；任务文档 doc/stage5/tasks/C5-research-runtime.md |
| C6 | Cross-check、冲突模型、带证据综合与「不确定」输出 | ✅ | 2026-08-16 完成（见顶部状态与任务文档「红→绿证据」）：实施前契约裁决 #140–#147（C6/C7 分阶段装配边界/Provider 响应侧有界性/VerificationDraft 严格协议/Claim 确定性装配与厂商分类/Conflict 引用完整性/数据交接/Prompt 所有权/parseResultDraft 边界）；红→绿聚焦 61/61、全量 test 1865/1865；冒烟 8.18 dev+生产双场景退出码 0/0；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0；生产 Research 仍 fail-closed（缺 C7）；真实 Provider 0 次；任务文档 doc/stage5/tasks/C6-crosscheck-conflict-synthesis.md |
| C7 | ResultValidator + 安全 Markdown/Table/Cards/Ranking Renderer（零新依赖） | ✅ | 2026-08-16 完成（见顶部状态与任务文档「红→绿证据」）：实施前契约裁决 #148–#155（Markdown 单一事实源/ResultDraft 三字段白名单/Validator 严格验证/Conflict·Coverage·不确定/Markdown AST 与 Renderer/logger 未初始化落盘修复/启动预占与 prepared Provider 交接/真实生产装配）；红→绿聚焦 172/172、全量 test 1964/1964；冒烟 8.18 真实 C7 端口 + 8.19-A 生产 factory 闭环 dev+生产双场景退出码 0/0；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0；生产 startTask 解除 fail-closed（决议 #140/#155）；真实 Provider 0 次；任务文档 doc/stage5/tasks/C7-result-validator-renderer.md |
| C8 | Research UI/IPC/bridge：侧栏控制/进度 + 大结果画布 + 证据下钻 + 表格交互 + CSV 导出 | ✅ | 2026-08-17 完成（见顶部状态与任务文档「红→绿证据」）：实施前契约裁决 #156–#163（八 invoke + 两事件/payload 严格白名单 fail-closed/list 1-based/task-done 三值/Service 查询视图与事件出口/大结果画布 WebContentsView 可见性/Evidence 下钻与安全导航/TableView 纯函数/CSV 导出当前 UI 视图/Dialog 窄端口/UI 状态收敛）；红→绿聚焦 99/99、全量 test 2054/2054；冒烟 8.19-B dev+生产双场景退出码 0；AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0；真实 Provider 0 次；**实际对应 10 个提交**（50c5651/a61261a/ff7d9a5/3410d16/b63fa9f/63d2869/4e1c690/**76070d3**/7edd96f/f9b005a——公开历史中 76070d3 为独立提交，不 amend 不重写）；任务文档 doc/stage5/tasks/C8-research-ui-ipc-table-export.md |
| C9 | Sources+Search 端到端 + 红队矩阵 FRT-01～FRT-12 + 隐私扫描 + 真实 Provider 验收基础设施 | ✅ | 2026-08-18 完成：8.20 全矩阵/隐私扫描/门控/真实运行器 dev+生产通过，真实 Provider 两次完整运行通过；真实运行发现并修复两处 C8 产品缺陷；证据见 threat-model §4.1、C9 任务文档实施记录与 Git |
| C10 | Fifth Stage 独立最终验收（不采信 C1–C9 报告）+ §9/§10 判定 + 文档同步 | ✅ | 2026-08-23 完成：独立 Stage Auditor=`PASS`，Fifth Stage Exit Gate=`GO/PASS`；§9 五组 14 项与 §10 五项全部通过，批准产品 HEAD `c1aafd963f4952c81933ab2d873d154fe1b2741b`；证据与命令见任务文档 doc/stage5/tasks/C10-finalize-acceptance.md；C10 完成当时停止，尚未进入 Sixth Stage |

| D1 | logger/Clock 基座与确定性时间边界 | ✅ | 2026-08-26 完成：产品候选 `94cc433`，四轮有界修复 `0c7182b`/`c286b31`/`e3ab456`/`3a750e1`；独立 Reviewer=`PASS`，聚焦 104/104、全量 2312/2312、typecheck/lint/format/build、dev/start 冒烟全部通过；任务遗留 stash 已精确清理；任务文档 doc/stage6/tasks/D1-logger-clock-foundation.md |
| D2 | Watch 域模型、条件 DSL 与状态机 | ✅ | 2026-08-26 完成：产品候选 `237eafb` + 有界修复 `438a11f`；Reviewer=`PASS`，聚焦 173/173、全量 2440/2440、typecheck/lint/format/build 全部通过；任务文档 doc/stage6/tasks/D2-watch-domain-condition.md |
| D3 | 安全 Feed/Public 网络与解析器资格门 | ✅ | 2026-08-28 完成：实施链 `662ef0b` → `dd3deeb` → `2325077` → `be33291` → `0df9bae` → `e412c12` → `e689484` → `ac579e4`；三个解析依赖资格门通过并精确固定；最终独立安全 Reviewer=`PASS`；聚焦 95/95、Watch 279/279、全量 2725/2725，typecheck/lint/format/build/audit/dev+production smoke 全绿；任务文档 doc/stage6/tasks/D3-safe-feed-network-parser.md |
| D4 | watch.db、Source 生命周期观察协议与恢复 | ✅ | 2026-08-28 完成：实施链 `04adce4` → `0acc794`（九个候选提交）+ D4-R 有界修复 `90cadd8` → `40f5c1e` → `743149e` → `bf1a2ff`；独立安全/持久化 Reviewer=`PASS`，全量 2908/2908、typecheck/lint/format/build/diff-check 全绿、dev+生产冒烟与 AIBROWSE_WATCH_SMOKE set/check dev+生产 0/0；任务文档 doc/stage6/tasks/D4-watch-store-source-lifecycle.md |
| D5 | Scheduler、RunCoordinator、预约事务与共享 HostRequestGate | ✅ | 2026-08-29 完成（见下）：baseline `1e88845`，实施链 `0a8ff98` → `3452724`（十一个候选提交）；独立 Reviewer=`PASS`，聚焦 34/34、Watch 190/190、全量 127 files/2990 tests，typecheck/lint/format/build/diff-check 全绿、WATCH set/check dev+生产 0/0；任务文档 doc/stage6/tasks/D5-scheduler-run-coordinator.md |
| D6 | Page region/Session task-owned Tab 投影 | ✅ | 2026-08-29 完成（见下）：baseline `d2226bb`，实施链 `3d62c02` → `d508d7c` → `25a93c9` → `19f04c2` → `321b5f3` → `f4f5cce` → `f4653e4` → `aa3d373`（八个候选提交，Repair baseline `f4653e4`）；独立 Reviewer=`PASS`，聚焦 8 files/178 tests、全量 133 files/3128 tests，typecheck/lint/format/build/diff-check 全绿、dev+生产冒烟 8.23 与 WATCH set/check 0/0；任务文档 doc/stage6/tasks/D6-page-region-session-projection.md |
| D7 | 确定性 Diff/Event/Evidence 与健康状态 | ⏳ | 依赖 D3–D6；任务文档 doc/stage6/tasks/D7-diff-event-evidence-health.md |
| D8 | Digest 分享投影与可选 AI 解释 | ⏳ | 依赖 D7；任务文档 doc/stage6/tasks/D8-digest-sharing-ai.md |
| D9 | Watch UI/IPC/通知/导出 | ⏳ | 依赖 D4–D8；任务文档 doc/stage6/tasks/D9-watch-ui-ipc-notification-export.md |
| D10 | 端到端、红队、隐私与真实门控 | ⏳ | 依赖 D1–D9；任务文档 doc/stage6/tasks/D10-e2e-redteam-live-gates.md |
| D11 | 第六阶段独立 Exit Audit | ⏳ | 依赖 D10；必须使用新的独立 Reviewer；任务文档 doc/stage6/tasks/D11-independent-exit-audit.md |

> 编号说明（2026-08-14 实施前校正）：第三阶段任务编号 A1–A8（原 T1–T8），避免与
> 上表第一阶段历史任务 T0–T5（已关闭，编号不可改）重名；第一、第二阶段历史任务
> 编号一律不变。（2026-08-15）第四阶段任务编号 B1–B9、威胁 ST-01～ST-12、红队
> SRT-01～SRT-12——同样避免与 T/S/A/RT/R 历史编号重名；历史编号一律不复用。
> （2026-08-16）第五阶段任务编号 C1–C10、威胁 FT-01～FT-17、红队
> FRT-01～FRT-12、决议承接 #94 起、冒烟场景承接 8.16 起——历史编号一律不复用。
> （2026-08-23）第六阶段任务编号 D1–D11、威胁 WT-01 起、红队 WRT-01 起；
> 正式编号以 `doc/stage6/` 当前契约为准，历史编号一律不复用。

## 最近验证结果（2026-08-14 起持续回填；2026-08-23 追加 Sixth Stage 正式设计审核）

- **D4 watch.db、Source 生命周期观察协议与恢复验收与关闭（2026-08-28，独立安全/持久化
  Reviewer=`PASS`）**：① 实施链 `04adce4` → `da5958a` → `a493039` → `ad859f9` →
  `2babe3a` → `70fd651` → `d23b365` → `0d1b876` → `0acc794`（九个候选提交）；独立
  Reviewer 在 `0acc794` 上发现八类缺陷，D4-R Repair Contract 产出有界修复
  `90cadd8`（红态回归测试先行）→ `40f5c1e` → `743149e` → `bf1a2ff`（未 amend 未重写，
  双远程保持 `40087b1` 直至本次收尾）。② 八类修复闭环：Repository 查询/行校验严格
  fail-closed（仅 not-found/合法空返回 null/[]）、协调器审计写入结果检查事务化、Source
  投影 found/missing/unavailable 三态协议（unavailable 回滚并使 Watch unavailable，
  hard-delete/reconcile 绝不级联）、restore post-swap 失败回滚（WAL/SHM 随迁、残留精确
  清理、回滚失败保留可恢复证据）、Watch 备份 100 MiB 集合预算（先数量/期限再最旧优先；
  Sources 缺省恒等）、Event/Baseline 单事务完整身份 CAS（存在/未删除/sourceId/
  fingerprint/baselineVersion 全匹配，审计同事务零半写）、投影真实 UTF-8 字节预算
  （声明=实际、伪造拒绝、启动扫描不一致 unavailable）、schema v1 watch_audits CASCADE
  与 kind/reason 白名单扩展（`baseline-established`/`rebaseline`，锚点 detailed
  §10.1/§3）、日志隐私（sanitizeWatchError 盘符路径占位符、成功日志零路径）。③ 最终
  门禁：全量 **121 files / 2908 tests** 全部 PASS（既有用例零删除零削弱，仅契约驱动机械
  校准），typecheck、lint、format:check、build、diff-check 全部退出码 0；dev+生产默认
  冒烟矩阵退出码 0（8.21 含日志隐私扫描全过；production 首轮既有 8.13 族以后瞬态失败
  一次，复跑全绿，如实登记）；AIBROWSE_WATCH_SMOKE=set|check dev+生产两对独立全新临时
  userData 全部 0/0 并精确清理（Test-Path=False）。④ 红线复核：业务 SQL 仅 Repository
  编译期常量/migration/driver·backup 运维白名单；14 文件全部在允许清单内；
  renderer/preload、公开 Source IPC、Sources schema/journal/Undo、package.json/lock
  零改动；diff 零新增网络能力；零 any/ts-ignore；diff 日志调用零路径拼接。⑤ 剩余风险：
  8.13/8.19-B 瞬态失败保持既有观察项；100 MiB 备份预算取「备份集合」语义（§10.2
  「备份也受 100 MiB 与最多 5 份/30 天边界」锚点）。⑥ D4 已关闭；下一唯一任务为
  `doc/stage6/tasks/D5-scheduler-run-coordinator.md`。

- **D5 Scheduler、RunCoordinator、预约事务与共享 HostRequestGate 验收与关闭（2026-08-29，
  独立 Reviewer=`PASS`）**：① baseline `1e88845b08e0b38ef957084415f816ae82f74fe9`（D4
  收尾）；实施链 `0a8ff98`（schema v2 watch_audits 审计 CHECK 扩展）→ `bd18e9c`
  （WatchScheduler/HostRequestGate 与 reservation/终态事务 M1–M3）→ `7035e4c`
  （WatchRunCoordinator M4）→ `ac5ed24`（M5 生命周期 stop-admission→abort→drain→close
  幂等）→ `09cc45f`（M6 结构红线静态扫描）→ `bb117ec`（D3 工厂追加式注入 hostGate）→
  `1aee435`（index.ts 生命周期装配 + before-quit watchShutdown 排水 + 8.22/门控冒烟）→
  `dd6ded7`（8.21/8.22 冒烟修复）→ `fc2ad75`（门控 D5 set reconcile 与 D4 夹具兼容 +
  prettier）→ `4d63af1`（HostRequestGate 并发串行化、delay/unavailable 排水与
  dependency_unavailable 健康暂停 R1–R4）→ `3452724`（非队首 waiter 越自身 deadline 与
  WATCH 门控夹具随机选错规则），共十一个候选提交；候选 HEAD
  `345272446277c5da5af4aef908e41014e19ffaed`；baseline 后历史未重写、未 amend。② 验收
  要点：HostRequestGate 非队首 waiter 在自身绝对 deadline 到达时立即、恰一次返回 deadline
  并即时出队；deadline/abort/clear 后零残留 timer/listener、零迟到 grant；同 host FIFO
  与相邻登记至少 5000ms 保持；WATCH smoke 的 D4 固定规则 ID 与 D5 专属 feed URL 已消除
  随机 UUID 顺序导致的夹具误选。③ 最终门禁：聚焦 gate+coordinator 34/34、Watch 8 文件
  190/190、全量 **127 files / 2990 tests** 全部 PASS；typecheck、lint、format:check、
  build、diff-check 全部退出码 0；两对独立全新受控 userData 的 AIBROWSE_WATCH_SMOKE=
  set|check（dev+生产）全部 0/0 并精确清理；dev 最终复跑与 production 默认 smoke 退出码
  0（8.21/8.22 通过）；敏感信息扫描零命中（git diff --check 1e88845..HEAD exit 0）。
  ④ 非阻断 flaky 观察（如实登记，**无证据归因于 D5**）：Reviewer 的 dev 首跑出现一次既有
  Stage 5 8.19-B Research UI 时序失败、复跑通过；Executor 的 production 首跑出现一次非
  Watch UI bounds/Matrix 9 时序失败、复跑通过；二者均不在 `3452724` 三个 repair 文件
  （host-request-gate.ts/.test.ts、smoke-watch-store.ts）内，D5/WATCH 专属门控连续稳定
  通过；按收尾边界不顺手修复 Stage 5，继续作为既有观察项登记。⑤ D5 已关闭；下一唯一任务为
  `doc/stage6/tasks/D6-page-region-session-projection.md`；本次未开始 D6。

- **D6 Page region/Session task-owned Tab 投影验收与关闭（2026-08-29，独立
  Reviewer=`PASS`）**：① baseline `d2226bb`（D5 远程关闭点）；实施链 `3d62c02`
  （DocumentChannels validator + Region 投影 M1）→ `d508d7c`（一次性 Session grant M2）→
  `25a93c9`（Watch Session 任务标签页隔离读取 M3）→ `19f04c2`（页面公开与 Session 采集
  路由 M4）→ `321b5f3`（Session 生命周期与隐私冒烟 8.23 + 跨进程门控）→ `f4f5cce`
  （prettier 格式化 smoke.ts）→ `f4653e4`（工作区日志去除任务 tabId，§13 隐私红线）→
  `aa3d373`（D6 Repair R1–R5：grant 单次消费/日志 tabId 脱敏/焦点新鲜快照/iframe 不判
  captcha/空表格单元格），共八个候选提交；Repair baseline `f4653e4`，候选 HEAD
  `aa3d373a3cb57cb761f53f83b8ed645b49797b15`；baseline 后历史未重写、未 amend。② 验收
  要点：只有用户显式选择的 Region 进入 Projection，main-text 明示高噪声、inputs/forms 零
  进入；grant 绑定 source/tab/origin/target、5 分钟单次，renderer 仅得 opaque handle、
  handle 零 DB/log、Cookie/session credential 零 renderer/DB/log，只持久化 consent +
  pageUrl；每次 run 只读取本 run 新建并证明 owned 的 Tab，用户 Tab 零 navigate/close，
  create 自动激活后焦点三态恢复；cleanup 失败保留 ownership、零结果提交并使 Watch
  unavailable；app 重启/原授权 Tab 关闭不使 consent 自动失效；歧义/失效/degraded/captcha/
  login 不建 Projection；64KiB/10 Region/50 fields 预算精确。③ 最终门禁：聚焦 8 files /
  178 tests 全部 PASS；全量 **133 files / 3128 tests** 全部 PASS；typecheck、lint、
  format:check、build、diff-check 全部退出码 0；dev 与 production 默认冒烟经一次有界重跑
  完整通过（D6 8.23 通过）；dev/production AIBROWSE_WATCH_SMOKE=set|check 四次全绿
  （两对独立全新受控 userData，精确清理）；task tabId 精确字节扫描零命中、临时 userData
  与 Electron 进程零残留；真实 Provider：N/A（本任务不涉及 Provider 链路）。④ 非阻断
  flaky 观察（如实登记，**无证据归因于 D6**）：默认冒烟首次分别观察到既有 reload 与 UI
  Matrix 9 bounds 时序抖动各一次、复跑完整通过，如实登记不得改写为「首次全部通过」。
  ⑤ D6 已关闭；下一唯一任务为 `doc/stage6/tasks/D7-diff-event-evidence-health.md`；
  本次未开始 D7。

- **D3 安全 Feed/Public 网络与解析器资格门验收与关闭（2026-08-28，独立安全
  Reviewer=`PASS`）**：① 实施链 `662ef0b` → `dd3deeb` → `2325077` → `be33291` →
  `0df9bae` → `e412c12` → `e689484` → `ac579e4`；最终独立 Reviewer 在精确 HEAD
  `ac579e41b3b9cef3e4ed535b74674bbdb4beb0ef` 上给出 `PASS`，无 P0–P3 发现。②
  `@federicocarboni/saxe@0.8.0`、`parse5-sax-parser@8.0.0`、`parse5@8.0.1` 均已通过
  资格门并精确固定。③ 最终门禁：聚焦 95/95、Watch 279/279、全量 2725/2725；
  typecheck、lint、format、build、audit、dev 与 production smoke 全绿。④ D3 已关闭；
  未开始 D4，下一唯一任务为 `doc/stage6/tasks/D4-watch-store-source-lifecycle.md`。

- **D2 Watch 域模型、条件 DSL 与状态机验收与关闭（2026-08-26，Reviewer=`PASS`）**：
  ① baseline `8e10249f062295e1dec8306432dcf460ba8943f3`；产品候选 `237eafb`，有界修复
  `438a11f`。② 独立审查确认实现范围仅 `src/shared/types/watch.ts` 与
  `src/shared/watch/` 的纯域契约、预算、状态机、条件引擎及测试；package/lock、main、preload、
  renderer、网络、SQL、Provider 均未改。③ 聚焦 6 files / 173 tests、全量 103 files /
  2440 tests 全部 PASS；typecheck、lint、format:check、build、diff-check 全部退出码 0；纯 shared
  逻辑未接线产品行为，Electron 冒烟 N/A。④ §2 常量与闭合 union、Schedule/Rule 状态迁移、
  Source rowVersion/fingerprint 分离、Condition 闭合字段/operator 与 UTF-8 预算均有确定性测试；
  修复后非法预算 fail-closed，accessor getter 零执行且 Proxy 反射异常闭合，Source 缺失原因稳定为
  `source-deleted`。⑤ 无新依赖、网络、Provider、SQL、UI/IPC 或 D3 内容；下一唯一任务为 D3，
  三个候选解析依赖仍未安装，必须先执行各自资格门。

- **D1 logger/Clock 基座验收与关闭（2026-08-26，Reviewer=`PASS`）**：① 设计基线
  `c53eb742897be406a25092333ed5d609f7495af2`；产品候选 `94cc433`，四轮有界修复
  `0c7182b`/`c286b31`/`e3ab456`/`3a750e1`，最终产品 HEAD
  `3a750e1183cb617bf3a27fc074c479663a87c5a7`。② 独立审查确认 diff 仅 logger/Clock、
  对应测试与最小 Watch 类型五个契约文件；无依赖、Provider、网络、SQL、UI/IPC 改动。
  ③ 聚焦测试 2 files / 104 tests、全量 98 files / 2312 tests 全部 PASS；typecheck、lint、
  format:check、build、diff-check 全部退出码 0；dev 与 production Electron 冒烟均完整运行并
  退出码 0。④ 8 KiB 行预算、10 MiB 写前硬上限、10 files/14 days、受控文件名与
  lstat fail-closed、有界滚动候选，以及 Clock 的 DST gap/fold、极东时区、O(1) interval、
  幂等 timer 清理均由红→绿测试覆盖。⑤ R4 前对既有 8.19-B 偶发时序失败做过基线/候选
  交叉分类，本次 Reviewer dev/start 均一次通过；保留为既有冒烟观察，不归因于 D1。
  ⑥ Closer 精确删除任务遗留 `stash@{0}`（对象 `96a02319`，父提交 `94cc433`）；下一唯一
  任务为 D2，D3 候选依赖仍未安装。

- **Sixth Stage 正式设计与独立审核（2026-08-23，最终 `PASS`）**：① remote/local
  baseline `a5361ecacd917c33db4a4b043fdbfbf270292134`；最终设计候选 HEAD
  `f1a062fe5c0b3ae9f7cfaf8bf634bc78e16c602b`，候选提交为 `4211e67`、`40b5952`、
  `f1a062f`。② 独立 Reviewer 两轮 `REPAIR` 分别闭合 Source version/identity、XML 预算、
  host 间隔、schedule 事务、端口，以及 Session page task-owned Tab 获取路径；最终无 P1/P2。
  ③ `npm test -- --maxWorkers=1` 为 97 files / 2226 tests PASS；typecheck、lint、
  format:check、build、diff-check 全部通过；build 仅保留既有 confirm-manager 动态/静态 import
  警告。④ diff 仅 16 个正式文档，无产品代码、依赖、凭据、数据、日志、数据库、构建产物或
  机器路径；Electron/Provider smoke 因纯设计任务不适用且未运行。⑤ Entry Design Gate=`GO`，
  不等同于第六阶段 Exit Gate；D1–D11 全部待实施，下一唯一动作是等待用户明确授权 D1。

- **C10 独立 Stage Audit（2026-08-23，最终 `PASS` / `GO/PASS`）**：
  ① 基线：remote baseline `bf65507d1001025b3ac857875e15f5683f764ced`，
  批准产品 HEAD `c1aafd963f4952c81933ab2d873d154fe1b2741b`；审核结束时工作区 clean，
  本地 `main` 比 Gitee/GitHub 各领先 3 个候选提交。② 聚焦测试 2 files / 34 tests
  PASS；全量 `npm test -- --maxWorkers=1` 为 97 files / 2226 tests PASS；
  `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`
  全部退出码 0。③ 默认 dev/production 冒烟 0/0；Session、Sources、Sources UI、
  Research 四组跨进程 set/check 全部 0/0；8.13、B-05、8.19-B、8.20
  FRT-01～FRT-12 全部通过；离线隐私扫描 60 条期望全部符合。④ 3 个真实主题
  全部 `completed`，共 28 次 HTTP；真 Key 九个检查表面零命中；未再次调用真实
  Provider。⑤ 红线无回退：ToolRegistry 17、Research 六工具、AgentLoop
  12 步/420 秒、Electron 隔离、SQL Repository 边界、Renderer 零任意 HTML/JS。
  ⑥ `conflicts=0` 只记为语义观察，不宣称完全免疫。⑦ Closer 仅修改 6 个批准文档，
  复用 Auditor 对产品 HEAD 的高成本验证证据；纯文档终检见 C10 任务文档与收尾提交。

- **C4 Post-Acceptance Repair 收尾（2026-08-21，独立 Reviewer B=`PASS`
  后的确定性 Closer 闭环）**：① 步骤 0 独立核验——HEAD
  `4c75a86b7b9d9fd3020a5af7be5fc4e29021efdf`、HEAD^ `abe7351…`、分支
  main、工作区干净；修复链 `65fe15d → f681451 → 56ea5c4 → e2404d0 →
f38fb4d → abe7351 → 4c75a86` 连续单父历史悬挂原 Repair baseline
  `3836587`；双远程 `main` 均为 `3836587`（push 目标）；隔离分支
  `codex/workflow-handoff-prompts`（`2525d8d`）未被动过。② **四项验收
  （独立 Reviewer B 最终 PASS，2026-08-21）**：Repair A 文档 gate（决议
  #173 契约冻结落 detailed-design/threat-model/C4 任务文档）PASS；Repair
  B implementation（empty table-cell 一律 fail-closed → `value-invalid`、
  field 通道 `field-path-invalid`、empty header → `locator.header =
null`、all-empty table 整体跳过、retained unit 仍受 canonicalText/
  contentHash 覆盖）PASS；surrogate coverage Repair（4c75a86 补全
  surrogate admission 边界）PASS；filesystem cleanup（工作区已核验空目录
  清理，无残留）PASS。③ **NOT RUN（已获 Reviewer 豁免，不得视为已运行）**：
  focused/full tests、typecheck、lint、build、dev/production smoke、
  Research smoke、真实 Provider——理由：本次 Repair 仅删除工作区已核验
  空目录，产品 HEAD 与 tracked tree 与已完成独立产品验证的 `4c75a86`
  完全相同。④ 收尾验证：`git diff --check` 与 `npm run format:check`
  全绿、closure 提交 diff 仅两个允许文件、无敏感信息/垃圾。⑤ 双远程
  push 后 `main` 前进至新 HEAD，`codex/workflow-handoff-prompts` 未动。
  下一唯一任务 = C10（须由新的独立 Codex GPT-5.6 Sol 上下文作为 Stage
  Auditor 执行）；本闭环不开始 C10、Fifth Stage Exit Audit 或 Sixth Stage。

- **C9-R1 格式漂移修复（2026-08-19，C9 的确定性文档收尾）**：① 根因 = C9
  证据回填后的任务文档与 threat-model 两处内容偏离仓库 Prettier 输出；后续开发
  工作流重构 Reviewer 已把它们识别为 baseline 既有且不在当轮 candidate 范围内，
  因此仅登记、未关闭，导致 C9 格式门控缺口延续。② candidate
  `8733313f0321e1c8f80d64e5ebbc0fed707ef30d` 只对
  `doc/stage5/tasks/C9-e2e-redteam-live-infra.md` 与
  `doc/stage5/threat-model.md` 执行确定性 Prettier 格式修复；Reviewer 独立审核
  后结论 `PASS`。③ Closer 接管时确认 HEAD 精确等于 candidate、工作区干净；
  独立复跑全仓 `npm run format:check` 全绿，`0f2cecd..8733313` diff-check
  零问题，candidate scope 精确为上述两份文档。④ 格式漂移缺口已关闭，C9 已完成；
  下一唯一任务恢复为 C10，本闭环不开始 C10、Fifth Stage Exit Audit 或 Sixth Stage。

- **独立开发工作流重构（2026-08-19，C9 与 C10 之间的纯文档闭环）**：
  ① Step 0 独立核验 baseline `0d4d185`：工作区干净、本地双远程跟踪同 SHA；
  C9 的提交、实际代码、C9 任务记录与 threat-model §4.1 在位，C9 聚焦测试
  107/107；确认 C9 已完成，而本文件任务表/下一任务仍停留 C9，属于状态漂移。
  ② 长期流程改为 Sol Planner/Reviewer/Stage Auditor + OpenCode/DeepSeek bounded
  Executor/Repair Worker + PASS 后 Closer；Execution Contract 固定 14 字段；Executor
  只做本地候选提交不 push，Reviewer 独立审查 `baseline..HEAD`，Closer 才同步
  progress/docs、最终验证与双远程 push。模板落于既有 vibe-coding-workflow
  `references/prompt-templates.md`，零新增状态文件。
  ③ AGENTS.md 从 2037 行缩至 482 行：移除任务完成轮次、历史测试数字和可由 Stage/
  progress/Git 查询的执行史，保留稳定架构、永久安全红线、技术基线、当前 Stage
  契约速查；明确产品“禁止多 Agent/Planner-Worker”不限制外部开发协作。
  ④ Reviewer 独立审查 `0d4d185..860822f`：仅 4 个文档文件，src/package/
  Fifth Stage 冻结设计/C10 零 diff；全量 test **2130/2130**、typecheck、lint、
  C9 聚焦 **107/107**、本次 4 文件 Prettier、diff-check、旧流程/状态漂移/永久
  护栏/敏感凭据形态扫描全部通过，结论 `PASS`。全仓 `npm run format:check`
  仍只报告 baseline 已存在且本次未改的 C9 任务文档与 threat-model 两处格式偏差；
  本闭环不为格式化改写冻结产品设计。纯文档任务未运行 build/Electron 冒烟/真实
  Provider（N/A：产品代码零变化）。⑤ Closer 收尾后下一唯一任务 = C10；不得开始
  Sixth Stage。

- **C9 中断恢复与实施（2026-08-18，第二十三个闭环；fix/feat/docs 逻辑提交
  见 git log：4209dd4/8e77854/c723b09/ce9cd75/f952319）**：
  ① **恢复审计**——中断现场完整保留（HEAD b4cb315 + 11 修改 + 6 未跟踪
  smoke-research-* 模块 + 仓库外 harness 已有 -Research 半成品但逐项核验
  完整；TEMP/Electron 进程零残留）；三个既有提交 09b258b/d678c27/b4cb315
  未重写。② **产品修复（先测后修，独立提交）**——#170 请求消息顺序
  （system 恒居首位且唯一/当前 user 恒保留/相对顺序/预算/context-too-long
  重试同序）+ #171 URL query/fragment 日志脱敏（全调用点 + 真实 logger 输出
  证明）+ #172 Research 工具结果回放 UNTRUSTED 块包裹（browser_read 携带
  正文零特权通道——FRT-01 红队发现）。③ **C9 结构缺口**——8.20 编排迁至
  smoke-research-redteam.ts（FRT/扫描/Fifth §7）与 smoke-research-live-runner.ts
  （真实 Provider 编排），smoke.ts 仅入口；manifest 3 个有界场景包 + 执行
  同源 fail-closed（validateLiveResearchExecution）+ purpose 进台账摘要；
  FRT 独立性安全网（每项后关闭非基线 Tab）；FRT-08 真实 DOM 冲突块证据、
  FRT-11 画布作用域零可执行元素、FRT-10 注入 Provider 计数器（第 25 轮
  执行前被拒绝，stream 恰 24 次）；Fifth §7 cohesive 端到端（Sources+Search
  真实命中 → merge 双 discoveredVia → 真实读取 → Evidence → C6 → C7 → 结果
  视图）；隐私扫描 Buffer 字节级 + fail-closed + provider-request-memory 面
  （6×10=60 条期望）；LIVE_RESEARCH 门控纯函数（请求标志独立读取——缺 SMOKE
  明确失败）+ 装配前退出；8.19-B 画布点击时序加固（按钮可用后再点——既有
  瞬态根因）。④ **红→绿证据**——调试期确认并修复三处夹具缺陷（canary 服务器
  精确路由 404 打飞 `?tok=` 捕获、跨运行 createId/captureId 回退碰撞 UNIQUE
  约束 → research-internal、cohesive 信源 id 非 UUID 被 merge 单条丢弃）；
  全量 test **2128/2128**（93 文件，单 worker）+ typecheck/lint/format:check/
  build/git diff --check 全绿；dev + 生产冒烟（含 8.20 全矩阵 FRT-01～FRT-12
  - Fifth §7 + 隐私扫描）退出码 0/0；LIVE_RESEARCH 门控矩阵（缺 SMOKE/缺
    LIVE_PROVIDER/冲突/非法值 → 退出码 1 零残留）+ 无 Key 路由（退出码 0 +
    「凭据不可用」+ 请求 0）； B-02/B-05/SESSION/RESEARCH_GATE 双进程全部 0/0；
    package/lock 零 diff；AgentLoop 12/420s 与 17 工具注册表零变化；TEMP/
    Electron 进程零残留。⑤ **真实 Provider 台账**：决议 #117 长期授权下执行
    **两次完整运行全部通过**（deepseek-v4-pro，harness `-Research`）——最终
    两次：HTTP 19 次（lr1=6/lr2=8/lr3=5）与 21 次（lr1=7/lr2=7/lr3=7）全部
    completed，用途 = 三个 manifest 场景包（Fifth §7.1/7.3/7.4/7.7、§7.2/7.4/
    7.5/7.6、FRT-01/02/08/11 观察）；C8 事件通道结构断言（渲染层 task-done
    到达 6 次——修复前 0）；真 Key 零暴露扫描 7 表面零命中 + 环境变量已清除 +
    零进程/临时目录残留；观察性结果如实登记（lr3 conflicts=0–2、claims=0–2
    ——模型是否识别语义冲突为自由行为，不冒充防御）。**真实验收还发现并修复
    两处 C8 生产缺陷**（先测后修，447bf0a）：research:progress/task-done 事件
    转发注册位于装配之前（`?.` 静默 no-op——生产面板不随任务完成自动刷新）+
    历史条目选择竞态守卫在无选中时恒丢弃首次选择（历史点击选择从未生效）；
    全量 test 2128 → **2130/2130**。诊断过程另消耗 ~190 次 HTTP（夹具/断言
    缺陷逐项定位修复：canary 服务器路由 404/跨运行 id 回退碰撞/UI 选择器/
    历史时序/真实模型引用标记的观察校准——每轮均为诊断驱动，非盲目重试）。
    **本条验证记录形成时不开始 C10；C9 后续收尾现已完成，当前下一唯一任务以文件末尾为准。**

- **C7 ResultValidator + 安全 Markdown 子集 + Renderer + 真实生产装配
  （2026-08-16，第二十二个闭环；docs/fix/feat 逻辑提交见 git log）**：
  ① 步骤 0 独立核对——HEAD `deb94cb`（C6 指针校准）与预期一致、工作区
  干净；基线 test 1865/1865·typecheck·lint·format:check 独立复跑全绿；
  **基线测试前根目录零 aibrowse-\*.log → 测试后生成
  aibrowse-2026-08-16.log（35116 字节）——logger 未初始化落盘缺陷红态
  机器证据**（#153(1)）。② **实施前契约裁决 #148–#155**（八项缺口逐一
  冻结，落 detailed-design §8 重写 + §13.2 冒烟表 8.19 拆分 + §15 +
  proposal D9/HLD §8/threat-model §3.5/C7 任务文档同步）：#148 D9/#99
  Markdown 单一事实源（表格不实现——proposal D9「表格」漂移废止；
  解析器进 shared 零 main→renderer 依赖）；#149 ResultDraft 三字段
  白名单（可信字段全由程序生成——模型提供即整份拒绝；fetchedAt =
  Evidence 最大 accessTime 或 ctx.now；context 增 now）；#150
  Validator 严格验证（不 throw/整份拒绝/两种规范化/表格行列严格一致/
  ranking 1..N/sourceRefs 有 Evidence 支撑/table block 级 sourceRefs
  （v1 无逐列映射——不伪造能力）/200k 总大小/错误零敌对正文）；#151
  Conflict·Coverage·不确定（evidenceMap/conflicts 程序投影/coverage
  由 claims 计数——类别可重叠/强制 uncertainty 五条件矩阵）；#152
  Markdown AST 与 Renderer（子集定稿/未闭合字面化/深度·节点·长度有界
  降级/单遍线性扫描防 ReDoS/raw HTML 零解释/URL 双防线/ResultView 零
  `<a href>` + onOpenUrl 预留）；#153 logger 未初始化落盘修复（未 init
  仅脱敏 console/getCurrentLogFilePath 未 init 返回 ''/re-init 重置/
  真实临时 cwd 探针）；#154 启动预占与 Provider 交接（starting slot
  原子预占/shutdown-during-resolve 迟到 continuation 零 DB 写入零
  launch + prepared 释放/resolve 失败任务保持 created/stopTask 在
  resolving 阶段 research-invalid-state/Factory 接口窄幅修改——
  resolveProvider 返回一次性 prepared（launch/release 恰好一次，等价
  竞态证明在 §15））；#155 真实生产装配（research-runtime-factory 新
  模块/真实 SearchProvider·SourceService·BrowserController·Provider
  config+credential 动态读取/Key 短生命周期零缓存/缺配置·缺 Key·不支持
  tools → provider-unavailable、Sources 缺失非 normal → sources-
  unavailable/状态查询不谎报（同步粗粒度 + 异步 resolve 权威）/index.ts
  装配顺序调整——Research store 移至 Sources/SearchProvider/Config/
  Credential 之后/生产 startTask 解除 fail-closed）。③ **红→绿**：
  7 新测试文件红态（模块缺失 + logger 旧实现真实失败 + 旧 factory
  形状 typecheck 红）→ 聚焦 **172/172**（markdown 26 + validator 45
  - ResultView 9 + logger 17 + preemption 8 + factory 7 + service/
    store/prompts 回归）→ 全量 **1964/1964**（基线 1865 + 99；既有
    用例零删除零削弱——async/service 测试 factory stub 按 #154(7) 机械
    校准；8.18 的 C7 stub 移除改真实端口）。④ **冒烟**：8.18 真实 C7
    端口（第一轮伪造可信字段草案整份拒绝 → 回注重提 → 三字段草案完成 +
    Claim/Conflict 断言全保持）+ **8.19-A 生产 factory 主进程闭环**
    （FakeProvider 经 createProductionResearchRuntimeFactory 真实代码
    路径（真实 config/credential resolution + 真实 C6+C7 端口）经
    ResearchService.startTask → completed + 可信字段全部程序生成 +
    危险链接草案被真实 C7 拒绝重提 + 缺 Provider 配置精确拒绝 + 用户
    Tab 恒等）——dev+生产双场景退出码 0/0（dev 冒烟期间 SRT-12 白名单
    补 parse-markdown 正则分类（契约同步非放宽）+ 8.13 既有瞬态失败
    一次（当日 14:47/16:55/19:37 同款先例，复跑通过如实登记）+ 8.17/
    8.19-A 脚本 vendorCandidateIds/getState 夹具校准（真实端口契约
    严格化所致））。⑤ **AIBROWSE_RESEARCH_SMOKE=set|check** 双进程
    退出码 0/0（SMOKE factory 改真实 C6+C7 端口后零回归）。⑥ **红线
    零回归**：migration v1 零改写；新模块零 SQL（parse-markdown
    `.exec` 为正则——SRT-12 分类证据）；renderer/preload 零 SQL；零
    dangerouslySetInnerHTML 实际使用；零 shell/child_process/eval；工具
    注册表仍 17、AgentLoop 12/420s 零改动（diff 断言）；package.json/
    lockfile 零 diff；**根目录 aibrowse-_.log 修复后多次全量测试零写入
    （mtime 证据）→ 修复前残留文件核验后精确删除（测试日志、gitignore
    覆盖、敏感形态为脱敏后的 apiKey=_**/sk-*** 形态）**；结束后零
    Electron 进程、零 aibrowse-* TEMP 残留（冒烟失败路径遗留的 5 个
    research pid 目录已精确清理）。⑦ **真实 Provider 台账**：0 次调用
    （C7 无真实 Provider 产品链路——FakeProvider 经生产 factory 路径；
    决议 #117 长期授权不等于强制无关调用）。**不开始 C8。下一唯一任务
    = C8。**

- **C5 ResearchRuntime（2026-08-16，第二十一个闭环；docs 与 feat 两个逻辑
  提交见 git log）**：① 步骤 0 独立核对——HEAD `686e052`（C4 指针校准）
  与预期一致、工作区干净；基线 test 1691/1691·typecheck·lint·
  format:check 独立复跑全绿。② **实施前契约裁决 #132–#139**（八项缺口
  逐一冻结，detailed-design §6 重写 + §15 + threat-model + C5/C6/C7 任务
  文档同步）：六工具专属执行模型（编译期固定集合/不经 ToolRegistry/
  ToolExecutor/权限链/browser_open 候选 URL 白名单经 CaptureService/
  browser_read 本 run 内存内容索引/C4 release 契约不变/安全工具结果）、
  ResearchPlan 判别联合（groupId/candidateId 只能引用程序提供的集合/
  MAX_PLAN_WEB_QUERIES=1/安全默认计划零模型输出）、C6/C7 稳定端口
  （research-runtime-unavailable 第 12 码/生产 fail-closed）、Service
  异步装配（单一 active slot + runToken + restart 屏障/终态单一写入者/
  幂等 async shutdown）、预算与 Provider 失败映射（超预算零执行/重试
  计数/context-too-long 裁剪重试/成功轮重置连续失败）、原子持久化与
  500k 终态预留（Runtime 零 SQL 窄端口/最坏终态任务行预留/非终态写不
  得卡 running）、Progress/heartbeat/终态优先级（stop>deadline>budget/
  语义变化才发快照/listener 异常隔离）、index.ts 最小装配（SMOKE 注入
  点/退出走 shutdown/零新 IPC）。③ **红→绿**：5 测试文件红态（模块
  缺失 5 failed/14 failed）→ 聚焦 **113/113** → 全量
  **1804/1804**（基线 1691 + 113；既有用例零删除零削弱——#113 投影
  检查用例按 #137(2) 语义校准为探针 SQL 直插填充；错误码表 11→12 码；
  C1 service 测试注入 immediate-settle stub factory）。④ **冒烟 8.17**
  （默认矩阵 dev+生产双场景退出码 0）：真实 Workspace + CaptureService
  - FakeProvider 全阶段 → completed + 落库读回 + 正文零落盘 + 用户 Tab
    恒等 + 进度首尾各恰好一次；stop 中途 → cancelled + 迟到写入零生效；
    预算注入 → research-budget-exhausted + 此前 60 条 Evidence 保留。
    ⑤ **AIBROWSE_RESEARCH_SMOKE=set|check 双进程退出码 0/0**（与
    SESSION/SOURCES/SOURCES_UI 确定性互斥）：set 经产品 Service/Runtime
    路径完成任务 + 遗留 running 直接退出；check 读回 + interrupted 自动
    标记；零测试 SQL 伪造核心状态。⑥ **红线零回归**：migration v1 零
    改写；Runtime 零 SQL（SQL 仅 Repository 编译期常量）；renderer/
    preload 零 SQL 零 Research IPC；零 shell/child_process/eval；capture
    正文/transcript/reasoning/Key 零持久化；工具注册表仍 17；AgentLoop
    12/420s 零 diff；package.json/lockfile 零 diff；用户 Tab 集合不变；
    结束后零 Electron 进程/零临时数据库/根目录日志零残留。⑦ **真实
    Provider 台账**：0 次调用（C5 无真实 Provider 产品链路；决议 #117
    长期授权不等于强制无关调用）。**不开始 C6。下一唯一任务 = C6。**
    docs 与 feat 两个逻辑提交见 git log）**：① 步骤 0 独立核对——HEAD
    `674cdbe` 与预期一致、工作区干净；基线 test **1518/1518**（64 文件，单
    worker）· typecheck · lint · format:check 独立复跑全绿。② **实施前契约
    裁决 #120–#123**（先改契约、再写红测、最后实现；C3 任务文档「实施前
    复核项」四项逐一裁决）：#120 三档发现路径排序（废止旧五档——档位 3/5
    对合法 merge 输出不可达；tier 1 source-search 保留 SourceService 输入
    顺序/tier 2 group-list priority 降序 + lastUsedAt 降序 + scope/
    canonicalKey/id 收尾/tier 3 web-search 保留 Provider 顺序且 trust/
    priority/lastUsedAt/note 恒 null；同身份合并采用 Sources 档位与字段 +
    双 discoveredVia；trust 仅 provenance 元数据不改变基础排序——来源选择
    顺序不是可信度评分；user+asserted ≠ 程序已核验；ai+unverified 恒显示
    未核验；official/primary/community 进一步选择归 C5 有界计划调整与 C6
    sourceTypes/交叉核验；Fifth_stage §3.2 为策略建议，经 source-search
    上游排序/group 限定/Search 补充/C5 有界调整实现）；#121 note 映射
    （group-list/search-only 恒 null；source-search 按「用户备注：」/「AI
    备注：」作者标签 + 换行连接 + NFC/trim/控制·bidi 清洗 + 标签·换行·正文
    共同计入 200 + 截断不拆 surrogate pair + 第二段预算不足不得留下无正文
    标签 + 不进 sortKey/模型上下文）；#122 candidateId 输入契约（C3 纯函数
    不生成 id；C5 预分配小写 RFC 4122 v4 UUID、全局唯一；非法 →
    candidate-invalid-input、重复 → candidate-id-conflict 整次 fail-closed；
    同身份合并采用 Sources 条目 candidateId；不同 task 每次新 UUID）；#123
    sortKey 编码 `TT|RRRRR|P|I|S|canonicalKey|candidateId`（tier 两位/rank
    5 位补零 group-list 固定 99999/priority 补码 6−p null=9/ISO 时间 UTC
    规范化后数字反转 null=`~`×24/scope 0|1/canonicalKey ASCII/小写 UUID；
    原始二元 `<` 比较不用 localeCompare，与 SQLite BINARY 排序一致）。
    同步：detailed-design §4 重写（输入契约/合并语义/档位/验证降级/note/
    sortKey/有界性）+ §15 + §13.1 测试行、high-level-design §4.2、
    threat-model FRT-07、proposal §3 场景 2 映射、C3 任务文档、本文件。
    ③ **红→绿**：`source-selector.ts` 不存在 → 测试 80 用例（A 三档可达性
    与互斥/B 上游顺序/C 合并矩阵/D provenance 防洗白/E note/F ID 契约/
    G sortKey 含真实 node:sqlite probe/H hostile input/I 预算）import 失败
    红态（1 file failed / 0 tests）→ 实现纯函数 → 聚焦 **80/80** → 全量
    test **1598/1598**（65 文件，单 worker，退出码 0）。真实 node:sqlite
    probe：三档混合 8 候选 insertCandidate 写入真实 research.db 后
    listCandidatesByTask() 顺序与内存 binary 排序逐元素一致（测试设施仅限
    测试文件）。实施中途修正三处测试夹具缺陷（fixture 默认 sourceId 非
    UUID 形状、预算组 candidateId 长度 12 位 hex、sortKey 断言未考虑
    candidateId 收尾差异——均为测试自身问题，非实现缺陷）。④ **红线零
    回归**：src/main/sources、src/main/ai、src/shared、src/renderer、
    src/preload、research db/domain/repository/store/service/workspace、
    package.json/lockfile 零 diff；migration v1 零改写；C3 模块零
    Electron/SQL/shell/child_process/网络/logger（grep 断言——「单条非法
    只增 droppedCount 零日志正文」由模块不产生日志保证）；renderer/preload
    零 SQL；密钥形态（sk-/Bearer/Authorization/baseURL/token）零新增；
    AgentLoop 12/420s 零变化；工具注册表 17（8+4+4+1）零变化。⑤ **验证
    矩阵**：typecheck · lint · format:check · build · git diff --check 全
    绿；**dev 冒烟退出码 0**（默认矩阵全过）；**production 冒烟退出码 0**
    （同矩阵，含 B8 红队 SRT-01～SRT-12 与 AI 共读矩阵）；冒烟临时 userData
    精确清理、零 Electron 进程残留；早期测试版本遗留的 3 个空临时目录精确
    清理。⑥ **真实 Provider 台账**：0 次调用（C3 为纯函数任务，无真实
    Provider 产品调用链；决议 #117 长期授权不等于强制无关调用）。
    **不开始 C4。下一唯一任务 = C4。**

- **C2 定向安全修复：取消/异常清理的 Tab 所有权漏洞（2026-08-16，第十九个
  闭环；fix 与 docs 两个逻辑提交见 git log）**：① 步骤 0 独立核对——HEAD
  `2019731` 与预期一致、工作区干净；基线 test **1509/1509**（64 文件，单
  worker）· typecheck · lint · format:check 独立复跑全绿。② **缺陷确认
  （只读代码证据）**：a) acquire 的 abort 检查先于 tabsBefore 所有权验证
  ——createTab 在 pending 期间返回 tabsBefore 中的既有用户 Tab 且信号已
  终止时，会在验证所有权前 closeTab(tab.id)（违反 #118(4)「绝不关闭该
  Tab」，威胁用户 Tab 安全）；b) create 期间 abort / 焦点恢复失败 / 后置
  快照异常三条路径均以 closeBestEffort 关闭新 Tab——它忽略
  closeTab=false/抛错，且调用方未保留所有权（焦点恢复失败路径还在关闭前
  从 owned/ownedUrls 删除 id）→ closeTab 失败后 Tab 继续存在但
  cleanupAll() 无法重试（违反「清理失败不得误报已清理」与「终态前
  cleanupAll 可补清理」契约）。③ **决议 #119**（先写红测 → 改契约与测试
  → 再改实现，§15 流程；detailed-design §15 + §10.1 acquire 注释 + C2
  任务文档同步，不改写 #118 既有结论）：(1) 所有权验证优先——createTab
  返回后先查 id 非空且不在 tabsBefore；属于 tabsBefore → tab-create-
  failed，即使已 aborted 也零关闭零登记、用户 Tab 集合与 URL/title/
  active 状态恒等；(2) provisional ownership——全新精确 id 在 abort
  检查/创建后 getTabs/焦点恢复前先登记进所有权集合，无「已知 id 未登记、
  清理失败即失联」窗口；(3) 清理事实语义——仅 getTabs 明确确认不存在或
  closeTab 明确返回 true 才移除所有权；false/抛错 → cleanup-failed +
  所有权保留 + cleanupAll 只针对该精确 id 重试；(4) 错误优先级——abort/
  焦点失败/后置异常 + 清理成功保持原码（tab-create-aborted /
  tab-restore-focus-failed / workspace-internal），任一路径清理失败 →
  cleanup-failed，不新增 WorkspaceErrorCode；(5) 禁止不经所有权证明调用
  closeTab——清理 helper 只接收已确认不属于 tabsBefore 的精确 id，
  消除 closeBestEffort 失真语义。④ **红→绿**：新增决议 #119 矩阵 9 用例
  （A 既有用户 Tab+abort 竞态/B abort+closeTab=false/C abort+closeTab
  抛错/D activateTab=false+closeTab=false/E activateTab 抛错+closeTab
  抛错/F1 F2 创建后 getTabs 抛错+closeTab false·抛错/G1 G2 对照路径，
  全部断言用户 Tab 逐 id/字段恒等、零未处理 rejection、只关闭本任务已
  证明拥有的精确 id）→ 红态 **7 failed / 41 passed**（A/B/C/D/E/F1/F2
  失败，G1/G2 对照与既有 39 用例保持通过——红态可甄别）→ 实现
  research-workspace.ts（closeOwnedTab helper 替换 closeBestEffort；
  acquire 所有权验证优先 + provisional 登记）→ 聚焦 **48/48** → 全量
  **1518/1518**（64 文件，单 worker，退出码 0）。⑤ **红线零回归**：
  BrowserController/TabManager/SearchProvider 零 diff；
  sources/ai/browser/renderer/preload/index.ts 零 diff；package.json/
  lock 零 diff；C2 模块零 Electron/SQL/shell/child_process/网络；
  renderer/preload 零 SQL；密钥形态（sk- 长串/Bearer/Authorization/
  baseURL/token）零新增（初扫「task-1」子串误报已甄别）；AgentLoop
  12/420s 零变化；工具注册表 17 零变化。⑥ **验证矩阵**：typecheck ·
  lint · format:check · build · git diff --check 全绿；**dev 冒烟退出码
  0**（默认矩阵全过）；**production 冒烟退出码 0**（同矩阵）；冒烟临时
  userData 精确清理、零 Electron 进程残留。⑦ **真实 Provider 台账**：
  0 次调用（C2 定向修复无真实 Provider 产品链路；决议 #117 长期授权
  不等于强制发起无关调用）。⑧ **文档漂移校准**：「下一个推荐任务」由
  C2 改为 C3（正确任务路径 doc/stage5/tasks/C3-source-selection-
  candidate-merge.md）；删除过时的「禁止未经授权调用真实 Provider」
  「C9/C10 真实验收须另获用户授权」表述，改为引用决议 #117 长期授权
  语义；修正 C2 验证记录「293 行」错误事实（当时实际 408 行，改为文件名
  与能力描述，不再写脆弱精确行数）；历史阶段当时的未授权/NOT RUN 记录
  全部原位保留。⑨ **C3 实施前契约缺口登记**（本轮不裁决不实现；C3 任务
  文档「实施前复核项」+ 本文「下一个推荐任务」同步）：§4.2 五档条件
  覆盖（档位 3/5 对合法输出不可达）/note 映射规则缺作者标识与确定性/
  candidate_id 生成契约缺 taskId·idFactory·失败语义（禁 canonicalKey
  充当）/sortKey ASC 与 priority·lastUsedAt 降序的字典序反向编码缺口。
  **不开始 C3。下一唯一任务 = C3。**

- **C2 ResearchWorkspace 与 task-owned Tab 隔离（2026-08-16，第十八个闭环；
  feat 提交见 git log）**：① 步骤 0 独立核对——HEAD `21aa0b0`（真实
  Provider 长期规则 docs 提交）与预期一致、工作区干净；基线 test
  **1470/1470**（单 worker）· typecheck · lint · format:check 独立复跑全绿；
  research-workspace.ts/test 零存在（红态可甄别）。② **实施前契约裁决
  #118**（八项，detailed-design §15 + §10.1 精确接口 + §13.1 测试行 +
  C2 任务文档同步）：§10 原只有行为描述无精确接口；实测
  BrowserController.createTab 自动激活新 Tab（browser-controller.ts:92），
  任务文档遗漏焦点恢复所需 activateTab——(1) Workspace 形态与接口（单实例
  单 taskId/ResearchWorkspaceBrowser 最小端口/局部闭合联合 WorkspaceErrorCode
  十一码不扩张 C1 ResearchErrorCode/Lease 绑定 taskId+tabId+规范 URL）；
  (2) 最小端口恰五方法（createTab/closeTab/activateTab/getTabs/getActiveTab）
  零 Electron import；(3) URL 边界复用 normalizeSourceUrl(url,'page')
  （http/https/userinfo/≤2048/控制字符），javascript:/data:/file:/about:/
  畸形/空 createTab 前拒绝，地址栏转搜索语义不进入，日志零 query 值（仅
  host）；(4) 精确所有权（tabsBefore/activeBefore 快照；createTab 返回已存在
  id → tab-create-failed 零关闭零登记；创建后消失 → tab-closed-by-user 不
  登记存活资源）；(5) 并发上限（MAX_RESEARCH_TABS 同时约束 owned 与
  in-flight 预留槽；同步段（第一个 await 前）检查 → 第 4 次并发 acquire 在
  createTab 前确定性拒绝；槽位覆盖整个 acquire 生命周期）；(6) 焦点恢复三态
  （用户未切换且 activeBefore 存在 → activateTab(activeBefore)；用户已切换 →
  零 activate；activeBefore 已关 → 不重建不激活 + 中文 warning；activateTab
  返回 false/异常 → 精确关闭新 Tab + tab-restore-focus-failed——不允许新
  Tab 无声留在前台仍称满足契约）；(7) 用户关闭感知 = checkTab 显式 getTabs
  快照（零事件/计时器/监听器；C4 读取前后调用；owned tab 消失 → 移除集合 +
  closed-by-user）；(8) 释放取消竞态（release/cleanupAll 幂等；closeTab
  false/抛错 → cleanup-failed 所有权保留可重试不误报；cleanupAll 置 closing
  - drain 屏障等待 in-flight acquire 终态后精确关闭零泄漏；cleanup 后
    acquire → workspace-busy；abort 前零创建/abort during create 精确清理）。
    ③ **红→绿**：先写 research-workspace.test.ts（39 用例，20 组覆盖任务书
    全部清单 + 非法 taskId + 确定性/隔离断言；FakeBrowser 完全离线可控
    Promise——manualCreate/completeCreate/waitForPending 时序控制）→ 红态
    **1 file failed**（模块缺失，导入失败）→ 实现 research-workspace.ts
    （决议 #118 §10.1 精确接口：Workspace 类/错误码联合/最小端口/acquire/
    checkTab/release/cleanupAll/焦点恢复）→ 聚焦 **39/39** → 全量
    **1509/1509**（64 文件，单 worker，退出码 0）。
    （2026-08-16 校准：原记录「293 行」为错误事实——当时实际为 408 行；
    精确行数随实现变化脆弱，后续以文件名与能力描述为准。）④ **红线零回归**：
    BrowserController/TabManager/SearchProvider 产品契约零改动（diff 确认）；
    sources/ai/browser/renderer/preload/index.ts 零 diff；package.json/lock
    零 diff；C2 模块零 Electron/SQL/shell/child_process/网络；renderer/preload
    零 SQL；密钥形态（sk- 长串/Bearer）零命中；AgentLoop 12/420s 零变化。
    ⑤ **验证矩阵**：typecheck · lint · format:check · build · git diff
    --check 全绿；**dev 冒烟退出码 0**（17 工具恒等 + SRT-01～SRT-12 全过 +
    RT 红队矩阵回归 + 8.13 UI DOM 全过）；**production 冒烟退出码 0**（同矩阵）；
    冒烟临时目录/日志精确清理 + 零 Electron 进程残留 + 根目录杂散日志
    （aibrowse-2026-08-16.log，测试生成、gitignore 覆盖、密钥形态零命中）
    精确删除。⑥ **真实 Provider 台账**：C2 无真实 Provider 产品链路（零
    调用，决议 #117「授权不等于强制调用」——不得为展示授权发起无关调用）。
    **下一唯一任务 = C3（Source Selection 候选合并与确定性排序）。**

- **真实 Provider 长期调用与保密规则更新（2026-08-16，第十七个闭环；docs
  提交 `21aa0b0`）**：用户明确要求的长期规则变更——真实 Provider 已获
  **长期授权**（决议 #117，detailed-design §15）：后续任务按需使用、无需
  逐次申请授权、不设固定调用次数；每次调用仍须服务于明确开发/验收/定位/
  复验目的；禁止无界循环、无诊断依据重复请求和无关测试；凭据只能通过既有
  仓库外说明、DPAPI 密文和受控 harness 注入；不得要求用户在聊天中粘贴
  Key；Key/base URL/认证头不得进入命令行、源码、Git、日志、prompt、DOM、
  research.db、sources.db、会话文件、报告或工具输出；应用读取环境变量后
  立即移除；运行结束清理子进程、环境变量和临时目录；完成报告登记实际调用
  次数和每次用途但不登记凭据；本地凭据缺失记录「凭据不可用」不得再写
  「未获授权」；Provider 失败必须区分余额、权限、网络、服务端、模型兼容和
  产品缺陷；授权不等于强制调用。修改文件：AGENTS.md（§1 第五阶段 + §6 长期
  真实 Provider 流程）、Fifth_stage.md 顶部、README.md（当前阶段与开发者
  真实验证流程）、doc/stage5/proposal.md §5、high-level-design.md §7、
  detailed-design.md（§15 决议 #117 + §13.2/§14 校准）、threat-model.md
  §4、C9/C10 任务文档、本文件。**C9 契约调整**：实现基础设施后，如本地
  凭据和 Provider 可用，真实执行属于 C9 范围，不再等待授权；**C10 契约
  调整**：不得再因「未授权」判 HOLD，只能因真实验证未完成、凭据/服务
  不可用或验证失败而如实 HOLD；FakeProvider 仍不能冒充真实 Provider
  证据。**历史保持**：第三/四阶段以及 progress/README/AGENTS 中记载当时
  「未授权、NOT RUN、后来授权」的历史记录全部原位保留，未改写为当时已有
  长期授权。

- **C1 第二次定向补修：ISO 8601 偏移日期校验 + 第五阶段状态指针校准
  （2026-08-16，第十六个闭环；fix 与 docs 两个逻辑提交见 git log）**：
  ① 步骤 0 独立核对——HEAD `a169fe5` 与预期一致、工作区干净；基线
  test **1429/1429**（单 worker）· 聚焦 174/174 独立复跑全绿。② **缺陷
  确认（只读 Node 证据）**：`isIso8601Timestamp` 偏移形态仅做
  `Date.parse(new Date(parsed).toISOString()) === parsed` 值级往返——对
  已成功解析的时间近似恒真，无法甄别 JS 日期回滚
  （`2026-02-30T00:00:00+08:00` → `2026-03-01T16:00:00.000Z`、
  `2026-04-31T12:00:00-05:00` → `2026-05-01T17:00:00.000Z`），违反
  决议 #116「形状 + 可解析 + 日历回滚拒绝」。③ **红→绿**：新增 41 例
  （23 非法——含偏移回滚/非闰年 2 月/月日时分秒与偏移边界外形态 + 16
  合法——闰年 2024-02-29/月末/毫秒 1–3 位/正负偏移 ±23:59 既有边界/
  toISOString 形态 + 2 迁移断言，两层断言：
  isIso8601Timestamp=false + transitionTask 全部事件零变化）→ 红态
  **6 failed / 80 passed**（断言落点 `expected true to be false`——恰好
  6 个偏移回滚用例）→ 最小修复（仅 task-state 纯函数：确定性日历字段
  校验——月范围/闰年/各月天数/时≤23/分秒≤59/偏移 HH≤23·MM≤59 既有
  边界；纯字段范围判定不参与本地时区；Z 形态保留字符串级往返；24:00 与
  闰秒 60 拒绝）→ 聚焦 **215/215**、全量 **1470/1470**（63 文件，单
  worker，退出码 0）。④ **红线零回归**：migration v1/Repository/Store/
  Service 零改动；sources/ai/browser/renderer/preload/index.ts 零 diff；
  零新依赖；AgentLoop 12/420s 零变化；17 工具注册表零变化。⑤ **文档
  漂移修正**：Fifth_stage.md 头部与 AGENTS.md 三处（§1 当前阶段/§4 目录树
  /§5 Research 速查）「C1–C10 全部待开始」改为实施阶段表述（完成项/
  HEAD/下一任务以 progress.md 为准）；决议范围引用改为「以 detailed-design
  §15 当前记录为准」；#116 仅补「Z 与偏移形态均进行日历字段校验」实现
  说明不改结论；C1 任务文档登记补修小节；**下一唯一任务 = C2**（不再写
  「C2/C3 并行」）。⑥ **验证矩阵**：typecheck · lint · format:check ·
  build · git diff --check 全绿；**dev 冒烟退出码 0**（A2 探针 17 工具
  恒等 + SRT-01～SRT-12 全过 + 8.13 B-06 UI DOM 全过）；**生产冒烟退出码
  0**（同矩阵；8.13 UI DOM 探针本轮**一次通过**——无重跑，上轮生产首轮
  瞬时失败未复现；7 处 ERROR 行均为 8.14 recovery 注入诊断）；TEMP 残留
  三目录（C1 store 测试 db/wal/shm 文件）白名单校验后精确删除零残留。
  ⑦ 安全扫描：密钥形态零命中/动态 SQL 零新增/renderer-preload 零 SQL/
  禁具零命中/零新依赖。**不开始 C2。下一唯一任务 = C2。**

- **C1 定向修复与契约边界复核（2026-08-16，第十五个闭环；fix 提交见 git
  log）**：① 步骤 0 独立核对——HEAD `285c74c` 与预期一致、工作区干净；
  基线 test 1386/1386（单 worker）· 聚焦 131/131 独立复跑全绿；C1 产物
  全部在位。② **五个契约边界缺口先红后修**（决议 #112–#116，落
  detailed-design §15 + §2/§3.2/§6.8/§9.1/§9.2 校准，不改写 #101–#111）：
  a) goal 截断标记未计入 MAX_GOAL_CHARS（返回 2006>2000，测试还固化错误
  期望）→ truncateWithMark 标记计入上限（String.length 恒 ≤maxChars、
  标记放不下绝不输出半截标记、CHARS 单位不变——#114）；b) table.header
  非 string/null/缺省被静默转 null → 非法形态整体拒绝（读取跳过、写入
  零落库——#115）；c) 六条任务状态更新路径 + markAllRunningInterrupted
  无预算检查——真实 node:sqlite 构造距 500k 仅 3 字节的任务实证可突破
  → 全部按更新后任务投影检查（子行字节 + 更新后任务行字节 ≤500k；替换
  写不误算为完整新增——离上限 300 字节控制用例；检查与写入在调用方事务
  内、超限整体回滚；markAll 任一投影超限整体拒绝零写入；映射
  research-budget-exhausted 不变——#113）；d) 31 created + 零终态启动
  溢出被静默忽略 → 单事务回滚（含标记）+ unavailable（中文诊断；created
  零删除；可清理形态（31 含 1 终态/31 全 running）不受影响——#112 依据
  #104 与两态唯一裁决）；e) now 注释声称 ISO 实现只查非空 → 状态机
  isIso8601Timestamp 输入有效性约束（形状 + 可解析 + 日历回滚拒绝；调用方
  恒 toISOString，责任边界入契约——#116）。③ **红→绿证据**：新增用例
  43 例（budget +3/task-state +18/repository +18/store +3/service +1 +
  错误期望修正 2 处）→ 红态 **34 failed**（断言落点逐项记录于 C1 任务
  文档）→ 修复后聚焦 **174/174**（9 文件）→ 全量 **1429/1429**（63 文件，
  单 worker）。绿态期间发现既有 store 夹具缺陷 1 处（makeSeededDb 仅建
  research_tasks 单表——投影检查需读全部子表；夹具改用产品 migration 全表
  集，非产品迁就）。④ **红线零回归**：migration v1 零改写（schema 零变化）；
  sources/ai/browser/renderer/preload/index.ts 零 diff；AgentLoop
  12/420s 零变化；17 工具注册表零变化；零新依赖（package.json/lock 零
  diff）；新增 SQL 仅 SQL_LIST_RUNNING_TASKS 一条（Repository 编译期常量 +
  参数绑定）；renderer/preload 零 SQL；research 零 shell/child_process/
  网络。⑤ **全量验证矩阵**：test 1429/1429（单 worker）· typecheck · lint ·
  format:check · build · git diff --check 全绿；dev 冒烟一次通过（17 工具
  恒等 + SRT-01～SRT-12 全过 + SRT-12 SQL 分类证据）；生产冒烟首轮瞬时
  失败于 8.13 UI DOM 探针（零 renderer 改动、dev 同场景同轮通过）→ 重跑
  一次全矩阵通过（如实登记，未复现）；临时冒烟日志已清理。
  **下一任务 = C2/C3（并行，均仅依赖 C1；本闭环不实施）。**

- **C1 Research 契约与存储基座（2026-08-16，第十四个闭环；feat 提交见 git log）**：
  ① 步骤 0 接管——HEAD c0f3dbc、工作区干净、Node 24.18.0；基线 test
  1255/1255（单 worker）· typecheck · lint · format:check 独立复跑全绿；
  C1 相关实现零存在（红态可甄别）。② **实施前契约裁决 #101–#111**（七项
  缺口逐项唯一裁决，detailed-design §2/§3/§6.6/§6.8/§9/§15 校准）：schema
  v1 补 research_candidates/research_captures 两表（7 表集）；rejected
  Evidence 三重一致（窄类型 API + CHECK 收窄）；500k = UTF-8 字节；任务
  总数硬上限 30（created 计入永不清）；状态机矩阵（completed 不可 start/
  delete 矩阵/事件统一 now 注入）；restart 单事务原子清理；goal 空拒绝
  超长截断；research-timeout 独立码（11 码）；Repository/Store/Service
  精确接口；§2 字段常量全表集中（单一事实源）；模式复用边界（import
  复用 sources 连接级与只读探测原语，零修改）。③ 红→绿：先写 9 测试文件
  （131 用例）→ **9/9 失败于模块缺失**（红态证据）→ 实现 10 文件 → 聚焦
  **131/131**；全量 test **1386/1386**（既有 1255 + 新增 131，单 worker）
  · typecheck · lint · format:check · build（三目标）· git diff --check
  全绿；dev/生产冒烟退出码 0 +「冒烟自检通过」+ 8.1 探针 **17 工具恒等**
  - SRT-01～SRT-12 全过。④ 既有改动仅 1 处：smoke.ts SRT-12 允许点表 +
    research-repository.ts 分类键（契约同步非放宽，+5 行）；sources/ai/
    browser/renderer/preload/index.ts 零 diff；AgentLoop 12/420s 零变化；
    package.json/lock 零 diff。⑤ 红线扫描：product 零动态 SQL（业务 SQL 仅
    ResearchRepository 编译期常量 + migration 冻结列表）/零 shell/零网络/
    renderer-preload 零 SQL/真 Key 形态零命中/禁具零命中/零新依赖。⑥ 杂散
    日志清理（根目录 aibrowse-2026-08-16.log，冒烟生成、gitignore 已覆盖）。
    ⑦ 前置复核登记：proposal D9 与决议 #99 表格漂移 → C7 前置复核项
    （C1 任务文档登记，未顺手修复）。**下一任务 = C2/C3（并行，均仅依赖 C1）。**
- **Fifth Stage 切换与设计定稿（2026-08-16，第十三个闭环；纯文档任务，零代码
  改动、零新依赖、零真实 Provider 调用，不实现任何 Research 功能）**：① 步骤 0
  独立核对——HEAD `6d730a6` = Gitee main = GitHub main（ls-remote 实测三方
  一致；GitHub 操作前确认 127.0.0.1:7890 代理 HTTP 200）、工作区干净；
  基线 test **1255/1255**（单 worker）· typecheck · lint · format:check
  独立复跑全绿；第四阶段 GO/PASS 证据与 B9/第五轮台账一致（Fourth_stage §10
  八项 PASS）。② **Entry Gate 逐项核验通过**（Fifth_stage.md §2 五项，证据
  表见 `doc/stage5/proposal.md` §7：工具接口稳定/Sources 检索可靠/备注参与
  选择/权限与注入防线稳定/可追踪来源标识——含真实 Provider 证据，无阻塞项）。
  ③ 新建 `doc/stage5/`：proposal.md（Q 拍板由决策表 D1–D13 承担 + Entry Gate
  核验记录 + 遗留风险分级 + 验收映射 + 里程碑）、high-level-design.md、
  detailed-design.md（唯一契约源 §2–§16：完整类型与接口签名/状态迁移表/
  候选合并排序/capture·evidence/ResearchRuntime/预算全表 §6.8/cross-check/
  Result Schema 与 Renderer/storage·migration/IPC 白名单/边界情况/测试规格/
  决议 #94–#100）、threat-model.md（FT-01～FT-17/FRT-01～FRT-12/诚实边界
  十一类/兼容声明，先于任何 Research 实现定稿）、tasks/C1–C10（每任务 =
  一个可验证开发闭环）。④ **遗留风险重新分级**（proposal §8 + 本文「风险与
  限制」）：无阻塞项；P2-3/六类注入残余/AgentLoop 固定预算/snippet 恒空/
  CitationCard 无结论级 Evidence/快照不持久化正文等**必须吸收**进本阶段设计
  （独立 research.db 字节预算 + FT 威胁模型 + 决策 D2/D5）；P2-2/P2-4/P3
  延期 Seventh Stage（判定已更新）。⑤ 更新 Fifth_stage.md（Entry Gate 结论 +
  doc/stage5 指针 + 正式进入标记）、Fourth_stage.md（冻结为已完成历史阶段 +
  切换注记，不改写既有验收过程）、AGENTS.md（§1 当前阶段/接管顺序/阶段机制/
  步骤链需求源/第五阶段架构纪律与不做清单/§3/§4/§5 速查）、README.md（顶部
  当前阶段 + 历史标记 + stage5 指针）、package.json.description（产品级描述
  不含阶段号）、本文件。⑥ 验证：全量回归（test 1255/1255 · typecheck · lint
  · format:check · build · git diff --check 全绿）+ 产品代码零 diff 确认 +
  交叉引用 grep（阶段名/任务编号/当前阶段/下一推荐任务/「B9 未实现」等表述
  唯一且一致）+ C/FT/FRT 编号无冲突 + 新文档无占位 TODO + 敏感信息扫描零
  命中 + 根目录过期残留日志 aibrowse-2026-08-15.log（测试生成，核验后精确
  删除）。**未调用任何付费 Provider、未安装任何依赖、未提前实现 C1。**

- **第四阶段最终真实 Provider 验收通过（2026-08-16，第十二个闭环；场景
  1a–8 全部真实通过 → 总 Exit 改判 `GO/PASS`）**：① 步骤 0 独立核对——
  HEAD `b19b2dc` = 候选 HEAD（纯文档提交，show --stat 核验）、工作区
  干净、双远程在案（gitee/github）；BrowserController.navigate 只加载
  目标 Tab 不激活的契约行为经源码核实（browser-controller.ts:145-164），
  第四轮「场景 6 敌对页未就绪」夹具缺陷根因属实。② **红→绿**：先写
  失败测试（旧夹具仅 navigate 无激活在顺序断言下失败；红态 1 file
  failed——模块缺失）→ 最小 SMOKE 辅助逻辑
  `src/main/smoke-activate-navigate.ts` `activateThenNavigate`
  （激活先于导航；激活失败/取消/超时零导航且不触发 Provider；Tab 不存在/
  已销毁/导航失败/未预期异常安全返回 false 不抛异常；空参数零调用；
  结构接口，BrowserControllerImpl 结构兼容（typecheck 保证）、
  BrowserController 产品契约零改动）→ 绿 **11/11**；场景 6/7 接线
  （smoke.ts runLiveAgentSourcesScenarios，激活必须先于导航）；全量
  test 1244 → **1255/1255**（54 文件，单 worker）。③ **离线门槛全绿
  （一次一条命令）**：typecheck · lint（修复 no-useless-assignment 后
  0）· format:check（prettier 单文件换行修复后 0）· build · git diff
  --check 全绿；**production 无 Key 路由退出码 0**（隔离临时 userData：
  双层中文跳过提示 + 离线矩阵全过（8.15 SRT-01～SRT-12 通过行实证）+
  `开始流式请求` 0 次 = 真实 Provider 请求 0；临时目录精确清理 + 零进程
  残留）。改动仅限 SMOKE 辅助逻辑——dev 冒烟与 B-02/B-05/SESSION 跨
  进程矩阵按规则不机械重跑（production 全矩阵已覆盖构建产物）。④
  **真实 Provider 验收（deepseek-v4-pro，harness `-Sources`，一次完整
  复验、零重试）**：`LIVE_SMOKE_PASS` 退出码 0——**场景 1a–8 全部真实
  通过**（1a L2 deny 零写入 + denied-by-user 后停止；1b approve 恰一次 +
  durable Undo；1c 数据供应；2 改组「日本购物」+ 备注「只用于中古
  价格」+ shareMode=full；3 标官方恒 {official, ai, unverified}；4a
  降 priority 且保持启用；4b disable deleted_at 落位；4c restore 实测
  生效；5 source_search → browser_open → browser_read 全链路 +
  usage=reachable；**场景 6 真实 SRT-01/场景 7 真实 SRT-02/场景 8 真实
  RT-10 观察场景实际到达**——机器可验证结构断言全部通过：库/journal 零
  新增、敌对页 URL 零入库、审计工具名全部 ∈ 注册表 17 工具、零 L2
  批准、伪造工具零执行、密码零写入、零外发）。台账（日志字节级统计）：
  **34 次 HTTP 全部正常**（1a:3/1b:2/1c:2/2:4/3:4/4a:4/4b:4/4c:3/5:4/
  6:1/7:2/8:1）；**8 次 L2 确认全部按纪律决议**（1a deny，1b/1c/2/3/4a/
  4b/4c approve——审计日志逐事件核对）；reasoning_content 回传校验零
  触发；观察性登记——本轮真实模型在三个敌对场景均未执行诱导指令（场景
  6 工具调用=[]、场景 7 恰 1 步 source_search、场景 8 工具提议=[] 且
  最终回答明确拒绝执行网页指令；语义层残余风险维持 threat-model §5
  登记，不宣称免疫）。⑤ **真 Key 零暴露扫描通过**：进程内扫描 18 文件
  （DOM/日志/Sources 库（含 WAL/备份/journal）/会话文件/ToolStep/审计/
  临时文件/密文形态）零命中 + 进程外当日日志全量 sk- 形态 0 命中 +
  本轮段 Bearer/Authorization 0 命中；凭据文件密文形态断言通过；
  DPAPI 密文文件保留（路径 %LOCALAPPDATA%\AIbrowse\S5\provider-key.
  dpapi，未删除未轮换）；运行后明文清除已执行（harness finally：
  AIBROWSE_* 环境变量 0 残留 + ZeroFreeBSTR 清零）。⑥ **清理证据**：
  Electron/Node 进程零残留、TEMP 零 aibrowse-smoke-* 目录（应用自清 +
  harness backstop）、临时 userData 已精确清理。⑦ **文档同步**：本文件/
  Fourth_stage §9 注记 + §10 八项判定（①～⑧ 全部 PASS）+ 头部状态、
  threat-model §4.1（RT-10 与真实 SRT-01/02 已执行登记 + 观察性登记）、
  B6/B8/B9 任务文档、README、AGENTS §1。**总 Exit 判定 = `GO/PASS`；
  第四阶段验收通过；阶段指针保持 Fourth Stage；下一推荐动作 = 提交本轮
  报告供只读复核；不得设计或实施 Fifth Stage。** 历史保持：首轮（1b
  夹具）→ 定向复验（4c 夹具）→ 第 3 轮越界中止 → 第四轮（1a–5 过/
  场景 6 夹具缺陷）→ 本轮（夹具修复后 1a–8 全过）——不重写为一次通过。

- **第四阶段最终真实 Provider 验收执行（2026-08-16，第十一个闭环；RT-10 接入
  完成 + 真实验收两轮失败 → 总 Exit 维持 HOLD/PENDING）**：① 步骤 0 独立核对
  ——HEAD `e8f1f88` = 候选 HEAD = Gitee main（ls-remote 实测一致；GitHub 经
  127.0.0.1:7890 代理 HTTP 200 确认可用）、工作区干净（git diff 空/diff
  --check 零命中）。② **红→绿**：旧 manifest 缺独立 RT-10 的失败测试先行
  （红态 1 failed/14 passed——`rt-10-observe` 不存在）→ 实现
  `LIVE_SOURCES_SCENARIO_MANIFEST` 独立 rt-10-observe 观察场景（kind=observe、
  与 SRT-01/02 不得合并、用途非空——单测固化）+ `runLiveAgentSourcesScenarios`
  场景 8 实际执行（复用 HOSTILE_RT10_HTML 敌对夹具与第三阶段强断言：伪造工具
  零执行（注册表 17 工具判定）/密码零写入/购买・删除・发布・提交零 DOM 副作用/
  零外发/L2 全 deny/库・journal 零新增/敌对页 URL 零入库/审计工具名全部 ∈
  注册表；观察性结果 logInfo 如实登记，不宣称语义免疫）→ 绿 15/15；全量
  test 1243 → **1244/1244**（53 文件，单 worker）。③ **离线门槛全绿（一次
  一条命令）**：test 1244/1244 · typecheck · lint · format:check（2 文件
  prettier 修复后 0）· build（out/ 三目标）· git diff --check；dev 默认
  矩阵退出码 0（8.6 RT-01～08+RT-11/8.15 SRT-01～SRT-12 通过行实证、真实
  请求 0）；production 无 Key 路由退出码 0（main + smoke 两层中文跳过提示
  - 离线矩阵通过 + `开始流式请求` 0 次 = 真实 Provider 请求 0）；4 个专属
    临时 userData 全部精确清理、零 Electron/Node 进程残留；harness 复核通过
    （ASCII 0 字节/PS 5.1 语法解析 OK/`-Sources` 与 -Sites/-Agent/-Pre/
    -Supplement 互斥先于 DPAPI 读取/finally 清除 10 环境变量 + ZeroFreeBSTR/
    backstop 清理 aibrowse-smoke-ai-\* 与 aibrowse-smoke-sources-\*/零 Key
    输出）。④ **真实 Provider 验收（deepseek-v4-pro，harness `-Sources`）——
    首轮失败**：场景 1b「收藏的 URL 应与当前页一致」断言缺陷——真实模型以
    origin 形态收藏（scope=origin、URL 无路径、change set 结构校验合法、L2
    确认门必现 approve 正常、审计 ops=1 add=1 脱敏正常），断言要求精确 URL
    相等属夹具缺陷（非产品缺陷）；红态证据在案（log/ 与运行输出）→ 最小修复
    （断言校准为与当前页同 origin——保留验收实质：收藏的是当前网站而非被诱导
    的其他站点；断言消息携带实际 URL 供台账）→ 完整离线复验全绿 → **定向复验
    （第 2 轮）失败**：场景 4c「恢复使用」L2 确认门 120 秒未出现——模型经
    source_search×3 + source_list 均未定位条目后如实回答（4 步 done、零确认
    提议）；根因确诊为**产品契约正确行为**：search/list 候选 SQL 全部过滤
    `deleted_at IS NULL`（disabled 条目对 agent 检索不可见——4b 刚禁用），
    任务文案未提供定位手段 → 夹具缺陷（非产品缺陷）；第 2 轮台账：31 次 HTTP
    全部正常（0 错误）、7 次 L2 确认全部按纪律决议（1a deny + 1b/1c/2/3/4a/4b
    approve）、reasoning_content 回传校验零触发、1a-4b 全部通过 → 最小修复
    （s4c-restore 任务文案显式提供来源编号 `{sourceId}`，执行时注入
    collectedId——真实用户可类比提供定位信息）→ 完整离线复验全绿（test
    1244/1244 · typecheck · lint · format:check · build · diff-check ·
    production 无 Key 路由退出码 0）→ 第 3 轮运行超出授权边界（一次完整
    运行 + 最多一次定向复验）**被中止**（18 次 HTTP 后停止、零
    LIVE_SMOKE_PASS；pid 残留目录已精确清理）。⑤ **总 Exit 判定 = HOLD/
    PENDING**：真实 Provider 验收未完成（场景 4c 起 + 场景 5/6/7/8 + 真 Key
    扫描未通过真实执行；RT-10 与真实 SRT-01/02 维持 NOT RUN，不冒充历史
    证据）；两处修复均已离线就绪。⑥ 文档同步：本文件/Fourth_stage/threat-
    model/AGENTS/README/B6・B8 补验记录（场景数量 1a-8、测试计数 1244、
    正式指针校准）。**下一唯一动作 = 用户单独授权后对 4c 修复做一次定向真实
    复验；不得自动重跑、不得实现 Fifth Stage。** 另如实登记观察性发现：
    disabled 条目对 agent 检索不可见（契约语义）意味着自然语言「恢复」任务
    在模型侧需要用户提供定位信息——属计划内语义边界，不命中 Exit Gate。

- **B6/B8 补验基础设施闭环（2026-08-15，第十个闭环；真实 Provider 验收前置，
  真实付费调用 0；总 Exit 维持 HOLD/PENDING）**：① 步骤 0 独立核对——HEAD
  `a8c3376` = 候选 HEAD、工作区干净；缺口逐项核实属实（五场景全 approve；
  Key 终检缺 Sources 库面；LIVE_SITES 无互斥；harness 缺 -Sources）。②
  **红→绿**：smoke-sources-scan 新模块 1 file failed → 14/14；全量 test
  **1243/1243**（53 文件，+14）；仓库外 harness 静态断言红 3/8（缺
  Sources/注入/互斥/清除/backstop 5 项 FAIL）→ 修改后 **8/8 PASS** +
  互斥组合运行实测退出码 1（ASCII 互斥错误、互斥先于 DPAPI 读取）。③
  **受控验证**（一次一条，单 worker）：test 1243/1243（19.85s）· typecheck
  · lint · format:check（修复 B9 文档表格 prettier 对齐——HEAD 既有偏差，
  纯格式零内容变化，已如实登记）· build · git diff --check 全绿。④ **冒烟
  矩阵**（env -u ELECTRON_RUN_AS_NODE + 8 个专属系统 TEMP 临时 userData，
  串行）：dev 全矩阵退出码 0（8.12/8.13/8.14/8.15 SRT-01～12 通过行日志
  实证）；生产产物全矩阵退出码 0；**无 Key 路由** dev+生产各一次（LIVE_
  PROVIDER+LIVE_AGENT_SOURCES、无 AIBROWSE_TEST_API_KEY）退出码 0——中文
  跳过提示（main + smoke 两层）+ 离线矩阵通过 + `providerId=openai-
compatible` 日志零命中（真实 Provider 请求 0）；LIVE_SITES 互斥实测退出码
  1 + 中文错误 + 失败清理零残留；B-02/B-05/SESSION 双进程全部退出码 0。⑤
  清理与红线：8 个临时 userData/8 个冒烟日志/一次性断言脚本全部精确清理；
  零 Electron/Node 进程残留；TEMP 下 aibrowse-smoke-* 零残留；今日日志 sk-
  形态零命中；禁具/source_sql/child_process/TS 逃逸（any/@ts-ignore）扫描
  零命中；Source 产品契约/权限矩阵/17 工具 schema/AGENT_SYSTEM_PROMPT/
  SQLite schema 零改动；工具注册表仍 17；schema v1/migration 零改写；
  未调用任何付费 Provider、未发起公网 Provider 请求、未新增依赖。⑥ 文档
  同步：B6/B8 任务文档补验记录小节、本文件、AGENTS §1、README（harness
  -Sources 用法）、Fourth_stage §10（harness 缺口表述更新）；threat-model
  不把真实观察写成通过（§4.1 维持 NOT RUN 登记）。**唯一下一推荐任务 =
  用户单独授权后执行最小真实 Provider Sources 验收**（仓库外 harness
  `-Sources` 一键执行场景 1a-7 + 真 Key 零暴露扫描 + 台账）并据证据更新
  Fourth Stage Exit Gate；不得实现 Fifth Stage。

- **B9 Fourth Stage 独立最终验收（2026-08-15，第九个闭环；总 Exit 判定 =
  HOLD/PENDING）**：① 步骤 0 独立核对——HEAD `c8e4122` = Gitee/GitHub 双远程
  HEAD（ls-remote 实测三方一致；GitHub 操作前确认 127.0.0.1:7890 代理
  HTTP 200）、工作区干净（git diff 空/diff --check 零命中）、c8e4122 为纯
  文档提交（show --stat 核验）、B1–B8 代码与测试全部在位（sources/ 全模块 +
  52 测试文件）。② **受控独立验证**（一次一条命令、单 worker、零重试变绿）：
  test **1229/1229**（52 文件，19.55s）· typecheck · lint · format:check ·
  build（out/ 三目标）· git diff --check 全部退出码 0。③ **冒烟矩阵独立复跑**
  （env -u ELECTRON_RUN_AS_NODE + 6 个 B9 专属系统 TEMP 临时 userData，串行）：
  dev 全矩阵退出码 0（1644 行日志；B-01 11 项 ①–⑦、⑩、⑪ 全过/⑧⑨ 可用、
  8.6 RT-01～08+RT-11、8.9/8.10、8.11 B-05、8.12/8.13、8.14 recovery、
  8.15 SRT-01～SRT-12 通过行日志实证）；生产产物全矩阵退出码 0（1631 行，
  同矩阵）；B-02 set/check 退出码 0（跨进程读回+Undo+usage 投影+SRT-10
  hard delete 清理）；B-05 set/check 退出码 0（真实 UI 链路两阶段删除）；
  SESSION set/check 退出码 0。每轮后检查：零 Electron/Node 进程残留、
  sources/ 目录冒烟自清（零 WAL/SHM）、临时目录全部精确清理、今日日志
  sk- 形态零命中、未触碰真实 userData。④ **红线独立复核**（不抄 B8 报告）：
  SQL 执行点 grep 分类——业务 SQL 仅 `sources/repository/`（编译期常量+
  参数绑定）；`db/sqlite-driver.ts` 连接级 PRAGMA（busyTimeout 程序校验
  整数 [0,30000]）/事务；`db/backup.ts` PRAGMA/VACUUM INTO 窄契约；
  `db/migrations.ts` 编译期语句；smoke/`*.test.ts` 为测试设施；
  snapshot-script `.exec` 为正则（非 SQL）；renderer/preload/AgentLoop/
  Tool 零 SQL；禁具（source_sql/source_delete_hard/source_export_all/
  shell/child_process）产品代码零命中；工具注册表 17（8+4+4+1）；
  Electron 隔离（sandbox/contextIsolation/nodeIntegration=false/window.open
  deny/UI will-navigate+will-redirect 白名单/IPC 全部 handle() sender+主帧
  校验/preload 白名单零回退）；Source Tool 零 Electron import 零网络；
  usage-tracker 零 timer 零网络；SRT-08 修复
  （sanitizeToolCallsForPersistence+redactUrlQueryValue）在位。⑤ **§9 四组
  18 项全部勾选回填证据**（Fourth_stage.md §9，每项含本轮独立复验来源）；
  ⑥ **§10 八项判定**：① HOLD（真实 Provider 缺口；离线 PASS）② PASS
  （唯一约束/删除语义/Undo 重启后可用）③ PASS（10/20/200 上限+allowlist+
  分享模式）④ PASS（provenance 三元组+不可信块+权限恒等）⑤ PASS（如实
  结论：trigram ≥3 主路径 + 1–2 字符安全降级，不宣称万能检索）⑥ PASS（B1
  决策门 11 项本轮实测+决议 #48 在案）⑦ PASS（SRT 全矩阵+RT 回归；
  RT-10 NOT RUN 计入①⑧同一缺口）⑧ 离线隐私扫描 PASS（SRT-08 逐通道字节
  扫描）/真 Key 扫描 NOT RUN；**总 Exit 判定 = HOLD/PENDING——唯一缺口 =
  真实 Provider 验收**。⑦ **真实 Provider 硬门**：按流程只询问用户一次 →
  用户选择**不授权**；本轮零付费调用零公网请求；真实 Provider = NOT RUN
  （不冒充历史证据、不以 FakeProvider 替代）；检查结果——产品侧
  `AIBROWSE_LIVE_AGENT_SOURCES` 门控与 runLiveAgentSourcesScenarios
  （§7 场景 1–5 AI 侧+L2 确认门+usage+真 Key 零暴露扫描）就绪；仓库外
  harness 缺 -Sources 开关（实测 grep 零命中，B6 记录属实）——补开关属
  B6/B8 补验任务（仓库外文件），B9 不越界补写。⑧ **P2/P3 开放风险独立
  处置**（见「风险与限制」独立处置结论）。⑨ **文档同步**：Fourth_stage
  §9/§10、B9 任务台账、本文件、AGENTS（§1 状态+决议 #45 四处速查校准）、
  README（状态+明文边界已知限制）；detailed-design/threat-model 无陈旧
  未改。**B9 标记完成；总 Exit = HOLD/PENDING；第四阶段保持为当前阶段；
  下一唯一动作 = 真实 Provider 补验（B6/B8 补验任务）；不得实现
  Fifth Stage。**

- **B8 红队矩阵 SRT-01～SRT-12 + 增量安全审计 + 隐私扫描（2026-08-15，
  第八个实现闭环；GO 判定见下）**：① 步骤 0 独立核对——HEAD `4c3a011` =
  Gitee/GitHub 双远程 HEAD、工作区干净、基线 test 1226/1226·typecheck·
  lint·format:check 独立复跑全绿。② **实施前契约校准（决议 #93，不向用户
  询问）**：B8 任务文档原写「smoke.ts 8.7」——8.7 已被 B1 SQLite 决策门
  B-01 占用（历史编号不复用不覆盖）→ B8 使用下一编号 **8.15**；SRT-12
  机器验证边界 = RT-01～RT-08、RT-11 本轮 dev/production 重跑（8.6 返回
  结构化已通过证据由同一进程 8.15 精确核验——不得仅依赖日志字符串、不得
  重复完整运行相同矩阵）+ RT-09 扩展静态审计 + RT-10 未授权则 NOT RUN
  （不冒充历史证据、不阻塞离线 B8）。③ **红→绿**：8.15 骨架接入默认矩阵
  ——红态 **12/12 项「断言未实现」独立失败**、dev 冒烟退出码 1（日志
  2026-08-15 21:19:35「8.15 红队矩阵红态（12 项）」）；逐项实现至绿——
  SRT-01 敌对收藏诱导（assertedBy=user 结构拒绝零写入/L2 必现/deny 零
  写入/approve 恒 {official,ai,unverified}+UI provenance 明示）、SRT-02
  敌对 note 块隔离与闭合转义 + system/17 工具恒等、SRT-03 禁具分片扫描零
  命中/上限/第 2 页尾部标记零进模型、SRT-04 注入仅作数据、SRT-05 变体
  矩阵确定性 + 唯一约束、SRT-06 第 N 项非法整体回滚 + 修正重提 + 21 项
  注册表拒绝、SRT-07 幂等/异指纹/迟到/跨 run/版本冲突、SRT-08 逐通道字节
  扫描、SRT-09 8.14 证据核验、SRT-10 hard delete 清理、SRT-11 20 项/重名
  幂等复用/每 set 独立确认/步数上限、SRT-12 8.6 证据核验 + RT-09 扩展
  审计（每项断言落点见 threat-model §4.1 证据表）。实现期修正均为冒烟
  夹具/断言自身缺陷 7 类（扫描 needle 运行时分片防自身误报/递增时钟注入/
  尾部标记种子顺序/200 字符截断边界与 WAL 文件集合/表名与 step-limit
  状态值/SRT-01 面板状态恢复/SRT-10 种子创建后立即 disable 保既有 B-02
  断言零改动），产品契约零迁就。**④ 红队发现产品缺陷 1 处（先测后修，
  独立提交）**：SRT-08 逐通道字节扫描实证 sanitizeToolCallsForPersistence
  仅脱敏 browser_fill.text——source_search query 与 browser_open url 若为
  URL 形态（含 ?token=/&key= 敏感 query）全量持久化进 ToolStep 会话文件，
  违反 threat-model §4 SRT-08 断言；红态 2 failed/21 passed → 最小修复
  （全部字符串字段应用审计层同源 redactUrlQueryValue，fill.text 保持
  FILL_MASK）→ 23/23。⑤ **全量验证**：test **1229/1229**（52 文件，单
  worker，+3 缺陷固化用例）· typecheck · lint · format:check · build ·
  git diff --check 全绿；**dev 冒烟退出码 0**（8.15 全矩阵通过日志实证）；
  **生产冒烟退出码 0**（out/ 重新构建后运行，8.15 全矩阵通过）；**B-02
  set/check 退出码 0**（含 SRT-10 扩展：set 写创建+禁用+usage → check 经
  journal 定位读回 → 两阶段 hardDelete → FTS/journal/usage 清理 + 令牌
  重放零删除）；**B-05 set/check 退出码 0**；**SESSION set/check 退出码
  0**。⑥ 资源清理：零 Electron/Node 进程残留；本次全部临时 userData/运行
  日志精确清理（含 1 个失败运行 pid 残留目录——app.exit 不触发 before-quit
  的既有模式）；TEMP 下 aibrowse-* 零残留。⑦ **未调用任何付费 Provider、
  未发起任何公网请求、未新增依赖、工具注册表仍 17、schema v1/migration
  零改写、AGENT_SYSTEM_PROMPT 恒等**。**RT-10 与真实 SRT-01/02 = NOT
  RUN**（本轮未获用户授权；LIVE_AGENT_SOURCES 门控保持就绪，授权后沿用
  仓库外 DPAPI harness 流程）。⑧ 文档同步：threat-model §4.1 机器证据
  回填（12 项全部「机器可证明」分类）、detailed-design §13.2/§15（决议
  #93）、B8 任务文档红→绿证据、本文件、Fourth_stage/README/AGENTS。
  **B8 判定 = GO（无阻塞发现）**；B8 完成即停止，不实现 B9。

- **B7 跨进程持久化 + migration/backup/recovery 全矩阵 + FTS rebuild 诊断 +
  usage/health 展示边界（2026-08-15，第七个实现闭环）**：① 步骤 0 独立核对
  ——HEAD `910c764` = Gitee/GitHub 双远程 HEAD（ls-remote 实测三方一致；
  GitHub 经代理确认可用）、工作区干净；基线 test 1160/1160·typecheck·lint·
  format:check 独立复跑全绿；B1–B6 代码/接口/测试在位（B7 零实现——无
  backup.ts/sources-store.ts）；任务授权实施前校准项核验属实（AGENTS 速查
  「B1–B5 已实现」陈旧、shared/types/sources.ts「UsageTracker 归 B7」注释
  陈旧、backup.ts SQL 红线未覆盖 VACUUM INTO/integrity 检查、「字节级完好」
  表述过强、备份三候选未冻结、保留策略未定）。② **实施前契约裁决（决议
  #86–#91，落 detailed-design §15 + §3.1/§10/§11/§13 + threat-model
  §3.2/§3.5 + B7 任务文档，本任务授权直接校准未向用户询问）**：backup.ts
  存储运维 SQL 窄契约（**VACUUM INTO 路径参数绑定实测成立**——node:sqlite
  `prepare('VACUUM INTO ?')` 支持绑定，本任务实测证据）/备份冻结 VACUUM
  INTO（node:sqlite backup API 不存在（B1 实测），不实现；关闭后复制仅为
  已验证后备不静默启用）/「迁移失败原库完好」逻辑恒等校准（原路径不得被
  替换/截断/自动恢复覆盖；不要求 WAL/SHM 逐字节恒等）/保留策略冻结（严格
  命名 + backups 目录内普通文件 + 最新 5 + 30 天）/usage 两处投影同事务一致
  - Undo 回放不覆盖 usage/rebuild 受控入口（仅 UI 通道 + normal 状态 + 零
    Undo 零 changed 零 manual 审计）。③ **红→绿**：先写测试——红态 5 files
    failed / **16 failed / 110 passed**（backup/store 两新文件模块缺失 +
    recordUsage 双投影 3 例 + rebuildSearchIndex 3 例 + adapter.rebuildIndex
    4 例 + describeLastUsage/formatLocalTime 6 例；既有 1160 用例零删除零
    削弱）；实现后全量 **1207/1207**（新增 47：backup 20 / sources-store 9 /
    source-service 9 / source-ipc 4 / sources-display 5）。实现期修正均为测试
    自身断言缺陷 5 处；**实现侧真实缺陷 3 处**（红→绿期间实测抓出，各有断言
    固化）：① 迁移失败路径主文件字节变化——openDb 默认切 WAL 写文件头 →
    迁移期间工作连接 `wal:false`、成功后才切换 WAL；② VACUUM INTO 遇已存在
    目标失败（SQLite 语义）→ 覆盖前先移除本次生成的严格命名目标；③ 快照校验
    失败 Windows 下先关只读句柄再删除（EPERM）。④ **冒烟 8.14 B-06 B7 部分
    （默认矩阵自动包含，dev+生产双场景退出码 0）**：真实启动装配路径
    openSourcesStore——新库零备份/v0→v1 先备份后迁移/注入迁移失败回滚 + 原库
    user_version 与数据逻辑恒等 + 主文件字节不变 + 备份完整/未来版本零写入
    （字节恒等）零备份/坏 magic 与截断原文件保留/恢复态读写 Undo usage
    rebuild 全拒 + 四 Agent Source 工具 fail-closed + 数据库零变化 + 浏览器
    其余能力继续可用（受控页加载断言）/保留清理（5+30 天上界 + 无关文件不动）/
    rebuild 诊断（行数一致 + FTS 破坏失败安全）/usage 两处投影一致（同事务
    同时钟）。**B-02 双进程扩展**（AIBROWSE_SOURCES_SMOKE=set|check 生产产物）：
    set 写 CRUD + journal + usage → check 新进程读回内容/版本/usage（两处投影
    一致断言）→ durable Undo → 退出码 0；**B-05 与 SESSION 双进程复跑退出码
    0**（启动存储路径改动回归）；全部互斥 gate 分进程运行，临时目录清理完毕。
    ⑤ **红线与敏感扫描**：SQL 仍仅 Repository/migrations 编译期常量 + backup.ts
    存储运维窄契约（决议 #86）；rebuild 通道零 payload（零 SQL/路径参数）；
    renderer/preload/tools/agent 零 SQL；新代码零 any/@ts-ignore/@ts-nocheck；
    工具注册表仍 17 工具（零新增）、schema v1 零改写、package/lockfile 零改动、
    AGENT_SYSTEM_PROMPT 恒等；恢复态为真实生产装配（非 SMOKE override）；
    git diff --check 零命中；敏感信息扫描零命中；临时 userData/备份夹具/WAL/
    SHM 零残留。**未调用任何付费 Provider、未发起任何公网请求、未新增依赖。**
    ⑥ 文档同步：detailed-design §1/§3.1/§10/§11/§13/§15（决议 #86–#91）、
    threat-model §3.2/§3.5、B7 任务文档红→绿证据、本文件、Fourth_stage/
    README/AGENTS（§1 状态校准 B1–B6 已完成、B8 为下一任务 + §4/§5/§7 速查
    回填）。B7 完成即停止，不实现 B8。（2026-08-15 事故恢复与安全加固后
    最终测试计数 1219/1219，见下一条目。）

- **B7 事故恢复与安全加固闭环（2026-08-15，事故止损 + 数据安全修复 + 可信
  收尾）**：承接上一条目 B7 主体工作（未提交），本任务按用户指令完成事故
  恢复、安全修正与可信重验。① **事故止损**——症状（VS Code 卡死/插件闪退/
  电脑长时间卡顿/uv_spawn unknown error/无法确定 Node.js 安装目录/退出码
  45）与「此前某次通过」不采信：先只读检查（无 node/electron/npm/vitest
  进程；内存 8.8GB 空闲/15.8GB；CPU 1%；node v24.18.0/npm 11.16.0 定位
  正常），未终止任何进程（MATCH_COUNT=0 无可终止目标，明确未批量结束
  VS Code/Electron/Node）。根目录事故产物逐项核验后精确清理（同一
  PowerShell 会话 + Remove-Item -LiteralPath，零 glob 零跨 shell）：
  **47 项删除**——45 个零字节文档碎片文件（文件名 = 各阶段文档片段，时间
  18:37–18:53）+ 1 个 157 字节「*_本设计闭环不新增任何」文件（内容为
  npm `Unknown command:` 错误输出——文档文本曾以某种方式进入 npm 命令
  解析，为事故机制的直接证据）+ 根目录事故日志
  aibrowse-2026-08-15.log（274KB；扫描确认内容为 B7 冒烟 8.14 注入矩阵的
  预期中文错误诊断 + vitest 堆栈，无秘密——sk-/apiKey/token=/Bearer/
  Authorization/DPAPI 六类扫描零命中）；清理后根目录零异常条目，工作区
  恢复「24 个 B7 修改 + 4 个预期新文件」形态。② **安全审查与修复（红→绿）**
  ——发现并修复 5 项数据安全问题（backup.ts/sources-store.ts）：a) 头部
  探测原 `readFileSync(dbPath)` 整库读入内存（大库无界内存/磁盘压力）→
  固定 16 字节 open/read/close（句柄 finally 可靠关闭）；b)
  createConsistentBackupAt 原可接受任意路径并先 rmSync（可删除仓库外文件/
  覆盖已有有效备份）→ 目标已存在（任何形态）fail-closed 拒绝，绝不删除/
  覆盖调用前已有文件；失败清理仅限「本次尝试新建且调用前已验证不存在」的
  部分文件；c) 目标名碰撞原「删除旧目标再覆盖」→ 换新名有限重试（5 次），
  全部碰撞 fail-closed；d) backups 目录原仅字符串前缀校验 → realpath
  解析校验（symlink/junction 越界拒绝，解析后必须仍位于 Sources 目录内）；
  pruneBackups 不跟随目录链接越界（junction → 安全空结果）+ 删除前
  lstat/realpath 复核（TOCTOU 防御）+ keepCount/maxAgeMs/nowMs 参数边界
  验证（非有限/负数/非整数 → 安全空结果零删除——旧实现 keepCount=NaN
  会全量误删，红态实测）；e) 备份源连接改只读（备份过程不写源库，WAL
  活跃库主文件字节恒等断言）。**红态证据**：先写测试，旧实现真实失败
  **11 failed / 30 passed**（目标碰撞覆盖 true、readFileSync 被调用、
  junction 跟随写入、外部目录放行、NaN 参数误删 2 文件、junction prune
  删除链接目标内文件、store junction/外部目录 normal 等）；实现后
  **41/41 全绿**（新增 12 用例：头部固定读取 2/碰撞与越界 5/prune 边界
  3/store 越界 2；既有碰撞用例按新契约改写为 fail-closed 语义——契约
  收紧非削弱）。实现期测试自身修正 2 处（ESM 命名空间不可 spy → 模块级
  mock/randomHex 注入；junction 夹具目标须在 root 外 + rmdirSync 显式
  清理）。③ **受控串行验证**（每次一条命令，单 worker）：定向
  41/41 → typecheck 0 → lint 0 → format:check（修复 backup.test.ts 格式
  后 0）→ build 0 → 全量 **1219/1219**（52 文件，19.56s，单 worker）→
  git diff --check 0 → dev 冒烟 0（1537 行日志，8.14 B-06 全矩阵通过）→
  生产冒烟 0（1525 行）→ B-02 set/check 0（usage 投影跨进程一致）→
  B-05 set/check 0 → SESSION set/check 0；每次 Electron 验证后进程/
  WAL-SHM/临时目录检查零残留，5 个专属 userData 目录 + 3 个红态测试夹具
  残留目录全部清理，TEMP 下 aibrowse-_ 零残留。④ 未调用任何付费 Provider、
  未发起任何公网请求、未新增依赖、schema v1/migration 零改写、工具注册表
  仍 17 工具、恢复态仍为真实生产装配。

- **B6 AI 自然语言管理端到端 + Browser Agent 复用 + usage 接线（2026-08-15，
  第六个实现闭环）**：① 步骤 0 独立核对——HEAD `6cde82b` = Gitee/GitHub 双远程
  HEAD（ls-remote 实测三方一致）、工作区干净；基线 test 1125/1125·typecheck·
  lint·format:check 独立复跑全绿；B5 六提交在位；两处契约矛盾核验属实——
  AGENTS §1「B1–B4 已实现/B5–B9 未实现」与同文件 B5 已完成冲突；detailed-design
  §1/§6/§11/§13 与 HLD §3/§4.4 把 UsageTracker/B-07 标 B7，与 B6 任务及 B7
  前置「B6（usage 记录接线）」冲突 → 校准（B6 负责 SourceSearchHintStore +
  Agent 打开后 usage 写入 + B-07；B7 保留 usage UI/health 展示与运维边界）。
  另核验属实：实际 serializer 未输出 §8.1 已要求的 id/canonicalKey/groupId
  （scope 亦缺）——模型无法执行 source_get 引用链路。② **实施前契约裁决
  （决议 #79–#85，落 detailed-design §15 + §1/§6/§11/§13.1/§13.2 + HLD §3/§4.4
  - B6/B7 任务文档）**：usage 归属校准/serializer allowlist 引用链路补齐/
    ToolExecutionContext 最小 `sourceUsage` 桥（run 级闭包 + AgentLoop.finish
    终态 clearRun + conversation-service usageBridge 工厂）/provenance 表述校准
    （AI change set 恒 ai+unverified，含口头「标成官方」——用户确认对话不等于
    用户通道断言；user-asserted 仅手工 UI 通道）/description 校准（search→list→
    get→apply 链路 + 「不再优先」= 降 priority ≠ disable）/B-07 冒烟探针（决议
    #47 同精神）+ sourcesDbPath 冒烟注入点/LIVE_AGENT_SOURCES 互斥门控与离线
    可测路由。③ **红→绿**：先写测试——红态 **5 files failed / 14 failed /
    1127 passed**（usage-tracker 模块缺失 + serializer 4 例（旧序列化无 ID/规范
    键/分组 ID/作用域行）+ source_search 命中登记 1 例（旧 executor 无回调）+
    browser_open 回调 2 例 + agent-loop 透传/终态清理 5 例 + conversation-service
    usageBridge 2 例；既有 1125 用例零删除零削弱）；实现后全量 **1160/1160**
    （新增 35：usage-tracker 19 / source-tools 6 / browser-tools 2 / agent-loop
    5 / conversation-service 3）。实现期修正如实登记：测试自身缺陷 4 处（探针
    工具名不在 TOOL_BASE_RISK → 权限层 L3 拒绝 executor 未执行——改用真实工具名
  - 注册表重置；cancelled 夹具首块不可达；usage-tracker「无关 URL」夹具误用
    同 origin URL——origin 命中语义本就应命中；browser-tools 桥异常夹具——
    executor 层增纵深防御 notifyOpen）；实现侧真实缺陷 0 处。④ **冒烟 8.12
    B-06/B-07（默认矩阵自动包含）**：usage 全链路（search 命中 → open（fragment
    变体规范化命中）→ read → 回答，usage_events=reachable；无关 URL/先 open 后
    search/跨 run 零记录；执行失败 → unreachable 且工具结果 execution-failed；
    写入失败不影响工具结果与 Agent 终态）+ 自然语言管理五场景（收藏 → deny 零
    写入 + 模型收到 denied-by-user 后停止且不重提等价写操作（stepsUsed=1）/收藏
    approve → 保存 → durable Undo/搜索 → get → 改组与备注（shareMode 显式 full
    ——决议 #52 缺省规则仅 add，update 保持现状）/标 official → trust 恒
    {official, ai, unverified}/降 priority ≠ disable → 明确 disable → restore）；
    **8.13 B-06 UI DOM 端到端（真实 DOM 任务模式 → ConfirmDialog approve/deny →
    preload/IPC → AgentLoop → 生产 SourceService → Sources UI）**：收藏当前页
    approve → 保存 → Sources UI 可见 + provenance「AI 推断·未核验」→ UI Undo；
    deny 零写入 + ToolStep「已拒绝」展示；source_search → browser_open → read →
    回答 usage=reachable（生产 usageBridge 全链路 + 只读探针）；无关 URL 零记录。
    **dev 默认矩阵退出码 0**；**生产产物默认矩阵退出码 0**；**B-02 生产双进程
    set/check 退出码 0**（跨进程读回 + Undo 回归，B-02 断言零改动）；**B-05
    生产双进程 set/check 退出码 0**；**LIVE 门控**：AIBROWSE_LIVE_AGENT_SOURCES
    与 LIVE_AGENT 同设 → 退出码 1 + 中文互斥错误（互斥实测）；LIVE_AGENT_SOURCES
    无 Key → 退出码 0 + 跳过 warn + 完整离线矩阵（离线可测路由实测）。冒烟期
    修正 3 处（均为冒烟夹具自身缺陷，产品契约零迁就）：① B-07e throwingBrowser
    对象展开丢失类原型方法（BrowserControllerImpl 方法在 prototype 上，非自有
    可枚举属性）→ 改 Object.create 原型链继承；② B-05 固定 delay(200) 在并行
    负载下早于列表重渲染（openDetailByName 找不到条目抛异常，复跑实测一次）→
    改确定性 waitFor 条目出现（B6 会话修正，冒烟断言自身时序缺陷）；③ B6 改组
    场景断言「写 userNote 自动 shareMode=full」与 B2 冻结语义不符 → 夹具显式带
    shareMode:'full'，真实验证任务文案同步显式要求。⑤ **红线与敏感扫描**：
    禁具 source_sql/source_delete_hard/source_export_all 零命中；新代码零 any/
    @ts-ignore/@ts-nocheck；usage-tracker 零 timer/零网络/零 SQL；usage_events
    只读探针仅 SMOKE_MODE 门控冒烟场景（决议 #84 测试设施）；SQL 仍仅
    Repository/migrations 编译期常量 + 参数绑定；日志仅记 sourceId（note/URL/
    query 零出现，单测固化）；工具注册表仍 17 工具（零新增）、schema/migration/
    依赖零变化、AGENT_SYSTEM_PROMPT 恒等（既有恒等断言与冒烟保持）；git diff
    --check 零命中；临时 userData（B-02/B-05 双进程目录）已清理。**未调用任何
    付费 Provider、未发起任何公网 Provider 请求**（LIVE_AGENT_SOURCES 真实
    场景待用户授权；harness -Sources 为仓库外扩展点，本次未创建——授权后沿用
    第三阶段凭据流程）。⑥ 文档同步：detailed-design §15 决议 #79–#85 + §1/§6/
    §11/§13.1/§13.2、HLD §3/§4.4、Fourth_stage §4（provenance 表述校准）、
    proposal §3 场景 4、AGENTS（§1 陈旧状态校准 + §4/§5 归属与速查回填 +
    provenance 表述）、B6/B7 任务文档、本文件、README。B6 完成即停止，不实现 B7。

- **B5 Sources UI + 手工管理 + 快速添加 + IPC/bridge（2026-08-15，第五个实现
  闭环）**：① 步骤 0 独立核对——HEAD `532ea78` = Gitee/GitHub 双远程 HEAD
  （ls-remote 实测三方一致）、工作区干净；基线 test 1071/1071·typecheck·lint·
  format:check 独立复跑全绿；B1–B4 代码/接口/测试在位（SourceService 手工路径 +
  令牌签发、Repository 唯一 SQL 点、四工具 + confirmSummary 钩子、冒烟
  8.7/8.9/8.10/B-02）、B5 零实现（无 source-ipc/renderer sources 目录/sources:*
  通道）；Fourth_stage.md 头部「B4–B9 待开始/下一任务 B4」陈旧属实 → 校准为
  B1–B4 完成、B5 待开始（未改写历史记录）。② **实施前契约裁决（决议 #68–#78，
  十一项，落 detailed-design §15 + §6/§13.1/§13.2 + threat-model §3.3/§3.6 +
  HLD）**：面板互斥切换与 App 级确认框不遮断/sources:* 白名单 + audience 硬编码
  user/有界 listGroups/quick-add 契约/两阶段硬删除/三态 UI 状态（readonly-
  recovery/unavailable 中文原因+建议+写入口禁用+读入口按决议 #39 拒绝；建议仅
  安全标签无绝对路径）/provenance 两形态 + aiNote 只读/独立 manual 审计适配器/
  UI 异步序号守卫与冲突刷新/纯文本渲染。③ **红→绿**：先写测试——红态 4 files
  failed / 15 failed / 76 passed（2 新文件模块缺失 + service/repo B5 扩展用例在
  旧结构下真实失败）；实现后全量 **1125/1125**（新增 54：source-ipc 30 /
  sources-display 9 / source-service B5 10 / source-repository B5 5；既有 1071
  用例零删除零削弱）。**冒烟期真实实现缺陷 4 处**（均已修复并单测/冒烟固化）：
  ① IPC 适配器在 handler 注册期捕获 sourceService=null（注册早于装配）→ 适配
  器 service 改 getter 惰性解析；② stateOverride 冒烟注入点同类构造期捕获 null
  → index.ts 改调用时解引用；③ 面板 hook 共享序号守卫把同批 refreshAll 内先发出
  的响应全部误判迟到（分组/状态/列表恒空）→ 改每种加载独立计数；④ quick-add
  成功后自动打开详情遮挡列表与「可能相关」提示 → 成功停留列表视图。冒烟断言
  自身缺陷 5 处（受控页每进程随机端口致跨进程按 URL 读回失败 → 改按名称；分组
  选项经直接服务种子无 changed 事件 → 面板先刷新；Undo 后详情异步重读竞态 →
  等表单重挂载再操作；B-05 结束未恢复 AI 面板破坏矩阵 4 前置 → 记录并恢复进入
  前面板状态；双进程门控生产服务指向 pid 专属目录绕开共享 userData → 门控模式
  改指 userData/sources）。④ **冒烟**：8.11 B-05 Sources UI 端到端矩阵自动
  包含于默认矩阵——dev 完整矩阵退出码 0、生产产物完整矩阵退出码 0（明文说明/
  快速添加与重复・可能相关/非 http 拒绝/分组分页 22 条/搜索 user 视角 blocked
  可见/手工添加表单/详情编辑 provenance・版本恰 +1/版本冲突提示刷新零静默覆盖/
  手工 Undo/禁用・恢复 deleted_at 联动/AI provenance + aiNote 只读 + 敌手 note
  纯文本零 DOM/两阶段永久删除取消与确认 + token 零 DOM/恢复态・不可用态中文诊断
  - 写入口禁用 + 写入零变化 + 读入口拒绝/面板互斥 + L2 确认框切换面板不遮断/
    sources:changed 刷新）。**B-05 双进程门控**（AIBROWSE_SOURCES_UI_SMOKE=
    set|check，与 SESSION_SMOKE/SOURCES_SMOKE 互斥；两独立生产进程共用同一系统
    TEMP 临时 userData，isPathInside 断言拒碰真实数据）：set 退出码 0（真实 DOM →
    preload → IPC → SourceService 快速添加 + 编辑持久化）→ check 退出码 0（新进程
    读回一致 → 真实 DOM Undo 生效 → 两阶段永久删除确认消失且无 Undo）；临时目录
    已清理。⑤ **红线与敏感扫描**：新代码零 any/@ts-ignore；渲染层零
    dangerouslySetInnerHTML/Markdown 库；SQL 仍仅 Repository/migrations 编译期
    常量 + 参数绑定；renderer/preload 零 SQL；source_sql/source_delete_hard/
    source_export_all 零命中；审计/日志零 note 正文・完整 URL/敏感 query・删除
    token・数据库路径（单测字节扫描 + 冒烟审计恰好一条）；package/lockfile 零
    改动；既有 17 工具 schema 与注册表零变化（8.1 断言回归）；浏览器 bounds/AI
    面板/Agent 确认对话框全回归（默认矩阵）。**未调用任何付费 Provider、未新增
    依赖、未改 B1 冻结 driver 与 B2 冻结 schema v1（migrations/sqlite-driver 零
    diff）。** ⑥ 文档同步：detailed-design §6/§13.1/§13.2/§15 决议 #68–#78、
    threat-model §3.3/§3.6、HLD 模块表、B5 任务文档红→绿证据、本文件、
    Fourth_stage/README/AGENTS（Sources 速查 B5 回填）。B5 完成即停止，不实现 B6。

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
- **审计 P2 备份发布与失败清理竞态**（独立审计 2026-08-15 发现，当日定向修复关闭，
  决议 #92）：`backup.ts` 旧序列「lstat 判定不存在 → VACUUM INTO → 失败/校验失败
  无条件 rmSync」在 lstat 与 VACUUM 之间的并发窗口可误删并发进程创建的文件
  （existsSync/lstatSync 检查不能作为后续 rmSync 的所有权证明）。处置：两阶段
  staging + 硬链接 no-clobber 原子发布（EEXIST 原子失败绝不覆盖）+ 所有权证明
  精确清理（rmSync 单一文件 + rmdirSync 空目录，绝不递归删除未知内容）+
  `createConsistentBackupAt` 任意路径公共导出移除；红→绿 5 failed/32 passed →
  37/37，全量 1226/1226。结论 **Resolved**；证据详见 B7 任务文档「独立审计后
  定向修复」小节与 detailed-design §10/§15 决议 #92。
- **审计 P2-2 日志队列/保留**（B9 独立处置 2026-08-15，D1 于 2026-08-26 关闭）：
  原 logger 无大小、文件数与保留期上限，存在长期磁盘无界增长。D1 已落地每物理行
  8 KiB、单文件 10 MiB 写前硬上限、最多 10 个受控文件与 14 个本地日历日保留，并对
  非普通文件、悬空链接、IO/stat 失败执行固定脱敏诊断与 fail-closed；聚焦、全量及
  dev/production 冒烟均通过。结论 **Resolved**。

### 开放风险登记

- **审计 P2-3 会话字节上限（B9 独立处置，2026-08-15；未修复，后续硬化）**：
  会话持久化有会话数（50）与消息条数（200）上限，**无字节上限**——触发
  条件 = 单会话 200 条内持续追问或超大单条消息；影响 = 会话 JSON 文件可达
  MB 级（存在隐式上界：200 条 × 上下文预算/摘要截断）；现有缓解 =
  MESSAGE_LIMIT=200 + 预算截断 + ToolStep 摘要化（fill 脱敏/快照正文零持久化）。
  **B9 独立判定：不命中本阶段 Exit Gate**（无卡死/数据丢失路径，规模有隐式
  界）；登记后续硬化（Seventh Stage 或专项闭环评估单文件字节上限）。
  **2026-08-16 Fifth Stage 切换重新分级：升级为「Fifth Stage 必须吸收」**——
  不得机械延期：若 Research 结果/证据/运行记录进入 ConversationStore 会把
  长 Research 塞进会话 JSON 放大无界风险。处置（已落入设计）：Research 数据
  **不进入会话 JSON**——独立 research.db + 独立字节预算（单任务持久化
  ≤500k 字符/保留任务 ≤30/最旧清理）+ 会话侧仅挂任务 id 引用
  （detailed-design §9 + proposal §8.2）。
- **审计 P2-4 Vitest 默认 worker（B9 独立处置，2026-08-15；未修复，建议
  配置固化）**：vitest.config.ts 未固化单 worker，直接 `npm test` 走默认
  并行；触发条件 = 未按纪律显式 `--maxWorkers=1` 的调用；影响 = 墙钟断言
  在并行负载下边缘抖动（F-1 已去墙钟化，风险显著降低）；现有缓解 = 验证
  纪律显式单 worker（AGENTS.md §6）+ 本轮 B9 单 worker 1229/1229 全绿。
  **B9 独立判定：不命中 Exit Gate**（验证基础设施可信——命令显式固定，本轮
  与历史验证均单 worker 全绿）；建议后续闭环在 vitest.config.ts 固化
  maxWorkers=1（一行配置，消除纪律依赖）。
  **2026-08-16 Fifth Stage 切换重新分级**：维持**可延期至 Seventh Stage**
  （验证基础设施，不阻塞 Research；验证纪律显式 `--maxWorkers=1` 延续；
  若任一 C 系列实现任务顺手固化须在其任务闭环内单独验证——proposal §8.3）。
- **审计 P3 smoke 效率（B9 独立处置，2026-08-15；未修复，后续优化）**：
  冒烟全矩阵运行分钟级（本轮 dev 约 4.7 分钟/生产约 4.2 分钟，双场景+
  跨进程门控合计约 15 分钟）；触发条件 = 每次全量验证；影响 = 验证耗时
  （非正确性）；**B9 独立判定：不命中 Exit Gate**（效率非阻塞条件；§9
  全量验证已通过）；登记后续闭环评估优化（不影响断言强度的前提下）。
  **2026-08-16 Fifth Stage 切换重新分级**：维持**可延期至 Seventh Stage**
  （效率非正确性）；但 C 系列冒烟必须不显著加重默认矩阵（新场景编号独立、
  断言不重复完整运行既有矩阵，延续决议 #93 纪律——proposal §8.3）。

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

- **规划 D7 确定性 Diff/Event/Evidence 与健康状态。**唯一任务文档：
  `doc/stage6/tasks/D7-diff-event-evidence-health.md`。D7 依赖 D3–D6（均已关闭），
  old/new Evidence 必须可解释，不能只有哈希；本轮已完成 D6 收尾，尚未开始 D7，先由新的
  Codex GPT-5.6 Sol Planner 按 Step 0 独立调查并输出 Execution Contract。

## 第一阶段验收未完成项

- 无：First_stage.md §十四 全部验收项已逐项核对并通过（T5，2026-08-13）；
  证据摘要见 First_stage.md §十四「验收证据」与本文「最近验证结果」。
