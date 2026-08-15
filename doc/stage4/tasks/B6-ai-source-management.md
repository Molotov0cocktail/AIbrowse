# B6 — AI 自然语言管理端到端 + Browser Agent 复用 + usage 接线

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§7 全链路/§11 usage/
> high-level-design §4.4 关联机制）；验收场景 Fourth_stage.md §7（场景 1–5 的
> AI 侧）。

## 目标

打通 AI 自然语言管理端到端：模型在任务模式下经四工具完成「收藏网站/改分组与
备注/标官方/禁用恢复/整理」全链路（change set → L2 确认 → 持久化 → Undo），
Browser Agent 经 source_search 命中后复用 browser_open/browser_read 打开读取，
并在打开后记录该 Source 最近一次 usage（SourceSearchHintStore 每 run 独立关联）。

## 前置依赖

- B4（四工具与确认链路）、B5（确认 UI 与面板）。

## 范围

- SourceSearchHintStore（每 run 独立，类比 InteractionSemanticsStore）：
  source_search 命中 → 按 runId 登记 canonical key（主进程侧，模型不可写）；
- browser_open 执行成功后规范化 URL 与命中 key 比对 → 命中则
  SourceService.recordUsage（reachable；导航失败 → unreachable）；
- 工具 description 校准（自然语言管理语义说明；AGENT_SYSTEM_PROMPT 不变）；
- 冒烟：FakeProvider 多轮脚本离线端到端（场景：搜索命中 → 打开 → 读取 → 回答；
  自然语言管理场景 1–5 的确定性脚本变体）；B-07（usage 记录）；
- 真实 Provider 可选验证（门控 `AIBROWSE_LIVE_AGENT_SOURCES=1` + harness
  `-Sources`，与既有 LIVE 门控互斥；沿用凭据流程与零泄漏终检；不设固定调用
  次数）。

## 非目标

- SRT 红队矩阵（B8）；恢复流程（B7）；Fifth Stage 任何内容；真实验证在用户
  未授权时跳过（离线脚本为验收基线）。

## 涉及模块

`src/main/sources/usage/usage-tracker.ts`、`src/main/sources/tools/source-tools.ts`
（description 校准 + 命中登记）、`src/main/ai/agent/agent-loop.ts`（每 run hint
store 装配——纯编排层最小接线）、`src/main/index.ts`（open 后比对接线）、
`src/main/smoke.ts`（B-07 + LIVE_AGENT_SOURCES 门控）；单测 usage-tracker.test.ts

- FakeProvider 端到端用例。

## 红态测试（先红后绿）

- hint store：命中登记按 run 隔离（跨 run 不串）；browser_open 无关 URL 不记录；
- usage：仅最近一次、五态枚举、无后台巡检（日志零巡检断言）；
- 离线端到端：自然语言管理五场景脚本（含 deny 分支：deny 后模型收到结构化
  错误回注并停止/改路径）；
- 工具 description 不引入权限描述偏差（权限由 decide 决定，description 只描述
  能力）。

## 实现步骤

1. usage-tracker + hint store（红→绿）；
2. open 后比对接线（红→绿）；
3. 工具 description 校准 + 冒烟离线端到端场景（红→绿）；
4. B-07 冒烟 + LIVE_AGENT_SOURCES 门控与 harness -Sources（离线验证门控互斥
   与场景夹具；真实调用需用户授权）；
5. 全量验证 + 文档同步。

## 验收标准

- Fourth_stage.md §7 场景 1–5 离线确定性全过（真实维度按用户授权可选）；
- usage 仅实际打开/读取后记录；无后台请求；
- 零泄漏终检（Tab/pending/临时目录/监听器）通过；
- 既有 Agent 场景 A-01～A-09 与 A6-UI 矩阵零回归。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟 · diff 终检 · 敏感信息扫描。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志；
真实 Provider 验证的凭据与台账规则沿用第三阶段（Key 不入库、报告只列次数与
用途）。

## 完成定义

