# D7 — 确定性 Diff、Baseline、Event/Evidence、health 与去重

## 目标

把 Feed/Page Projection 经统一 main-process processing service、来源专属确定性 Diff、Condition 和
EventValidator 转为可复现的不可变观察与 Event；确保每个变化保留可解释 old/new Evidence，并以
Baseline/Run/Event/observation/item/outbox/audit 单事务、Source 身份 CAS 和 schema v3 关系约束闭合并发、
重放、合并、反转、迁移与健康语义。

## 契约冲突裁决（2026-08-29 Planner 第二次 REPLAN，已写回正式设计）

以下九项已冻结，Executor 不得重新选择：

1. **#S6-045/#S6-052 Source rowVersion**：身份 CAS = Rule 存在未删除 + sourceId + locator fingerprint +
   baselineVersion；rowVersion 不入身份 CAS，但结果事务只可
   `sourceRowVersion=max(current,revalidation.rowVersion)` 单调更新。revalidation 后 metadata-only commit
   不丢有效结果且不回退；locator prepare 已改变 fingerprint/state 时新建/合并/dedup 全部整体 CAS 失败。
2. **#S6-046 Feed 截断前完整哈希**：`FeedField.valueHash` 由 D3 normalization 在截断前生成；D7
   Evidence 只消费，不对 excerpt 重算冒充。Page 完整字段由 Diff/Evidence 计算 hash。
3. **#S6-049/#S6-051 观察幂等**：`idempotencyKey` 是唯一 replay key；`changeFingerprint` 只做确定性签名，
   不丢弃 Event 内/跨 Event 的真实观察。窗口内 `A→B→A→B→A` 四个变化观察与全部 pair 均持久化并逐次推进
   Baseline；合法 replay 零新增事实写，但 running Run 精确终结为 event-deduplicated 并审计，已终态重入零写。
4. **#S6-048 reversal**：仅取同 Rule/itemId/fieldKey 最近持久化 pair 的 typed 镜像；按 schema v3 冻结全序
   跨 Event/时间戳/重启查询，不搜索更早任意旧值；部分 reversal → mixed。
5. **#S6-047 coalesce/outbox**：候选只取该 Rule 最近创建 Event；窗口以 firstObservedAt 严格 `<30min`；
   32 KiB 只计 Evidence item JSON；合并追加 observation/items，绝不折叠 pair 或碰 outbox；outbox 仅新建
   Event 且非 muted 时写程序事实。
6. **#S6-044 D7 审计**：D5 schema v2 只冻结当时 Run 终态，不授权 future outcome→unchanged。schema v3
   reason CHECK/TS 同源码追加 changed-unmatched/event-created/event-coalesced/event-deduplicated/
   condition-error；kind 不新增。每个 Run 恰一条精确 run audit，新建/合并/dedup 不得冒充 unchanged。
7. **#S6-053 Condition 终态**：字段缺失/非规范数值/typed operator 不适用 = no-match + 闭合 warning，推进
   Baseline、健康恢复；shape/version/catalog/value/throw = failed condition_error、retryable=false、旧
   Baseline、counter+1、无 backoff、立即 health=paused/condition_error；Rule pauseReason 复用 schema v2 已有的
   dependency-unavailable，run + 首次 lifecycle audit 精确使用 condition-error。
8. **#S6-054 Feed envelope/acquisition**：FeedParser 只产带 valueHash 的 FeedProjectionValue/canonical JSON；
   FeedAcquisitionService 以 HTTP 可信元数据盖章统一 envelope，contentHash=SHA-256(canonical value bytes)。
   已有 Baseline 的304=unchanged；首次304同 deadline 无条件 GET 恰一次，仍304则 unavailable 零 Baseline。
   Feed/Page 都汇入唯一 WatchProcessingService；持久化 JSON exact-key/hash/bytes validator fail-closed。
9. **#S6-055 schema v3**：observations 有 Event 内 sequence；items 以 `(observation_id,event_id)` 复合 FK
   拒绝跨 Event 错配，并有 Event/observation 两级连续 sequence。迁移 guard 拒绝零 item/计数不一致/缺口；
   最近 Event/pair 同时间戳全序、`v2:`+eventId 回填冲突失败、任一语句失败整体回滚，v2 原列逐列恒等。

公式、排序、事务和完整性 validator 的唯一细节源为 detailed §5/§6.4/§8.1/§9/§10/§13.1/§14/§15 与
决议 #S6-044～#S6-055。

## 范围与非目标

- **做**：Feed/Page Diff、StructuredChangeSet、EvidencePair、Condition 接线、Baseline first/rebaseline、
  Feed acquisition/envelope、统一 processing service、Run/Event health、idempotency/fingerprint、30 分钟
  item-preserving coalesce、reversal、schema v3 migration/validator、原子新建/合并/dedup、8.24 冒烟与 WATCH
  跨进程门控。
- **不做**：AI equality/importance、Digest、Watch UI/IPC/renderer/preload、Windows 通知展示；哈希不能单独
  创建 Event；不新增 audit kind，只按 #S6-044 批准集合扩展 reason；不修改 D3 网络安全工厂、D6 Session
  ownership、BrowserController/SourceService 公共接口或依赖。

## 涉及模块和输入文档

- `src/shared/watch/diff/`、`src/shared/watch/event-validator.ts`、ConditionEngine/Watch types；
  `src/main/watch/feed-acquisition-service.ts`、`watch-acquisition-service.ts`、新的有界 processing service、
  `watch-run-coordinator.ts`；Watch Repository/migration/store/row validator。
