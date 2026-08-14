# B2 — Source 域模型 + Repository + SourceService + change journal + Undo

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§2 类型/§4 规范化/
> §5 schema/§6 SourceService/§7.4–7.6 事务与 journal/§7.5 Undo）。

## 目标

落地 Source 域模型与数据层：canonicalization 纯函数、schema v1 migration、
Repository（唯一 SQL 执行点）、SourceService（UI 与 Agent 共用唯一入口）、
持久 change journal 与 durable Undo。UI/Agent 面与工具面不在本任务（B3/B4/B5）。

## 前置依赖

- B1 完成（driver 冻结 + migration 骨架）。

## 契约裁决（2026-08-15 实施前硬停点，九项缺口用户裁决，决议 #49–#57）

实现前逐项核验发现的设计缺口与裁决结论（详细设计 §15 决议 #49–#57 已同步）：

1. **origin/page 唯一性**（决议 #49）：`UNIQUE(scope, canonical_key)` 复合唯一
   约束，canonical_key 不编码 scope；
2. **空路径/尾斜杠**（决议 #50）：page 键 = WHATWG href（两形态同身份）；展示
   URL 保留原始输入；
3. **disable/restore 状态机**（决议 #51）：单一软删状态·双字段联动（不变量
   enabled=0 ⟺ deleted_at≠NULL；version 每次成功提交 +1；update 不触碰）；
4. **共享类型完整定型**（决议 #52）：SourcePatch/SourceTag/SourceListItem/
   SourceView/结果判别联合/SourceErrorCode（+undo-conflict/undo-not-found）/
   Manual/Undo 系列 + 缺省与通道语义（AI 通道 trust 缺省 ai+unverified 等）；
5. **幂等重放**（决议 #53）：journal 增部分唯一索引 (run_id, tool_call_id) +
   request_fingerprint（SHA-256）+ result_payload；同指纹幂等返回原结果、
   异指纹 fail-closed、失败零落 journal；
6. **FTS 所有权**（决议 #54）：B2 最小写同步（FTS 行 = 非 hard-deleted 行镜像，
   查询期过滤归 B3；B3 负责查询构造/排序/rebuild）；
7. **journal 精确关联**（决议 #55）：source_ids JSON 数组、payload
   {sourceId: 快照} 映射；hard delete 精确拆分、剩余为空删整行、其余 Undo 保留；
8. **hardDeleteManual 令牌**（决议 #56）：内置 ConfirmTokenIssuer（256-bit、
   绑定 sourceId、TTL 300s、消费即失效、now 注入）；未签发/错绑定/过期/重用 →
   source-conflict 零删除；
9. **B-02 门控路由**（决议 #57）：专属 `AIBROWSE_SOURCES_SMOKE=set|check`
   （与 SESSION_SMOKE 互斥）；index.ts 最小路由；set 写 CRUD+journal、check
   读回+Undo，两进程均需 AIBROWSE_SMOKE=1 + 已核验 TEMP 子目录。

## 范围

- shared/types/sources.ts 全量类型（§2，决议 #52 定型）落地；
- source-canonical.ts 纯函数（§4 规则矩阵，决议 #49/#50）；
- migrations v1：schema 语句（§5 表集 + 决议 #49/#51/#53/#54/#55 校准）+ user_version 1；
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
  非默认端口/空路径两形态同身份——决议 #50）；
- change set 结构校验（≤20/字段白名单/长度/枚举/URL 形状/trust 通道规则/blocked
  仅用户/缺省冻结/同 set 重复 sourceId 拒绝——决议 #52）；
- 唯一约束：并发/顺序双写同 canonical key → 一个成功一个 source-duplicate
  （决议 #49：复合唯一约束，双连接锁竞争）；
- 事务：中途冲突（同 set 内重复 canonical/CHECK 违规）→ 整体 rollback 零写入
  （sources/groups/tags/links/journal/FTS 全零部分写入）；
- journal：100 条/30 天任一触发清理（注入时钟，恰好 30 天保留/超过清理）、
  Undo 消费幂等、版本冲突拒绝、畸形 payload 安全失败、hard delete 精确拆分
  （决议 #53/#55）；