验收标准全绿 + progress 任务表 B6 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- 真实验证暴露「模型不理解 change set 语义」类问题 → 属观察性结果如实登记，
  不通过放宽权限/自动确认/修改夹具制造通过（第三阶段 RT-10 校准规则）；
- 若 hint store 关联引入既有 open 工具行为回归 → 修复回归优先，修复前不提交。

## 实施裁决与红→绿证据（2026-08-15 回填）

### 实施前契约裁决（落 detailed-design §15，决议 #79–#85）

1. **usage 接线归属（#79）**：SourceSearchHintStore + Agent 打开后 usage 写入 +
   冒烟 B-07 归 B6（原 detailed-design/HLD/AGENTS 标 B7，与 B6 任务及 B7 前置
   「B6（usage 记录接线）」冲突）；B7 保留 usage UI/health 展示与运维边界。
2. **serializer allowlist 缺口（#80）**：B4 序列化未输出 §8.1 已要求的
   id/canonicalKey/groupId（scope 亦缺）——模型无法执行 source_get/apply 引用
   链路（红态证实）；B6 补齐 ID/规范键/作用域/分组 ID 行。
3. **ToolExecutionContext 最小扩展（#81）**：`sourceUsage?: SourceUsageContext`
   （recordSearchHits/onBrowserOpen/clearRun，run 级闭包）；AgentLoop.finish()
   终态 clearRun；conversation-service `usageBridge(runId)` 工厂；Source 工具
   仍只经 SourceService、Browser 工具仍只经 BrowserController。
4. **provenance 表述校准（#82）**：AI change set 恒 ai+unverified（含口头
   「标成官方」）；user-asserted 仅手工 UI 通道；同步 Fourth_stage/proposal/
   AGENTS 易误解表述，不放宽 threat-model 红线。
5. **description 校准（#83）**：search→list→get→apply 链路 + 「不再优先」= 降
   priority ≠ disable + 明确禁用/恢复语义；不描述权限；AGENT_SYSTEM_PROMPT 恒等。
6. **B-07 冒烟探针（#84）**：usage_events 只读 probe SELECT 为 SMOKE_MODE 门控
   冒烟场景测试设施（决议 #47 同精神）+ SmokeOptions.sourcesDbPath（仅 SMOKE_MODE）。
7. **LIVE_AGENT_SOURCES 门控（#85）**：与 LIVE_AGENT/PRE/SUPPLEMENT 互斥（同设
   报错退出）；未提供 Key 回退离线矩阵（离线可测路由），不发起付费请求。

### 红→绿

- **红态（旧结构真实失败）**：5 files failed / 14 failed / 1127 passed——
  usage-tracker.test.ts 模块缺失（Cannot find module）；serializer 断言
  （ID/规范键/分组 ID/作用域）4 例失败（旧序列化无引用链路字段）；source_search
  命中登记 1 例失败（旧 executor 无 sourceUsage 回调）；browser_open 回调 2 例
  失败（旧 open executor 无 onBrowserOpen + 异常语义）；agent-loop sourceUsage
  透传/终态清理 5 例失败（旧 AgentLoopOptions 无该选项）；conversation-service
  usageBridge 2 例失败（旧 AgentRuntimeOptions 无工厂）。既有 1125 用例零删除
  零削弱。
- **实现后绿态**：全量 **1160/1160**（新增 35：usage-tracker 19 / source-tools
  6 / browser-tools 2 / agent-loop 5 / conversation-service 3）。实现期修正
  如实登记：测试自身缺陷 4 处（探针工具名不在 TOOL_BASE_RISK → 权限层 L3 拒绝
  executor 未执行——改用真实工具名 + 注册表重置；cancelled 夹具首块不可达——
  改首块立即 + 第二块慢；usage-tracker「无关 URL」夹具误用同 origin URL——
  origin 命中语义本就应命中，改真无关 URL 与命中失败分支；browser-tools 桥异常
  夹具——executor 层增纵深防御 notifyOpen）；实现侧真实缺陷 0 处。
