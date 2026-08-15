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