- 输入：detailed §5/§6.4/§7/§8.1/§9/§10/§13.1/§14/§15、#S6-044～#S6-055；threat-model
  §3.3/§3.5/§3.6/§3.8、WRT-08/WRT-10～WRT-12/WRT-17/WRT-18。

## 预计修改文件

- 新增：`src/shared/watch/diff/{feed-diff,page-diff,evidence}.ts` 与测试、
  `src/shared/watch/event-validator.ts` 与测试、`src/main/watch/feed-acquisition-service.ts`、有界
  `watch-processing-service.ts` 与测试、`src/main/smoke-watch-diff-event.ts`。
- 修改：`src/shared/types/watch.ts`（Feed value/envelope、condition_error、event-coalesced 等闭合类型）、
  `src/main/watch/feed-parser.ts`、`src/shared/watch/feed-normalize.ts`、ConditionEngine、
  `src/main/watch/watch-acquisition-service.ts`、`watch-run-coordinator.ts`、
  `repository/watch-repository.ts`、`db/watch-migrations.ts`（v3）、Watch store/row validator、相关测试，
  `src/main/smoke.ts`、`smoke-watch-store.ts`、`index.ts`（只装配接线）。
- 不改 Research Evidence/Result，不落盘 Capture/Feed/HTML 正文；不改 renderer/preload/IPC/Provider/
  AgentLoop/ToolRegistry/package/lockfile；不新增依赖。若实际文件名需最小调整，FINAL EVIDENCE 必须解释；
  需要越过上述模块时停止。

## 实施步骤（红→绿）

1. 红：先建能甄别 schema v2/旧占位 pipeline 的行为测试；不得用类型错误/模块缺失作为唯一红态。
2. 绿一：FeedField valueHash + ParsedFeedProjection → FeedAcquisition envelope/304 → Feed/Page 持久化
   validator；接入统一 acquisition 判别联合。
3. 绿二：Feed/Page Diff → EvidencePair → Condition 三分支（matched/no-match-warning/error）→
   EventValidator 与最近 pair reversal。
4. 绿三：schema v3 audit/observation/items 表重建、复合 FK、sequence/count validator、v2 回填与逐语句
   rollback；v1/v2 migration 字节不变。
5. 绿四：ProcessingService → Repository 新建/合并/dedup 三事务；Baseline、rowVersion max、Run health/audit、
   outbox 与所有故障交错原子。
6. 绿五：Coordinator 第二次 revalidation 后接线、受控 Feed/Page 8.24 冒烟、WATCH set/check 跨重启。

## 验收标准与测试方式

- **Diff/Evidence**：feed 重排/Region 外噪声零 Event；真实字段变化有 typed old/new；contentHash 变化但零
  合规 pair → failed parse_changed、零 Event/零 Baseline。
- **完整循环/重放**：窗口内 A→B→A→B→A 四观察/全部 pair/Baseline=A；29:59 合并、30:00 新建、
  32 KiB+1 新建；窗口边界和重启后 reversal 一致；相同 fingerprint 不去重，相同 idempotencyKey 才 dedup，
  且 Baseline/Run/observation 精确符合 detailed §9.4。
- **并发 CAS**：第二次 revalidation 后 metadata update 完成 → 结果有效且 rowVersion 不回退；locator prepare
  完成 → 新建/合并/dedup 整体失败。expectedBaseline/Event firstObservedAt/itemCount 陈旧零部分写。
- **Condition/health/audit**：unsupported/no-match warning 与 condition error 全矩阵；每种 RunOutcome 的 reason
  精确，Event created/coalesced/deduplicated 零 unchanged 冒充；condition_error pause/counter/backoff/health/
  Baseline/audit 全断言（Rule pauseReason=dependency-unavailable，不重建 watch_rules 父表）。
- **Feed**：valueHash 截断固定向量、200 envelope hash、304 首次/已有 Baseline、持久化 JSON 未来/非法/
  超限；Page/Feed 进入同一 processing service。
- **schema v3**：数据库层拒绝跨 Event observation/item；拒绝零 item/计数不一致/sequence 缺口；相同
  时间戳排序全序；`v2:`+eventId 回填冲突失败；每条 migration 语句失败均完整回滚；成功后 v2 所有既有列
  逐列恒等。
- **原子/隐私**：Event+observation+items+Baseline+Run+audit+新建 outbox 单事务；muted 零 outbox；原始
  body/HTML/PageSnapshot/query/Cookie/token 零非 Evidence 持久化/日志。
- 聚焦红→绿后运行 `npm test -- --maxWorkers=1`、typecheck、lint、format:check、build、`git diff --check`；
  主进程接线运行 dev+production 8.24 与 `AIBROWSE_WATCH_SMOKE=set|check`；安全/持久化使用新的独立 Reviewer。

## 完成定义

红→绿记录、迁移逐列/回滚证据、循环/并发/审计/Feed 机器 oracle、全量/构建/冒烟/跨进程/隐私扫描全绿、
diff/范围/垃圾/敏感信息终检、local logical candidate commit(s)（不 push）、新的独立安全/持久化 Reviewer
`PASS`。Reviewer PASS 前不更新 progress 为完成、不 push。

## 依赖与停止条件

- 依赖 D2–D6（均已关闭）；D8–D10 依赖本任务。
- 无法给 equality/循环/迁移/并发精确 oracle、需要模型判定、需要保存正文/HTML、Event 无双侧 Evidence、
  需要放宽 Baseline/关系/审计原子性、要改变 BrowserController/SourceService 公共接口或偏离
  #S6-044～#S6-055 任一裁决时停止并 REPLAN。
