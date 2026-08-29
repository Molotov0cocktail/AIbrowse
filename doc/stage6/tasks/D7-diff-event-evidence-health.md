# D7 — 确定性 Diff、Baseline、Event/Evidence、health 与去重

## 目标

把 Feed/Page Projection 通过来源专属确定性 Diff、Condition 和 EventValidator 转为不可变 Event，确保每个
变化拥有可解释 old/new Evidence；实现 Baseline CAS、健康闭环、观察级幂等/合并/反转和通知 outbox 原子写。

## 契约冲突裁决（2026-08-29 Planner REPLAN，已写回正式设计）

实施前五项冲突已全部裁决并冻结，Executor 不得重新选择：

1. **#S6-045 Source rowVersion CAS = 方案 A**：结果事务 CAS 身份条件 = 规则存在且未删除 +
   sourceId 一致 + `sourceLocatorFingerprint` 一致 + `baselineVersion` 一致；Source rowVersion
   永不进入 CAS，仅在每次复验后同事务更新。detailed §10.3 步骤 5 与 §14 保持不变。
2. **#S6-046 Feed 截断前完整哈希**：`FeedField` 增加 `valueHash`（截断前完整规范化值 SHA-256），
   由 D3 规范化管线计算；D7 只消费，不得对已截断 excerpt 重算冒充。Page 字段完整持有，哈希由
   Diff/Evidence 对投影值确定性计算。
3. **#S6-049 schema v3 observation**：新增 `watch_event_observations`（观察级
   `idempotency_key` UNIQUE），`watch_event_items` 重建追加 `observation_id`；v2 既有 Event 无损
   回填恰好一个观察；去重分层（观察幂等全局唯一 + 事件内指纹去重；跨事件指纹不去重）。
4. **#S6-048 reversal = 最近对镜像有界 oracle**：P 为 reversal 当且仅当同 Rule 同
   `(itemId, fieldKey)` 最近一次已持久化对 Q 满足 P.before≡Q.after 且 P.after≡Q.before；
   add/remove 同判；部分反转 → mixed。
5. **#S6-047 coalesce/outbox**：窗口锚定 `firstObservedAt` 严格小于 30 分钟；候选只取该 Rule 最近
   Event；32 KiB 预算只计 Evidence item JSON；合并绝不创建/修改 outbox；outbox 只在新建 Event 且
   非 muted 时写入（in-app、程序事实 privacy_json）。

公式与算法冻结见 detailed §9.4 与 #S6-050（idempotencyKey/changeFingerprint 编译期编码）。

## 范围与非目标

- **做**：FeedDiff/PageDiff、StructuredChangeSet、EvidencePair、Condition 接线、Baseline
  first/rebaseline、Event/Run health、fingerprint/idempotency、30 分钟 item-preserving coalesce、
  reversal、schema v3 迁移、合并/新建事务提交、8.24 冒烟与 WATCH 门控扩展。
- **不做**：AI equality/importance、Digest、Watch UI/IPC/renderer/preload、系统通知展示；
  哈希不能单独创建 Event；不新增审计 kind/reason 码（沿用 #S6-044 冻结集合）。

## 涉及模块和输入文档

- `src/shared/watch/diff/`、`src/shared/watch/event-validator.ts`、
  `src/main/watch/watch-acquisition-service.ts` 与 run pipeline 接线、
  `src/main/watch/repository/watch-repository.ts`、`src/main/watch/db/watch-migrations.ts`。
- 输入：detailed §6.4/§7/§9/§10/§14/§15 与决议 #S6-045～#S6-050；threat-model WT-12～WT-14、
  WRT-08/WRT-10～WRT-12。

## 预计修改文件

- 新增：`src/shared/watch/diff/{feed-diff,page-diff,evidence}.ts` 与测试、
  `src/shared/watch/event-validator.ts` 与测试、有界 main-process processing service 与测试、
  `src/main/smoke-watch-diff-event.ts`。
- 修改：`src/shared/types/watch.ts`（FeedField.valueHash 与闭合类型）、
  `src/main/watch/feed-parser.ts`、`src/shared/watch/feed-normalize.ts`（仅完整值哈希）、
  `src/main/watch/watch-acquisition-service.ts`、`src/main/watch/watch-run-coordinator.ts`、
  `src/main/watch/repository/watch-repository.ts`、`src/main/watch/db/watch-migrations.ts`（v3）、
  `src/main/smoke.ts`、`src/main/smoke-watch-store.ts`、`src/main/index.ts`（仅装配接线）。
- 不改 Research Evidence/Result 类型，不把 Capture/Feed/HTML 正文落盘；不改 renderer/preload/IPC/
  Provider/AgentLoop/ToolRegistry；不新增依赖。

## 实施步骤（红→绿）

1. 红：Feed/Page equality、新增/删除/修改/反转/噪声、hash-only、Condition unmatched/error、
   CAS/观察幂等/合并/事务测试在旧 baseline 上必须失败（行为断言，不以类型错误冒充红态）。
2. 绿：Normalization（含 valueHash）→ Diff → EvidencePair → Condition → EventValidator →
   Repository transaction（新建与合并两条组合写）。
3. 添加/删除必须以 absent/present 双侧证据；截断/时间/URL 去 query/documentId/itemKey 引用逐项验证。
4. 失败矩阵证明旧 Baseline 不变；changed-unmatched 推进；首次/rebaseline 仅 Baseline+audit；
   unexplainable_change 映射 failed/parse_changed 零推进。
5. 端到端受控 feed/page 运行（8.24）与跨进程 Baseline/Event/observation 恢复（WATCH set/check）。

## 验收标准与测试

- contentHash 变化但零合规 pair → unexplainable_change，零 Event/零 Baseline 更新。
- Event+observations+items+Baseline+Run+outbox 原子；同 idempotency 同进程/跨进程零重复；
  coalesce 不吞中间 pair；窗口/预算边界精确（29:59 合并、30:00 新建、超 32 KiB 新建）。
- feed 重排/页面 Region 未变零事件；真实字段变化必有 before/after UI-ready 投影；
  reversal 有固定测试向量与可解释 Evidence。
- Source/expectedBaseline/Event 期望值陈旧零部分写入；muted 零 outbox；
  全量门控、冒烟、WRT 对应项全绿；v2→v3 无损升级与 future/corrupt fail-closed。

## 完成定义

红→绿、Evidence 机器证据、隐私/事务扫描、独立安全/持久化 Reviewer PASS、候选提交（不 push）。

## 依赖与停止条件

- 依赖 D2–D6；D8–D10 依赖本任务。
- 无法给 equality 精确 oracle、需模型判定、需保存正文/HTML、Event 无双侧 Evidence、要放宽
  Baseline 原子性、或需要偏离 #S6-045～#S6-050 任一冻结裁决时停止并 REPLAN。