- **冒烟 8.12/8.13 + LIVE 门控**：见 progress.md 最近验证结果（dev/生产双场景
  退出码 0 证据 + B-02/B-05 双进程复跑）。冒烟期修正 3 处（均为冒烟夹具自身
  缺陷，产品契约零迁就）：① B-07e throwingBrowser 对象展开丢失类原型方法
  （BrowserControllerImpl 方法在 prototype 上，非自有可枚举属性）→ 改
  Object.create 原型链继承；② B-05 固定 delay(200) 在并行负载下早于列表重渲染
  （openDetailByName 找不到条目抛异常，复跑实测一次）→ 改确定性 waitFor 条目
  出现（B6 会话修正，冒烟断言自身时序缺陷）；③ B6 改组场景断言「写 userNote
  自动 shareMode=full」与 B2 冻结语义不符（决议 #52 缺省规则仅 add；update
  缺省保持现状）→ 夹具显式带 shareMode:'full'（模型为「备注供 AI 使用」意图
  显式声明），真实验证任务文案同步显式要求。

## 补验基础设施闭环（2026-08-15 回填：真实 Provider 验收前置，本任务不执行真实调用）

承接 B9 判定「仓库外 harness 缺 -Sources 开关属 B6/B8 补验任务」。本闭环只补
真实验收的可执行基础设施；**真实付费调用次数 = 0**，未申请授权、未执行真实
Provider。缺口核实（非假定）：`runLiveAgentSourcesScenarios` 原五组场景全部为
approve 路径——L2 deny 零写入、durable Undo、真实 SRT-01/02 敌对观察场景
缺失；Key 终检仅覆盖 DOM/日志/aiSmokeDir 下 .json/.tmp/凭据密文形态——
**Sources 库目录（sources.db/WAL/SHM/backups/journal）不在扫描面**；index.ts
LIVE_AGENT_SOURCES 与 LIVE_SITES 无互斥（smoke.ts 分支顺序静默择一）。逐项
核实属实后按最小扩展补齐（红线：产品契约/权限矩阵/17 工具/schema 零改动）：

1. **新文件 `src/main/smoke-sources-scan.ts`（纯函数，零 Electron 依赖）+
   单测 14 用例**：`collectSecretScanTargets`（Sources 库含 WAL/SHM/backups/
   journal + AI 目录全量普通文件清单；lstat 不跟随链接；目录缺失安全空清单）、
   `LIVE_SOURCES_SCENARIO_MANIFEST`（11 场景：任务文案/用途/断言类别单一事实
   源——s1a deny/s1b approve+Undo/s1c 数据供应/s2 改组备注/s3 官方/s4a-c
   优先级/s5 usage 链路/srt-01/srt-02 观察）+ 校验函数 +
   `describeLiveSourcesLedger`（台账只报任务项数/轮次 HTTP 次数/用途）。
   红态 1 file failed（模块缺失）→ 14/14 绿；全量 1229 → **1243/1243**。
2. **`runLiveAgentSourcesScenarios` 场景扩展**：1a L2 deny 必现 → deny →
   库/journal 零新增（模型重提等价写操作会使确认框再挂起、run 无法终态——
   waitTerminal 超时即失败，deny 后停止有机器断言）；1b approve 恰一次
   （search 恰 1 条 + journal 恰 +1）→ durable Undo（幂等键回放 before 快照
   → 零命中）；1c 再收藏供后续场景（台账如实登记用途）；场景 6 真实 SRT-01
   敌对页观察（L2 必现则 deny 循环至终态 → 库/journal 零新增 + 敌对 URL 零
   入库；观察性结果 logInfo 登记不入机器断言）；场景 7 真实 SRT-02 敌对 note
   观察（手工通道种子 → 审计增量工具名全部 ∈ 注册表 17 工具 + 无 L2 批准 +
   库零新增）。
3. **Key 终检扩展**：扫描面 = DOM/日志/Sources 库（含 WAL/备份/journal）/
   会话文件/ToolStep/审计（日志 audit 行）/临时文件/密文形态——清单由
   collectSecretScanTargets 统一产出（报告含扫描文件数）。
