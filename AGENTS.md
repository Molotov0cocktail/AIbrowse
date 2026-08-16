# AGENTS.md — AIbrowse 项目专属开发手册

> 依据 `.agents/skills/project-rules/PROJECT_RULES.md` §8 于 2026-08-13 初始化；
> 与根目录 `Fifth_stage.md`（当前阶段需求/验收标准）、`ROADMAP.md` + `First_stage.md` /
> `Second_stage.md` / `Third_stage.md` / `Fourth_stage.md`（已完成）、
> `Sixth_stage.md`～`Seventh_stage.md`（后续阶段需求与验收标准）配套；技术基线已于
> 2026-08-13 按官方来源验证冻结（§1）。
> 新会话接管顺序：本文件 → 当前阶段文件（现为 `Fifth_stage.md`）+ `doc/stage5/`
> （proposal / high-level-design / detailed-design / threat-model / tasks/C1–C10）
> → `doc/tasks/progress.md` → git 状态与代码核对（§2 步骤 0）。
> 与本文件冲突时以本文件为准，通用规则基线见 `.agents/skills/project-rules/PROJECT_RULES.md`。
> 任务进度不记在本文件：唯一进度源 `doc/tasks/progress.md`（本文件仅在有长期变化时更新，见 §2）。

## 1. 项目概览

- **一句话定位**：Windows 桌面「AI 信息浏览器 / AI Information Browser」——内置 Chromium 的
  多标签页浏览器，用户与 AI 共享同一浏览器会话与登录状态；AI 仅通过受限
  BrowserController / Tool Layer 操作浏览器，不得拥有任意系统权限。
- **当前阶段（第五阶段，多源 Research、证据链与结构化展示）**：把 Browser Agent +
  Sources 组合成可靠的多源信息研究系统，并以可验证、可交互的形式展示结果。
  *_阶段状态（2026-08-16）：Fifth Stage 已正式进入（用户切换指令）；设计闭环
  已完成——`doc/stage5/` 定稿（proposal（决策表 D1–D13 + Entry Gate 证据表）/
  high-level-design / detailed-design（唯一契约源 §2–§16，决议以 §15 当前
  记录为准）/ threat-model（FT-01～FT-17 / FRT-01～FRT-12，先于任何 Research
  实现定稿）/ 任务 C1–C10）；**第五阶段已进入实施阶段——具体完成项、当前
  HEAD 与下一唯一任务以 `doc/tasks/progress.md` 为准；已实现能力不再标为
  「全部待实现」。**本阶段内禁止实现 Sixth Stage 代码、禁止安装依赖。**
  **真实 Provider 已于 2026-08-16 获用户长期授权**（决议 #117）——后续
  任务按需使用、无需逐次申请授权、不设固定调用次数；每次调用仍须服务于
  明确开发/验收/定位/复验目的，凭据只走仓库外 DPAPI/harness 受控流程，
  凭据不可用如实记录「凭据不可用」。架构纪律（第五阶段）：依赖方向固定
  `Research UI → ResearchService → ResearchRuntime → SourceSelector /
ResearchWorkspace / EvidenceValidator / ResultValidator → SourceService /
BrowserController / SearchProvider / LLMProvider → ResearchRepository
（独立 research.db）`；Renderer 只消费已验证 Result Schema（不接触
  BrowserController/SQLite/Electron/Provider）；Research 不经 ToolRegistry
  新增工具（注册表保持 17；模型轮工具为六工具编译期子集，决议 #96）；
  AgentLoop 12 步/420s 契约零改动（独立有界 ResearchRuntime，决策 D2）；
  模型只提引用与结论，Evidence/Result 由确定性程序验证；capture 正文/模型
  思维/完整 transcript 零落盘；全部确定性预算为编译期常量（详细设计 §6.8）；
  Markdown 渲染自实现安全子集零新依赖（决策 D9：raw HTML 关闭、URL 仅
  http/https、纯文本兜底）；CSV 导出仅主进程 dialog 安全通道 + 公式注入
  防护；Research 库 v1 本地明文如实说明。
- **已完成（第四阶段，Sources 长期信源系统）**：把传统浏览器「收藏夹」升级为
  可被 AI 理解、检索、自动维护的长期信息源系统。*_阶段状态（2026-08-15）：
  Fourth Stage 已正式进入（用户切换指令）；详细设计与 B1–B9 任务拆分已完成；
  B1 已完成——node:sqlite 决策门 dev+生产双场景 11 项逐项实测，基础能力项
  ①–⑦、⑩、⑪ 全部通过、⑧ FTS5/⑨ trigram 实测可用，驱动冻结 = node:sqlite
  （决议 #48）+ sqlite-driver/migrations 基座与冒烟 B-01 已落地；
  B2 已完成——九项契约缺口实施前用户裁决（决议 #49–#57）+ schema v1 +
  Source 域模型 + canonicalization + Repository（唯一 SQL 执行点）+
  SourceService + change journal + durable Undo + 冒烟 B-02 双进程（全量
  test 947/947）；B3 已完成——六项契约裁决（决议 #58–#63）+ 多语言 Source
  Search（FTS5/trigram 主路径 + 短查询安全降级）+ 有界 Retrieval（硬上限
  10/每页 20）+ 分享模式（audience 必填）+ 确定性排序 + note 摘录 ≤200 +
  rebuild 一致性 + 冒烟 B-04 B3 子集（全量 test 1007/1007）；
  B4 已完成（2026-08-15）——实施前契约裁决（决议 #64–#67）+ Source 四工具
  （注册表 13 → 17；source_search/list/get L0 + source_apply_changes L2，
  audience 硬编码 agent，executor 零 Electron import）+ change set 确认全链路
  （previewChangeSet 只读 diff → confirmSummary 钩子 → ConfirmManager →
  applyChangeSet 版本复验/单事务/journal）+ 审计脱敏 + 4000 预算 +
  UNTRUSTED_TOOL_RESULT 块隔离 + 主进程 <userData>/sources/sources.db 装配 +
  冒烟 B-03/B-04（全量 test 1071/1071）；B5 已完成（2026-08-15）——实施前
  契约裁决（决议 #68–#78）+ Sources 面板（分组浏览/搜索/详情编辑/手工添加/
  快速添加/禁用恢复/手工 Undo/两阶段永久删除二次确认/恢复态与不可用态中文
  诊断/明文边界说明，与 AI 面板互斥切换不遮断 App 级确认框）+ 14 个 sources:_
  通道 + sources:changed 事件（仅成功变更后最小 payload）+ source-ipc 适配器
  （参数严格白名单/audience 硬编码 user/状态门控/独立 manual 审计，零 Electron
  import）+ preload 白名单 + 冒烟 8.11 B-05 默认矩阵（dev+生产双场景退出码 0）
  - AIBROWSE_SOURCES_UI_SMOKE=set|check 双进程门控（退出码 0，全量 test
    1125/1125）——**Sources 功能对用户已可用**；B6 已完成（2026-08-15）——
    实施前契约裁决（决议 #79–#85：usage 接线归属 B6/序列化 allowlist 引用链路
    缺口/ToolExecutionContext 最小 usage 桥/provenance 表述校准/description
    校准/B-07 冒烟探针/AIBROWSE_LIVE_AGENT_SOURCES 互斥门控与离线可测路由）+
    SourceSearchHintStore（每 run 独立/有界 120/按 sourceId 去重/跨 run 隔离/
    终态清空）+ browser_open 比对写 usage（reachable/unreachable/写失败安全
    no-op）+ search/list/get 序列化补齐 ID/规范键/作用域/分组 ID + 自然语言
    管理 description + 冒烟 8.12 B-06/B-07 与 8.13 B-06 UI DOM（dev+生产双
    场景、B-02/B-05 双进程复跑、LIVE 门控互斥与离线回退全部退出码 0；全量
    test 1160/1160）；真实 Provider 场景待用户授权；
    B7 已完成（2026-08-15）——实施前契约裁决（决议 #86–#91：backup.ts 存储运维
    SQL 窄契约（VACUUM INTO 路径参数绑定实测成立）/备份方案冻结 = VACUUM INTO
    （node:sqlite backup API 不存在，不实现；关闭后复制仅为已验证后备不静默
    启用）/「迁移失败原库完好」逻辑恒等校准（原路径不得被替换/截断/自动恢复
    覆盖；不要求 WAL/SHM 逐字节恒等）/保留策略冻结（严格命名 + backups 目录内
    普通文件 + 最新 5 个 + 30 天）/usage 两处投影同事务一致 + Undo 回放不覆盖
    usage/rebuild 受控入口（仅 UI 通道 + normal 状态 + 零 Undo 零 changed））+
    `db/backup.ts`（只读探测/VACUUM INTO 一致性备份/完整性·外键检查/有界保留
    清理）+ `sources-store.ts` 启动存储装配（probe → 备份 → 逐级迁移 → 检查 →
    normal|readonly-recovery|unavailable——恢复态为真实生产装配能力，非 SMOKE
    override）+ 恢复态全拒 + FTS rebuild 诊断入口（IPC/bridge/UI）+
    usage「上次使用结果」展示边界 + 冒烟 8.14 B-06 B7 部分（真实启动迁移/备份/
    恢复态全矩阵）+ B-02 usage 跨进程扩展；
    **B7 事故恢复与安全加固已完成（2026-08-15）**——环境事故止损（根目录
    46 个零字节文档碎片 + npm Unknown command 错误输出文件 + 事故日志精确
    清理）+ 5 项数据安全修复（backup.ts 头部探测固定 16 字节读取（不整库读
    入）/目标已存在 fail-closed 拒绝（绝不删除/覆盖调用前已有文件）/碰撞换
    新名有限重试/backups 目录 realpath 解析校验（symlink/junction 越界拒绝，
    prune 不跟随目录链接）+ prune 参数边界验证（NaN/负值/非整数 → 安全空结果
    零删除）+ 备份源连接只读（不写源库）；红→绿 11 failed → 41/41）+ 受控
    串行重验（全量 test **1219/1219** + typecheck/lint/format:check/build +
    dev/生产冒烟 + B-02/B-05/SESSION 双进程退出码 0）；
    **B8 已完成**；独立审计 + B7 审计后定向修复已完成（2026-08-15，
    HOLD 解除：backup.ts 备份发布/失败清理 P2 竞态——决议 #92 两阶段私有
    staging + 硬链接 no-clobber 原子发布 + 所有权证明精确清理 + 任意路径
    公共导出移除；红→绿 5 failed/32 passed → 37/37，全量 1226/1226）；
    **B8 红队矩阵已完成（2026-08-15）**——冒烟 8.15（决议 #93 校准：8.7
    已被 B1 SQLite 决策门占用，历史编号不复用）SRT-01～SRT-12 每项独立
    机器断言 dev+生产双场景退出码 0（断言落点 threat-model §4.1 证据表）+
    8.6/8.14 结构化证据核验（非日志字符串、不重复完整运行相同矩阵）+
    RT-09 扩展静态审计（SQL 执行点分类证据/renderer-preload 零 SQL/
    Electron 隔离・Key 零读回・Source Tool 零网络）+ SRT-08 发现并修复
    产品缺陷（sanitizeToolCallsForPersistence 对 URL 形态参数 query 值
    全量持久化——先测后修独立提交）+ B-02 SRT-10 跨进程扩展（hard delete
    后 FTS/journal/usage 清理）；全量 test 1229/1229；**RT-10 与真实
    SRT-01/02 = NOT RUN**（本轮未获用户授权，不冒充历史证据）；
    **B9 已完成（2026-08-15）**——独立最终验收（不采信 B1–B8 报告）：步骤 0
    三方 SHA 一致（c8e4122，本地/Gitee/GitHub）+ 全量 test 1229/1229（单
    worker）· typecheck · lint · format:check · build 独立复跑全绿 + dev/
    生产冒烟全矩阵（B-01 11 项/8.6 RT/8.14 recovery/8.15 SRT-01～SRT-12）
    退出码 0 + B-02/B-05/SESSION 双进程退出码 0 + 红线独立复核（SQL 仅
    Repository/migrations/driver/backup 窄契约/SMOKE 设施；renderer/preload
    零 SQL；禁具零命中；工具注册表 17；Electron 隔离/IPC sender+主帧/preload
    白名单零回退）+ P2-2/P2-3/P2-4/P3 独立处置（均不命中本阶段 Exit Gate，
    P2-2/P2-3 为真实无界增长项后续硬化）+ 决议 #45 四处速查滞后项已校准；
    **总 Exit 判定 = HOLD/PENDING——唯一缺口 = 真实 Provider 验收**
    （本轮用户未授权；RT-10 与真实 SRT-01/02 观察性场景 NOT RUN）；
    第四阶段保持为当前阶段。
    **B6/B8 补验基础设施闭环已完成（2026-08-15）**——真实 Provider Sources
    验收的可执行前置全部就绪（真实付费调用 0、未授权未执行）：仓库外
    harness `run-live-smoke.ps1` 已增 `-Sources` 开关（与 -Sites/-Agent/
    -Pre/-Supplement 确定性互斥、ASCII、不输出 Key）；真实场景扩展
    （1a L2 deny 零写入/1b approve 恰一次 + durable Undo/场景 6 真实
    SRT-01/场景 7 真实 SRT-02 观察——断言只落结构面、观察性结果如实
    登记）；Key 终检覆盖 Sources 库（含 WAL/备份/journal）/会话文件/
    ToolStep/审计/DOM/日志/临时文件；LIVE_SITES 互斥门控补齐 +
    SMOKE-only 审计收集探针；全量 test 1243/1243。
    **真实验收执行（2026-08-16，本任务）**：RT-10 已接入 `-Sources`
    （独立 rt-10-observe 观察场景 + 场景 8 执行路径，红→绿全量 test
    1244/1244）；真实 Provider 验收首轮失败（场景 1b URL 断言夹具缺陷
    ——模型 origin 形态收藏为契约合法行为）→ 修复后定向复验失败（场景
    4c——disabled 条目对 agent 检索不可见为契约语义，任务文案无定位
    手段属夹具缺陷）→ 两处修复均已最小落地并完整离线复验全绿；第 3 轮
    运行超出授权边界（一次完整运行 + 最多一次定向复验）被中止。
    **总 Exit 维持 HOLD/PENDING——真实 Provider 验收未完成**（场景 4c
    起与真 Key 扫描未通过真实执行；RT-10 与真实 SRT-01/02 仍 NOT
    RUN）；下一唯一动作 = 用户单独授权后对 4c 修复做一次定向真实复验；
    补验通过前不得宣称第四阶段验收通过、不得实现 Fifth Stage。
    **真实 Provider 补验第二次执行（2026-08-16，第四轮运行，用户单独授权
    的一次完整复验）**：场景 1a/1b/1c/2/3/4a/4b/4c/5 **全部真实通过**
    （含 4c restore 实测生效、场景 5 usage=reachable；37 次 HTTP 全部
    200、9 次 L2 确认全部按纪律决议）；**失败于场景 6（真实 SRT-01）**：
    「敌对页未就绪」——harness 夹具缺陷（非产品缺陷）：场景 5 真实模型
    经 browser_open（auto-visible 契约）激活新 Tab 后，场景 6 断言等待
    活动 Tab URL，而 `navigate()` 契约只加载目标 Tab 不激活 → 超时；
    场景 7 同模式；修复方案 = 场景 6/7 导航前 `activateTab(activeBefore)`
    （唯一下一任务，本轮不修改代码）。**总 Exit 维持 HOLD/PENDING——
    真实 Provider 验收未完成**（场景 6/7/8 + 真 Key 扫描未通过真实执行；
    RT-10 与真实 SRT-01/02 仍 NOT RUN）；场景 6/7 导航夹具修复 + 离线
    复验全绿后，下一唯一动作 = 用户单独授权的一次定向真实复验；补验通过
    前不得宣称第四阶段验收通过、不得实现 Fifth Stage。
    **第四阶段最终真实 Provider 验收通过（2026-08-16，第五轮运行）——总
    Exit 改判 `GO/PASS`（第四阶段验收通过）**：场景 6/7 导航夹具修复——
    SMOKE 辅助逻辑 `src/main/smoke-activate-navigate.ts`
    `activateThenNavigate`（激活先于导航；激活失败/取消/超时零导航且不
    触发 Provider；安全返回 false 不抛异常；结构接口，BrowserController
    产品契约零改动），红→绿 11 用例（旧夹具仅 navigate 无激活在顺序断言
    下失败），全量 test **1255/1255** + typecheck/lint/format:check/
    build/diff-check 全绿 + production 无 Key 路由退出码 0；一次完整
    `-Sources` 复验（deepseek-v4-pro）：**场景 1a–8 全部真实通过**
    （34 次 HTTP 全部正常、8 次 L2 确认全部按纪律决议——1a deny + 7
    approve；durable Undo/restore/usage=reachable 实测；真实 SRT-01/02
    与 RT-10 观察场景实际到达，结构断言全部通过、观察性结果如实登记；
    真 Key 零暴露扫描 18 文件零命中 + 进程外 sk-/Bearer 零命中；DPAPI
    密文文件保留；进程/临时目录/环境变量零残留）。**Fourth_stage §10
    八项全部 PASS；阶段指针保持 Fourth Stage；下一推荐动作 = 提交本轮
    报告供只读复核；不得设计或实施 Fifth Stage**（切换须按 ROADMAP.md
    阶段切换原则由用户指令执行）。历史保持：首轮（1b 夹具）→ 定向复验
    （4c 夹具）→ 第 3 轮越界中止 → 第四轮（1a–5 过/场景 6 夹具缺陷）→
    本轮——不重写为一次通过。
    契约源
    `doc/stage4/detailed-design.md`（2026-08-15 定稿）+ 安全契约源
    `doc/stage4/threat-model.md`（ST-01～ST-12 / SRT-01～SRT-12，先于任何 Source
    实现定稿）；任务 B1–B9 见 `doc/stage4/tasks/`；需求源 `Fourth_stage.md`。
    **架构纪律（第四阶段）**：依赖方向固定
    `Sources UI / Agent Source Tools → SourceService → SourceRepository /
SourceSearchIndex / SourceChangeJournal → SQLite driver（主进程）`；
    renderer/preload/AgentLoop/Tool 实现不得直接执行 SQL；UI 与 Agent 共用同一
    SourceService；SQL 只能是 Repository 内的编译期常量或 migration，所有用户/
    网页/模型文本只能作为 prepared statement 参数；禁止 `exec(sql)` 动态串、
    动态表名/列名/排序表达式、SQLite 扩展加载；Source Tool 不新增网络能力
    （打开网页继续 browser_open/browser_read）；v1 最小 4 工具
    （source_search/source_list/source_get 为 L0 有界检索、source_apply_changes
    为 L2 确认门），禁具 source_sql/source_delete_hard/source_export_all/任意
    导入/任意抓取/任意通用数据库工具；AI 写入统一 change set（≤20 项、幂等键、
    expectedVersion、单事务、确认前数据库零变化、durable Undo）；AI 推断的 trust
    永远是 unverified（provenance 三元组）；分享模式 full/metadata/blocked；
    数据库/备份/change journal 不进模型上下文；API Key 绝不进 Sources 数据库。
    **⚠️ B1–B9 已实现**（B1 驱动冻结/B2 数据层/B3 检索/B4 工具层/B5 Sources
    UI 与 IPC/B6 usage 接线 + 自然语言管理端到端/B7 存储运维面——backup/迁移
    全矩阵/恢复态/rebuild 诊断/usage 展示/B8 红队矩阵 SRT-01～SRT-12 + 安全
    审计 + 隐私扫描，冒烟 8.15；B9 独立最终验收已完成，当时总 Exit 判定 =
    HOLD/PENDING（唯一缺口 = 真实 Provider 验收，用户未授权）；
    **2026-08-16 第五轮真实 Provider 验收通过后总 Exit 改判 `GO/PASS`**
    （场景 1a–8 全部真实通过 + 真 Key 零暴露扫描通过，见上）；
    B6/B8 补验基础设施已闭环（harness -Sources/真实场景扩展/Key 终检
    Sources 库面/互斥补齐，test 1243/1243）；**第四阶段验收通过（总 Exit =
    GO/PASS，2026-08-16）；2026-08-16 已按用户指令正式切换 Fifth Stage
    （本阶段指针移至 Fifth_stage.md + doc/stage5/，本段保留为第四阶段历史
    验收过程）。**
- **已完成（第三阶段，Browser Agent）**：让 AI 可以通过受限、可审计、可撤销的
  Tool Layer 自主完成低风险浏览任务——tool-calling 兼容层（A1 硬前置）、Tool Registry、
  SearchProvider、scroll/click/fill/find 交互能力（elementId 生命周期）、最小可控
  Agent Loop（最大步数/超时/取消/防循环）、确定性权限分级与确认状态机（L0 自动 /
  L1 自动显著展示 / L2 用户确认 / L3 禁止）、操作可见性与审计日志。契约源
  `doc/stage3/detailed-design.md`（2026-08-14 定稿）+ 安全契约源
  `doc/stage3/threat-model.md`（Prompt Injection 威胁模型已按第二阶段约定重建，
  先于任何 Browser Tool 实现）；任务 A1–A8 见 `doc/stage3/tasks/`（2026-08-14
  实施前校正：任务编号由 T1–T8 改为 A1–A8，避免与第一阶段任务 T1–T5 重名）。
  **A1 tool-calling 兼容层已实现并通过验证（2026-08-14，硬前置解除）**；
  **A2 Tool Registry + 权限分级与确认状态机 + 审计日志已实现（2026-08-14）**
  ——首批 8 个只读/导航工具（get_tabs/get_active_tab/read/open/navigate/
  back/forward/reload）已接线，仅经 BrowserController 执行；
  **A3 浏览器交互能力已实现（2026-08-14）**——interaction-script 固定模板 +
  BrowserController 扩展（clickElement/fillElement/scrollTab + elementId
  文档世代绑定）+ find/scroll/click/fill 四工具经既有 ToolExecutor 链路接线
  （allowedKind 由 classifyClickTarget 单一事实源派生）；
  **A4 SearchProvider 与 search_web 已实现（2026-08-14）**——Bing 搜索页实现
  （临时 Tab 精确 tabId 所有权 + finally 清理 + 恢复语义，决议 #32）+ 确定性
  解析 + search_web 工具（L0，注册表 13 工具）；
  **A5 Agent Runtime 已实现（2026-08-14）**——AgentLoop 纯编排状态机
  （MAX_STEPS=12/总超时 420s/取消/防循环执行前阻断/终态单一所有权，决议 #33）
  - AgentContextBuilder（AGENT_SYSTEM_PROMPT + UNTRUSTED_TOOL_RESULT 块）
  - agent-history（ToolStep/脱敏 toolCalls/完整交互组）+ ConversationStore
    version 2 + ConversationService agentAsk/confirmTool + 主进程冒烟
    A-01～A-09（dev/生产双场景退出码 0）。
    **A6 操作可见性 UI 与通道已实现（2026-08-14）**——6 IPC 通道（agent-ask/
    agent-confirm invoke + agent-step/agent-confirm-request/agent-run-done/
    agent-status 事件；决议 #34 新增实时状态通道）+ preload bridge 白名单 +
    任务模式/AgentStatusBar/ToolCallList/ConfirmDialog（deny 默认焦点、
    elementText 不可信纯文本渲染）/停止按钮/ToolStep 历史渲染 +
    agent-run-state 纯 reducer + UI 端到端冒烟 A6-UI-01～A6-UI-12（dev/生产
    双场景退出码 0）。
    **A7 红队矩阵与安全审计已完成（2026-08-14，离线部分）**——冒烟 8.6
    RT-01～RT-08 + RT-11（dev/生产双场景退出码 0）+ RT-09 全仓库 grep +
    增量安全审计 + logger 日志行伪造防御修复（normalizeLogMessage）；
    RT-10 与真实 Provider 场景 NOT RUN（真实调用首轮 400 的**根因已确诊为
    wire 名称契约**——13 工具名全部携带点号违反 OpenAI 兼容端点 function.name
    约束，非「模型不支持 tools」；补验离线修复已落地，见决议 #35；
    `AIBROWSE_LIVE_AGENT=1` 完整场景与 `AIBROWSE_LIVE_AGENT_PRE=1` 最小预检
    门控均就绪，真实验证待用户重新授权）。
    **A8 第三阶段收尾已完成（2026-08-14）**——§9 验收逐项核对 + §10 五项技术
    条件逐项判定 PASS；**A7 补验真实验收已完成（2026-08-14）**——wire 兼容性
    修复（决议 #35）+ 最小预检 + 完整真实 Provider 验收（deepseek-v4-pro，
    §7 场景 1–6 + RT-10 + 停止全部真实通过，`LIVE_SMOKE_PASS` 退出码 0），
    **A7 补验补证已完成（2026-08-14 定向补验）**——场景 2 修订（真实长页面
    read/find/scroll 三类工具真实调用链）+ 场景 3 修订（真实搜索后两个不同
    origin 公开来源各自读取比较）+ A3 确认门状态机补齐（迟到/未知 toolCallId
    决议无效），`LIVE_SMOKE_PASS` 退出码 0（12 次 HTTP 全部 200），
    **第三阶段总 Exit 决策 = `GO/PASS`**（2026-08-15 已按用户指令正式切换
    Fourth Stage；第四阶段设计闭环详见 progress.md 与 doc/stage4/）。
    纪律保持：任何 Browser Tool 实现必须在其任务闭环内落地
    （Entry Gate「tool calling」项校正方式，见 doc/stage3/proposal.md §8）。
    核心原则：AI 决定「需要做什么」；确定性程序决定「是否允许、如何执行、执行结果
    是什么」。AI 不得直接获得 Electron API、webContents、Node.js、shell 或任意
    JavaScript 执行权限。
