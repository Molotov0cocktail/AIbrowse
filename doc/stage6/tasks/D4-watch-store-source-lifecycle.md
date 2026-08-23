# D4 — watch.db、Repository、恢复/保留与 Source 生命周期协调

## 目标

落地独立 `watch.db` schema v1、Repository/Store、原子 Baseline/Event/Evidence/Outbox 写入、分级保留与
Source disable/restore/url-change/hard-delete 的跨库 fail-closed 协议。

## 范围与非目标

- **做**：detailed §10 全部表/索引/外键/JSON validator；normal|unavailable；running→interrupted；
  backup/restore；100 MiB/时间/数量清理；durable cleanup intent + run revalidation 端口。
- **不做**：Scheduler、网络/Parser、Page Diff、UI；不把 Watch 表放入 sources.db/research.db；不宣称跨库事务原子。

## 涉及模块和输入文档

- `src/main/watch/db/`、repository、store、lifecycle coordinator；SourceService 内部观察者最小装配及测试。
- 输入：detailed §3/§9/§10；threat-model WT-19～WT-22、WRT-17/WRT-18；Stage4 Sources 生命周期契约。

## 预计修改文件

- 新增 watch migration/repository/store/lifecycle 模块与测试。
- SourceService 仅允许增加内部观察者装配/call site；renderer/Agent 公共方法、Sources schema/journal/Undo 零变化。

## 实施步骤（红→绿）

1. 红：真实 node:sqlite migration/CRUD/CAS/注入/预算/恢复和每个 hard-delete 崩溃切点测试。
2. 绿：migration → Repository → Store → retention → lifecycle intent/reconciliation。
3. 事务测试 Event+items+Baseline+Run+outbox 要么全有要么全无；future/corrupt/非法 JSON 整库 unavailable。
4. Source disable/soft-delete/restore/url update/hard-delete/失败/重启矩阵；用户 Source/Research 数据恒等。
5. 全量、dev/production store 冒烟、跨进程 set/check、隐私/SQL 红线。

## 验收标准与测试

- schema v1 与 detailed §10.1 完全一致；业务 SQL 只在 Repository/migration，注入串仅数据。
- 运行前 Source revalidation 端口可在孤儿状态拒绝联网；硬删最终级联且不可 Undo。
- 公开90天/200、Session30天/100、全库100MiB和对象预算逐边界验证。
- 恢复后 Session grant 失效；dispose 幂等；全量门控与相关冒烟全绿。

## 完成定义

红→绿、恢复/隐私证据、独立安全/持久化 Reviewer PASS、候选提交；不启动周期任务。

## 依赖与停止条件

- 依赖 D2；D5/D7/D8/D9 依赖本任务。
- 若需要改 Sources 公共语义/schema/journal、动态 SQL、第三数据库库、不可恢复迁移或无法保证孤儿零网络，停止 REPLAN。