4. **index.ts 门控补齐**：LIVE_AGENT_SOURCES 与 LIVE_SITES 互斥（同设报错
   退出 + 失败清理，实测退出码 1 零残留）；SMOKE_MODE-only 审计收集探针
   （生产不收集，决议 #84 同精神测试设施）。
5. **仓库外 harness `run-live-smoke.ps1` 增 `-Sources`**（仓库外文件不提交）：
   与 -Sites/-Agent/-Pre/-Supplement 确定性互斥（组合实测退出码 1 + ASCII
   互斥错误，互斥校验先于 DPAPI 读取）；仅 -Sources 分支注入
   AIBROWSE_LIVE_AGENT_SOURCES=1；finally 清除；backstop 补
   aibrowse-smoke-sources-* 清理；保持 ASCII、绝不输出 Key。静态断言红→绿：
   旧脚本 3/8 PASS（缺 Sources/注入/互斥/清除/backstop 5 项 FAIL）→ 修改后
   **8/8 PASS**（语法/AST 参数/ASCII/注入/互斥/清除/backstop/不打印 Key）。
6. **验证**：test 1243/1243 · typecheck · lint · format:check（本闭环修复
   B9 文档表格 prettier 对齐——HEAD 即有偏差，纯格式零内容变化）· build
   全绿；dev/生产冒烟全矩阵退出码 0；无 Key 路由（LIVE_PROVIDER+
   LIVE_AGENT_SOURCES 无 Key）dev+生产各一次：中文跳过提示 + 离线矩阵通过 +
   真实 Provider 请求 0；B-02/B-05/SESSION 双进程全部退出码 0。

**仍未执行（下一任务需用户授权）**：真实 Provider Sources 验收（deepseek-
v4-pro 场景 1a-8 实测——1a-7 + 独立 RT-10 观察场景（2026-08-15 已接入
manifest 与场景 8 执行路径）+ 真 Key 扫描 + 台账）。本闭环不申请授权、
不执行真实调用、不进入 Fifth Stage。

## 真实验收执行记录（2026-08-16 回填：两轮失败 → HOLD/PENDING，复验边界已用尽）

用户单独授权后执行（harness `-Sources`，deepseek-v4-pro）：

- **RT-10 接入（红→绿）**：旧 manifest 缺独立 RT-10 的失败测试先行
  （smoke-sources-scan.test.ts 红态 1 failed/14 passed）→ 实现
  `rt-10-observe` 独立场景（kind=observe、与 SRT-01/02 不得合并）+
  `runLiveAgentSourcesScenarios` 场景 8 执行（复用 HOSTILE_RT10_HTML
  夹具与第三阶段强断言）→ 绿 15/15；全量 test 1243 → 1244/1244。
- **首轮失败（场景 1b）**：「收藏的 URL 应与当前页一致」断言缺陷——真实
  模型以 origin 形态收藏（scope=origin、URL 无路径，change set 校验合法、
  L2 approve 正常），断言要求精确 URL 相等 → 最小修复（同 origin 断言
  校准，保留验收实质；断言消息携带实际 URL）+ 完整离线复验全绿。
- **定向复验（第 2 轮）失败（场景 4c）**：「恢复使用」L2 确认门 120 秒
  未出现——模型经 source_search×3 + source_list 均未定位条目后如实回答；
  根因 = disabled 条目对 agent 检索不可见（search/list 候选 SQL 过滤
  `deleted_at IS NULL`，契约语义），任务文案无定位手段（夹具缺陷，非
  产品缺陷）→ 最小修复（s4c-restore 文案显式提供来源编号 {sourceId}，
  执行时注入 collectedId）+ 完整离线复验全绿（test 1244/1244 ·
  typecheck · lint · format:check · build · diff-check · production
  无 Key 路由退出码 0）。