- **已完成（第二阶段，AI 共读）**：PageSnapshot / Selection → AI Context →
  Conversation——AI 侧栏、ConversationService、ContextBuilder、LLMProvider
  （OpenAI-compatible + FakeProvider）、SecureCredentialStore（safeStorage/DPAPI）。
  §9 验收逐项通过 + §10 Exit Gate 通过（2026-08-13）；用户独立复验发现 4 项
  非阻塞缺陷已修复并全量回归（2026-08-14，证据见 progress.md）。
- **已完成（第一阶段，浏览器核心）**：`Browser → PageSnapshot → Browser Tool Interface`
  ——BrowserController/TabManager/PageReader/SessionManager + WebContentsView 多标签浏览器 +
  PageSnapshot 采集 + 调试面板；Exit Gate 已于 2026-08-13 通过（First_stage.md §十四）。
- **阶段机制**：`ROADMAP.md` 描述全阶段路线与切换原则；各阶段需求/验收标准分文件存放
  （当前 `Fifth_stage.md`；已完成 `First_stage.md` / `Second_stage.md` /
  `Third_stage.md` / `Fourth_stage.md`；后续 `Sixth_stage.md`～
  `Seventh_stage.md`）。当前处于第五阶段；**只有当前 Stage 的 Exit Gate
  通过后才切换下一 Stage**（纪律见 §2 文档职责划分）。各 Stage 文件的完整
  内容不复制进本文件，需要时直接读对应 Stage 文件。
- **技术栈**：Electron + TypeScript + React + Vite + Node.js；页面承载用官方当前推荐的
  **WebContentsView**（禁用已废弃的 BrowserView）；测试 **Vitest**、lint **ESLint**、格式 **Prettier**。
  历史阶段禁用语义（第三阶段冻结，保留原文语义）：Playwright（作为浏览器主体）、
  向量数据库、RSS、图表系统、登录账号系统、云同步、厂商 LLM SDK（Provider 调用用
  原生 fetch + SSE 自实现，零新依赖）、Markdown/富文本回答渲染库。**第五阶段校准
  （2026-08-16）**：Research 单 Agent Runtime 已为本阶段目标（不再是禁用项——
  但禁用项「多 Agent 编排/任意渲染库/图表系统/RSS/向量数据库」在第五阶段
  继续成立）；Markdown 渲染由自实现安全子集承担（决策 D9，仍零新依赖——
  不引入任何 Markdown/富文本渲染库）。⚠️ **SQLite 语义（第四阶段校准）**：
  第三阶段当时将 SQLite 列为阶段禁用项（历史语义保留于 Third_stage.md §5.3/§6 原文
  与 progress.md 历史条目，不改写）；第四阶段引入 SQLite 作为 Sources 持久化层——
  driver = `node:sqlite` **已由 B1 决策门实测冻结（2026-08-15，决议 #48：基础能力项
  ①–⑦、⑩、⑪ 全过，⑧ FTS5/⑨ trigram 可用；`doc/stage4/detailed-design.md` §3.2）**；
  **「任意 SQL/任意通用数据库工具」仍是永久红线**（模型/网页无任何 SQL 通道；业务
  SQL 仅为 Repository 编译期常量与 migration，参数绑定；driver 仅连接级运维 SQL）。
  ⚠️ LLM API 调用**允许**（既有能力）但仅限主进程内 Provider 适配器发起；API Key
  不得进入源码/日志/prompt/网页/renderer 可读通道，也绝不进入 Sources 数据库。
  若某技术选择与最新版 Electron 明显不兼容，可选更合理实现，但**必须在修改前说明原因**。
  **技术基线（2026-08-13 按官方来源验证后冻结）**：Node.js 24.x（Active LTS，本机 24.18.0；
  Electron 43.4.0 内置 Node 24.18.1，运行时实测）/ Electron 43.4.0 / electron-vite 5.0.0 / Vite 7.3.6 /
  @vitejs/plugin-react 5.2.0 / React 19.2.8 / TypeScript 6.0.3（typescript-eslint 8.67.0 官方支持范围
  `>=4.8.4 <6.1.0`）/ Vitest 4.1.10 / ESLint 10.8.1（flat config）/ Prettier 3.9.6；
  依赖全部精确版本固定（无 ^/~，`.npmrc` save-exact=true），`engines.node` `>=24 <25` +
  `.node-version` = 24.18.0；main/preload 输出 CJS（preload 必须 CJS 以兼容 `sandbox=true`）。
  ⚠️ **基线冻结**：第三阶段内任何 Agent 不得擅自升级上述核心工具链；升级必须走 §3「技术基线升级流程」。
- **交付形态**：Windows 桌面应用（Electron 产物）。
- **git 双远程**（用户已提供，2026-08-13）：
  - Gitee（默认推送目标，国内直连，无需代理）：
    `https://gitee.com/Molotov0coaktail/aibrowse`
  - GitHub（任何网络操作前必须先启用并确认代理，见 §3 代理红线）：
    `https://github.com/Molotov0cocktail/AIbrowse`
  - ✅ 两个平台用户名拼写不一致（Gitee `Molotov0coaktail` / GitHub `Molotov0cocktail`）——
    2026-08-13 已按用户提供的地址实际推送成功，URL 均正确；推送用本机已存凭据。
- **团队语言（中英混合）**：界面文案 / 错误信息 / 日志 / 提交信息 / 文档 → **中文**；
  代码注释 → **英文**。提交信息格式 `<type>: <中文描述>`，
  type ∈ feat / fix / docs / refactor / test / chore / perf；一条提交一个逻辑变更，写「为什么」。

## 2. 工作流程

### 文档职责划分（唯一权威 + 单一事实源）

```
ROADMAP.md（全阶段路线与切换原则，低频修改）
  ↓
当前阶段文件 Fifth_stage.md（已完成 First_stage.md / Second_stage.md /
Third_stage.md / Fourth_stage.md；后续 Sixth_stage.md～Seventh_stage.md，
Exit Gate 通过后依次启用）
  ↓
AGENTS.md（长期规则/稳定架构/技术基线，低频修改）
  ↓
doc/（第一阶段历史：proposal / high-level-design / detailed-design，定稿不覆盖；
    Second Stage 起：doc/stage2/（定稿）、doc/stage3/（定稿）、doc/stage4/
    （定稿）、doc/stage5/（当前）… 各自独立的 proposal / 高层设计 / 详细设计 /
    威胁模型 / 任务文档——目录约定 2026-08-13 起）
  ↓
doc/tasks/progress.md（当前工程状态/短期记忆，高频更新）
  ↓
Git + 代码 + Test/Typecheck/Lint/Build/冒烟（真实历史与机器验证）
```

- **阶段切换纪律**：当前处于第五阶段。只有当前 Stage 的 **Exit Gate** 全部通过（逐项核对该 Stage
  文件的 Exit Gate/验收标准、progress.md 无阻塞级缺陷、全量验证通过）后，才可切换到下一 Stage；
  切换按 ROADMAP.md「阶段切换原则」执行；阶段完成后**停下向用户报告**，不得擅自进入下一阶段
  （Fifth_stage.md §10；C10 必须独立复验、不采信 C1–C9 完成报告）。
- 不引入额外的状态文件 / Agent 日志 / checklist / handoff / summary 文件，除非实际开发证明必要。
- **文档用于理解需求与意图；Git、当前代码、测试和构建结果用于确认项目实际状态。**
  若 progress.md 声称某功能已完成、但代码/Git/测试证明没有：以实际工程状态为事实，修正文档，再继续开发。
  同样，代码存在也不得违背 First_stage.md / AGENTS.md 中的明确需求与安全规则。

### 步骤 0：新对话接管（每次新对话开始先做）

1. 阅读 `AGENTS.md`（本文件）
2. 阅读当前阶段文件（现为 `Fifth_stage.md`）+ 当前阶段设计文档（现为
   `doc/stage5/`：proposal / high-level-design / detailed-design / threat-model /
   tasks/C1–C10；已完成 `First_stage.md` / `Second_stage.md` / `Third_stage.md` /
   `Fourth_stage.md` 与 `doc/stage2/`、`doc/stage3/`、`doc/stage4/`）
3. 阅读 `doc/tasks/progress.md`（如存在）
4. `git status` + 最近若干条 `git log --oneline`
5. 检查本次任务相关的实际代码和配置
6. 确认文档描述与代码实际状态一致（不一致按上述原则处理）
7. 然后才开始工作

### 步骤链

1. **稳定项目（含 git 前置）**：动工前摸清语言/框架/包管理器/测试/lint/构建/现有约定。
   git 远程已配置（§1）；新建项目时再执行 git init + 双远程 + .gitignore（`log/`、密钥/令牌本地文件、
   构建产物、IDE 个人配置）。
2. **需求澄清**：Fifth_stage.md 已是阶段需求源（契约源 `doc/stage5/detailed-design.md` +
   安全契约源 `doc/stage5/threat-model.md`）；新需求先写 proposal。
3. **设计先行**：风险、歧义、备选方案必须写明，不得用自信措辞掩盖不确定性。
4. **任务拆分（闭环粒度）**：**一个新对话 ≈ 一个可验证的开发闭环**，不机械等于一个文件或一个模块。
   每个任务明确：目标 / 范围 / 非目标 / 涉及模块 / 验收标准 / 测试方式 / 完成定义。
   任务应尽量小，但必须形成完整、可机器验证的闭环（例：「建立可运行项目基线」= install 成功 +
   typecheck + lint + test + build + Electron 冒烟 + diff 检查 + commit）。
5. **小步实现**：一次一个未阻塞任务；实现 → 补测试 → 跑该任务检查 → 审阅 git diff → 更新 progress。
6. **验证闭环（含提交）**：全量测试 → lint/类型检查 → 冒烟（实际启动 Electron 验证可运行）→
   diff 终检（无关改动/生成杂项/密钥泄漏/意外重写）→ 提交前清除垃圾文件并复查工作区（§3）→
   git commit + push 双远程 → 更新 progress.md → 汇报（改了啥/验证了啥/剩余风险）。
   **提交粒度**：一个 commit = 一个逻辑完整、可验证的变化；任务内部可有多个逻辑 commit；
   禁止每改几行就 commit、把大量无关修改塞进一个 commit、提交失败构建状态、
   把临时脚本/日志/截图/缓存一起提交（§3 提交纪律）。
7. **收尾状态可移交（每次对话结束前）**：检查 git diff 与 `git status --short` → 运行该任务要求的验证
   （必要时全量回归）→ 更新 progress.md → 仅在存在长期变化时更新 AGENTS.md → 提交符合规则的 commit →
   报告：做了什么 / 验证了什么 / 遗留问题 / 下一个最合适的独立任务。
   不留：未说明的半成品、不知道是否保留的临时文件、未记录原因的失败测试、与 progress.md 不一致的工作区。

**AGENTS.md 更新规则**：每个任务**不强制**更新本文件；仅当以下内容发生实质变化时才更新——
工程规则 / 稳定架构 / 重要接口约定 / 技术基线 / 长期开发流程 / 必须让后续所有 Agent 都知道的重要事实。

**询问边界（项目专属，细化 PROJECT_RULES「不确定就问」）**：仅以下情况停下来问用户——
会导致数据丢失 / 需要删除大量已有代码 / 存在两个会显著影响长期架构且无法轻易迁移的方案 /
需要密钥、账号或外部凭据。其余不影响总体设计的小问题自行做合理决定，不频繁询问。

## 3. 规则（护栏）

通用红线（出处：PROJECT_RULES.md §3，全部适用）：

1. **测试权威，不得迁就实现**：禁止改测试让现有实现过关；契约有问题先改设计文档与测试，再改实现。
2. **红→绿纪律**：改动前必写能甄别新旧结构的测试；旧代码也能通过的弱测试无效。
3. **分层纪律**：纯逻辑/核心层零副作用、零环境依赖、可单测；UI/IO/副作用放在外层胶水。
4. **越界安全返回**：越界/异常输入安全返回（undefined/空结果/降级），不抛异常（明确豁免除外）。
5. **最小改动**：只做任务范围内改动；不顺手重构、不碰其他模块、不覆盖用户已有工作。
6. **敏感信息零入库**：密钥/令牌/凭据/用户数据严禁提交（.gitignore 本地文件或环境变量；脚本只读不打印）。
7. **提交纪律**：git commit 前先清除文件夹内多余垃圾文件（临时/缓存/探测脚本/日志/截图/构建残留/
   测试与安装残留），清除后复查工作区；仅提交构建项目所必需的文档（源码/文档/测试/构建配置）；
   禁止提交开发残余文件、用户使用与测试信息、与软件使用配置无关的内容。
8. **清理纪律**：每次作业后清理旧产物、缓存、临时脚本、测试残留目录。
9. **全量回归**：作业完成必跑全量测试（+ 冒烟/构建，见附 A 验证矩阵）。
10. **语言一致**：文案/错误/日志/提交信息用中文，代码注释英文，全项目一致。
11. **详尽日志**：每次软件运行必须生成便于 bug 修复的详尽日志（启动/退出、关键操作路径、
    错误分类与堆栈、耗时、环境信息）；**所有日志统一保存在根目录 `log/`**（按日期/会话轮转），
    `log/` 加入 .gitignore（运行时产物，绝不入库）；用户数据与敏感信息脱敏后记录。

项目特有护栏：

- **GitHub 代理红线**：GitHub 上任何网络操作（拉取/推送/Release）前**必须先启用代理
  （git 代理/系统代理/镜像）并确认可用**，确认前不做任何网络动作；Gitee 直连无需代理。
- **双远程策略**：Gitee 为默认推送目标；GitHub 作为镜像同步（代理确认后推送）。
  每次任务完成两个远程都应更新。
- **架构纪律**（First_stage.md §四）：React UI **不得**直接调用 Electron webContents API；
  **BrowserController 是浏览器能力的统一入口**，依赖方向固定为
  `UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`；
  不把所有代码写进几个巨大文件，从第一天起模块化。
- **AI 子系统架构纪律**（Second_stage.md §5 + doc/stage2/detailed-design.md 定稿）：依赖方向
  `UI(AI 面板) → ConversationService → ContextBuilder / LLMProvider → SecureCredentialStore`；
  网页上下文经 `ConversationService → BrowserController.getPageSnapshot`（**提问时刻实时采集**，
  禁止复用缓存快照——防串页核心）；禁止 LLMProvider 直接访问 webContents；禁止 React Chat UI
  接触 API Key（只写不读）；禁止网页内容直接拼接进 system prompt（只进 user 消息的
  `UNTRUSTED_WEB_CONTENT` 块，system 恒为应用常量）。
- **Agent 子系统架构纪律（第三阶段新增，doc/stage3/detailed-design.md 定稿）**：依赖方向
  `UI(AI 面板) → ConversationService(agent 模式) → AgentLoop → ToolRegistry →
PermissionPolicy / ConfirmManager / ToolExecutor → BrowserController / SearchProvider`；
  工具实现**只经 BrowserController / SearchProvider**操作浏览器（禁止绕过直连 webContents）；
  AgentLoop/AgentContextBuilder 为纯核心零 Electron 依赖；**权限判定为确定性纯函数**
  （模型只是提议者，无任何通道修改工具列表/权限矩阵/system 提示）；Tool Result 与网页
  内容同等视为不可信（`UNTRUSTED_TOOL_RESULT` 块）；审计全量脱敏（fill 值只记长度）。
  **硬前置**：A1 tool-calling 兼容层验证通过前禁止引入任何 Browser Tool 实现
  （proposal §8 Entry Gate 校正方式）。
- **安全红线**（First_stage.md §八，从第一版开始）：远程网页 `nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`（架构允许时）、`webSecurity` 不得关闭；
  远程网页不得直接访问 Electron API / 文件系统 / 程序内部数据；preload bridge 最小权限，
  不把 ipcRenderer 整体暴露给网页；限制不必要的 window.open/新窗口行为；合理处理导航；
  React UI 与远程网页保持明确安全边界。**不得为省事关闭 Electron 安全机制。**
- **API Key 零暴露红线**（Second_stage.md §3.3）：Key 不入源码/日志/prompt/网页/renderer
  可读通道（设置界面只写不回显，`list` 仅回 hasKey）；落盘仅 safeStorage 密文；错误与日志
  只记 provider/model/requestId 等非敏感元数据；真实 Provider 验证需用户提供 Key
  （询问边界），未经提供不得联网调用付费 API。
- **TypeScript 纪律**（First_stage.md §十二）：类型错误不得用 `any`、`@ts-ignore` 或关闭严格
  检查解决；不得删除有意义的测试来让测试通过；不留明显 placeholder 实现然后声称完成。
- **生命周期纪律**（First_stage.md §十二）：对 Electron 生命周期、Tab 销毁、WebContents 销毁
  做好清理；注意 memory leak 与 event listener 重复注册。
- **范围纪律（第三阶段不做清单，Third_stage.md §5.3/§6 + 任务红线）**：**严禁万能工具**
  ——shell.exec、eval、任意 JavaScript 执行、任意文件系统读写、任意 HTTP POST、任意
  Electron IPC、任意数据库 SQL（**永久红线**，本阶段及以后均禁止，grep 断言）；
  **不放宽既有 Electron 安全边界**（远程网页隔离/Tab 无 preload/权限默认拒绝/
  window.open deny/UI 导航保护均不变）；**A1 tool-calling 兼容层完成前禁止任何
  Browser Tool 实现**。本阶段不做：长期信源数据库、AI 自动添加收藏、多源 Research
  报告、图表/复杂结果渲染、RSS、Watch、定时任务、自动支付/购买/发布、浏览器扩展
  生态、多 Agent 编排、Agent 记忆系统、向量数据库、page.extract 独立工具、
  向 Agent 开放的关闭 Tab 工具（Agent 打开的 Tab 归用户管理）——除非本阶段目标
  绝对必要，不得主动扩展。
- **范围纪律（第四阶段不做清单，Fourth_stage.md §5 + 任务红线；历史语义保留，
  2026-08-16 第四阶段已完成）**：Sources 子系统纪律见
  §1「已完成（第四阶段）」与 §5 Sources 契约速查；第四阶段当时不做——Research
  报告/多源自动交叉核验/引用渲染/图表、RSS/Watch/Diff/后台定时请求、云同步/
  多设备/账号、embedding/向量数据库、任意 SQL/任意文件系统/任意 HTTP POST/
  后台抓取（永久红线）、Agent 硬删除（无 source_delete_hard 工具）、把 AI 推断
  的 official/primary 当已核验事实、Fifth Stage 代码；**B1 决策门实测通过前
  禁止任何 Source 实现**（同第三阶段 A1 硬前置纪律）；SQLite 静态加密不在本
  阶段承诺（v1 本地明文，README/UI 如实说明）。
- **范围纪律（第五阶段不做清单，Fifth_stage.md §6 + 任务红线）**：Research 子系统
  纪律见 §1「当前阶段（第五阶段）」与 §5 Research 契约速查；本阶段不做——
  多 Agent 编排/Planner-Worker 架构、持续监控/RSS/Watch/Diff/后台定时任务
  （Sixth Stage）、Timeline/Chart/图表系统（本阶段后半或独立闭环再评估）、
  跨重启续跑（resume——运行中任务重启后标 interrupted 可重新开始）、云同步/
  多设备/账号、embedding/向量数据库、任意 SQL/任意文件系统/任意 HTTP POST/
  任意 shell/eval/JS（永久红线）、任意 Markdown/富文本渲染库（自实现安全
  子集，决策 D9）、把收藏/优先级/用户备注自动等同可信、虚构可信度百分比、
  无限上下文/无限 Agent steps、Sixth Stage 代码；**threat-model
  （doc/stage5/threat-model.md）先于任何 Research 实现定稿**（已满足）；
  Research 库 v1 本地明文（README/UI 如实说明）；C10 通过后停止不实现
  RSS/Watch/Sixth Stage。
- **技术基线冻结（第三阶段起长期生效）**：§1 已冻结版本不得由后续 Agent 擅自升级。升级流程：
  先说明理由 → 验证 typecheck + lint + test + build + Electron 冒烟全绿 → 同步相关文档 → 提交。
- **依赖可复现**：`package-lock.json` 必须提交；禁止删除 lockfile 后重新解析依赖来「解决」问题；
  npm 出现 peer dependency / engine 警告时不得用 `--force` / `--legacy-peer-deps` 直接掩盖，
  必须先查明原因；核心工具链依赖保持精确版本固定（package.json 无 ^/~，`.npmrc` save-exact=true）。
- **质量门槛（不得为绿灯降门槛）**：typecheck / lint / test / build / 冒烟失败必须先修根因。
  禁止：删除或跳过有意义的测试、修改测试让错误实现通过、大范围 `eslint-disable`、随意降低 ESLint 规则、
  放宽 tsconfig 隐藏已有类型问题、用 `any` / `@ts-ignore` / `@ts-nocheck` 掩盖设计问题、注释掉失败功能、
  catch 后静默吞掉本应处理的异常、忽略 Promise rejection、`--force` / `--legacy-peer-deps`、
  删除 lockfile 重装碰运气、关闭 Electron 安全机制绕过实现问题。
  若质量规则本身确有问题：先指出规则为何不合理与修改影响 → 修改设计/规范 → 再修改实现 → 完整重新验证。

## 4. 项目结构（2026-08-13 实际状态 + 规划）

