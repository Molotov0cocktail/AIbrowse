# B2 — Source 域模型 + Repository + SourceService + change journal + Undo

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§2 类型/§4 规范化/
> §5 schema/§6 SourceService/§7.4–7.6 事务与 journal/§7.5 Undo）。

## 目标

落地 Source 域模型与数据层：canonicalization 纯函数、schema v1 migration、
Repository（唯一 SQL 执行点）、SourceService（UI 与 Agent 共用唯一入口）、
持久 change journal 与 durable Undo。UI/Agent 面与工具面不在本任务（B3/B4/B5）。

## 前置依赖

- B1 完成（driver 冻结 + migration 骨架）。

## 范围

- shared/types/sources.ts 全量类型（§2）落地；
- source-canonical.ts 纯函数（§4 规则矩阵）；
- migrations v1：schema 语句（§5 表集）+ user_version 1；
- source-repository.ts：CRUD/唯一约束/事务/soft delete/restore/hard delete
  清理（CASCADE + FTS/usage/journal payload 清理）——全部 SQL 编译期常量 +
  prepared statements；
- change-journal.ts：before/after payload、幂等键 UNIQUE、有界清理（100 条/30
  天，注入时钟测试定稿）、Undo 回放与幂等；
- source-service.ts：§6 接口落地（search/list/get 的 Repository 部分可先返回
  基础实现——FTS 检索接口由 B3 补齐，本任务 search 可用参数化精确匹配最小实现）；
- 审计接线（手工操作与 applyChangeSet 的审计出口预留，B4 接工具管线）。

## 非目标

- Source Tools/权限矩阵/确认接线（B4）；FTS5 索引与多语言检索（B3）；Sources
  UI/IPC/bridge（B5）；usage 记录（B7）；备份定稿（B7）；任何 Agent 上下文改动。

## 涉及模块

`src/main/sources/domain/source-canonical.ts`、`source-change-set.ts`（结构校验
部分）、`src/main/sources/repository/source-repository.ts`、`change-journal.ts`、
`src/main/sources/source-service.ts`、`src/main/sources/db/migrations.ts`（v1）、
`src/shared/types/sources.ts`；单测各 .test.ts；冒烟 B-02（CRUD 跨进程持久化）。

## 红态测试（先红后绿）

- canonicalization 矩阵（大小写/默认端口/fragment/userinfo 拒绝/IDN/query/
  非默认端口/空路径）；
- change set 结构校验（≤20/字段白名单/长度/枚举/URL 形状/trust 通道规则/blocked
  仅用户）；
- 唯一约束：并发/顺序双写同 canonical key → 一个成功一个 source-duplicate；
- 事务：注入中途异常 → 整体 rollback 零写入；
- journal：100 条/30 天任一触发清理（注入时钟）、Undo 幂等、版本冲突拒绝；
- hardDelete：FTS/journal/usage payload 清理断言（字节级）；
- 冒烟 B-02：临时 userData 双进程重启读回（沿用 SESSION_SMOKE 同模式）。

## 实现步骤

1. shared 类型 + canonical 纯函数（红→绿）；
2. migrations v1 + Repository（红→绿：先用注入内存 driver 单测，冒烟走真实
   node:sqlite）；
3. change-journal + Undo（红→绿，注入时钟）；
4. SourceService 装配（手工操作路径 + applyChangeSet 路径，事务/审计出口）；
5. 冒烟 B-02 双进程持久化场景；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §2/§4/§5/§6/§7.4/§7.5 全部落地并有单测证据；
- 跨进程重启后 CRUD 数据与 journal 数据完整读回（B-02）；
- 红线 grep：SQL 仅 repository/migrations；无 exec 动态串；无扩展加载；
  renderer/preload/tools/agent 零 SQL；
- duplicate 由唯一约束保证（非先查后写）的单测证据。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟（含 B-02 与既有矩阵回归）· 敏感信息扫描
（note 全文不入日志的既有链回归）· diff 终检。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时 userData/日志。

## 完成定义

上述验收标准全绿 + progress 任务表 B2 ✅ + 双远程推送；若实施中发现契约问题：
先按 detailed-design §15 流程校准文档与测试，再改实现（记录决议）。

## 风险与停止条件

- node:sqlite 行为与设计假设冲突（如 FK/事务/并发语义）→ 停止并提交证据，回
  B1 决策门评估备选；
- migration v1 定稿后不得改写已发布语句（追加版本）；若本任务内发现 v1 设计
  缺陷，在本任务完成前修正并重跑（未发布无兼容负担）；
- 红线：不新增依赖、不改 B1 冻结的驱动行为、不提前实现 B3+ 面。