- hardDelete：FTS/journal/usage payload 清理断言（字节级，决议 #54/#55/#56）；
- schema v1 契约断言（migrations.test.ts 扩展：表集/复合唯一/部分唯一索引/
  user_version=1——旧 MIGRATIONS 空列表下明确失败，非仅「模块不存在」红态）；
- 冒烟 B-02：临时 userData 双进程 set/check 读回 + Undo（决议 #57 专属门控）。

## 实现步骤

1. shared 类型 + canonical 纯函数（红→绿）；
2. migrations v1 + Repository（红→绿：先用注入内存 driver 单测，冒烟走真实
   node:sqlite）；
3. change-journal + Undo（红→绿，注入时钟）；
4. SourceService 装配（手工操作路径 + applyChangeSet 路径，事务/审计出口）；
5. 冒烟 B-02 双进程持久化场景；
6. 全量验证 + 文档同步。

## 红→绿证据（2026-08-15 已回填，B2 完成）

- **红态（先写测试，旧结构下真实失败）**：全量 test 6 files failed / 10 failed /
  818 passed——5 个新测试文件「Cannot find module」（source-canonical/
  source-change-set/change-journal/source-repository/source-service）+ migrations
  schema v1 契约断言在旧 MIGRATIONS 空列表下以真实断言失败（`expected +0 to be
1`、`expected 'up-to-date' to be 'migrated'`、`no such table: sources`——非仅
  「模块不存在」红态）；typecheck 红（TS2307 模块缺失 + smoke B-02 隐式 any）。
  既有 816 用例零删除零削弱。
- **绿态**：全量 test **947/947**（新增 131：source-canonical 22 /
  source-change-set 28 / source-repository 17 / change-journal 15 /
  source-service 37 / migrations +12 schema v1 契约），typecheck/lint/
  format:check/build 全绿。
- **实现期修正（如实登记）**：实现侧真实缺陷 5 处——① journal 部分唯一索引与
  复合唯一索引的 SQLite 冲突消息为「列名」形态（实测 3.53.1：`UNIQUE constraint
failed: t.a, t.b`），translateSqliteError 匹配串修正；② listSources/
  countSources 的 groupId=null 语义（未分组过滤）与「不过滤」混淆——SQL 改三态
  mode 参数；③ applyChangeSet 逐项预检未包裹 try/catch（drop 表后不可预期错误
  泄漏为抛异常）——补归一化；④ stripControlChars 遗漏 \n/\r——按 C0 除 \t 全剔
  校准；⑤ B-02 冒烟断言自身缺陷（Undo 后列表期望 2 实为 1——list 默认过滤
  deleted_at IS NULL，决议 #51 语义，disabled 行不列出）。测试自身缺陷若干
  （'https:///path' 经 WHATWG 解析 host='path' 属合法形态、IDN 非 ASCII 路径
  百分号编码、LIKE 前缀语义下 '%可靠' 不命中 '100%可靠'、部分夹具缺 FK 前置/
  canonical 重复——均按契约修正测试，无实现迁就）。**SQLite 3.53.1 实测事实**
  （本任务新增证据）：转义通配符位于 LIKE 模式首位时前缀语义正常
  （`'\%bc%'` 匹配 `'%bc'`/`'%bcx'`、不匹配 `'x%bc'`）；唯一冲突消息为列名形态。
- **冒烟**：默认完整 dev 矩阵退出码 0；默认完整生产矩阵退出码 0（B-01 ①–⑪ 全过，
  既有 T/S/A/RT 全矩阵回归通过，S4 bounds 本轮未复现）；**B-02 生产双进程**
  `AIBROWSE_SOURCES_SMOKE=set` 退出码 0（CRUD + 5 条 journal）→ 新进程 `check`
  退出码 0（读回一致 + 重启后 Undo 生效 + 重复 Undo 幂等 + 版本冲突拒绝），两
  进程均 AIBROWSE_SMOKE=1 + 已核验系统 TEMP 子目录（smoke 内 isPathInside 断言）；
  互斥路由实测（SESSION_SMOKE 与 SOURCES_SMOKE 同设 → 退出码 1 + 中文错误）；
  临时目录解析确认位于系统 TEMP 后仅删除本次目录，零残留。

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