```
d:\AIbrowse\
├── AGENTS.md / Fifth_stage.md / README.md      # 手册 / 当前阶段需求与验收 / 启动与架构简介
├── ROADMAP.md / First_stage.md / Third_stage.md～Seventh_stage.md  # 路线图 / 已完成与后续阶段需求
├── .agents/skills/…                           # 规则基线 + references/prompt-templates.md
├── .gitignore / .editorconfig                 # 忽略 log/、密钥、构建产物、IDE 个人配置
├── .prettierrc.json / .prettierignore         # 格式约定（需求/路线文档不参与格式化）
├── .node-version / .npmrc                     # Node 24.18.0 固定 / save-exact 精确版本
├── electron.vite.config.ts / vitest.config.ts # 构建（三目标）/ 测试配置
├── tsconfig.json + tsconfig.node/web.json     # 主进程与渲染进程各自的严格配置
├── eslint.config.mjs                          # ESLint 10 flat config（react-hooks + refresh）
├── package.json / package-lock.json           # 脚本见 §6；lockfile 入库
├── doc/                                       # 第一阶段历史（定稿不覆盖）；Second Stage：stage2/；
│                                              #   tasks/progress.md 唯一进度源
├── log/                                       # 运行时日志（gitignore，按日轮转）
└── src/
    ├── main/
    │   ├── index.ts                           # 入口：生命周期/单实例锁/安全默认值/IPC 装配（sender 校验）/UI 窗口导航保护/冒烟
    │   ├── logger.ts                          # log/ 文件日志（脱敏、按日轮转；logger.test.ts 脱敏专项用例，S1）
    │   ├── smoke.ts                           # AIBROWSE_SMOKE 场景（T2 核心 + T3 导航保护拦截/bounds 上报 + S3 AI 共读矩阵 1–8
    │   │                                      #   + 8.4 A5/8.5 A6/8.6 A7 红队矩阵 + LIVE_AGENT 门控（A7））
    │   ├── ui-navigation-policy.ts / .test.ts # UI 窗口导航保护纯函数（自身来源白名单，T3 落地，9 用例）
    │   └── browser/
    │       ├── browser-controller.ts          # 浏览器能力统一入口（接口 BrowserController + 实现类）
    │       ├── tab-manager.ts                 # WebContentsView 创建/销毁/事件→TabInfo 登记表
    │       ├── tab-state.ts / .test.ts        # 状态机纯函数 + 14 用例
    │       ├── session-manager.ts             # persist:aibrowse 分区（多 Profile 预留；双权限处理器默认拒绝）
    │       ├── permission-policy.ts / .test.ts  # 网页权限策略纯函数（v1 默认拒绝）+ 4 组用例（安全补丁）
    │       ├── page-reader.ts                 # （T4）快照编排：executeJavaScript 注入 + L0–L2 降级阶梯
    │       │                                  #   （A3 规划：交互注入编排）
    │       ├── snapshot-script.ts             # （T4）注入脚本源（自安装 IIFE 字符串，DOM lib 引用保持 TS 检查；
    │       │                                  #   A3 已扩展 isSubmit/ariaExpanded 语义元数据）
    │       ├── interaction-script.ts / .test.ts # （A3 ✅）固定模板交互脚本（click/fill/scroll，
    │       │                                  #   参数只进 JSON 字面量；node:vm 敌手参数逃逸测试）
    │       ├── interaction-normalize.ts / .test.ts # （A3 ✅）交互结果形状校验纯函数（页面视为敌手）
    │       └── snapshot-normalize.ts / .test.ts  # （T4）脚本输出校验纯函数 + 51 用例（A3 扩展语义元数据）
    │   └── sources/                           # （Fourth Stage，契约见 doc/stage4/detailed-design.md §1）：
    │       │                                  #   db/（✅ B1：sqlite-driver 薄封装 + migrations 引擎，决议 #48；
    │       │                                  #        ✅ B2：schema v1 全表集（决议 #49–#55）；
    │       │                                  #        ✅ B7：backup.ts 存储运维（决议 #86——只读探测/
    │       │                                  #        VACUUM INTO 一致性备份（决议 #87）/
    │       │                                  #        integrity·外键检查/有界保留清理（决议 #89）））、
    │       │                                  #   ✅ B7：sources-store.ts 启动存储装配（probe → 备份 →
    │       │                                  #   逐级迁移 → 检查 → normal|readonly-recovery|unavailable）、
    │       │                                  #   domain/（✅ B2：source-canonical/source-change-set
    │       │                                  #   纯函数；✅ B3：source-search-query 检索纯函数——归一化/分流/
    │       │                                  #   FTS 短语构造/档位/排序全序/note 摘录，决议 #60/#61）、
    │       │                                  #   repository/（✅ B2：source-repository 唯一 SQL 执行点 +
    │       │                                  #   change-journal；✅ B3：source-search-index 候选查询
    │       │                                  #   （四条编译期常量 SQL + 参数绑定）/FTS 可用性/rebuild/一致性）,
    │       │                                  #   ✅ B2/B3：source-service（UI 与 Agent 共用唯一入口；
    │       │                                  #   B3 起 search/list/get 必填 audience，决议 #58；
    │       │                                  #   B7：恢复态装配（db=null 全拒）/rebuildSearchIndex
    │       │                                  #   受控诊断入口（决议 #91）/usage 双投影事务，决议 #90）、
    │       │                                  #   usage/usage-tracker（B6：SourceSearchHintStore 每 run
    │       │                                  #   独立 + Agent 打开后 usage 写入，决议 #79/#81）、
    │       │                                  #   tools/source-tools（B4）、
    │       │                                  #   ✅ B5：source-ipc（sources:* 适配器：白名单校验/
    │       │                                  #   audience 硬编码 user/状态门控/独立 manual 审计/
    │       │                                  #   changed 事件，零 Electron import）；
    │       │                                  #   shared/types/sources.ts（✅ B2 单一事实源；B3 增
    │       │                                  #   SourceReadAudience/SourceSearchItem/SourceSearchNote，决议 #58/#59；
    │       │                                  #   B5 增 SourceGroupsResult/SourcesState/QuickAddResult/
    │       │                                  #   PrepareHardDeleteResult，决议 #71–#74）
    │   └── research/                          # （Fifth Stage，契约见 doc/stage5/detailed-design.md §1：
    │       │                                  #   ✅ C1 已完成——契约基座 + 存储基座（domain 状态机/预算常量/
    │       │                                  #   migration v1/Repository/store 装配/Service 骨架；
    │       │                                  #   完成状态与下一任务以 progress.md 为准）/
    │       │                                  #   ✅ C2 research-workspace（task Tab 所有权）/✅ C3 source-selector/
    │       │                                  #   ✅ C4 capture-service + evidence-validator/✅ C5 research-runtime +
    │       │                                  #   C6 synthesis（claim-model/research-prompts）/
    │       │                                  #   C7 result-validator/C8 research-ipc（C6–C8 待实现））
    │   └── ai/                                # （Second Stage 已实现，契约见 doc/stage2/detailed-design.md；
    │       │                                  #   Third Stage 规划，契约见 doc/stage3/detailed-design.md §1）
    │       ├── conversation-service.ts        # （S3 ✅ + A5 ✅ + A6 ✅）会话编排：ask 实时快照/中止/事件/持久化接线；
    │       │                                  #   agentAsk/confirmTool/ToolStep 持久化/Agent 终态恰好一次/
    │       │                                  #   A6 onAgentStatus 状态事件（starting/waiting-confirm/confirm-resolved）
    │       ├── conversation-store.ts          # （S3 ✅ + A5 ✅）会话 JSON 持久化（原子写/上限/损坏容错；
    │       │                                  #   version 2 ToolStep 消息，读兼容 v1，孤立 tool 丢弃）
    │       ├── context-builder.ts             # （S2 ✅ + A5 ✅）纯函数：角色隔离 IR 构建 + UNTRUSTED 块
    │       │                                  #   （A1 tools 透传；A5 共读重放过滤工具轮）
    │       ├── context-budget.ts              # （S2 ✅）纯函数：预算常量与确定性裁剪
    │       ├── credential-store.ts            # （S1 ✅）SecureCredentialStore：API Key 密文落盘
    │       │                                  #   （cipher 后端注入可替换，Q2）+ 纯文件格式 + 单测
    │       ├── safe-storage-cipher.ts         # （S1 ✅）Electron safeStorage（DPAPI）→ CipherBackend 薄胶水
    │       ├── config-store.ts                # （S1 ✅）Provider 配置 JSON（非机密，形状校验 fail-closed）+ 单测
    │       ├── provider/                      # （S1 ✅）LLMProvider 接口/工厂注册表/OpenAI-compatible
    │       │                                  #   适配器（fetch+SSE）/FakeProvider/error-normalize + 单测
    │       │                                  #   （A1 规划：tools/SSE tool_calls/FakeProvider 工具脚本）
    │       ├── agent/                         # （A5 ✅ + A6 ✅）agent-loop（纯编排状态机，零 Electron import；
    │       │                                  #   A6 onStatus 相位回调 + onAgentStep argsSummary）/
    │       │                                  #   agent-context-builder/agent-history/agent-safety
    │       │                                  #   （防循环纯函数）+ 各自 .test.ts
    │       ├── tools/                         # （A2 ✅ + A3 ✅ + A4 ✅ + A6 ✅）tool-types/tool-registry（schema 校验）/
    │       │                                  #   tool-executor（校验→权限→确认→执行→审计；A6 确认摘要
    │       │                                  #   elementText/目标站点 URL）/
    │       │                                  #   browser-tools（A2 只读导航 8 工具）/
    │       │                                  #   interaction-tools（A3 ✅ find/scroll/click/fill）/
    │       │                                  #   interaction-semantics（A3 ✅ 快照语义存储+世代绑定；A6 text 映射）/
    │       │                                  #   search-tool（A4 ✅ search_web 注册/序列化）
    │       ├── permission/                    # （A2 ✅）permission-policy：L0–L3 确定性权限纯函数
    │       ├── confirm-manager.ts             # （A2 ✅ + A6 ✅）确认状态机（pending/approve/deny/作废；
    │       │                                  #   A6 判别联合 PendingChange + 多监听者 Set 分发）
    │       ├── audit-log.ts                   # （A2 ✅）结构化审计条目（参数脱敏摘要；
    │       │                                  #   A4 search_web query 全量记录，决议 #32）
    │       └── search/                        # （A4 ✅）search-provider：接口 + Bing 页面实现 +
    │                                          #   确定性解析（临时 Tab 精确所有权 → 快照解析
    │                                          #   → 统一结果结构，零 Electron import）
    ├── preload/
    │   ├── index.ts                           # UI bridge（contextBridge 白名单：tabs/nav/page/ui
    │   │                                      #   + conversation/config（S4 ✅）+ agent 可见性（A6 ✅）；
    │   │                                      #   事件通道单次注册 + JS 侧 listener 集合退订）
    │   └── index.d.ts                         # renderer 侧 window.aibrowse 类型
    ├── renderer/                              # React UI（index.html + src/）
    │   ├── src/browser/                       # （T3/T4）chrome：Toolbar/TabBar/AddressBar +
    │   │                                      #   DebugPanel + useTabsState/useContentBounds（hooks）
    │   ├── src/ai/sources/                    # （B5 ✅）Sources 面板：SourcesPanel/SourceDetailForm/
    │   │                                      #   SourceAddForm/HardDeleteDialog/useSourcesPanel/
    │   │                                      #   sources-display 纯函数（决议 #68–#78）
    │   └── src/ai/                            # （S4 ✅ + A6 ✅）AI 侧栏：AiPanel（对话/任务模式切换）/
    │                                          #   ChatView（ToolStep 条目 + agentRun 徽标）/Composer/
    │                                          #   ContextBadge/CitationCard/ProviderSettings +
    │                                          #   useConversation/useStream/useAgent + 纯函数
    │                                          #   （stream-state/history-events/context-badge-format/
    │                                          #   A6 agent-run-state（reducer）/agent-display（脱敏/文案）；
    │                                          #   A6 AgentStatusBar/ToolCallList/ConfirmDialog 组件）
    └── shared/
        ├── types/app.ts                       # 共享类型（AppInfo / AibrowseBridge，S4 conversation/config
        │                                      #   + A6 agent 可见性扩展 ✅）
        ├── types/browser.ts                   # TabInfo/TabsState/PageSnapshot/meta（T2）
        ├── types/conversation.ts              # （S1 ✅）会话/消息/上下文/错误码/Provider 类型
        │                                      #   （§2+§3.3+§3.5；S4 增 ProviderInfo/kind 常量）
        ├── types/ipc.ts                       # IPC 通道常量 + payload 类型（T2 基线 + S4 conversation/config
        │                                      #   + A6 agent-ask/agent-confirm/4 事件通道扩展 ✅）
        ├── types/agent.ts                     # （A2 ✅）ToolCall/ToolResult/权限级别/ElementSemantics（A6 增 text）
        │                                      #   （A5/A6 扩展 Agent 事件 payload：A6 增 AgentStatusPhase/Event/
        │                                      #   AgentConfirmOutcome/AgentStepEvent.argsSummary）
        └── url.ts / url.test.ts               # 地址栏输入判断纯函数 + 15 用例
```

分层方向（不可反向或跳跃）：`UI → BrowserController → TabManager / PageReader / SessionManager → Electron APIs`；
AI 子系统：`UI(AI 面板) → ConversationService → ContextBuilder / LLMProvider → SecureCredentialStore`，
网页上下文 `ConversationService → BrowserController.getPageSnapshot`；
Agent 子系统（第三阶段）：`UI → ConversationService(agent) → AgentLoop → ToolRegistry →
PermissionPolicy / ConfirmManager / ToolExecutor → BrowserController / SearchProvider`。
按实际 Electron 项目结构调整文件布局时，必须保持该分层不变。

## 5. 模块接口速查

接口契约已于 2026-08-13 **定稿**（T1），唯一契约源 `doc/detailed-design.md`（§2–§7 + §12 决议记录，
含 proposal Q1–Q4 拍板）；以下为速查摘要，**T2/T3/T4 部分已用 `grep -n "^export"` 与实际代码逐项核对**
（2026-08-13，T4 完成时回填 PageReader/normalize 部分；T5 收尾补记 will-redirect 加固与
elementId 跨集合复用）。

- **shared/url（已实现，2026-08-13 已用 grep 核对）**：`export const SEARCH_ENGINE_URL: string`
  （当前 `https://www.bing.com/search`，以后整体换 SearchProvider）；
  `export function resolveAddressBarInput(raw: string): string` —— `https://…`/`http://…`/`about:…`
  直开、裸域名/IP/localhost 补 `https://`、其余（含危险 scheme）走搜索；空输入与非法 URL
  安全返回 `''`（越界安全返回）。测试：`src/shared/url.test.ts`（15 用例）。
  另有 `export const ALLOWED_SCHEME_PATTERN`（T2 起被 Tab 导航白名单共用）。
- **shared/types/browser.ts（T2）**：`TabState`（idle/loading/ready/error）、`TabInfo`、
  `TabsState`、`PageSnapshot`（含必填 `meta{capturedAt,readyState,degraded,warnings}`，
  降级阶梯 L0–L2 见 detailed-design §4）、`SnapshotDegradation`、`SnapshotMeta`。
- **shared/types/ipc.ts（T2）**：`IPC` 通道常量（tabs:list/create/close/activate、
  nav:navigate/back/forward/reload、page:snapshot、ui:content-bounds、app:get-info、
  app:renderer-ready、tabs:updated）+ `ContentBounds`/`TabsCreatePayload`/`TabIdPayload`/
  `NavNavigatePayload`。
- **BrowserController（T2 已实现）**：契约接口 `export interface BrowserController` +
  实现类 `export class BrowserControllerImpl implements BrowserController`（lint 规则要求分名）。
  接口方法（未来 AI Agent 只能经它/Tool Layer 操作浏览器）：
  `createTab(url?) → Promise<TabInfo>`（新 Tab 自动成为活动 Tab；空 URL 创建空白 Tab + warn）/
  `closeTab · activateTab · navigate · goBack · goForward · reload → Promise<boolean>`
  （参数/状态问题安全返回 `false`，不抛异常）/
  `getTabs() → Promise<TabInfo[]>` / `getActiveTab() → Promise<TabInfo | null>` /
  `getPageSnapshot(tabId) → Promise<PageSnapshot | null>`（null = L3；L0–L2 由 PageReader
  编排——注入只读采集脚本 + normalize 校验 + 降级阶梯，T4 接入）/ `dispose(): void`
  （退出路径全量清理，幂等，不触发最后 Tab 策略）。
  **类方法（不在 AI 契约接口内，UI 接线用）**：`setContentBounds(bounds: ContentBounds): void`
  （ui:content-bounds 通道落点，非法值忽略 + warn）。
  地址栏原始输入由 main 侧 IPC handler 统一规范化后再进 controller（§9）。
- **TabManager（T2）**：`export class TabManager` + `TabEntry`/`TabEntryInfo`/`TabManagerOptions`。
  每个 Tab 一个 WebContentsView（显式安全默认值：无 preload、`nodeIntegration=false`、
  `contextIsolation=true`、`sandbox=true`、`session=persist:aibrowse`）；可见性用 `setVisible`
  切换（不用 removeChildView）；全部监听器注册于创建时、closeTab/dispose 时逐一移除；
  `will-navigate` + `will-redirect` 白名单 http/https/about（302 目标同过白名单，T5 R-02
  加固——程序化 loadURL 遇重定向时唯一拦截点）+ `setWindowOpenHandler` 一律 deny。
- **tab-state（T2，纯函数零 Electron 依赖）**：`export type TabStateEvent`（start-loading/
  finish-load/fail-load，含 isMainFrame/errorCode）；
  `export function transition(state, e): TabState`（子框架忽略；-3=ERR_ABORTED 忽略；
  fail→error；start-loading 从任意状态→loading）；
  `export function selectNextActive(tabs, activeTabId, closedTabId): string | null`
  （**tabs 为关闭前完整列表**；关闭活动 Tab → 右邻优先/左邻/唯一时 null→最后 Tab 策略自动新建空白 Tab）。
  测试：`tab-state.test.ts`（14 用例）。
- **SessionManager（T2）**：`export const PERSIST_PARTITION = 'persist:aibrowse'`；
  `export interface SessionManager { getSession(profile?): Session }`；
  `export class AppSessionManager`（`session.fromPartition` 懒加载单例；'main'→PERSIST_PARTITION，
  未来 Profile 映射 `persist:aibrowse-<profile>`）。本阶段仅持久 Session（重启后 Cookie/登录状态保留），
  不真正实现多 Profile。
- **permission-policy（安全补丁，2026-08-13）**：`export function resolvePermissionRequest(
permission, requestingUrl): boolean` / `export function resolvePermissionCheck(permission,
requestingOrigin): boolean` —— 网页权限策略纯函数，v1 固定默认拒绝（未知权限/畸形来源同样拒绝）；
  由 SessionManager 在分区首次创建时注册的 `setPermissionRequestHandler` +
  `setPermissionCheckHandler` 调用（官方要求两者同时实现）。测试：`permission-policy.test.ts`（4 组）。
  后续扩展权限白名单只改本模块与测试。
- **PageReader（T4 已实现）**：`export class PageReader` +
  `snapshot(webContents: WebContents) → Promise<PageSnapshot>`（前置守卫/L3 由 BrowserController
  完成；执行失败/页面崩溃/脚本结果不可用 → L2，不抛异常）。`executeJavaScript` 注入
  `SNAPSHOT_SCRIPT_SOURCE`（`snapshot-script.ts` 导出，自安装 IIFE 字符串——采集函数经
  `/// <reference lib="dom" />` 保持完整 TS 检查后 `.toString()` 序列化）。
  `snapshot-normalize.ts`：`export const NORMALIZE_LIMITS`（校验限额常量，与采集限额一致）+
  `export function normalizeSnapshot(raw: unknown, fallback: SnapshotFallback): PageSnapshot`
  ——页面输出视为敌手：逐字段类型校验/限额二次截断/elementId 格式 `el-N` 过滤/表格行列补齐截断/
  warnings 合并去重；任何输入（含 null）返回合法 PageSnapshot 不抛异常；L2 形状由同一模块产出。
  测试：`snapshot-normalize.test.ts`（46 用例）。结构化快照**不得默认返回整个 DOM**；过滤
  script/style/隐藏内容等噪声；`elementId` 双层映射（data-aibrowse-el 属性烙印 + 每次快照
  重建的有界 Map，§8.4）在一次快照生命周期内对应真实 DOM 元素；同一元素出现在多个集合
  （a[role=button]、input[type=button]）时跨集合复用同一 id，敌手预置顶格合法烙印时分配
  回绕（T5 修复）；type=password 不采集 value；
  PageReader 不污染网站正常行为（唯一写操作是幂等烙印属性）；远程网页不得通过此机制执行
  Node.js 或 Electron privileged API（脚本页面世界运行，无 preload/无 IPC）。
- **URL 判断逻辑（已实现）**：见上 shared/url；地址栏原始输入经 `nav:navigate`/`tabs:create`
  由 main 侧 IPC handler 统一规范化（T3 已接入，UI 不做 URL 判断）。
  已知限制：不支持中文/国际化域名（IDN）；以后替换 SearchProvider 时一并评估。
- **preload bridge（AibrowseBridge，T3 已实现）**：`src/shared/types/app.ts` 定稿签名
  （§3.2）+ `src/preload/index.ts` 白名单实现。`tabs.list/create/close/activate/onUpdated`
  （onUpdated 返回退订函数，preload 内同一通道只注册一次 ipcRenderer 监听、JS 侧管理
  listener 列表）；`nav.navigate/back/forward/reload`（navigate 传原始输入）；`page.snapshot`；
  `ui.reportContentBounds`。原始 `ipcRenderer` 永不暴露给渲染层。
- **ui-navigation-policy（T3 已实现，安全，T4 收紧）**：`export interface UiNavigationPolicy`
  （selfOrigin / selfFileUrl）+ `export function resolveUiNavigationAllowed(targetUrl,
policy): boolean`——UI 窗口导航保护纯函数（零 Electron 依赖）。开发模式仅放行
  `ELECTRON_RENDERER_URL` origin；生产仅放行 `file:` 入口文件 URL **精确匹配**（scheme+pathname
  相等，hash/query 变体视为同一文档；同目录其他文件/`..` 路径穿越/大小写变体一律拒绝，失败关闭；
  不用 origin 比较——file: 的 origin 恒为 'null'，会误放行所有本地文件）；畸形输入安全返回 `false`。
  由 `main/index.ts` 挂到 UI 窗口 `will-navigate` + `will-redirect`（§9，两处共用同一判定）。
  测试：`ui-navigation-policy.test.ts`（10 用例）。
- **渲染层 chrome（T3/T4 已实现）**：`renderer/src/browser/`——Toolbar（后退/前进/刷新/地址栏/
  新建 Tab）/ TabBar（标题兜底「新标签页」、切换/关闭、active 高亮、loading spinner、
  error 红标）/ AddressBar（聚焦期不随 URL 刷新草稿、失焦同步、Enter 提交原始输入）/
  DebugPanel（「读取当前网页」→ 活动 Tab PageSnapshot JSON + degraded 徽标 L0–L3 +
  warnings 列表 + 可收起；面板在 chrome 容器内，高度变化经 ResizeObserver 自动上报 bounds）；
  hooks：`useTabsState`（tabs:updated 全量推送幂等更新，先订阅后拉取防旧快照回退）、
  `useContentBounds`（ResizeObserver 测 chrome 高，防抖 50ms 上报 ui:content-bounds）。
  主区域为占位容器，真实网页由 WebContentsView 按上报 bounds 覆盖渲染。

### Second Stage AI 共读契约速查（定稿 2026-08-13；S1–S4 全部已实现并经 `grep -n "^export"` 逐项核对；S5 审计与 S6 验收通过，2026-08-13 最终状态）

> 唯一契约源 `doc/stage2/detailed-design.md`（§2–§12 + §15 决议记录，含 proposal Q1–Q10 拍板）；
> 任务拆分见 `doc/stage2/tasks/S1–S6`。以下为速查摘要；S1–S4 部分签名已于 2026-08-13 与
> 实际代码 `grep -n "^export"` 逐项核对。

- **shared/types/conversation.ts（S1 ✅ 已实现；S4 增补）**：`ContextMode`（selection/snapshot/none）、
  `ContextSource`（mode/tabId/url/title/capturedAt/degraded/thin/selectionExcerpt/warnings）、
  `ConversationMessage`（role ∈ user|assistant；status complete/aborted/error；
  contextSource 仅 user 消息携带；**不持久化快照正文**）、`ConversationSession`
  （含 ephemeral「不保存」）、`NormalizedErrorCode`（not-configured/invalid-key/rate-limit/
  timeout/network/context-too-long/provider-error/aborted/busy/not-found/internal）、
  `NormalizedProviderError`（code/message/retryable/providerId/model/requestId/httpStatus，
  **不含响应体/请求头/密钥**）、`ContextPreview`、`AskResult`、事件 payload
  `StreamChunkEvent`（requestId/sessionId/delta）与 `TurnDoneEvent`（requestId/sessionId/
  status/message/error/contextSource）；Provider 类型——`ProviderMetadata`/`ProviderMessage`/
  `ProviderRequest`/`ProviderUsage`/`ProviderEvent`/`ProviderConfig` + S4 增补
  `ProviderInfo`（providerId/label/baseUrl/model/hasKey——**无 Key 值**）与常量
  `PROVIDER_KIND_OPENAI_COMPATIBLE`（Provider 数据类型放 shared，preload/renderer 直接复用）。
