# B7 — 跨进程持久化 + migration/backup/recovery 全矩阵 + FTS rebuild + usage/health

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§10 migration/backup/
> 恢复、§5 journal 清理、§8.3 rebuild、§11 usage 边界）。

## 目标

落地第四阶段存储运维面：跨进程持久化验收（双进程临时 userData，沿用
AIBROWSE_SESSION_SMOKE 同模式）、migration 全矩阵（旧库升级/失败回滚/未知高
版本）、备份定稿（B1 实测证据基础上冻结方案与有界保留策略：最近 5 个版本 +
30 天）、只读恢复态装配（Sources 只读、浏览器其余能力正常）、FTS 诊断性 rebuild
受控入口（UI 诊断按钮 + 测试）、usage/health 边界确认（无后台巡检、最近一次
语义）。

## 前置依赖

- B2（migration v1/journal/恢复态判定）、B6（usage 记录接线）。

## 范围

- backup.ts 定稿：冻结方案（VACUUM INTO / backup API / 关闭后复制三候选中
  B1 实测最优）+ integrity_check/foreign_key_check 流程 + 有界保留；
- migration 全矩阵：v0→v1 升级（备份生成 + 单事务）；注入中途异常 → rollback +
  原库完好；user_version > 程序版本 → 只读恢复态；损坏库（人为截断/坏 magic）
  → 恢复态 + 中文诊断 + 原库保留；
- 只读恢复态装配：SourceService 全部写入口拒绝（source-unavailable），UI 诊断
  展示；浏览器其余能力回归（既有冒烟场景全过）；
- FTS rebuild 受控入口（UI 诊断按钮 + 冒烟探针）：rebuild 后行数一致校验；
- usage/health 边界（**B6 决议 #79 校准：SourceSearchHintStore 与 Agent 打开后
  的 usage 写入接线、冒烟 B-07 已归 B6 完成；B7 保留以下展示与运维边界**）：
  无后台巡检（日志断言零定时请求）；最近一次语义 UI 展示（「上次使用结果」
  文案，不宣称长期健康）；
- 跨进程持久化冒烟：进程 A 写入 CRUD + journal → 退出 → 进程 B 读回一致 +
  Undo 可用（B-02 扩展）。

## 非目标

- 静态加密（非目标）；自动恢复执行（仅诊断与手动指引）；云同步；CI 化。

## 涉及模块

`src/main/sources/db/backup.ts`、`migrations.ts`（全矩阵落地）、
`src/main/sources/source-service.ts`（恢复态写拒绝）、`src/main/index.ts`
（启动迁移/恢复态装配）、`src/renderer/src/ai/sources/`（诊断 UI）、
`src/main/smoke.ts`（B-06 migration/恢复场景 + 跨进程持久化扩展）；单测
migrations.test.ts/backup 纯逻辑。

## 红态测试（先红后绿）

- 迁移：逐级事务、异常回滚后原库完好（字节级）、未知高版本判定；
- 备份：WAL 活跃时备份一致性（备份库能打开且数据完整）；有界保留清理；
- 恢复态：写入口全部拒绝（含 UI 路径）；读入口拒绝；浏览器其余能力正常
  （既有冒烟矩阵回归）；
- rebuild：行数一致 + 诊断输出；
- 跨进程：双进程写读一致 + journal 可 Undo。

## 实现步骤

1. backup.ts 定稿（红→绿）；
2. migration 全矩阵 + 恢复态装配（红→绿）；
3. rebuild 入口 + 诊断 UI（红→绿）；
4. usage 边界断言 + 跨进程冒烟（红→绿）；
5. 冒烟 B-06 与既有矩阵全回归；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §10/§11 全部落地并有单测 + 冒烟证据；
- 恢复态下浏览器其余能力零回归（既有冒烟全矩阵）；
- 中文诊断可读（检测结果/原库位置/备份位置/建议动作）；
- 无后台巡检、无定时请求（grep/日志断言）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟 · diff 终检 · 敏感信息扫描。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B7 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- 备份方案三候选实测均不可靠（如 VACUUM INTO 在 WAL 下失败且 backup API 不存在）
  → 停止并提交证据，回设计流程裁决（可能采用「迁移前关闭连接 + 全文件复制」
  保守方案——迁移时机为启动早期，可行性高）；
- 恢复态若意外影响主进程启动 → 修复回归优先（恢复态必须局部化于 Sources
  子系统），修复前不提交。