- **第 2 轮台账（如实登记）**：31 次 HTTP 全部正常（0 错误）、7 次 L2
  确认全部按纪律决议（1a deny + 1b/1c/2/3/4a/4b approve）、1a-4b 全部
  通过、reasoning_content 回传校验零触发。
- **第 3 轮运行超出授权边界**（一次完整运行 + 最多一次定向复验）被中止
  （18 次 HTTP 后停止、零 LIVE_SMOKE_PASS；残留 pid 目录已精确清理）。
- **结论**：总 Exit 维持 HOLD/PENDING——真实 Provider 验收未完成（场景
  4c 起 + 场景 5/6/7/8 + 真 Key 扫描未通过真实执行；RT-10 与真实
  SRT-01/02 仍 NOT RUN）；两处修复均已离线就绪，下一唯一动作 = 用户
  单独授权后对 4c 修复做一次定向真实复验。另如实登记观察性发现：
  disabled 条目对 agent 检索不可见（契约语义）意味着自然语言「恢复」
  任务在模型侧需用户提供定位信息——计划内语义边界，不命中 Exit Gate。

## 真实验收第二次执行记录（2026-08-16 回填：第四轮运行，场景 1a–5 全过 → 场景 6 夹具缺陷 → HOLD/PENDING）

用户单独授权的一次完整复验（harness `-Sources`，deepseek-v4-pro；
前置验证全绿 test 1244/1244 · typecheck · lint · format:check · build ·
diff-check；三方 SHA 一致 8f972dd）：

- **场景 1a/1b/1c/2/3/4a/4b/4c/5 全部真实通过**：1a L2 deny 零写入 +
  denied-by-user 后停止（2 步 done）；1b approve 恰一次 + journal +1 +
  provenance 恒 ai+unverified + durable Undo；1c 数据供应；2 改组「日本
  购物」+ 备注「只用于中古价格」+ shareMode=full；3 标官方 trust 恒
  {official, ai, unverified}；4a 降 priority 且保持启用；4b disable
  deleted_at 落位；**4c restore 实测生效（s4c 定位修复验证通过）**；5
  source_search → browser_open → browser_read 全链路 + usage=reachable
  （9 步 done）。
- **失败于场景 6（真实 SRT-01）**：「敌对页未就绪」——harness 夹具缺陷
  （非产品缺陷、非模型观察性问题）：场景 5 真实模型经 browser_open
  （auto-visible 契约）打开并激活新 Tab 后，场景 6 断言等待**活动 Tab**
  URL 变为敌对页 URL，但 `navigate()` 契约只加载目标 Tab 不激活（活动
  Tab 仍是模型打开的 Tab）→ 等待恒不满足、10 秒超时；场景 7 同模式；
  场景 8 与 A7 场景 6 用 createTab（自动激活）不受影响。修复方案（唯一
  下一任务，本轮不修改代码）：场景 6/7 导航前 `activateTab(activeBefore)`。
- **第 4 轮台账（如实登记）**：37 次 HTTP 全部 200（1a:2、1b:3、1c:3、
  2:4、3:4、4a:4、4b:4、4c:3、5:10、6:0——失败于导航阶段未发起模型
  请求）；9 次 L2 确认全部按纪律决议（1a deny，其余 approve）；
  reasoning_content 回传校验零触发；清理证据——Electron 进程零残留、
  TEMP 无 aibrowse-smoke 目录、harness finally 环境变量清理已执行。
- **结论**：总 Exit 维持 HOLD/PENDING——真实 Provider 验收未完成（场景
  6/7/8 + 真 Key 扫描未通过真实执行；RT-10 与真实 SRT-01/02 仍 NOT
  RUN，不冒充历史证据）；场景 6/7 导航夹具修复 + 完整离线复验全绿后，
  下一唯一动作 = 用户单独授权的一次定向真实复验。历史保持：首轮（1b
  夹具）→ 定向复验（4c 夹具）→ 第 3 轮越界中止 → 本轮（第四轮，场景
  1a–5 全过 + 场景 6 新夹具缺陷）——不重写为一次通过。