- **ConversationService（S3 ✅ 已实现，2026-08-13 grep 核对）**：接口 `ConversationService`
  与实现类 `ConversationServiceImpl`——`createSession(opts?): Promise<ConversationSession | null>`
  （**决议 #19**：达 50 会话上限拒绝新建 → null；实际签名与唯一契约源 §3.1 均为可空返回）/
  `listSessions`（新→旧）/`getHistory`（null=不存在）/
  `deleteSession`（先中止在途生成 → 删内存+文件含残留 tmp → 更新索引）/
  `setEphemeral`（false=现有消息落盘，true=移除磁盘文件）/`ask`（同步校验+注册在途后
  立即返回 `{ok:true,requestId}`，生成后台执行经事件回调推送）/`abort(requestId)`
  （幂等，无匹配 false）/`previewContext`（实时快照摘要不含正文）/`dispose`（中止全部
  在途，幂等）；纯函数 `selectRegisteredProviderInfo(infos, kinds)`（**决议 #20**：
  v1 单 Provider 选择契约，见下）。构造注入：`browser: SnapshotSource`（getActiveTab/
  getPageSnapshot 最小接口，BrowserControllerImpl 结构兼容；实时采集防串页）/`store`/
  `configStore`/`credentials`/`resolveProviderFn?`（冒烟注入 FakeProvider 缝；缺省生产
  resolveProvider，决议 #17）`onStreamChunk`/`onTurnDone`（§3.1 事件输出，index.ts
  转发主窗口 send）。
  ask 编排时序即防串页契约：实时 `getPageSnapshot(activeTabId)`（禁止复用缓存快照）→
  **Provider 选择（决议 #20）**：`selectRegisteredProviderInfo(await configStore.list(),
listProviderKinds())`——取 providerId 属于已注册工厂 kind 的配置；v1 仅注册
  `openai-compatible` 一种 kind、ConfigStore 以 providerId 为键 upsert 同键恒唯一，
  选择唯一且**与 `list()` 条目顺序无关**（不依赖任何隐含排序）；无已注册 kind 配置 →
  not-configured 零网络请求；多 kind 并存是 Third Stage+ 扩展点 → `buildContext`
  （requestId 先生成、model 来自所选配置——决议 #18）→
  **先持久化 user 消息（含 ContextSource + meta.warnings）** → `resolveProvider` →
  `provider.stream` → delta 逐块转发 → 终态组装 assistant 消息（complete 全文 /
  aborted 保留部分 / error 保留部分+errorCode）→ 持久化 → turn-done 恰好一次。
  每会话单在途（busy，ask 同步段注册原子）；参数/状态问题安全返回不抛异常
  （not-found/busy/internal）；未预期异常 → error 日志 + 归一化 internal 且保证
  turn-done；deleteSession 中止竞态下在途编排不得复活已删会话文件（appendMessage
  存活守卫）。日志链：开始/结束各一条（requestId/providerId/model/mode/url/耗时/
  status/errorCode，无内容与密钥）。
- **ConversationStore（S3 ✅ 已实现，2026-08-13 grep 核对）**：`export class
ConversationStore(userDataDir)`——`dirPath`/`loadSessions`/`saveSessions`（写入前过滤
  ephemeral 纵深防御）/`loadMessages`（缺失/损坏 → 空，fail-closed 不暴露原文）/
  `saveMessages`（原子写 tmp+rename）/`deleteFiles`（消息文件+残留 tmp）。纯函数：
  `deriveTitle`（首问 ≤30 字符，换行折叠）、`validateMessageShape`/`validateSessionShape`
  （§9 逐条校验）、`serialize/parseMessagesFile`/`serialize/parseIndexFile`（version 1；
  整体不可解析 → null；索引解析丢弃 ephemeral 条目）、`cropMessagesToLimit`（200 条
  裁最早）、常量 `SESSION_LIMIT=50`/`MESSAGE_LIMIT=200`/`TITLE_MAX_CHARS=30`。
  **A5 版本演进（决议 #45 校准）**：写入恒 v2（ToolStep 消息），读兼容 v1
  （孤立 tool 丢弃），见 Third Stage 段落。
  布局 `<userData>/conversations/index.json + <sessionId>.json`（运行时目录，不入库）。
- **ContextBuilder（S2 ✅ 已实现，2026-08-13 grep 核对）**：`buildContext({question,
snapshot, history, system, requestId, model, budget?}) → {request, meta}`——
  `request: ProviderRequest`（requestId/model 由 Service 传入，决议 #18；web 块只进
  末条 user 消息）；`deriveContextMode(snapshot, thin)`（null/L3 → none；selection
  trim 非空优先独占 → selection；其余 → snapshot——thin 不改变模式，L2 保留身份降级）；
  `isThinSnapshot`（正文合计 < 300 字符）；`buildContextSource(snapshot, mode, thin,
tabId)`（tabId 由 Service 传入，决议 #18；selectionExcerpt ≤ 200）。网页内容只进
  user 消息 `UNTRUSTED_WEB_CONTENT` 块（`</` → `<\/` 闭合转义 + 属性 `& < > "` 转义 +
  `<selection>`/`<section name>` 结构），`SYSTEM_PROMPT` 编译期常量（恒等断言）。
  context-budget.ts：`CONTEXT_BUDGET`（§7.5 全量表，可注入）/`THIN_SNAPSHOT_THRESHOLD`/
  `TRUNCATION_MARK`/`truncateWithMark`/`countSnapshotBodyChars`/`filterLayoutTables`
  （表头空且行少或内容稀薄 → 跳过）/`fillWebContentSections`（text→headings→tables→
  links→buttons→inputs 优先级 + 各节/条目上限 + 总预算 30000 停止 + 任何截断标记）/
  `trimHistory`（最近 8 对 + 12000 字符）/`renderHistoryMessageContent`（单条 2000 +
  来源行 ≤ 120 计入预算）。
- **LLMProvider（S1 ✅ 已实现，src/main/ai/provider/）**：`llm-provider.ts`——
  `export interface LLMProvider`（`metadata` + `stream(request, signal): AsyncIterable<
ProviderEvent>`，delta/done/error）、`PROVIDER_KIND_OPENAI_COMPATIBLE`、
  `ProviderFactory`/`registerProviderFactory`/`listProviderKinds`、`resolveProvider
(config, store) → Promise<LLMProvider | null>`（async——无 Key 判定依赖 §3.4 异步
  `store.has()`；设计 §3.3 签名已校准为 Promise（决议 #17）；未配置/无 Key/未注册
  kind → null → not-configured，不发起网络请求）。`openai-compatible.ts`——`OpenAICompatibleProvider`
  （原生 fetch + SSE 自解析：`\n\n` 分帧/`[DONE]`/usage 末帧/末帧 delta+usage 同帧不丢
  内容/CRLF 归一化，`POST {baseUrl}/chat/completions`，Key 请求时从 store 取不缓存、
  适配器不记录请求头，超时 `PROVIDER_TIMEOUTS` 连接 15s/空闲 chunk 60s/总 300s
  AbortController 组合，零 Electron import）+ 可单测纯函数 `parseSseFrame`/
  `interpretSsePayload`/`mapMessages`。`fake-provider.ts`——`FakeProvider`
  （确定性脚本 `FakeChunk`/`FakeProviderScript`：分块/延迟/错误注入 code|httpStatus/
  中止 + `getLastRequest()` 供冒烟断言）+ `FAKE_PROVIDER_METADATA`。
  `error-normalize.ts`——`normalizeProviderError`（判别联合 `NormalizeInput`：
  http/network/timeout/aborted/parse/not-configured/internal）+ `isContextTooLongIndicator`
  纯函数：状态码矩阵 → 错误码（401/403→invalid-key、429→rate-limit、400/422 上下文
  指征→context-too-long、5xx→provider-error retryable、网络/超时/中止/解析失败各归一；
  脱敏断言：错误绝不含响应体/密钥）。
- **SecureCredentialStore（S1 ✅ 已实现，src/main/ai/）**：`credential-store.ts`——
  `export interface SecureCredentialStore`（`isAvailable/set/get/has/delete`，`has` 供 IPC
  查询不含密钥）+ `SecureCredentialStoreImpl`（cipher 后端注入 `CipherBackend`，Q2 可替换；
  safeStorage/Windows DPAPI 密文落盘 `userData/credentials.json`（原子写 tmp+rename）；
  不可用 fail-closed：set 返回 false 不落盘 + 仅内存 Key（退出即弃）；损坏/解密失败 → 空/
  null + warn）+ 纯文件格式 `serializeCredentialsFile`/`parseCredentialsFile`/
  `isCiphertextShape`（sk- 明文形态条目丢弃）。`safe-storage-cipher.ts`——
  `SafeStorageCipher`（Electron 薄胶水，运行时行为已由 S4 冒烟场景 10 验证：真实
  safeStorage 密文落盘 + DOM/日志零暴露断言，§13.2）。
  **渲染层只写不读**（S4：bridge 仅 `setKey` 写入，`has` 为 main 侧方法不进 bridge——
  renderer 只能经 `list()` 拿到 hasKey 布尔，无 get 通道）。`config-store.ts`——
  `ConfigStore`（`get`/`set`/`list(): Promise<ProviderInfo[]>`——设计 §3.5 签名已校准为
  Promise（决议 #17）：hasKey 依赖 §3.4 异步 `store.has()`；ProviderConfig 定义于 shared
  并重导出）+ 纯校验 `normalizeBaseUrl`（仅 http/https 去尾 /）/`validateProviderConfig`
  （model/providerId 非空）；文件 `userData/provider-config.json` 形状校验 fail-closed
  （Key 不入此文件）。
- **IPC/bridge 扩展（S4 ✅ 已实现，2026-08-13 grep 核对）**：invoke——conversation:list/
  create/get-history/delete/set-ephemeral/ask/abort/preview、config:providers:list/set/
  set-key（apiKey='' = 删除）——11 个通道常量与 payload 类型在 shared/types/ipc.ts
  （§4.1）；两事件通道常量与 StreamChunkEvent/TurnDoneEvent payload 类型 S3 已落地。
  main 侧 handler 全部复用既有 `handle()` sender+主帧校验包装（index.ts），逐参数验证
  安全返回不抛异常；question > 16000 字符确定性截断（truncateWithMark +
  CONTEXT_BUDGET.questionMaxChars + warn，§4.1；buildContext 内 §7.5 预算截断为
  纵深防御）、空串/非串 → AskResult{ok:false, internal}；事件只发主窗口。preload
  bridge 白名单（§4.2）：`conversation.{list/create/getHistory/remove/setEphemeral/
ask/abort/preview/onStreamChunk/onTurnDone}` + `config.providers.{list/set/setKey}`
  ——事件订阅返回退订函数、preload 内同一通道只注册一次 ipcRenderer 监听 + JS 侧
  listener 集合（与 tabs:updated 同模式，eventRelay 泛型封装）；**API Key 只写不回读**：
  setKey 后 Key 无法经任何通道回渲染层，list() 仅含 hasKey（无读回方法，冒烟场景 10
  白名单断言）。ProviderInfo 与 PROVIDER_KIND_OPENAI_COMPATIBLE 常量定义于
  shared/types/conversation.ts（单一事实源；config-store/llm-provider 重导出）。
- **AI 侧栏与布局（S4 ✅ 已实现，2026-08-13 grep 核对）**：`renderer/src/ai/`——
  AiPanel（header：新建/会话列表/删除/不保存开关/设置/收起）· ChatView（消息流 +
  追溯卡片 + 已中止/错误标记；回答纯文本 pre-wrap，不引入 Markdown 库）· Composer
  （textarea Enter 发送 / Shift+Enter 换行；生成中显示「中止」）· ContextBadge
  （conversation:preview 驱动：面板打开/tabs:updated 即时/窗口 focus 防抖 300ms；
  文案纯函数 `describeContextPreview`）· CitationCard（ContextSource 摘要）·
  ProviderSettings（v1 只配置已注册 openai-compatible kind——决议 #20，无多 Provider
  选择 UI，与 list() 顺序无关；API Key type=password 只写不回显、保存后清空、apiKey=''
  = 删除）；hooks `useConversation`（会话列表/当前会话/历史镜像 + turn-done 补
  contextSource 收敛，纯函数 `reduceHistory`）与 `useStream`（requestId → delta 逐块
  追加、turn-done 收敛，纯函数 `reduceStream`；竞态残留事件按 requestId 忽略）；面板
  定宽 380px 停靠挤压、默认收起、不持久化、无拖拽/动画；useContentBounds 升级为测量
  内容容器两维矩形（ResizeObserver + 防抖 50ms，通道/契约 ui:content-bounds 不变）；
  布局：Toolbar+TabBar（chrome）→ 内容行（内容容器 + 面板）→ DebugPanel 底部通栏。
  冒烟模式 AI 子系统走进程专属临时目录 + FakeProvider 注入（不触碰用户 userData）。
- **Prompt Injection 验收边界（S5 ✅ 已实施验证，S6 ✅ 分类校准，2026-08-13）**：机器可
  验证断言——网页内容只存在于 user 消息 UNTRUSTED 块、system 恒等、块不可被内容闭合
  （`</`→`<\/` 转义）、角色程序字面量赋值、渲染层无 Key 读回、本阶段无浏览器写 Tool
  （click/fill/scroll 不存在，grep 断言 + 请求无 tools 字段）、权限默认拒绝回归、
  日志无 Key——全部经 S5 逐项审计与运行时探针验证（§12.1/§14 结论见 progress.md；
  矩阵 11 注入夹具已增强为含「忽略之前的指令」/伪造 role/原始闭合标签拼接等 4 条
  文案 + 5 断言；真实 Provider 场景真 Key 零暴露扫描已落地，§6；S6 多网站验证沿用
  同套扫描）。
  **不承诺（也不得宣称）模型语义层完全免疫**：语义层剩余风险经 S6 分类校准正式登记为
  「已接受的剩余设计风险/计划内限制」（progress.md，不分配 R 编号、开放风险为「无」）；
  **威胁模型已于 2026-08-14 随 Third Stage 切换重建定稿**（`doc/stage3/threat-model.md`，
  先于任何 Browser Tool 实现）。

### Third Stage Browser Agent 契约速查（定稿 2026-08-14；A1–A8 已实施）

> 唯一契约源 `doc/stage3/detailed-design.md`（§2–§16 + §15 决议记录，含 proposal
> Q1–Q15 拍板与决议 #21–#34）；安全契约源 `doc/stage3/threat-model.md`（威胁枚举
> T-01～T-10、五层防线、红队矩阵 RT-01～RT-11、诚实边界声明）；任务 A1–A8 见
> `doc/stage3/tasks/`。以下为速查摘要，**A1–A6 部分已于 2026-08-14 实现并经
> `grep -n "^export"` 逐项核对**；A7 红队矩阵与安全审计已实施（RT-01～RT-08 +
> RT-11 冒烟 8.6、RT-09 grep 断言、**RT-10 真实模型证据**——2026-08-14 补验
> 场景 6：结构性防线全部生效，观察性结果如实登记）；A8 收尾验收已完成——
> §9 五组全 PASS + §10 五项条件 PASS，**第三阶段总 Exit 决策 = `GO/PASS`**
> （真实 Provider 验证缺口已解除：首轮 400 根因 = wire 名称契约——13 工具名
> 携带点号违反 function.name 约束，非「模型不支持 tools」；修复见决议 #35
> （wire-safe 下划线名 + 注册/序列化双闸门 + reasoning_content 不透明回传 +
> 程序内内容相等校验）；完整真实验收 deepseek-v4-pro `LIVE_SMOKE_PASS`
> 退出码 0）。

- **tool-calling 兼容层（A1 ✅ 已实现，2026-08-14 grep 核对）**：shared/types/
  conversation.ts 新增 `ProviderToolParameter`/`ProviderTool`/`ProviderToolCall`
  接口；`ProviderMessage` role 增 `'tool'`（`toolCallId?` 关联）+ assistant
  `toolCalls?` 重放；`ProviderRequest.tools?: ProviderTool[]`（程序生成，缺省
  undefined = 无工具，共读路径请求无 tools 字段）；`ProviderEvent` 增
  `{type:'toolCalls', toolCalls: ProviderToolCall[]}`——聚合校验完成的整组调用，
  恰好在 done 之前（SSE `delta.tool_calls` 原始分片 `ToolCallFragment` 仅为
  openai-compatible.ts 适配器内部状态，对外不暴露半截 arguments——决议 #30）。
  openai-compatible.ts：`interpretSsePayload` 扩展 tool-delta/finish 帧判定、
  `applyToolCallFragments`（index 分槽累积）/`finalizeToolCalls`（index 升序 +
  id/name 非空 + arguments JSON.parse 且结果为对象，失败 → provider-error）、
  `streamSseBody`（fetch 之外纯管道：解码/分帧/聚合/产出）、`mapMessages`
  （返回 WireMessage：tool → `tool_call_id`、assistant toolCalls → 线格式
  tool_calls 重放）、请求体透传 tools（v1 不发 tool_choice）；
  `supportsToolCalling: true`。fake-provider.ts：`FakeChunk` 联合增
  `FakeToolCallsChunk {kind:'toolCalls', toolCalls, delayMs?}`（整组一步产出，
  arguments 为已拼接合法 JSON）、`FAKE_PROVIDER_METADATA.supportsToolCalling:
true`、getLastRequest 含 tools 断言。context-builder.ts：`ContextBuildInput.
tools?` 恒等透传（未传 tools 时请求字段缺失）。conversation-service.ts 共读
  流出现 toolCalls 事件（供应商异常）→ fail-closed 归一化 internal。
- **共享 Agent 类型（shared/types/agent.ts，A2/A5/A6 ✅ 已实现，grep 核对）**：
  `ToolPermissionLevel`（0=auto/1=auto-visible/2=confirm/3=forbid）、`ToolCall`
  （id/name/arguments 原始 JSON）、`ToolResultErrorCode`（invalid-args/
  tool-not-found/element-not-found/stale-element/not-interactable/forbidden/
  denied-by-user/execution-failed/search-failed 闭合枚举）、`ToolResult`
  （toolCallId/ok/content/errorCode?/warnings?）、`ElementSemantics`（href?/
  isSubmit?/ariaExpanded?/inputType?/A6 增 text?——links/buttons 可见文本，
  确认框 elementText 唯一来源（页面提供不可信）；inputs 不采集；不影响权限
  判定）、`ToolStepDecision` 六值（决议 #33 单一事实源）、`ToolStep`/
  `AgentRunStatus`/`AgentRunSummary`/`AgentConfirmRequest`/`AgentStepEvent`
  （A6 增 argsSummary——审计同源脱敏摘要，非持久化）/`AgentConfirmOutcome`/
  `AgentStatusPhase`（starting/thinking/executing/waiting-confirm/
  confirm-resolved/finalizing）/`AgentStatusEvent`（决议 #34 实时状态——
  确定性运行事实）/`AgentRunDoneEvent`/`ClickAllowedKind`（'submit'|'nav'|
  'expand'|'toggle'|null——click 分类单一事实源 classifyClickTarget 返回值
  类型，A3）/`ElementSemanticsBinding`（elementId + documentId 世代绑定，
  执行器内部参数，A3）。
- **ToolRegistry（A2 ✅ 已实现，grep 核对）**：tool-types.ts——`ToolDefinition`
  （name/description/parameters（ProviderToolParameter 子集）/baseRisk/
  riskLift?{submitClick?}/executor）+ `ToolExecutorFn(call, ctx, signal) →
Promise<ToolResult>` + `ToolExecutionContext`（browser: BrowserController /
  runId / getElementSemantics?）。tool-registry.ts——`registerTool(def): void`
  （工具名唯一，重复注册确定性抛出；**wire 名称双闸门（决议 #35）**——
  `TOOL_NAME_PATTERN` `/^[A-Za-z0-9_-]{1,64}$/` 注册阶段与 listTools 序列化
  阶段双重拒绝非法名（点号/超长/空/非 ASCII））/ `getTool(name): ToolDefinition | null` /
  `listTools(): ProviderTool[]`（只从注册表序列化，按名排序、每次全新对象）/
  `validateToolArgs(name, rawArgs) → {ok:true,args}|{ok:false,reason}`
  （JSON.parse 失败/未知工具/缺必填/类型/enum/未知键/长度上限——字符串 500、
  url 2048（`VALIDATION_LIMITS`）/tabId UUID 形状/elementId `el-N` 形状，
  任何非法输入安全返回不抛异常）/ `resetToolRegistry()`（测试专用）。
  首批 13 工具分三批：A2 只读导航 8 个（get_tabs/get_active_tab/read/open/
  navigate/back/forward/reload，browser-tools.ts `BROWSER_TOOL_DEFINITIONS`
  只经注入 BrowserController 执行，不 import Electron）、A3 交互 4 个
  （find/scroll/click/fill）、A4 search_web；page.extract 与关闭 Tab 工具
  v1 不实现（决议 #21/#28）。
- **权限分级（A2 ✅ 已实现，grep 核对）**：permission-policy.ts——
  `TOOL_BASE_RISK`（13 工具编译期常量矩阵，模型/网页无通道修改，T-06）、
  `isHttpUrl(value): boolean`（仅 http/https，与 Tab 导航白名单同源判定）、
  `decide(toolName, args, elementSemantics | null) → PermissionDecision
{level, reason}` 纯函数。click 确定性允许列表判定优先级：isSubmit===true
  **首先**升级 L2（不因并存 href/ariaExpanded 等特征降回 L1）→ href 存在且
  http/https → L1（href 存在但非 http/https → L3，危险特征不放行）→
  **ariaExpanded 字段存在 → L1（true 与 false 均为展开/折叠控件——§5.4
  「显式声明」语义，A2 实施前校准原 §7.1「=true」为文档疏漏）** → inputType
  checkbox/radio → L1 → 其余（普通按钮/语义不明）→ L3；elementSemantics
  null（历史无该 elementId 元数据）→ L3 fail-closed，不回落到基础 L1、不以
  执行时检查代替。fill：inputType password/file **恒 L3**；类型元数据缺失 →
  L3。open/navigate：URL 非 http/https 恒 L3。未知工具名 → L3（防御）。
  权限层判定结果映射审计决策 auto/auto-visible/confirmed/denied/forbidden
  （校验前失败 = invalid）。
- **确认状态机（A2 ✅ 已实现，grep 核对）**：confirm-manager.ts——
  `ConfirmManager` 类（单 pending；`requestConfirm(runId, toolCallId, toolName,
summary) → Promise<ConfirmOutcome>`（同步段建立 pending；已有 pending 时
  新请求立即决议 denied，fail-closed 不覆盖））；`approve/deny(toolCallId):
boolean`（未知/已终结 id → false，幂等）、`cancelAll(runId): void`（作废
  决议 cancelled，幂等）、`getPending()/isPending(toolCallId)`；**无自动批准**；
  确认等待计入总超时由 A5 执行。
- **审计（A2 ✅ 已实现，grep 核对）**：audit-log.ts——`AuditDecision`
  （auto/auto-visible/confirmed/denied/forbidden/invalid）、`AuditEntry`
  （requestId/toolCallId/tool/argsSummary/decision/ok/errorCode/durationMs）、
  `summarizeArgs(toolName, args)`（键排序确定性；browser_fill 的 text →
  `len=N` 原文零出现；url 全量；其余 ≤ `ARGS_SUMMARY_MAX`=200 截断）、
  `summarizeRawArgs`（解析失败路径原文截断）、`formatAuditMessage(entry)`
  （§10.1 确定性中文格式）、`formatAgentRunAuditMessage(run)`（A5 agent-run
  出口审计条目格式）、`createAuditLogger(log=logInfo)`（薄封装，装配
  注入；全部经 logger sanitize 脱敏）。tool-executor.ts——`ToolExecutor
(confirmManager, audit)` 类 + `execute(call, ctx, signal) →
Promise<ToolResult>`（注册表查找/参数校验 → 权限判定 → 确认状态机 →
  executor → 结构化结果 → 审计**每次调用恰好一条**；任何错误不以 ok:true
  返回；执行层异常归一化 execution-failed 并 logWarn）；预算常量
  `TOOL_RESULT_CONTENT_MAX`=2000 / `READ_TOOL_CONTENT_MAX`=8000 /
  `SEARCH_TOOL_CONTENT_MAX`=4000（A4 接线）+ `truncateToolContent`（总长 ≤
  预算含截断标记，超限附 warnings）。browser-tools.ts 另有
  `serializeSnapshotForTool(snapshot, budget)`（read 章节化序列化纯函数：
  可见文本→标题→表格→链接→按钮→输入固定顺序 + 各节条目上限 + 确定性截断）。
