# D4 — watch.db、Repository、恢复/保留与 Source 生命周期协调

## 目标

落地独立 `watch.db` schema v1、Repository/Store、原子 Baseline/Event/Evidence/Outbox 写入、分级保留与
Source 全部写路径的 prepare/commit/abort 跨库 fail-closed 协议；明确区分行 version 与 locator identity。

## 范围与非目标

- **做**：detailed §10 全部表/索引/外键/JSON validator；normal|unavailable；queued/running→interrupted；
  backup/restore；100 MiB/时间/数量清理；SourceService 窄 projection observer、durable intent + run revalidation
  端口、`desiredEnabled`/rowVersion/locator fingerprint。
- **不做**：Scheduler、网络/Parser、Page Diff、UI；不把 Watch 表放入 sources.db/research.db；不宣称跨库事务原子。

## 涉及模块和输入文档

- `src/main/watch/db/`、repository、store、lifecycle coordinator；SourceService 内部观察者最小装配及测试。
- 输入：detailed §3/§9/§10；threat-model WT-19～WT-22、WRT-17/WRT-18；Stage4 Sources 生命周期契约。

## 预计修改文件

- 新增 watch migration/repository/store/lifecycle 模块与测试。
- SourceService 仅允许增加内部观察者装配/call site；renderer/Agent 公共方法、Sources schema/journal/Undo 零变化。

## 实施步骤（红→绿）

1. 红：真实 node:sqlite migration/CRUD/CAS/注入/预算/恢复；Source disable→restore version 递增、metadata-only、
   locator change、用户 pause 和 prepare/Source transaction/commit/abort/hard-delete 每个失败/崩溃切点测试。
2. 绿：migration → Repository → Store → retention → lifecycle intent/reconciliation。
3. 事务测试 Event+items+Baseline+Run+outbox 要么全有要么全无；future/corrupt/非法 JSON 整库 unavailable。
4. manual/AI change set/Undo/disable/soft-delete/restore/update/hard-delete 全 call-site 矩阵；用户 Source/Research
   schema、journal、Undo 和公共返回类型恒等。
5. 全量、dev/production store 冒烟、跨进程 set/check、隐私/SQL 红线。

## 验收标准与测试

- schema v1 与 detailed §10.1 完全一致；业务 SQL 只在 Repository/migration，注入串仅数据。
- `Source.version` 仅作 rowVersion；locator fingerprint 由 sourceId/scope/canonicalKey/kind/canonical target
  决定。disable→restore 即使版本递增也按 `desiredEnabled` 恢复；metadata-only 不 rebaseline，locator 变化必须暂停。
- observer 顺序/失败传播符合 detailed §10.3：prepare 失败时 hard-delete 零 Source 写；Source 已提交而
  commit 失败时返回 Source 成功但 Watch unavailable/intent 可重放；运行前 revalidation 使所有孤儿零联网。
- intent 持久化受影响 Rule 的 prepare 前状态，abort 只在 Source 仍等于 before 时恢复；D4 接线后 DB
  missing/corrupt/unavailable 绝不退化成 no-op。
- hard-delete 最终级联且不可 Undo；启动 reconciliation 幂等完成/取消 intent 后才启动 Scheduler。
- 公开90天/200、Session30天/100、全库100MiB和对象预算逐边界验证。
- 恢复后 Session grant 失效；dispose 幂等；全量门控与相关冒烟全绿。

## 完成定义

红→绿、恢复/隐私证据、独立安全/持久化 Reviewer PASS、候选提交；不启动周期任务。

## 依赖与停止条件

- 依赖 D2；D5/D7/D8/D9 依赖本任务。
- 若需要改 Sources 公共语义/schema/journal、动态 SQL、第三数据库库、不可恢复迁移或无法保证孤儿零网络，停止 REPLAN。