- **交互能力与 elementId 生命周期（A3 ✅ 已实现，2026-08-14 grep 核对）**：
  BrowserController 扩展 `clickElement(tabId, elementId, allowedKind,
expectedDocumentId)/fillElement(tabId, elementId, text, expectedDocumentId)/
scrollTab(tabId, dy)`（安全返回不抛异常；allowedKind/documentId 为执行器
  内部参数——权限决策派生，模型不可见不可写，不进入工具 schema）；
  `classifyClickTarget(semantics) → 'submit'|'nav'|'expand'|'toggle'|null`
  （permission-policy 导出，click 分类**单一事实源**——decide 级别映射与执行器
  allowedKind 同源派生，executor/交互脚本不自行分类）；interaction-script
  固定模板（click=allowedKind 白名单复核后原生 el.click()、fill=原生 value
  setter+input/change、scroll=window.scrollBy；参数只进 JSON 字面量，node:vm
  敌手参数逃逸测试固化）；interaction-normalize（交互结果逐字段校验，异常/
  堆栈/页面原文零穿透）；**elementId 文档世代绑定（决议 #31）**——TabManager
  主框架 did-navigate 提交计数（页内导航不递增）、快照 `meta.documentId` 主
  进程盖章（页面/模型不可伪造）、click/fill 执行前 BrowserController 校验
  「绑定世代 === 当前世代」→ 不符 stale-element 不注入脚本（真实 DOM 红态
  探针实证：跨导航/同 URL 刷新后新文档重新分配相同 el-N，「旧 id 自然失效」
  不成立）；执行时刻实时重新定位 + 元素类型与允许列表语义复核；快照扩展 click
  语义元数据（buttons 条目 isSubmit/ariaExpanded、inputs 条目 isSubmit 已有
  type；严格布尔校验，非法形状丢弃字段）；interaction-tools 四工具
  find/scroll/click/fill（find 实时快照多章节确定性匹配、无命中 ok 空结果；
  read/find 经 ctx.recordSnapshot 登记语义来源 InteractionSemanticsStore
  （按 Tab 键控、世代随绑定）；click/fill 无派生参数 fail-closed）；
  tool-registry paramRules（find text ≤200 非空/fill text ≤2000/dy 整数
  ±50000）；A2 起 ToolExecutionContext 扩展（getElementSemantics 绑定签名/
  recordSnapshot/ToolExecutionDerived）。
- **SearchProvider（A4 ✅ 已实现，2026-08-14 grep 核对）**：
  search-provider.ts——`SearchResult`（title ≤200/url http/https/snippet/source）/
  `SearchProviderResult`（ok/results/errorCode 'search-failed'|'aborted'/
  warnings）/`SearchProvider` 接口（id + search(query, signal)）/
  `BingSearchProvider`（实现类，构造注入 browser/timeoutMs/pollIntervalMs/
  now/sleep/searchBaseUrl——零 Electron import，只经 BrowserController）/
  纯函数 `buildSearchUrl(query, baseUrl=SEARCH_ENGINE_URL)`（encodeURIComponent，
  常量语义不变）/`unwrapBingWrapper`（ck/a u=a1 base64url 确定性还原，仅
  http/https）/`parseBingSearchResults(snapshot | null) → {results, warnings,
hasContent}`（bing 自身域 + 中英双语非结果标签过滤/非 http/https/畸形丢弃/
  URL 去重保持首现/前 10/snippet 恒空串 + warning——扁平快照无可靠关联证据，
  宁缺勿错）+ 常量 `SEARCH_QUERY_MAX_LENGTH`=500/`SEARCH_READY_TIMEOUT_MS`=15000。
  **临时 Tab 所有权与恢复语义（决议 #32）**：本次调用以精确 tabId 独占
  （createTab 返回值，绝不按位置/标题/URL/活动 Tab 推断）；任何路径
  try/finally 最佳努力清理；只关本调用创建的确切 id，已关闭安全无操作不关
  替代 Tab；用户停留 → 恢复调用前仍存在的活动 Tab，已切换 → 不抢焦点，调用前
  活动 Tab 已关闭 → 不重建不激活（沿用 closeTab 正常策略）；并发各持局部
  tabId 零共享状态。**错误映射**：ready 超时/导航失败/Tab 提前关闭/快照 null
  （L3）/L2 降级/空内容快照（结构无法识别）/控制器异常 → ok:false +
  search-failed（不伪装成功空结果）；页面有内容无有机结果（合法空结果）→
  ok:true 空数组 + 明确提示；aborted 由工具层归一 execution-failed。
  search-tool.ts——`SEARCH_TOOL_NAME`/`SEARCH_TOOL_DESCRIPTION`/
  `formatSearchResults(results)`/`createSearchTool(searchProvider)`（schema
  仅 {query}、paramRules nonEmpty、baseRisk 0；ctx.searchProvider 优先于注册
  注入；结果纯文本行零指令性/富文本特权；不暴露 documentId/内部 tabId/快照
  正文/调试字段）。审计：search_web 查询串与 url 同等级**全量**记录（T-03 外发
  审查可追溯，上限 500 有界）；ToolExecutionContext 增 `searchProvider?`
  （A4 注入点，设计 §4.1 落点，A5 AgentLoop 装配复用）。
- **AgentRuntime（A5 ✅ 已实现，2026-08-14 grep 核对）**：agent-loop.ts——
  `AGENT_MAX_STEPS=12`/`AGENT_TOTAL_TIMEOUT_MS=420_000`（含确认等待）/
  `AgentLoopLimits`（可注入）/`AGENT_LOOP_LIMITS`/`AgentRoundRecord`/
  `AgentRunResult`/`AgentLoopCallbacks`/`AgentLoopOptions`/`class AgentLoop`
  （纯编排状态机，零 Electron import：每轮 buildAgentRequest → provider.stream
  累积 → 无工具有文本 done/空轮 no-progress 连续 2 轮/有工具逐条串行经
  ToolExecutor 管线 → 步数/防循环执行前判定；终态单一所有权 finish() 守卫——
  终态时 abort 模型流 + cancelAll 作废 pending + 零后续执行 + 迟到事件忽略；
  工具执行与 Provider 解析与终态 Promise.race（cancel 不挂起）；协议非法
  （空/重复/跨轮冲突 toolCallId）fail-closed error 终态；
  `verifyReasoningReplay`（决议 #35：reasoning_content 回传程序内内容相等
  校验，任何不一致 fail-closed error 终态）；每 run 独立
  InteractionSemanticsStore）。agent-safety.ts——`AGENT_LOOP_SAME_SIGNATURE_
CONSECUTIVE=3`/`AGENT_LOOP_SAME_SIGNATURE_TOTAL=5`/`AGENT_LOOP_NO_PROGRESS_
STEPS=2`/`AgentSafetyLimits`/`AGENT_SAFETY_LIMITS`/`normalizeSignatureArguments`/
  `buildToolSignature`（键排序 + Unicode NFC；解析失败 → NFC 原始串）/`class
AgentSafety`（wouldTriggerLoop 先于 record——触发次在执行前阻断，零副作用；
  无白名单例外——决议 #24）。agent-context-builder.ts——`AGENT_SYSTEM_PROMPT`
  编译期常量（与共读 SYSTEM_PROMPT 互不混用）/
  `buildAgentGoalMessage`（goal + 启动快照 UNTRUSTED_WEB_CONTENT 块，复用共读
  块序列化）/`formatToolResultBlock` + `buildToolResultMessage`
  （UNTRUSTED_TOOL_RESULT 块，闭合转义同 UNTRUSTED 块）/`buildAgentRequest`
  （replay + transcript 原序拼接、tools 恒等透传、未传无字段）。agent-history.ts
  ——`TOOL_STEP_PREVIEW_MAX=200`/`FILL_MASK`/`buildToolStep`/`sanitizeToolCalls
ForPersistence`（fill arguments.text →「（已输入 N 字符）」）/`buildToolStep
Message`/`buildRoundAssistantMessage`/`buildFinalAgentMessage`（finalText +
  AgentRunSummary）/`filterIncompleteToolGroups`/`replayToProviderMessages`
  （完整交互组裁剪 + tool 消息只回摘要——决议 #26）。**决议 #33 校准（六点，
  2026-08-14）**：循环/步数上限在执行前阻断（触发次计步 + 恰好一条审计
  decision=invalid + 一个 ToolStep；stepsUsed === toolStepCount === 审计条数）；
  协议历史 assistant（完整按序 toolCalls + 轮次文本）→ 同序 tool 消息；首轮
  goal+快照恰一次（后续轮不重复插入）；finalText = 最后一个模型轮的文本（与
  终态消息 content 恒等，每轮文本恰好落盘一次）；终态映射 done→complete/
  cancelled→aborted/timeout→error(timeout)/安全终止→error（权威理由在
  AgentRunSummary.status）；`ToolStepDecision` 六值（auto/auto-visible/confirmed/
  denied/forbidden/invalid）单一事实源在 shared/types/agent.ts，audit-log.
  AuditDecision 为别名，execution-failed 保留实际权限决策。ConversationService
  扩展 `agentAsk({sessionId, goal})`/`confirmTool(toolCallId, approve)`
  （共读与 Agent 共享每会话单在途互斥；goal >16000 确定性截断 + warn；Provider
  未配置/不支持 tool calling → 零工具执行；逐步 ToolStep 持久化 + 终态恰好一次）；
  ConfirmManager 增 `onPendingChange`（确认可见性事件源，Service 映射 runId →
  sessionId 防串 run）；FakeProvider 增多轮 `rounds` 脚本/`getRequests()`/
  中止感知睡眠；ConversationStore version 2（写入恒 v2/读兼容 v1/ToolStep 逐字段
  fail-closed/孤立 tool 消息解析丢弃/200 条裁剪组感知）。主进程冒烟 8.4
  A-01～A-09（多步任务/确认 deny・approve/取消含 pending 作废/step-limit/
  loop-detected 触发次零 DOM 副作用/invalid-args 修正/世代 stale/fill 隐私 +
  密码 forbidden/审计恰好一条 + 日志字节扫描）——dev + 生产双场景退出码 0。
- **操作可见性 UI 与通道（A6 ✅ 已实现，2026-08-14 grep 核对）**：IPC 6 通道
  （invoke：conversation:agent-ask/agent-confirm——payload AgentAskPayload/
  AgentConfirmPayload，goal 空串/非串 internal 拒绝 + >16000 确定性截断、
  confirm 逐字段校验未知/迟到 id 幂等 false；事件：agent-step/agent-confirm-
  request/agent-run-done/agent-status——sender+主帧校验复用、只发主窗口）。
  preload bridge 白名单：`agentAsk(sessionId, goal)`/`confirmTool(toolCallId,
approve)`/`onAgentStep/onAgentConfirmRequest/onAgentRunDone/onAgentStatus`
  （eventRelay 模式，每个原生通道只注册一个底层监听、JS 侧 Set 分发与退订）。
  决议 #34 实时状态：shared/types/agent.ts——`AgentStatusPhase`（starting/
  thinking/executing/waiting-confirm/confirm-resolved/finalizing）/
  `AgentStatusEvent`（requestId/sessionId/phase + toolName?/stepsUsed?/
  maxSteps?/confirmOutcome?——确定性运行事实，不含思维过程；stepsUsed 与 A5
  计数一致）/`AgentConfirmOutcome`/`AgentStepEvent.argsSummary`（非持久化
  参数摘要——审计同源 summarizeArgs 脱敏纯函数主进程生成：fill len=N/URL・
  query 全量/其余 ≤200 截断；Store v2 持久化结构不变）/`ElementSemantics.text?`
  （links/buttons 可见文本——确认框 elementText 唯一来源，页面提供不可信；
  inputs 不采集；不影响权限判定）。ConfirmManager：`PendingChange` 判别联合
  （pending/settled 携带 outcome）+ `addPendingChangeListener` 多监听者 Set
  分发 + dispose 退订（关闭 A5「最后构造实例所有权」计划内限制）；tool-executor
  `buildConfirmSummary` 填充 elementText + 目标站点 URL（参数无 url 的工具取
  目标 Tab 的主进程可信 URL）。渲染层：`agent-run-state.ts`——
  `AgentRunUiStatus`/`AgentRunEntry`/`AgentRunsState`/`INITIAL_AGENT_RUNS_STATE`/
  `AgentRunEvent`/`reduceAgentRuns`（按 sessionId/requestId 键控：step 去重、
  错误会话/旧 run/终态后迟到事件忽略、run-done 幂等、新 run 不继承、确认作废
  收敛、会话切换隔离）/`runForSession`/`globalPendingRequest`（确认 UI 全局
  跟随精确 pending）；`agent-display.ts`——`CONFIRM_TEXT_MAX=120`/
  `sanitizeConfirmText`（控制字符与双向控制符剔除 + 截断）/`TOOL_DECISION_LABELS`
  六值含 invalid/`TOOL_ERROR_LABELS`/`AGENT_RUN_STATUS_LABELS` 九值/
  `toolActionLabel`/`describeAgentStatus`（思考中/执行工具 N/12/等待确认/已完成/
  已停止/五种终止理由全覆盖——run.status 权威）。UI 组件：AgentStatusBar（当前
  页面来自 tabs:updated 可信订阅）、ToolCallList（事件顺序渐进/argsSummary/
  失败不可伪装成功）、ConfirmDialog（App 级全局；deny 默认高亮+焦点、Enter 只
  激活焦点按钮、Escape=拒绝、approve 精确 toolCallId 一次提交即禁用、无始终
  允许、confirmTool 返回 false 显示已失效、作废自动关闭）、停止按钮（真实
  requestId abort、双击幂等、「正在停止」非终态）、任务模式（对话/任务切换仅
  渲染层状态；共读 Composer 行为不变；同会话 busy 互斥；模式/折叠/会话切换不
  静默取消 Agent）、ChatView ToolStep 紧凑条目（只渲染持久化 contentPreview/
  decision/errorCode）+ agentRun 徽标、reduceHistory 按消息 id 去重（历史刷新
  与 run-done 竞态不重复气泡）。冒烟 8.5 A6-UI-01～A6-UI-12（React DOM 事件
  驱动真实链路：多步任务状态渐进/search 临时 Tab 零泄漏/确认 deny 默认焦点・
  approve 一次执行/pending 停止作废・迟到 approve 无效/慢模型停止/四种终止
  理由中文/invalid 非成功样式/切换不串 run/磁盘重读 ToolStep 7 条目/fill 零
  原文/敌对 elementText 纯文本/共读互斥）——dev + 生产双场景退出码 0。
  冒烟注入点（仅 SMOKE_MODE，生产不变）：smokeAgentLimits（step-limit/
  timeout 场景）/smokeAgentSearchProvider（受控搜索夹具，委托 Provider 调用
  时读取）。
- **红队矩阵与安全审计（A7 ✅ 已实现，2026-08-14）**：smoke.ts
  `runRedTeamScenarios`（8.6：RT-01～RT-08 + RT-11 离线确定性，6 组敌对夹具
  ——敌对诱导页/探测页/敌对搜索页/提交并存特征页/禁填字段页/click 越权页；
  RT-09 全仓库 grep 断言 + 增量安全审计）+ logger 日志行伪造防御
  （`normalizeLogMessage`——CR/LF 折叠恒单行/ANSI/控制字符按码点剔除，
  `export function` 已核对，13 用例）+ `runLiveAgentScenarios`
  （`AIBROWSE_LIVE_AGENT=1` 门控：Third_stage §7 场景 1–6 + RT-10 敌对页
  （诱导目标全部指向本地安全地址）+ 停止/取消 + 零泄漏终检（Tab/pending/
  临时目录/监听器）+ 真 Key 零暴露扫描 + 模型轮次台账；
  `AIBROWSE_LIVE_AGENT_SUPPLEMENT=1` 定向补验门控：仅修订场景 2/3 + 零泄漏
  终检——2026-08-14 补证使用；**未经用户授权不联网调用付费 API**）。
  **A7 补验（2026-08-14）**：wire 兼容性修复
  （决议 #35）+ 最小预检（`AIBROWSE_LIVE_AGENT_PRE=1`，harness `-Pre`）+
  完整真实验收（deepseek-v4-pro，§7 场景 1–6 + RT-10 + 停止全部真实通过，
  `LIVE_SMOKE_PASS` 退出码 0）+ **定向补验（`-Supplement`，场景 2/3 修订 +
  A3 状态机补齐，12 次 HTTP 全部 200）**——**第三阶段总 Exit 决策 =
  `GO/PASS`**（证据见 Third_stage.md §9/§10 与 progress.md）。

### Fourth Stage Sources 契约速查（定稿 2026-08-15；B1–B9 已实现并 grep 核对，第四阶段总 Exit = GO/PASS（2026-08-16））

> 唯一契约源 `doc/stage4/detailed-design.md`（§2–§16 + §15 决议记录，含 proposal
> Q1–Q12 拍板）；安全契约源 `doc/stage4/threat-model.md`（威胁 ST-01～ST-12、
> 五层防线继承 + 检索/持久化/数据完整新防线、红队矩阵 SRT-01～SRT-12、诚实边界
> 六类残余风险）；任务 B1–B9 见 `doc/stage4/tasks/`（B1 为硬前置决策门）。以下为
> 速查摘要，**签名以详细设计为准，实施后按 `grep -n "^export"` 回填核对**。

- **依赖方向（不可反向）**：`Sources UI / Agent Source Tools → SourceService →
SourceRepository / SourceSearchIndex / SourceChangeJournal → SQLite driver
（主进程）`；renderer/preload/AgentLoop/Tool 零 SQL；UI 与 Agent 共用同一
  SourceService；打开网页继续 browser_open/browser_read（Source Tool 零网络能力）。
- **SQLite driver（B1 ✅ 已完成并冻结，2026-08-15）**：驱动 = `node:sqlite`
  （Electron 43.4.0 / Node 24.18.1 / SQLite 3.53.1 实测；决议 #48 冻结记录——
  基础能力项 ①–⑦、⑩、⑪ 全过，⑧ FTS5/⑨ trigram 可用，中文 ≥3 字符子串命中；
  1–2 字符查询不命中为 trigram 语义 → B3 短查询降级路径）。ExperimentalWarning
  实测不产生（如实记录未压制）。备份三候选：VACUUM INTO 可用 / node:sqlite
  backup API 不存在 / 关闭后复制可行（B7 定稿）。落地：
  `src/main/sources/db/sqlite-driver.ts`——`openDb(path, {busyTimeoutMs,
enableForeignKeys, wal}) → DbHandle` / `closeDb`（幂等）/ `withTransaction`
  （同步语义、异常整体回滚、连接可诊断）；`migrations.ts`——`MIGRATION_V1`
  （B2 ✅ schema v1 全表集，编译期常量、定稿不改写）/ `MIGRATIONS` /
  `validateMigrationList` / `planMigration` / `readUserVersion` /
  `runMigrations`（每级单事务、失败回滚保留原库、未知更高版本
  newer-than-program 零写入）。冒烟 B-01 自动包含于默认
  AIBROWSE_SMOKE=1 矩阵；**冒烟 B-02（B2 ✅，决议 #57 专属门控）**：
  `AIBROWSE_SOURCES_SMOKE=set|check` 两进程共用同一已核验系统 TEMP 子目录
  （均需 AIBROWSE_SMOKE=1 + AIBROWSE_USER_DATA_DIR；与 SESSION_SMOKE 互斥，
  同设报错退出）——set 写 CRUD + journal、check 新进程读回并执行 Undo。业务
  SQL 仅为 Repository 编译期常量 + migration（参数绑定）；driver 仅允许连接级
  运维 SQL 编译期常量（PRAGMA/事务控制，决议 #47）；禁止 exec 动态串/动态表名
  列名/排序表达式/扩展加载。
- **域模型（shared/types/sources.ts，B2 ✅ 已实现，grep 核对）**：Source
  （origin/page 双作用域 + canonicalKey 唯一）/SourceGroup/SourceTag +
  SourcePatch/SourceChangeOp/Set/OpResult/ChangeResult + SourceListItem/
  SourceView/SourceSearchResult/SourceListResult/SourceResult/ManualAddInput/
  ManualPatch/ManualWriteResult/UndoResult/UndoableChange（判别联合）+
  `SourceService` 接口（单一事实源，B4 工具零 Electron 依赖）。Source 字段：
  id/scope/canonicalKey/url/name/groupId/tags/priority(1–5)/enabled/shareMode
  (full|metadata|blocked)/trust{value,assertedBy,verification}/userNote/aiNote/
  createdBy/version/时间戳/deletedAt/lastUsedAt/lastUsageOutcome。note ≤2000、
  name ≤200、tag ≤32×20 个；错误码 `SourceErrorCode` 10 值（+undo-conflict/
  undo-not-found，决议 #52）。schema v1 与 SQL 封闭（决议 #49/#51/#53/#54/#55）。
- **canonicalization（source-canonical 纯函数，B2 ✅ 已实现，grep 核对）**：
  `SOURCE_URL_MAX_LENGTH`=2048 / `containsUrlControlChar(text)` /
  `normalizeSourceUrl(raw, scope) → {ok:true,canonicalKey,displayUrl} |
{ok:false,reason}` / `defaultSourceName(raw, scope)`。仅 http/https、拒
  userinfo 与控制字符、scheme/host 小写、IDN 用 WHATWG URL 解析后稳定 host
  （非 ASCII 路径百分号编码）、去默认端口与 fragment（展示保留 fragment）、
  保留路径大小写/非默认端口/普通 query（utm_* 默认保留）；origin 键 = 规范化
  origin、page 键 = WHATWG href 去 fragment（决议 #50：空路径两形态同身份）；
  duplicate 由 `UNIQUE(scope, canonical_key)` 唯一约束保证（决议 #49，不靠
  先查后写），同 origin 只提示「可能相关」不自动覆盖。
- **change set 结构校验（source-change-set.ts，B2 ✅ 已实现，grep 核对）**：
  常量 CHANGE_SET_MAX_OPS=20/NAME 200/TAG 32×20/GROUP 64/NOTE 2000/SEARCH 500/
  PRIORITY 1–5；`isUuidShape`/`stripControlChars`（C0 除 \t 全剔）/
  `validateChangeSet(raw)`（字段白名单/长度/枚举/URL 形状/trust 通道规则/
  缺省冻结/同 set 重复 sourceId 拒绝，决议 #52）/
  `validateManualAddInput`/`validateManualPatch`（手工通道 blocked 可设、
  trust 恒 user-asserted）/`computeChangeSetFingerprint(ops)`（规范化
  SHA-256，决议 #53）。确认文案 diff 与 Tool 接线归 B4。
- **Repository（source-repository.ts，B2 ✅ 已实现，grep 核对；唯一业务 SQL
  执行点，全编译期常量 + 参数绑定）**：`RepositoryError`（duplicate-source/
  duplicate-journal-key/duplicate-journal-run-tool/version-mismatch/
  sqlite-error 五码）/`translateSqliteError`（实测 3.53.1 冲突消息为列名形态）/
  `SourceRepository` 类（getSourceById/ByCanonical/getSourceRowid/
  getGroupByName/getGroupNameById/getTagByName/listTagsBySource/listSources/
  countSources（groupId 三态 mode 参数）/searchBasic（参数化 LIKE ESCAPE
  前缀，B2 最小检索）/insertSource（唯一约束兜底）/updateSourceFields/
  setSourceDisabled/Restored（决议 #51 状态机）/deleteSource/
  restoreSourceSnapshot（Undo 回放）/upsertGroup/Tag（幂等）/setSourceTags/
  ftsInsert/ftsDelete（决议 #54 镜像）/upsertUsage）。`change-journal.ts`：
  `JOURNAL_MAX_ENTRIES`=100/`JOURNAL_MAX_AGE_MS`=30d/`ChangeJournal`
  （record/findByKey/findByRunTool/listRecent/deleteByKey/removeSource
  （决议 #55 JSON 精确拆分）/prune（双上限注入时钟））/serialize/parseSnapshotMap
  （畸形 fail-closed null）。
- **SourceService（source-service.ts，B2 ✅ 已实现，grep 核对；UI 与 Agent
  共用唯一入口）**：`SourceServiceImpl`（构造注入 `{db, now?}`）——search
  （默认/硬上限 10；B2 参数化最小实现）/list（每页 ≤20；默认过滤
  deleted_at IS NULL）/get/applyChangeSet({runId,toolCallId})（结构校验→
  指纹重放（决议 #53）→逐项预检→单事务全成或全退）/addManual/updateManual/
  disableManual/restoreManual/hardDeleteManual(confirmToken)+
  `issueDeleteConfirmToken(sourceId)`（决议 #56 能力令牌：256-bit/绑定/TTL
  300s/消费即失效）/undoChange（版本冲突拒绝 + 消费幂等，决议 #52）/
  listUndoable（畸形行跳过）/recordUsage/getState（恒 normal，B7 接管）/
  dispose（幂等）；非法输入安全返回不抛异常，不可预期异常归一化
  source-unavailable。
- **写入安全（change set 全链路，B4 ✅ 已实现，grep 核对）**：模型提 ≤20 项
  change set → ToolRegistry 递归 schema 校验（决议 #64）→ ToolDefinition.
  confirmSummary 钩子（决议 #66，ToolExecutor 在 requestConfirm 前调用）→
  `SourceService.previewChangeSet(cs)` 只读预览（与 apply 同一校验语义 +
  逐项预检（版本/blocked 猜测/重复），`buildChangeDiff(ops, rows)` 纯函数
  （≤2000 中文 diff，note 仅长度+首 40 字符预览，控制/bidi 剔除）——零 journal/
  零幂等键/确认前数据库零变化）→ L2 确认（ConfirmManager 复用，deny 默认焦点）
  → approve 后 `applyChangeSet` **重新校验版本（TOCTOU 关闭）** + 单事务提交
  （全部成功或全部 rollback）；主进程生成 idempotency key（重放幂等：同
  (runId,toolCallId) 指纹一致幂等返回、异指纹 fail-closed source-conflict、
  失败零落 journal——决议 #53 已落地 B2）；expectedVersion 乐观并发（不符整体
  拒绝）；blocked 猜测引用（update/disable/restore）→ source-forbidden 零写入
  零泄漏（add 撞 blocked canonicalKey → duplicate 不回注 id，决议 #66）；
  deny/timeout/cancel/迟到/未知 toolCallId 零写入；Agent 无硬删除工具
  （disable/restore 显式，决议 #51 状态机）；手工永久删除二次确认（能力令牌）
  - 清理 FTS/usage/journal 私有 payload（B2 已落地）；手工 UI 同经
    SourceService + Undo；审计脱敏（决议 #67：ops 计数/字段名/长度/版本/成功后
    幂等键；note 正文与 URL 值零出现；source_search 查询 ≤500 但 URL 形态
    query 值脱敏——`redactUrlQueryValue`/`summarizeSourceChangeSet`）。
- **provenance（B2/B5；B6 决议 #82 表述校准）**：trust{value: official|primary|
  secondary|community|unknown；assertedBy: user|ai；verification: asserted|
  unverified}；用户经**手工 Sources UI** 标定 → official+user-asserted；经 AI
  change set（含用户口头「标成官方」——用户确认对话不等于用户通道断言）恒
  official/任意值 + ai + unverified；模型 change set 不能写 assertedBy=user
  （仅用户 UI 通道）、不能设 blocked（防自我隐藏）；UI 必须展示来源。
- **Source Tools v1（B4 ✅ 已实现，grep 核对；B6 决议 #80/#83 校准）**：`src/main/sources/tools/
source-tools.ts`——`createSourceTools(sourceService: SourceService | null)`
  → ToolDefinition[]（source_search/source_list/source_get = L0 有界 + 分享
  模式过滤 + allowlist；source_apply_changes = L2 + confirmSummary 钩子）；
  executor 只经 `ctx.sourceService`（ToolExecutionContext 扩展，缺省回退注册
  注入，两者皆缺 → source-unavailable 安全失败）、零 Electron import、零网络；
  audience 硬编码 'agent'（schema 无该字段，决议 #58）；序列化纯函数
  `formatSourceSearchResults/formatSourceListItems/formatSourceDetail`
  （allowlist：**B6 补齐 ID/规范键/作用域/分组 ID 引用链路**——模型经
  search/list→get→apply 引用条目的唯一标识；`source_get` 返回 expectedVersion
  并发令牌（决议 #65）、version 字段名不回显（决议 #38 校准）、search/list 恒
  无版本字段；metadata 零 note 字节；provenance 标注「用户标定/AI 推断·未核
  验」）；**B6 description 校准（决议 #83）**：说明引用链路与自然语言管理语义
  （「不再优先」= 降 priority ≠ disable；明确禁用/恢复意图才用对应 op；
  description 不描述权限，AGENT_SYSTEM_PROMPT 恒等不变）；错误码 8 值恒等映射
  （mapSourceError；ToolResultErrorCode/TOOL_RESULT_ERROR_CODES/agent-display
  文案同步）；禁具 source_sql/source_delete_hard/source_export_all/任意导入/
  任意抓取/任意通用数据库工具（grep 断言）。注册后 17 工具（冒烟 8.1 断言
  校准，B6 零新增工具）；ToolResult 预算 SOURCE_TOOL_CONTENT_MAX=4000
  （确定性截断 + warning）。
  **递归 schema（决议 #64）**：ProviderToolParameter type 增 object/array
  （properties/required/items/maxItems）；tool-registry 导出
  `MAX_ARRAY_ITEMS`=20/`MAX_NESTING_DEPTH`=4 + 递归校验（additionalProperties
  =false 未知字段拒绝/嵌套 enum/逐项校验）；既有 13 工具 schema 与序列化零
  变化（零回归断言固化）。
- **有界 Retrieval 与隐私（B3 ✅ 已实现，grep 核对）**：search 硬上限 10（默认
  10、limit>10 → source-limit）、list 每页 ≤20、候选有界 200（SQL LIMIT 编译期
  常量）、本地过滤排序（整库不进模型）、返回 allowlist；读取视角**必填**
  `audience: 'user' | 'agent'`（决议 #58：agent 视角 blocked 完全不可见——search
  不命中/list 不列出/get 视同不存在 source-not-found 且不分页空洞/错误差异/
  日志泄漏；user 视角可见可管理；B4/B5 主进程适配器硬编码，模型参数与 renderer
  原始 payload 均不能自行选择）；搜索条目类型 `SourceSearchItem`（决议 #59：
  独立于 `SourceListItem`，note 摘录 `note: {userNote: string|null, aiNote:
string|null} | null` 仅 agent + full 命中携带——userNote/aiNote 各 ≤200 码点
  截断 + 控制/bidi 剔除 + provenance 由字段分离承载；metadata 条目与 user 视角
  恒 null 零 note 字节）；agent get：metadata 无 note 正文（两字段空串）、full
  返回 note；note 读取侧防御性清洗（旧数据/损坏数据同样覆盖）；无备注快速收藏
  默认 metadata、用户写备注默认 full（UI 明示）；检索结果进 UNTRUSTED_TOOL_RESULT
  块（B4 ✅ 已接线——ToolExecutor/AgentLoop 既有 formatToolResultBlock 同源路径，
  冒烟注入 note 夹具断言块隔离 + 闭合转义）与 ToolResult 预算 4000（B4 ✅）；
  普通日志只记 sourceId/字段名/数量/长度/结果数；ToolStep 不复制完整备注
  （contentPreview ≤200 摘要，B-03/B-04 冒烟尾部标记零出现断言）。
- **多语言检索（B3 ✅ 已实现，grep 核对）**：`source-search-query.ts` 纯函数——
  `SEARCH_CANDIDATE_MAX`=200/`SEARCH_NOTE_EXCERPT_MAX`=200/`SearchQueryKind`
  （url|short1|short2|fts|like-long）/`SearchMatchTier`（0–4）/
  `normalizeSearchQuery`（stripControlChars+NFC+trim）/`countUnicodeChars`/
  `classifySearchQuery`（决议 #60 分流）/`buildFtsQuery`（≥3 字符 token 短语包裹
  - 双引号转义，引号/通配符/FTS 操作符/SQL 片段只作数据）/
    `escapeLikePattern`/`likePrefix`/`likeSubstring`/`computeMatchTier`/
    `compareSearchItems`（决议 #61 全序）/`buildNoteExcerpt`。
    `source-search-index.ts`（Repository 层）——`SearchCandidateOptions`/
    `FtsConsistency`/`class SourceSearchIndex`（isFtsAvailable/searchCandidates
    （四条编译期常量 SQL + 参数绑定）/rebuildFts/verifyFtsConsistency（逐行
    MATCH 回查探针））。分流语义（决议 #60）：1 字符仅精确；2 字符精确+前缀+
    参数化字面子串 LIKE（中文 2 字符子串经降级路径诚实交付，**不声称 trigram
    原生支持两字符**——B1 实测 ≥3 才命中）；≥3 字符 FTS5 trigram 主路径；URL
    判定集合 = normalizeSourceUrl 可解析或 http(s):// 前缀 → canonicalKey/url
    精确+前缀。「FTS 不可用」（决议 #62）仅指建库成功后 MATCH/构造失败或
    sources_fts 被破坏 → 参数化降级（note 检索随之不可用，如实登记不伪装成功）；
    数据库整体不可用 → source-unavailable；migration v1 不改写。排序全序
    （决议 #61）：精确 > 前缀 > tag/group > name/domain > note **档位不可跨档**
    （priority 不得反转档位）；priority/recency 仅同档内、lastUsedAt=null 恒末位；
    scope + canonicalKey + id 收尾（origin/page 同键也全序）。大小写语义如实登记：
    SQLite =/trigram 区分大小写、LIKE ASCII 不区分大小写。FTS 与主表同事务同步
    （B2 冻结路径，B3 不重写）+ 诊断性 rebuild/一致性校验（外部内容表语义下计数
    读取内容侧——一致性探针为逐行 MATCH 回查，滞留行查询期被 FTS5 自动忽略、
    rebuild 清除）。bidi 补齐：stripControlChars 增 U+061C/U+2066–U+2069
    （写入侧 + 读取侧同源清洗）。
- **migration/backup/recovery（B1/B7 ✅ 已实现，决议 #86–#89 校准；2026-08-15
  事故恢复加固 + 独立审计 P2 竞态修复，决议 #92）**：启动顺序
  ——只读探测（magic/user_version，不修改原库；绝不先以 WAL 写连接打开；头部
  探测仅固定 16 字节 open/read/close，绝不整库读入）→ 新库
  直接迁移（零无意义备份）/ 当前版本 quick_check → normal / 有效旧版本 →
  VACUUM INTO 一致性备份（决议 #87 冻结；路径参数绑定，决议 #86；源连接只读
  ——备份不写源库；决议 #92 两阶段发布：VACUUM 只写本次调用独占的私有
  staging（mkdtemp 原子创建于已验证 backups 目录内）→ 快照校验（可打开 +
  integrity ok + 版本匹配）→ 硬链接 no-clobber 原子发布（目标已存在 →
  EEXIST 原子失败绝不覆盖，碰撞换新名有界重试，全碰撞 fail-closed；失败仅
  精确清理本次 staging 文件与空目录，绝不递归删除未知内容；
  `createConsistentBackupAt` 任意路径公共导出已移除，生产仅经
  `createConsistentBackup`））→ 逐级单事务迁移 →
  integrity_check/foreign_key_check → normal（迁移期间工作连接 wal:false——
  失败路径主文件字节不变，决议 #88：原路径不得被替换/截断/自动恢复覆盖，
  user_version/schema/数据逻辑恒等，不要求 WAL/SHM 逐字节恒等）；未知更高
  版本/损坏/截断/坏 magic/备份失败/迁移失败/迁移后检查失败 → **只读恢复态**
  （真实生产装配——SourceService db=null 全拒读写/Undo/usage/rebuild + 四
  Source 工具 fail-closed + 中文诊断 + 浏览器其余能力正常 + 原库与备份保留）；
  目录/链接形态与无法创建数据库 → unavailable（非恢复态）；备份保留（决议
  #89 + 加固）：严格命名 + backups 目录内普通文件 + 最新 5 个 + 30 天（两上界
  同时生效），绝不跟随链接/删除原库或无关文件；**目标已存在 fail-closed
  （绝不删除/覆盖调用前已有文件，碰撞换新名有限重试）；backups 目录
  realpath 解析校验（symlink/junction 越界拒绝，prune 链接形态安全空结果 +
  删除前 lstat/realpath 复核）；prune 参数边界验证（非有限/负数/非整数 →
  安全空结果零删除）**；数据库/备份/journal 不进模型上下文。
- **usage 接线（B6 ✅ 已实现，决议 #79/#81）**：`src/main/sources/usage/
usage-tracker.ts`——`MAX_HINTS_PER_RUN`=120 / `SourceSearchHintStore`
  （recordHits(runId, hits)/matchOpenUrl(runId, rawUrl)/clearRun/dispose——
  每 run 独立、按 sourceId 去重首现、FIFO 有界、跨 run 隔离、零 timer 零网络）/
  `SourceUsageTracker`（构造注入 `SourceUsageWriter | null` + `bridge(runId)
→ SourceUsageContext`）。`SourceUsageHit`/`SourceUsageContext` 定义于
  shared/types/sources.ts；ToolExecutionContext 增唯一可选字段 `sourceUsage?`
  （决议 #81）；source_search 成功从结构化结果登记（禁止解析 ToolResult 文本）；
  browser_open 执行后回调（成功→reachable/失败→unreachable/executor 层纵深
  防御 notifyOpen）；AgentLoop.finish() 终态 clearRun（取消/超时/终态后迟到
  工具结果零写入）；conversation-service `AgentRuntimeOptions.usageBridge?
(runId)` 工厂（index.ts 传 SourceUsageTracker.bridge 绑定）。usage 写入
  失败仅脱敏告警（只记 sourceId）安全 no-op——不改变 ToolResult/权限/终态；
  B7 保留 UI 展示「上次使用结果」与运维边界。
- **本地明文边界（B5 如实说明）**：v1 明文保存 URL/分组/标签/备注（OS 用户权限
  保护），不承诺静态加密；API Key 仍只走 safeStorage/DPAPI，绝不进 Sources 库。
- **usage/health（B6 接线 + B7 ✅ 决议 #90/#91）**：无后台巡检；仅 Agent 实际
  经 Source 打开/读取后记录最近一次（unknown/reachable/unreachable/
  auth-required/blocked 五态；v1 可靠信号仅 reachable/unreachable，其余占位
  宁缺勿错）。SourceSearchHintStore 每 run 独立/有界（120 FIFO）/按 sourceId
  去重/跨 run 隔离；source_search 成功从结构化结果登记（禁止解析 ToolResult
  文本）；browser_open 经 ctx.sourceUsage 比对（origin/page 各自规范化匹配；
  一 URL 多命中全记录）；无关 URL/先 open 后 search/跨 run/取消·超时·终态后
  （AgentLoop.finish 清空 hints，迟到工具结果零写入）/无 SourceService 均不
  记录；usage 写入失败仅脱敏告警安全 no-op（不改变 browser_open 的 ToolResult/
  权限/Agent 终态）；零 timer/零网络；不保存正文、不宣称长期健康。
  **B7（决议 #90）**：recordUsage 同一事务更新 usage_events + sources
  last_used_at/last_usage_outcome（两处最近一次投影一致；usage 不算数据变更：
  零 version bump/零 journal/零 Undo/零 changed；Undo 回放不覆盖 usage 两列）。
  **B7（决议 #91）**：FTS 诊断性 rebuild 受控入口 `sources:rebuild-index`（无
  payload）→ SourceService.rebuildSearchIndex（复用 B3 rebuild/一致性）——仅
  Sources UI 通道 + normal 状态（pending 互斥 + 状态门控双保险）；零 Agent
  工具/零 L2 权限变更/零 Undo/零 changed/零 manual 审计；成功失败均有界中文
  诊断（行数对比，无绝对路径）。详情展示「上次使用结果」+ 时间
  （`describeLastUsage`：可达/不可达/其余如实标「暂无可靠信号」），严禁写成
  「健康/长期可用」。
- **Sources UI 与 IPC（B5 ✅ 已实现，grep 核对；决议 #68–#78；B7 ✅ 决议
  #91 扩展）**：
  `renderer/src/ai/sources/`——SourcesPanel（与 AiPanel 互斥切换 sidePanel
  'ai'|'sources'|null，380px 同模式；切换不卸载/遮断 App 级 Agent ConfirmDialog）/
  SourceDetailForm（aiNote 只读展示，trust 仅可设 value，provenance 区分
  用户标定/AI 推断·未核验）/SourceAddForm/HardDeleteDialog（「不可撤销且不能
  Undo」二次确认）/useSourcesPanel（每种加载独立序号守卫忽略迟到响应、卸载
  退订 sources:changed、写 pending 互斥、expectedVersion 冲突提示刷新严禁静默
  覆盖）/sources-display 纯函数（错误码 10 码中文、状态诊断仅「应用数据目录」
  安全标签无绝对路径）；note/name/tag 纯文本渲染（零 dangerouslySetInnerHTML/
  Markdown）。`src/main/sources/source-ipc.ts`——sources:list/get/search/groups/
  add/update/disable/restore/undoable/undo/quick-add/state/prepare-hard-delete/
  hard-delete 适配器（零 Electron import）：参数严格白名单验证（未知字段拒绝）、
  audience 硬编码 'user'、状态三态门控（normal/readonly-recovery/unavailable：
  写入口全拒 + 读入口按决议 #39 一并拒绝）、每次写尝试恰好一条脱敏审计
  （sourceId/操作/字段名/长度/结果码；note 正文/完整 URL/query/删除 token/路径
  零出现）、sources:changed 仅成功变更后最小 payload（renderer 重读）；quick-add
  无参数（main 读取活动 Tab，仅 http/https、page scope + metadata 默认、重复
  →duplicate、同 origin 不同页面 ≤5 条「可能相关」绝不覆盖）；两阶段永久删除
  （prepare 签发 300s 能力令牌 → hard-delete 消费；取消/过期/错绑定/重放零删除）。
  Service 增 listGroups（有界分页 ≤20、名 NOCASE+id 收尾全序）与 quickAddPage；
  Repository 增 SQL_LIST_GROUPS/SQL_COUNT_GROUPS/SQL_FIND_RELATED（编译期常量 +
  参数绑定）。冒烟 8.11 B-05 默认矩阵 + AIBROWSE_SOURCES_UI_SMOKE=set|check
  双进程门控（与 SESSION_SMOKE/SOURCES_SMOKE 互斥；共享系统 TEMP 临时
  userData）。**B7 扩展（决议 #91）**：`sources:rebuild-index` 通道（无
  payload——零 SQL/路径参数）→ SourceService.rebuildSearchIndex；面板「重建
  索引」按钮（仅 normal 状态可触发，pending 互斥受控）；详情显示「上次使用
  结果」（describeLastUsage：可达/不可达/其余「暂无可靠信号」+ 时间；严禁
  「健康/长期可用」）。

### Fifth Stage Research 契约速查（定稿 2026-08-16；C1 已实现，其余任务实施后按 `grep -n "^export"` 回填核对）

> 唯一契约源 `doc/stage5/detailed-design.md`（§2 类型 / §3 状态机 / §4 候选合并
> 排序 / §5 capture·evidence / §6 ResearchRuntime 与预算 / §7 cross-check /
> §8 Result Schema·Renderer / §9 存储 / §10 Tab 所有权 / §11 IPC / §12 边界 /
> §13 测试 / §14 验收 / §15 决议——编号范围以 §15 当前记录为准）；安全契约源
> `doc/stage5/threat-model.md`（FT-01～FT-17 / FRT-01～FRT-12 / 诚实边界十一类）；
> 任务 C1–C10 见 `doc/stage5/tasks/`。**C1–C5 已实现**（C1 契约基座 + 存储基座/C2 ResearchWorkspace/C3 SourceSelector/C4 CaptureService + EvidenceValidator/C5 ResearchRuntime——完成状态以 progress.md 为准）；
> C6–C10 为「规划/待实现」——在对应任务完成前不得宣称已实现（完成状态以
> progress.md 为准）。

- **依赖方向（不可反向）**：`Research UI → ResearchService → ResearchRuntime →
SourceSelector / ResearchWorkspace / EvidenceValidator / ResultValidator →
SourceService / BrowserController / SearchProvider / LLMProvider →
ResearchRepository（独立 research.db）`；Renderer 只消费已验证 Result Schema
  （不得访问 BrowserController、SQLite、Electron、Provider）；renderer/preload/
  Runtime/Tool 零 SQL；Research 不新增注册工具（注册表保持 17；模型轮 tools 为
  六工具编译期子集 browser_open/browser_read/search_web/source_search/
  source_list/source_get——决议 #96）。
- **任务**：ResearchTask（status: created/running/completed/failed/cancelled/
  interrupted + phase: planning/reading/verifying/synthesizing）；单 running
  互斥；start 前置 = Sources 库 normal 态 + Provider 已配置；v1 不承诺跨重启
  续跑（interrupted 可重新开始）。
- **Evidence**：模型只提引用（captureId/type/locator/excerpt 草案）；
  EvidenceValidator 确定性验证（归属/来源存在/摘录规范化匹配/表格坐标边界/
  字段路径存在）；url/title/accessTime/documentId/contentHash 主进程盖章；
  未验证引用不渲染不入库；capture 正文零落盘（仅哈希 + 摘要元数据）。
- **Cross-check**：Claim（severity=high 强制多源）/Coverage（程序计算）/
  sourceTypes（vendor/third-party/community 程序判定）/Conflict（positions ≥2、
  resolved 恒 unresolved——不静默抹平）/Uncertainty 正式输出；**无百分比/分数
  型可信度字段**（schema 白名单红线）。
- **Result Schema**：闭合判别联合（markdown/table/cards/ranking/uncertain）+
  字段白名单 + ResultValidator 逐块校验；Markdown 渲染自实现安全子集（决策 D9：
  raw HTML 关闭、URL 仅 http/https、纯文本兜底、零新依赖）；Timeline/Chart
  非本阶段目标。
- **预算（§6.8 全表，编译期常量）**：候选 ≤24 / 选定 ≤8 / 并发 Tab ≤3 / 单页
  ≤60k 字符 / Evidence ≤60 条·摘录 ≤500 / 轮次 ≤24 / 步数 ≤64 / 时长 ≤30 分钟 /
  请求上下文 ≤200k 字符 / Result ≤200k 字符 / 单任务持久化 ≤500k 字符 /
  保留任务 ≤30；预算用尽 = 正式终态（failed + Evidence 保留，不自动扩预算）。
- **Tab 所有权**：精确 tabId（createTab 返回值）；清理只关本任务 Tab；用户 Tab
  永不关闭；用户关 task Tab → 读取失败继续；跨任务引用拒绝。
- **IPC**：research:create/start/stop/get/result/list/delete/export-csv +
  progress/task-done 事件（sender+主帧校验/参数白名单/事件只发主窗口）；CSV
  导出仅主进程 dialog 安全通道（renderer 零路径参数）+ 公式注入防护 + BOM。
- **UI**：侧栏 ResearchPanel（380px 同模式）仅控制/进度 + 主窗口内大结果画布
  （viewMode 切换，不新开窗口）；表格排序/筛选/来源详情/复制；Evidence 下钻
  （点击结论看来源）。

## 6. 常用命令

- **Node 环境固定（技术基线，§1）**：`node --version` 应为 24.x（`.node-version` = 24.18.0，
  `engines.node` `>=24 <25`）。新环境按 `.node-version` 装好 Node 24 再 `npm install`；
  版本不符时 npm 会给出 engine 警告，先解决版本问题，不要用 `--force` 掩盖。
- **本机环境两个坑（Windows，实测 2026-08-13）**：
  1. 全局环境变量 `ELECTRON_RUN_AS_NODE=1`（可能被本机 node 配置依赖，**不要动全局变量**）——
     任何启动 Electron 的命令前加 `env -u ELECTRON_RUN_AS_NODE`，如：
     `env -u ELECTRON_RUN_AS_NODE npm run dev`
     （PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null; npm run dev`）。
  2. Electron 二进制从 GitHub 下载，Node 24 原生 fetch 默认不走代理；安装依赖用：
     `NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm install`
- **常用脚本**（以 package.json 为准，已核对落地）：
  - `npm run dev` — Electron 开发模式（渲染进程 HMR）
  - `npm run build` — 构建产物 `out/`（main/preload/renderer 三目标，CJS）
  - `npm run start` — 以构建产物启动
  - `npm test` — Vitest 全量测试（当前 1255 用例）
  - `npm run typecheck` — tsc 严格检查（node + web 两套 tsconfig）
  - `npm run lint` / `npm run format` / `npm run format:check` — ESLint / Prettier 格式化 / 检查
  - **冒烟自检**：`env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev`
    （启动 → 窗口 → React 挂载 → preload bridge 链路 → 浏览器核心场景：多 Tab
    创建/切换/关闭、最后 Tab 自动新建、dispose 幂等无泄漏 → T3 起再验证 UI 窗口导航保护
    拦截（远程/同目录 file:/路径穿越三探针，800ms 后 UI URL 不变）与渲染层 bounds 上报生效
    （活动 view y>0）→ T4 起再验证 PageSnapshot 真实采集（本地受控页面 L0 内容对照/
    L1 跨域 iframe 跳过/L3 null/elementId 唯一与跨快照稳定）→ T5 起再验证：敌对页面
    elementId（重复/畸形/超大/冲突烙印 → 唯一且对应活 DOM 真实元素）、Tab 302 重定向
    白名单（允许目标跟随/禁止目标 custom:// 拦截 + 日志断言）、UI 端到端（React DOM 点击/
    键盘驱动：地址栏 URL/搜索、多 Tab、后退前进刷新、标题随网页变化、调试面板 L0/L1 徽标
    - warnings 展示）、远程页面隔离探针（window.aibrowse/process/require/electron 均
      undefined）→ S3 起再验证 AI 共读场景（FakeProvider 离线：流式端到端/selection 独占/
      防串页/L3 降级/薄快照/中止/错误归一化/会话持久化与删除/ephemeral 不落盘）→ S4 起
      再验证 UI 端到端矩阵 1–12（流式分块渐进 DOM/selection/防串页/L3/薄快照/中止/错误
      归一化/会话管理 UI/布局 bounds 380 收缩与恢复/Key 不可达——DOM 与日志字节扫描 +
      credentials.json 密文 + 白名单无读回/注入结构断言/远程隔离回归；矩阵见
      doc/stage2/detailed-design.md §13.2）→ A2/A3/A4 起再验证工具层探针（注册表恰好
      13 个工具（A2 8 + A3 4 + A4 search_web）+ listTools 恒等 + 经 ToolExecutor
      走真实 BrowserController 的 get_tabs/read 成功、javascript: URL forbidden
      不建 Tab、非法 tabId → invalid-args、未知 tabId read → execution-failed、
      search_web 空查询/超长 invalid-args + 日志切片 7 条审计恰好一次一条）→
      A3 起再验证交互场景 8.2（真实 DOM：
      A-12 click 允许列表四类点击（含 nav 真实导航）/提交类 deny・approve 确认门/
      非允许列表与「立即购买/删除账户」forbidden 零 DOM 动作/权限判定后动态变化
      执行器复核拒绝/fill 隐私（len=N 零原文 + input/change 事件真实触发 +
      password/file/disabled/readonly/隐藏零写入）/scroll 边界/find 多章节与
      无命中/elementId 世代（同文档稳定、导航/刷新后 stale-element、重新快照
      不碰撞、类型复核）/每次调用审计恰好一条）→ elementId 生命周期红态探针
      （跨导航/同 URL 刷新重新分配 el-N 证据）→ A4 起再验证搜索生命周期场景 8.3
      （受控搜索页夹具三形态：有结果——包装链接还原/自身导航・重复・非 http・
      非结果标签过滤/摘要空串零误配/documentId 零暴露/服务端命中计数证明真实
      loadURL、合法空结果 ok:true 明确提示、结构无法识别 ok:false search-failed；
      临时 Tab 精确清理 + 数量恢复进入前 + 活动 Tab 恢复调用前；审计恰好一条
      decision=auto）→ 可选公网 Bing 探针（`AIBROWSE_SMOKE_LIVE_SEARCH=1`，
      需网络；成功断言结构、失败仅记录跳过原因不作失败，硬性断言只有临时 Tab
      零泄漏）→ A5 起再验证 Agent Runtime 场景 8.4 A-01～A-09（FakeProvider
      多轮脚本离线确定性，主进程驱动完整生产链路 agentAsk → AgentLoop → 13 工具
      注册表 → 权限/确认/审计 → 真实 BrowserController/SearchProvider 受控夹具：
      A-01 多步任务（open/read/find/search_web/scroll/click 真实执行 + 最终回答 +
      协议历史合法序 + 13 工具请求 + system 恒等 + goal 恰一次 + 搜索临时 Tab
      run 内零泄漏）/A-02 提交类确认 deny 零动作・approve 执行（审计 denied/
      confirmed 各一）/A-03 慢模型中停 cancelled 部分保留 + pending 作废零执行/
      A-04 step-limit（注入 maxSteps=3 第 4 步零执行）/A-05 loop-detected
      连续第三次执行前阻断（触发次零 DOM 副作用，阻断步骤 decision=invalid）/
      A-06 invalid-args 回注后调整成功/A-07 reload 后旧 elementId stale-element
      新快照正常（传递性证明零误操作）/A-08 fill 隐私（审计 len=N + password
      forbidden 零写入 + 会话文件/日志字节扫描零原文）/A-09 每步审计恰好一条 +
      run 审计 2 条 + 日志无 Key/fill 值）→ A6 起再验证操作可见性 UI 场景 8.5
      A6-UI-01～A6-UI-12（React DOM 事件驱动真实链路：任务模式多步任务状态
      渐进（思考→执行工具→已完成、ToolCallList 7 步顺序/参数摘要/7-12 徽标/
      搜索临时 Tab 零泄漏）/确认框 deny 默认焦点（document.activeElement）+
      拒绝零 DOM 动作 + approve 一次执行（审计 denied/confirmed 各一）/pending
      停止→确认框作废关闭→迟到 approve 无效/慢模型中途停止 cancelled + 部分
      保留/step-limit・loop-detected・no-progress・timeout 中文理由 + invalid
      条目非成功样式/invalid-args 回注修正/模式・会话・面板切换不串 run + 共读
      互斥/历史刷新无重复回答 + ToolStep v2 磁盘重读 7 条目/fill 页面真实写入
      - DOM・日志・会话文件零原文/敌对 elementText 纯文本截断 + 无富文本注入 +
        无自动批准/共读回归）→ A7 起再验证 8.6 红队矩阵 RT-01～RT-08 + RT-11
        （6 组敌对夹具：诱导文案结构隔离/URL 白名单 + 日志行伪造防御（行首
        时间戳前缀真实审计行数 == 工具调用数）/提交并存特征确认门/搜索结果
        注入块隔离/密码・文件・动态变形零写入/陈旧 elementId 传递性证明/
        system・Key 探测零暴露/确认疲劳独立确认/通用 click 越权 L3 零 DOM——
        RT-09 grep 断言与 RT-10 真实场景见验证与报告）→ 可选真实 Provider
        Agent 验证（`AIBROWSE_LIVE_AGENT=1` 门控，需用户授权——询问边界，
        未授权不联网调用付费 API：Third_stage §7 场景 1–6 + RT-10 + 停止/
        取消 + 零泄漏终检 + 真 Key 零暴露扫描 + 模型轮次台账；诱导目标全部
        指向本地安全地址）→ B8 起再验证 8.15 红队矩阵 SRT-01～SRT-12
        （决议 #93 校准，每项独立断言：敌对收藏诱导页/敌对 note 块隔离/
        禁具与上限/注入仅作数据/canonicalization 欺骗/中途失败整体回滚/
        重放・迟到・跨 run/逐通道字节级隐私扫描（敏感标记运行时分片构造）/
        8.14 证据核验/hard delete 清理/垃圾上界/8.6 证据核验 + RT-09 扩展
        静态审计分类证据；RT-10 未授权 NOT RUN——证据见 threat-model
        §4.1）→ 自动退出，退出码 0 即通过；日志链见 log/）。
        生产产物路径同样可跑：
        `AIBROWSE_SMOKE=1 npm run start`（file: 入口精确匹配导航保护）。可选真实网页加载验证
        （需网络）：`AIBROWSE_SMOKE_URL=https://www.bing.com/` 附加设置（15 秒超时，验证
        state=ready + 标题非空）。
  - **Session 跨进程持久化冒烟**（§十四 Session 验收，以生产产物验收，需先 `npm run build`）：
    两个独立应用进程共用同一临时 userData——进程 A
    `AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set` 经受控页 Set-Cookie（HttpOnly）写入
    persist:aibrowse 分区后完整退出；进程 B `AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=check`
    新进程读回 Cookie。两进程均需 `AIBROWSE_SMOKE=1`（缺省不会运行冒烟、只启动普通应用）与
    `AIBROWSE_USER_DATA_DIR=<临时目录>`（app ready 前 setPath，不触碰用户真实数据，测试后
    清理该目录）；命令（与 README 一致）：
    `env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set AIBROWSE_USER_DATA_DIR=<临时目录> npm run start`
    （check 同理），退出码 0 即通过。
  - **B-05 Sources UI 跨进程冒烟（B5 专属门控）**：`AIBROWSE_SOURCES_UI_SMOKE=set|check`
    两独立生产进程共用同一系统 TEMP 临时 userData（与 SESSION_SMOKE/SOURCES_SMOKE
    互斥）；set 经真实 DOM → preload → IPC → SourceService 快速添加 + 编辑；check
    新进程读回 → Undo → 两阶段永久删除并确认消失且无 Undo；测试后清理临时目录。
  - **真实 Provider 可选验证（S5 落地，长期安全测试流程，S6 起为通用规则）**：
    两个 env 门控场景，均需 `AIBROWSE_SMOKE=1` + `AIBROWSE_LIVE_PROVIDER=1` +
    `AIBROWSE_TEST_API_KEY`（无 Key 环境跳过并记录、回退离线矩阵，不作为失败）：
    - **S5 一问一答**（缺省）：固定问题「用一句话回答：1+1 等于几」真实流式一问一答
      （完整生产链路 UI → IPC → ConversationService → ContextBuilder → OpenAI-compatible
      Provider → 流式事件 → DOM；断言流式 delta / turn-done complete / 回答非空 /
      配置与日志使用记录 / **真 Key 零暴露扫描**：DOM、日志切片、全部临时文件均不含
      Key、凭据文件为密文形态）。
    - **S6 多网站共读**（`AIBROWSE_LIVE_SITES=1`，§10 Exit Gate 证据）：多个真实网站
      各对应一个明确验收项——普通文章页（正文提问 + 总结）/ 长文页（确定性裁剪 +
      warnings + 回答可用）/ 表格页（信息提取）/ selection 独占 / 切 Tab 与刷新
      （URL、capturedAt、内容更新，旧页内容不串入）+ 同套 Key 零暴露扫描。
    - **调用规则（2026-08-13 用户更新取消固定次数上限；2026-08-16 用户更新长期
      授权）**：**不设固定 API 调用次数**。每次真实调用必须服务于明确的验收项、
      问题定位或修复复验；**禁止**无界循环、无诊断依据的重复请求和无关问题测试；
      完成报告必须列出实际调用次数及每次用途。失败时区分 Provider 侧问题
      （余额/权限/服务/模型）与代码缺陷，不得为排查打印 Key、削弱安全机制或
      无限重试。**2026-08-16 起真实 Provider 已获用户长期授权（决议 #117）**：
      后续 Agent 在后续任务中按需使用，**无需逐次申请授权**；授权不等于强制调用
      （无真实 Provider 产品链路的任务正常为 0 次，不得为「展示授权」发起无关
      调用）；本地凭据缺失时记录「凭据不可用」，**不得再写「未获授权」**。
      **凭据与启动的通用流程（长期规则，后续 Agent 直接复用，不重新索取/重新设计）**：
      ① 本地说明文件固定路径 `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md`
      （后续 Agent **优先读取本地说明**获取 Provider kind / base URL / model / DPAPI
      文件路径 / 注入规则——base URL 与 model **只存在于本地说明**，不写进项目文档；
      说明严禁写入明文 Key/DPAPI 密文/请求头/任何可用于认证的数据，不得入库/快照/报告）；
      ② API Key 用 Windows DPAPI 加密保存在仓库外 `%LOCALAPPDATA%\AIbrowse\S5\provider-key.dpapi`；
      ③ 仅通过受控子进程的环境变量 `AIBROWSE_TEST_API_KEY` 短暂注入（应用读取后立即从
      process.env 移除；禁止命令行参数/明文文件/聊天输入）；测试子进程用仓库外启动脚本
      `%LOCALAPPDATA%\AIbrowse\S5\run-live-smoke.ps1`（`-Sites` 开关进入 S6 多网站场景；
      `-Agent` 进入 A7 真实 Agent 完整场景；`-Pre` 进入 A7 补验最小 tools 兼容性预检
      （仅场景 1 + 零泄漏终检，1 次调用量级，完整场景需用户二次授权）；
      `-Supplement` 进入 A7 补验补证定向补验（仅修订场景 2/3 + 零泄漏终检，
      2026-08-14 证据缺口裁决后使用）；
      DPAPI 解密 → 短暂赋环境变量 → 启动冒烟 → finally 清环境变量 + ZeroFreeBSTR 清零
      明文内存 + 清理临时 userData；脚本纯 ASCII——PowerShell 5.1 按 ANSI 解析无 BOM 的
      .ps1，中文会破坏解析）；④ 测试结束清除环境变量、明文内存和临时目录；⑤ 完成报告
      只列出调用次数与用途，不报告凭据或机器专属配置。
      **无可用凭据（DPAPI 密文 + 本地说明缺失）不得联网调用任何付费 API**（凭据
      缺失 = 「凭据不可用」，与授权无关——2026-08-16 起授权已长期生效，不再逐次
      申请）；DPAPI 文件与本地说明默认保留供后续阶段复验，未经用户要求不得删除
      或轮换测试 Key。
- **git 双远程**（已初始化，2026-08-13 双远程推送验证）：
  ```bash
  # 日常推送：Gitee 直连
  git push gitee main
  # GitHub：经本机代理（git 只认 http.proxy 键；本机全局的 https.proxy 是无效键）
  git -c http.proxy=http://127.0.0.1:7890 push github main

  # 提交前必做：git status --short 复查工作区，无多余文件/敏感信息/构建产物
  ```
- **代理配置（已确认可用，2026-08-13 实测）**：本机代理 `http://127.0.0.1:7890`（Clash 类），
  github.com 经代理可达；Gitee 直连/代理均可达。⚠️ **git 的合法代理键是 `http.proxy`**
  （本机全局配置的 `https.proxy` 是无效键、会被静默忽略，导致推送时直连 github 超时）；
  推送 GitHub 一律用 `-c http.proxy=http://127.0.0.1:7890`。

## 7. 测试约定

- **框架**：Vitest 4，`environment: 'node'`（纯逻辑零环境依赖，分层纪律）；测试文件 `src/**/*.test.ts`。
- **重点测核心业务逻辑**（First_stage.md §十三），至少覆盖：
  - ✅ 地址栏输入 → URL / 搜索判断（`src/shared/url.test.ts`，15 用例，T0 红→绿落地）
  - ✅ Tab 状态机纯逻辑（`src/main/browser/tab-state.test.ts`，14 用例，T2 红→绿落地）
  - ✅ 网页权限策略默认拒绝（`src/main/browser/permission-policy.test.ts`，4 组用例，安全补丁）
  - ✅ UI 窗口导航保护自身来源白名单（`src/main/ui-navigation-policy.test.ts`，10 用例，T3 红→绿落地 + T4 收紧精确匹配）
  - ✅ PageSnapshot 数据规范化（`src/main/browser/snapshot-normalize.test.ts`，46 用例，T4 红→绿落地：
    不可信输入→L2 合法快照、限额二次截断、elementId 格式过滤、非法条目丢弃、表格行列对齐、
    warnings 去重）
- Second Stage（规格见 doc/stage2/detailed-design.md §13.1）：
  - ✅ S1（2026-08-13 红→绿落地，81 用例）：error-normalize 状态码矩阵与脱敏断言（18）、
    FakeProvider 确定性分块/错误注入/中止/getLastRequest（12）、OpenAI-compatible SSE
    分帧/帧判定（含末帧 delta+usage 同帧）/消息映射纯函数（12）、resolveProvider 注册表
    与 not-configured 路径（6）、credential-store 密文落盘/损坏容错/不可用降级/纯格式
    （16，cipher 后端注入测试替身，safeStorage 行为由冒烟验证）、config-store 校验规则
    与持久化（11）、logger sanitize `sk-…` 形态与 apiKey 键值对脱敏（6）。
  - ✅ S2（2026-08-13 红→绿落地，72 用例）：context-budget 确定性裁剪（42：预算优先级/
    各节与条目上限/总预算停止/截断标记/历史裁剪轮数与字符/单条重放上限与来源行/布局表
    过滤边界）、context-builder 角色隔离（30：system 恒等/块闭合转义与属性转义/注入文案
    夹具/selection 独占/模式推导矩阵/薄快照/L2 降级/历史重放/问题截断/warnings 合并/
    buildContextSource）。
  - ✅ S3（2026-08-13 红→绿落地，57 用例）：conversation-store 纯格式与文件读写（27：
    消息/会话形状校验、索引不含 ephemeral、整体损坏 fail-closed、上限裁剪、title 推导、
    原子写无 tmp 残留、删除含残留 tmp）、conversation-service 编排（30：生命周期/上限
    拒绝新建、§6.1 时序——实时采集防串页/L3/selection 独占/薄快照/先持久化 user 消息
    （磁盘探针）/错误归一化/not-configured 零网络、busy/abort 幂等与部分保留/dispose/
    deleteSession 中止不复活文件/ephemeral 不落盘与切换/重启恢复/200 条裁剪）。
  - ✅ S4（2026-08-13 红→绿落地，22 用例）：stream-state 纯 reducer（10：delta 追加/
    turn-done 收敛以终态全文为准/aborted-error 保留部分/requestId 不匹配竞态残留忽略/
    ask 拒绝文案）、history-events 历史收敛（6：乐观追加/turn-done 补 contextSource +
    追加终态/磁盘历史不覆盖/替换）、context-badge-format 徽标文案映射（6：selection
    N 字/snapshot thin-degraded 提示/none 原因）。UI 端到端矩阵 1–12 由 Electron 冒烟
    覆盖（§6）；IPC/bridge 参数校验与 Key 只写不回读为 main/preload 胶水层（冒烟断言）。
- Third Stage（规格见 doc/stage3/detailed-design.md §13.1）：
  - ✅ A1（2026-08-14 红→绿落地，35 新增：openai-compatible 27 / fake 5 / context-builder 3；
    另有 fake/llm 各 1 处 metadata 断言原位校准为 supportsToolCalling=true，基线 326 → 361）：
    interpretSsePayload tool_calls 帧判定
    （首分片/arguments 分片/同帧多工具/content 同帧/finish 同帧/非法帧矩阵）、
    applyToolCallFragments 分槽累积 + finalizeToolCalls 聚合校验（index 升序/
    arguments 非法 JSON 与非对象/id・name 空 → 失败）、streamSseBody 管道
    （跨帧拼接 + finish_reason 收尾顺序：toolCalls 恰在 done 之前/同帧多工具按
    index 升序/文本先于工具/usage 透传/非法帧与非法 arguments → provider-error/
    finish=stop 丢弃半成品/无 [DONE] 干净结束/CRLF 归一化）、mapMessages tool 与
    assistant tool_calls 重放、FakeProvider 工具脚本（整组产出/延迟/确定性/
    getLastRequest tools 恒等/abort 不产出工具调用）、buildContext tools 恒等透传
    （未传 tools 无字段）；冒烟矩阵 11 校准 + A1 工具探针。
  - ✅ A2（2026-08-14 红→绿落地，91 新增：tool-registry 17 / permission-policy 18 /
    confirm-manager 9 / audit-log 14 / tool-executor 14 / browser-tools 17 /
    logger 审计形态回归 2，基线 361 → 452）：注册表（重复注册拒绝/listTools 恒等与
    排序/executor 不外泄/校验矩阵——JSON 解析失败/非对象/缺必填/未知键/类型/enum/
    长度 500 与 url 2048 边界/tabId UUID 形状/elementId el-N 形状/任意垃圾输入不抛
    异常）、权限矩阵全表（13 工具 × 条件判定；click 允许列表各分支——nav 链接/
    ariaExpanded true 与 false 均为 L1/isSubmit 优先升级 L2 且不因并存特征降回/
    checkbox・radio/普通按钮与危险 href L3/语义缺失 fail-closed；fill password・
    file 恒 L3；open/navigate scheme L3；确定性同一输入同一决策）、确认状态机
    （单 pending/approve/deny/未知与已终结 id false/幂等/cancelAll 作废/无自动
    批准/并发请求 fail-closed）、审计脱敏（fill text len=N 原文零出现/URL 全量/
    确定性截断与键序/Key 形态 sanitize 链零暴露/无堆栈形态）、ToolExecutor 管线
    （成功/校验失败/L3 不执行/deny 与 approve 与作废/执行异常归一化/结果截断
    2000+标记+警告/已中止信号/错误永不以 ok:true 出现/每次调用审计恰好一条）、
    8 工具 BrowserController 注入调用（read 实时采集逐次调用/tabId 缺省解析/
    false・null 失败安全映射/序列化章节顺序与条目上限与确定性）、冒烟工具层探针
    （dev + 生产双场景，5 条审计日志实证）。
  - ✅ A3（2026-08-14 红→绿落地，81 新增：interaction-script 28 / interaction-normalize
    11 / interaction-semantics 9 / interaction-tools 12 / permission-policy 3 /
    snapshot-normalize 5 / tool-registry 4 / tool-executor 8 / browser-tools 1，
    基线 452 → 533；既有 452 用例仅机械夹具更新零删除零削弱）：交互模板经 node:vm
    假 DOM 真实执行（模板编译期固定/JSON 字面量往返恒等/敌手参数引号・反斜杠・
    闭合片段・脚本字符串不能逃逸；click not-found/nav 接受与 javascript:・非 A
    拒绝/expand true 与 false 接受・属性消失拒绝/toggle 接受・类型变化拒绝/submit
    三形态接受・form 外无 type 与 reset 拒绝/未知 kind bad-args/不可见禁用
    not-interactable；fill 原生 setter+冒泡 input/change 事件/password・file
    执行层再拒/disabled・readonly・隐藏拒绝/非输入框 not-fillable/原型篡改 error；
    scroll 整数 ±50000 与 viewport；querySelector・getAttribute 抛异常结构化
    失败）、交互结果形状校验（click/fill/scroll 成功形状逐字段/失败 code→错误码
    闭合映射/reason 截断折叠/畸形输入不抛异常）、快照语义映射与存储（links/buttons/
    inputs 合并/跨集合同元素/按 Tab 隔离/世代绑定/clear）、find 确定性匹配
    （章节固定顺序/无命中空结果/大小写敏感/inputs 多字段/节选截断）、scroll/click/
    fill executor（无派生参数 fail-closed 不触碰 BrowserController/派生参数透传/
    stale-element 映射/fill 内容零原文）、classifyClickTarget 与 decide 同源
    双表对照（submit→L2、nav/expand/toggle→L1、null→L3）、paramRules（dy 边界/
    text 长度同名字段差异化/非空）、ToolExecutor derived（L1/L2 approve 派生
    allowedKind+documentId/fill 仅 documentId/L3 无 derived/tabId 解析）、read
    recordSnapshot 登记、快照语义元数据（buttons isSubmit/ariaExpanded 严格
    布尔、inputs isSubmit 透传不合成、meta.documentId 主进程盖章敌手伪造无效）。
    冒烟 8.2 A3 交互场景（真实 DOM：A-12 允许列表/确认门/执行器复核/世代校验/
    fill 隐私/审计恰好一条）+ elementId 生命周期红态探针（跨导航/同 URL 刷新
    重新分配证据）；8.1 校准为注册表 12 工具。dev + 生产双场景退出码 0。
  - ✅ A4（2026-08-14 红→绿落地，43 新增：search-provider 28 / search-tool 14 /
    audit-log 1，基线 533 → 576；既有用例零删除零削弱——audit-log「其余截断」
    用例改用 browser_find 覆盖属决议 #32 契约校准）：解析矩阵（正常结果组装与
    顺序/确定性去重保持首现/source 恒 bing/非 http・https 与畸形 URL 丢弃计数
    警告/bing.com 子域过滤与形似域名不误伤/中英双语非结果标签过滤/ck/a 包装
    链接 base64url 还原与非法形态丢弃/前 10 条/title 200 截断/snippet 恒空串 +
    warning/空 links 与 null 与结构退化安全降级）、生命周期所有权矩阵
    （成功链路精确 tabId 快照与关闭/URL 编码构造/用户停留恢复活动 Tab/用户
    切换不抢焦点/调用前活动 Tab 已关闭不重建不激活/临时 Tab 提前关闭安全无
    操作/ready 超时注入时钟/导航 error 快速失败/快照 null（L3）与 L2 降级
    search-failed/结构无法识别 vs 合法空结果区分/Abort 前后两阶段/query 校验
    不建 Tab/控制器异常归一化/敌手 createTab 返回已存在 id 不纳入清理/并发
    调用互不清理对方 Tab/任何路径无临时 Tab 泄漏）、search_web 工具（常量
    schema/序列化纯文本行/snippet 空省略/成功与失败与取消映射/ctx.searchProvider
    优先/管线 L0 auto 恰好一条审计/query 空串・超长・缺失・未知键・类型不符
    invalid-args 零 Provider 调用/500 边界/4000 截断附 warning/查询串全量审计）。
    冒烟 8.3 受控搜索页生命周期（三夹具形态 + 服务端命中计数 + 活动 Tab 恢复 +
    审计恰好一条）；8.1 校准为注册表 13 工具；可选公网 Bing 探针成功
    （10 条真实结果）。dev + 生产双场景退出码 0。
  - ✅ A5（2026-08-14 红→绿落地，123 新增：agent-safety 17 / agent-context-builder
    15 / agent-history 17 / agent-loop 32 / conversation-store 22 /
    conversation-service 14 / fake-provider 4 / confirm-manager 3，基线 576 →
    699；既有用例零删除零削弱——store 既有 1 处版本断言随 v2 契约原位校准
    （version 2 为写入版本）；期间修正均为测试自身断言缺陷，实现侧真实缺陷
    2 处——工具执行 await 未与终态竞争（cancel 挂起）、run 审计出口冒烟未接线）：
    agent-safety 签名规范化（键排序/NFC/非法 JSON 原始串/嵌套递归排序/数值类型
    区分）+ 循环判定（连续 3 在执行前阻断/非连续累计 5/read 无白名单例外/被拒与
    失败同样计签/不同签名打断连续/触发次也计入/阈值注入/no-progress 连续 2）；
    agent-loop 状态机全路径（多步 done/协议历史合法序与 toolCallId 精确关联/
    文本+工具同轮为过程性输出/goal 不重复插入/invalid-args・tool-not-found・
    forbidden・execution-failed 结构化回注后继续/execution-failed 保留实际权限
    决策/L2 deny・approve・取消作废・总超时与确认竞争/step-limit 边界（13 调用
    只执行 12、未执行零审计零伪造、步数用尽后最终回答仍 done）/防循环执行前
    阻断（连续 3・累计 5・invalid-args 计签键序不能逃避）/no-progress 两轮与
    打断/Provider 错误直传与流异常归一/用户取消部分保留/终态竞态（done 后迟到
    abort 忽略、门闩流 abort 抢先、工具挂起时取消 run 不挂起且迟到结果无 step
    事件、终态后零后续工具、审计仍恰好一条）/空・重复・跨轮冲突 toolCallId
    fail-closed）；agent-context-builder（AGENT_SYSTEM_PROMPT 恒等且与共读
    互不混用/goal+启动快照块闭合转义/快照 null 降级/goal 截断/tool 块 ok・
    error_code 属性与敌手闭合转义/tools 恒等透传与未传无字段/replay+transcript
    原序拼接/goal 恰一次）；agent-history（ToolStep 内部能力参数零出现/
    contentPreview ≤200/decision 六值/FILL_MASK/assistant toolCalls fill 脱敏/
    轮次与终态消息组装/完整交互组校验——孤立 tool 丢弃・不完整组整组丢弃・
    toolCallId 错配丢弃/重放只回摘要 + 完整组预算裁剪）；conversation-store
    v2（写入恒 v2/读兼容 v1/未知版本 null/tool 消息必填 toolStep+toolCallId/
    ToolStep 逐字段 fail-closed/decision 六值/assistant 扩展字段形状非法丢字段
    保留文本/孤立与重复 tool 消息解析丢弃/组感知 200 条裁剪/真实文件字节断言
    fill 原文・快照正文・Key 形态・documentId 零落盘）；conversation-service
    agentAsk（goal 空串与非串拒绝/超 16000 截断/共读与 Agent 双向互斥/not-found/
    Provider 未配置 not-configured 零审计/不支持工具请求无 tools 字段与工具
    事件 fail-closed/多步 ToolStep 持久化 16 条协议序/事件恰好一次/ephemeral
    不落盘/重启恢复/abort 部分保留/deleteSession 不复活/confirmTool 转发与
    防串 run 事件映射）；fake-provider 多轮 rounds 消费与回退/getRequests/
    中止感知睡眠；confirm-manager onPendingChange（建立/决议/作废回调幂等）。
    冒烟 8.4 A-01～A-09 主进程真实链路（多步任务 7 步/16 条历史/13 工具请求/
    搜索临时 Tab 零泄漏/确认 deny・approve/取消含 pending 作废/step-limit/
    loop-detected 触发次零 DOM 副作用/invalid-args 修正/世代 stale/fill 隐私 +
    密码 forbidden/审计恰好一条 + 日志字节扫描）。dev + 生产双场景退出码 0。
  - ✅ A6（2026-08-14 红→绿落地，67 新增：agent-run-state 23 / agent-display 23 /
    history-events 1 / confirm-manager 2 / interaction-semantics 1 /
    tool-executor 3 / agent-loop 7 / conversation-service 7，基线 699 → 766；
    既有用例零删除零削弱——confirm-manager 3 与 interaction-semantics 3 为
    决议 #34 契约校准原位更新）：agent-run-state（start/starting 收养/thinking・
    executing 合并计数/confirm 建立 pending/waiting-confirm 相位/confirm-
    resolved 清 pending 记 outcome/step 按序追加与 toolCallId 去重/错误
    requestId・未知会话・旧 run 事件忽略/run-done 收敛与幂等/终态后迟到
    status・step・confirm 忽略（不把终态改回 running）/终态后新 starting 新
    run（不继承 steps/pending/终态）/running 中异 requestId starting 防御忽略/
    stop-requested stopping 与重复幂等/rejected 竞态残留忽略/两会话隔离/
    runForSession・globalPendingRequest 选择器）；agent-display（sanitize
    控制字符・双向控制符・零宽字符剔除/120 截断/非串空串安全返回/决策六值・
    错误码・run 状态九值文案全映射/工具动作文案/状态栏描述全相位与五种终止
    理由——run.status 权威）；history-events turn-done 按消息 id 去重（历史
    刷新与终态事件竞态）；confirm-manager 判别联合（pending/settled 携带
    outcome approve・deny・cancelled/未知与已终结 id 不触发/并发 fail-closed/
    幂等）+ 多监听者 Set 分发；interaction-semantics text 映射（links/buttons
    有 text、inputs 无——宁缺勿错）；tool-executor 确认摘要（elementText 页面
    提供目标文本/目标站点 URL 主进程可信 TabInfo/缺失宁缺勿错）；agent-loop
    onStatus 相位（thinking/executing 计数一致/finalizing 仅 done/终态后零
    迟到/防循环阻断零 executing）+ onAgentStep argsSummary（审计同源一致/
    fill 只记长度/阻断路径原始串截断）；conversation-service onAgentStatus
    （starting 0/maxSteps/waiting-confirm/confirm-resolved 三态/abort 作废/
    非在途防串）+ step argsSummary 转发 + 共享 ConfirmManager 双 Service 互不
    串扰与 dispose 退订。冒烟 8.5 A6-UI-01～A6-UI-12（React DOM 事件驱动真实
    链路，见 §6）。dev + 生产双场景退出码 0。
  - ✅ A7（2026-08-14 红→绿落地，5 新增：logger.test normalizeLogMessage——
    日志行伪造防御：模型可控字符串携带 CR/LF/ANSI 转义/双向文本控制符/零宽
    字符不得在日志文件中伪造新的 `[INFO] [audit]` 条目行（CR/LF 折叠为空格
    条目恒单行、ANSI CSI/OSC 整体剔除、C0/DEL/NEL/双向/零宽/BOM/行段分隔符
    按码点剔除、\t 保留；sanitize 凭据脱敏行为零改动，既有 8 用例原位通过），
    基线 766 → 771；红队矩阵为冒烟 8.6（RT-01～RT-08 + RT-11）+ RT-09 grep
    断言（无单测新增）。
- Fourth Stage（规格见 doc/stage4/detailed-design.md §13.1）：
  - ✅ B1（2026-08-15 红→绿落地，+31：sqlite-driver 17 / migrations 14——
    文件库重开/注入串仅作数据/事务三路回滚/外键双证/WAL/busy 读回/两连接锁竞争
    （worker 正证 + 零超时负证 + 等待下界）/重复关闭/重命名删除/无效路径；迁移
    列表空/重复/乱序/缺级/非正整数/未知更高版本/第 N 步失败该步整体回滚零部分
    状态/续跑），基线 785 → 816。
  - ✅ B2（2026-08-15 红→绿落地，+131：source-canonical 22 / source-change-set
    28 / source-repository 17 / change-journal 15 / source-service 37 /
    migrations schema v1 契约 +12——规范化矩阵（决议 #49/#50 空路径两形态同身份/
    IDN 百分号编码/控制字符拒绝/确定性）；change set 白名单/长度/枚举/trust
    通道/缺省/指纹；唯一约束双连接并发（列名形态冲突消息实测）；乐观版本；
    FTS 镜像同步（决议 #54）；LIKE ESCAPE 前缀字面匹配（SQLite 3.53.1 实测
    转义通配符首位前缀语义正常）；journal 100 条/30 天边界（注入时钟）/
    removeSource 精确拆分（决议 #55）/畸形 payload 安全失败；service 幂等重放
    （决议 #53）/Undo 消费幂等与版本冲突（决议 #52）/硬删令牌（决议 #56）/
    非法输入安全返回/异常归一化/dispose 幂等/重启后 Undo），基线 816 → 947；
    冒烟 B-02 为决议 #57 专属双进程门控（默认矩阵不含 B-02）。
  - ✅ B3（2026-08-15 红→绿落地，+60：source-search-query 23 /
    source-search-index 13 / source-service B3 14 / source-change-set bidi 10，
    基线 947 → 1007；既有用例零删除零削弱——audience 为决议 #58 机械校准 +
    语义保留 + 隐私断言新增）：查询归一化与分流（trim/NFC/码点计数/1–2–3 字符
    边界/URL 判定集合，决议 #60）、FTS 短语构造（引号/操作符/通配符/SQL 片段
    只作数据/短 token 过滤）、LIKE 模式转义、档位计算（决议 #61 档位不可跨档/
    agent note 档位受分享模式约束/大小写语义与 SQL 一致）、排序器全序
    （priority 上下界/lastUsedAt=null 末位/origin+page 同键三元组收尾）、note
    摘录（200/201 码点边界/C0/换行/零宽/U+061C/U+202A–U+202E/U+2066–U+2069
    剔除）、bidi 敌手矩阵（9 case + 幂等）；候选集四条路径（FTS/LIKE/短查询/
    URL）注入串仅作数据、FTS 可用性判定与降级（决议 #62）、rebuild 前后一致/
    索引缺行检出/失败不破坏数据与降级能力（外部内容表语义实测：计数读取内容
    侧——一致性探针为逐行 MATCH 回查）；service audience × 分享模式完整矩阵
    （blocked 三面不可见 vs 可见可管理/metadata 零 note 字节/full 摘录有界 +
    provenance 字段分离/读取侧防御性清洗）、多语言命中（中/日/英/混合）、
    排序全序证据、硬上限 10/每页 20 与 total 一致、注入串/降级/数据库不可用/
    disposed 安全返回。冒烟 8.9 B-04 B3 子集自动包含于默认矩阵（dev+生产双
    场景）；B-02 check 增 B3 检索命中证据（原有断言零改动）。
  - ✅ B6（2026-08-15 红→绿落地，+35：usage-tracker 19 / source-tools 6 /
    browser-tools 2 / agent-loop 5 / conversation-service 3，基线 1125 →
    1160；既有用例零删除零削弱——serializer 既有断言按决议 #80 契约校准机械
    更新）：hint store（每 run 独立/有界 120 FIFO/按 sourceId 去重/跨 run
    隔离/clearRun・dispose/零 timer——fake timers 断言）；匹配语义（origin/
    page 各自规范化：fragment/默认端口变体命中、query 差异不命中、一 URL 多
    命中全记录、无关/先 open 后 search/规范化失败零命中）；tracker 桥（成功
    reachable/失败 unreachable/同步与异步写失败安全 no-op 无
    unhandledRejection/无 writer 零写入/run 级闭包绑定/终态后迟到回调零
    写入）；serializer allowlist 引用链路（search/list/get 含 ID/规范键/作用
    域/分组 ID；get 仍为 expectedVersion 唯一来源；version/deletedAt 零回显）；
    source_search 结构化命中登记（失败/空结果零登记；仅 search 是 hint 来源）；
    browser_open onBrowserOpen 回调（成功/失败/桥异常纵深防御不影响结果）；
    AgentLoop ctx 透传 + 终态（done/cancelled/timeout）clearRun 恰好一次 +
    迟到工具回调发生在 clearRun 之后；conversation-service usageBridge 每
    run 创建/未装配零行为/连续 run 独立。冒烟 8.12 B-06/B-07 与 8.13 B-06
    UI DOM 自动包含于默认矩阵（dev+生产双场景退出码 0；B-02/B-05 双进程
    复跑退出码 0）。
  - ✅ B7（2026-08-15 红→绿落地，+47：backup 20 / sources-store 9 /
    source-service 9 / source-ipc 4 / sources-display 5，基线 1160 → 1207；
    既有用例零删除零削弱；**2026-08-15 事故恢复加固 +12 安全用例，最终
    1219**）：backup（只读探测矩阵 missing/坏 magic/空文件/
    截断/目录形态；WAL 活跃一致性备份 + 目标已存在 fail-closed 拒绝 + 版本
    不匹配删除部分备份 + 路径校验拒绝；integrity/外键检查；保留清理 5/6 与
    30 天边界/非严格命名与目录不动/确定性排序；**加固：头部固定 16 字节读取
    （readFileSync 零调用 + 1 GiB 稀疏坏头）/碰撞换新名与持续碰撞 fail-closed/
    backups 目录 junction 越界拒绝/外部目录拒绝/备份不写源库字节恒等/prune
    参数边界（NaN/负值/非整数安全空结果）/prune junction 安全空结果/sourcesDir
    越界安全空结果**）；sources-store 启动装配矩阵（新库零备份/
    v0→v1 先备份后迁移/注入迁移失败回滚原库逻辑恒等 + 主文件字节不变 + 备份
    完整/未来版本零写/坏 magic 与截断保留/目录形态 unavailable/恢复态 service
    全拒矩阵 + 数据库零变化；**加固：backupsDir junction/源库目录外 → 备份
    失败恢复态 + 原库字节不变 + 链接目标零写入**）；source-service（recordUsage
    双投影同事务一致/最近一次覆盖/usage 非数据变更/未知 sourceId 零写入/
    Undo 回放保留 usage；rebuildSearchIndex 行数一致 + FTS 破坏失败安全 +
    disposed 拒绝）；
    source-ipc（rebuild-index 门控：normal 透传/恢复态拒绝/零审计零 changed）；
    sources-display（describeLastUsage 五态文案矩阵 + 时间格式 + 无「健康」）。
    冒烟 8.14 B-06 B7 部分（真实启动迁移/备份/恢复态全矩阵 + rebuild + usage
    投影 + 保留清理）自动包含于默认矩阵（dev+生产双场景退出码 0；B-02 双进程
    扩展 usage 跨进程断言退出码 0；B-05/SESSION 双进程复跑退出码 0）。
  - ✅ B8（2026-08-15 红→绿落地，+3：agent-history 3——sanitizeToolCallsForPersistence
    URL 形态参数 query 值脱敏（source_search query/browser_open url 含
    ?token=/&key= 敏感 query →「query 值已脱敏 + 长度」；非 URL 形态原样；
    fill.text 保持 FILL_MASK），基线 1226 → 1229）：**红队发现的产品缺陷**
    （SRT-08 逐通道字节扫描实证 ToolStep 会话文件 token 泄漏）——先写失败
    测试（红态 2 failed/21 passed）→ 最小修复（复用审计层同源
    redactUrlQueryValue）→ 23/23。红队矩阵 SRT-01～SRT-12 为冒烟 8.15
    （决议 #93 校准：8.7 已被 B1 决策门占用，历史编号不复用；SRT-12 边界 =
    RT-01～08、RT-11 本轮 dev/production 重跑 + RT-09 扩展静态审计 +
    RT-10 未授权 NOT RUN）——每项独立断言（落点 threat-model §4.1 证据表，
    12 项全部「机器可证明」）；8.6/8.14 返回结构化已通过证据由 8.15 精确
    核验（非日志字符串、不重复完整运行相同矩阵）；SRT-08 敏感标记运行时
    分片构造逐通道字节扫描（ToolResult/审计/日志/ToolStep/会话文件/UI
    DOM）；SRT-10 扩展 B-02 set/check（hard delete 后 FTS/journal/usage
    私人 payload 清理跨进程证据，既有断言零改动）；RT-09 扩展静态审计为
    分类证据（SQL 执行点全部位于允许点：Repository/migrations/driver/
    backup/SMOKE 测试设施 + snapshot-script 正则非 SQL 分类；renderer/
    preload 零 SQL；Electron 隔离/Key 零读回/Source Tool 零网络代码证据）。
    dev+生产双场景退出码 0；B-02/B-05/SESSION 双进程退出码 0。
- Electron 本身难以单元测试的部分**不强 mock 成复杂系统**；纯逻辑与 Electron 壳分层
  （§3 分层纪律），让可测逻辑零环境依赖；真实采集行为由冒烟集成场景覆盖（§6）。
- 红→绿纪律 + 作业完成必跑全量回归（§3）。

## 8. 已知弱点与改进建议

- **本机环境变量陷阱**：`ELECTRON_RUN_AS_NODE=1` 全局存在（未改动，可能被本机 node 依赖），
  每次启动 Electron 须 `env -u` 排除，容易忘 → 后续可在 dev 脚本内兜底检测并给出中文提示。
- **本机全局 git 配置的 `https.proxy` 是无效键**：git 只认 `http.proxy`，该全局配置被静默忽略，
  GitHub 推送必须显式 `-c http.proxy=…`（§6）；是否清理全局配置待用户确认（属用户机器配置，未动）。
- **接口契约已定稿**（2026-08-13，T1）：唯一契约源 doc/detailed-design.md（含 Q1–Q4 决议与
  相对草案的 14 条变更）。T2/T3/T4 部分签名已于 2026-08-13 回填 §5 并与代码 grep 核对。
  已知设计限制：PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（快照点时刻尽力采样）。
- **PageSnapshot 采集已接入（T4）**：L0/L1/L2/L3 全阶梯可用；调试面板展示 degraded/warnings，
  能区分「页面没有链接」与「采集失败」。已知边界：iframe 跨域计数为尽力采样（未加载完成的
  同源 iframe 可能被计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回
  L2（按契约降级，不构成安全问题）；L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟中
  强制触发（normalize 单测覆盖 L2 形状，PageReader 拒绝路径为薄胶水）。
- **shared/url 已知限制**：不支持 IDN（中文域名）；无 SearchProvider 抽象（Bing 硬编码）；
  非 http/https/about 的 scheme 一律按搜索处理（安全优先，可接受）。
- **日志位置随打包变化**：开发时 log/ 在项目根目录；打包后写用户数据目录（asar 只读），排查注意两处。
- **尚无 CI / 打包配置**：第一阶段验收不要求；electron-builder 打包与 GitHub Actions
  （lint + test + typecheck）待阶段收尾评估。
- **冒烟已扩展（T2–T5 + S3–S4）**：覆盖多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等与
  webContents 无残留；T3 起覆盖 UI 窗口导航保护拦截（远程/同目录 file:/路径穿越三探针，
  dev origin 与生产 file: 精确匹配两条路径）与渲染层 bounds 上报生效；T4 起覆盖
  PageSnapshot 真实采集（本地受控双服务器页面：L0 内容对照/元素 id 唯一性与跨快照稳定/
  L1 跨域 iframe 跳过警告/L3 null）；T5 起覆盖敌对页面 elementId（重复/畸形/超大/冲突烙印）、
  Tab 302 重定向白名单（R-02 验证）、**UI 端到端**（React DOM 点击/键盘驱动地址栏/搜索/
  多 Tab/后退前进刷新/标题/调试面板，不引入 Playwright）、远程页面隔离探针、Session 跨进程
  持久化（AIBROWSE_SESSION_SMOKE=set/check 双进程，§6）；S3 起覆盖 AI 共读主进程矩阵
  1–8；S4 起覆盖 **AI 面板 UI 端到端矩阵 1–12**（含真实 safeStorage 密文落盘与 Key 零
  暴露断言，场景 10）。真实网页加载需 `AIBROWSE_SMOKE_URL` 附加验证（§6）。仍不覆盖：
  L2 触发路径（渲染进程崩溃）的强制触发（normalize 单测覆盖 L2 形状，PageReader 拒绝
  路径为薄胶水）。
- **Tab will-redirect 白名单为防御纵深（T5）**：file:/data:/about:blank 等重定向目标已被
  Chromium 网络层拦截（ERR_UNSAFE_REDIRECT，探针实测不触发 will-redirect）；当前无自定义
  协议注册，未来注册 `aibrowse://` 等协议时该拦截点是唯一防线（冒烟以 custom:// 目标验证
  handler 真实触发）。
- **Prompt Injection 边界声明（长期事实，第三阶段已重建）**：第二阶段结构性隔离保证
  网页内容不能取得权限、读取密钥、调用写操作或改变消息角色（doc/stage2/detailed-design.md
  §12）；第三阶段引入 Browser Tool 前**威胁模型已重建定稿**（2026-08-14，
  `doc/stage3/threat-model.md`：威胁枚举 T-01～T-10、五层防线、红队矩阵
  RT-01～RT-11、诚实边界声明——语义层诱导式工具参数/确认疲劳/低风险动作累积/
  click 允许列表目标的页内 JS 副作用四类残余风险如实登记，不宣称免疫）。

## 附 A：验证矩阵（「作业完成」的定义）

| 改动类型     | 必做验证                        | 说明                                |
| ------------ | ------------------------------- | ----------------------------------- |
| 任何改动     | 全量测试 + diff 终检 + 文档同步 | 测试全绿；diff 无杂项/密钥/意外重写 |
| 用户可见行为 | + 冒烟/实际运行验证             | 实际启动 Electron 验证可运行        |
| 交付物相关   | + 重新构建产物                  | 产物必须包含本次改动                |
| 重大版本     | + Release 发布与独立验证        | tag + 上传 + 下载 URL 验证          |
| 纯文档       | 免构建/重打包                   | 但提交推送必须                      |

## 附 B：第三阶段验收标准（摘要，完整清单见 Third_stage.md §9）

- **Agent**：可完成多步低风险网页任务；有最大步骤（12）/超时（420s）/取消；
  Tool 调用全程可审计；失败能安全停止而非无限重试（防循环三触发 + 结构化终止理由）。
- **Browser Tools**：read/find/scroll/open/click/fill 等核心工具稳定；elementId
  生命周期正确；页面刷新后不会误操作旧元素（执行时刻重新定位）。
- **Search**：AI 可经统一 SearchProvider 查询；搜索结果可继续交给 Browser Agent
  打开读取。
- **Permission**：高风险动作无法无确认执行（L2 确认门）；网页文本无法提升 Tool
  权限（确定性权限纯函数）；无万能 shell/eval/filesystem 工具（永久红线 grep 断言）。
- **Engineering**：全量验证通过；多个真实网站 Agent smoke test 通过（**PASS，
  2026-08-14 A7 补验最终执行 + 定向补验**——deepseek-v4-pro，§7 场景 1–6 全部
  真实完成，`LIVE_SMOKE_PASS` 退出码 0；**多网站证据 = 定向补验场景 3 修订：
  真实搜索后两个不同 origin 公开来源（blog.openreplay.com + peerlist.io）
  各自读取比较 + 场景 1/2 electronjs.org + bing 真实搜索 ≥4 个真实公开 origin**；
  此前 BLOCKED 根因 = wire 名称契约（13 工具名携带点号致整组 tools 400），
  修复见决议 #35；不得以离线 FakeProvider 冒烟替代真实验证的规则不变）；
  Agent 操作日志无敏感信息（离线证据 + 真 Key 零暴露扫描随真实验收执行通过）。

## 附 C：第三阶段完成报告格式（Third_stage.md §10）

阶段完成后**停下**，不擅自开发第四阶段：更新 progress.md → 向用户报告（已实现内容 /
验证结果 / 剩余风险 / Fourth Stage 的切入点建议）→ **不直接实现信源数据库**，
等待下一条指令。
