# B1 — Electron node:sqlite 决策门 spike + SQLite/migration 基座

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§3 决策门/§1 文件布局/
> §5 schema 原则）；安全契约源 `doc/stage4/threat-model.md`（先于本任务定稿）。

## 目标

在 Electron 43.4.0 main 进程的 **dev 与生产构建**中实测 `node:sqlite` 的 11 项
能力（detailed-design §3.2），逐项独立实测与报告；**基础能力项（①–⑦、⑩、⑪）
全部通过后冻结 driver**（⑧⑨ 失败不构成 B1 失败，B3 以降级路径为主并如实登记——
决议 #46）并落地薄封装（sqlite-driver.ts）+ migration 引擎骨架（user_version
单调逐级 + 事务 + 备份触发点）。本任务是第四阶段**硬前置**：基础能力项全部通过前
禁止任何 Source 域模型/Repository/Tool/UI 实现。

## 前置依赖

- 第三阶段 GO/PASS（已满足）；Entry Gate 通过（proposal §8）。
- 无新增 npm 依赖（本任务用 Node 内置 node:sqlite 实测；失败时仅提交证据，
  评估 better-sqlite3 属 B1 停止后的后续决策，不在本任务内安装）。

## 范围

- 冒烟探针（smoke.ts 新场景，`AIBROWSE_SMOKE=1` 内自动运行，dev+生产双场景）：
  ① import DatabaseSync（dev）；② import（生产构建产物）；③ 文件库创建/重开
  （临时 userData 路径）；④ prepared statements 参数绑定（中文/引号/注入串仅作
  数据）；⑤ 事务 BEGIN/COMMIT/ROLLBACK（异常路径回滚）；⑥ `PRAGMA foreign_keys=ON`
  生效；⑦ busy_timeout 设置生效；⑧ FTS5 建表成功；⑨ trigram tokenizer 建表 +
  中文子串命中；⑩ userData 路径建库；⑪ close 后句柄清理（重命名/删除成功）。
- 薄封装 `sqlite-driver.ts`：openDb/closeDb/withTransaction（Repository 只依赖
  该接口，测试可注入内存实现）。
- `migrations.ts` 骨架：版本常量 + 迁移列表类型 + 逐级事务执行 + 异常 rollback +
  未知高版本判定（本任务不含业务表——schema 定义随 B2）。

## 非目标

- 任何 Source 表结构/Repository/Service/Tool/UI/IPC 实现（B2+）；
- better-sqlite3 等备选依赖的安装与评测（仅 B1 失败后另起决策）；
- 备份方案定稿（B1 只实测候选可行性证据，冻结与保留策略归 B7）；
- 修改任何既有产品代码行为（仅新增测试设施与受门控冒烟场景；13 工具注册表不变）。

## 涉及模块

`src/main/sources/db/sqlite-driver.ts`（新增）、`src/main/sources/db/migrations.ts`
（新增，骨架）、`src/main/smoke.ts`（新增 B1 探针场景）、`src/main/index.ts`
（探针接线，仅 SMOKE_MODE）；单测 `sqlite-driver 相关纯逻辑`（迁移列表校验/
回滚决策纯函数，如可分离）。

## 红态测试（先红后绿）

- 冒烟探针在探针代码落地前不存在 → 运行冒烟报「B1 场景未实现」或断言失败（红）；
- 每个实测项写成**独立失败断言**（不聚合为单一通过标记），11 项全绿才退出码 0；
- 生产构建路径用 `npm run build` 产物启动（`AIBROWSE_SMOKE=1 npm run start`）
  独立验证 import 项。

## 实现步骤

1. 冒烟新增 B1 场景（临时 userData 目录，结束清理）——11 项独立断言，先写断言
   跑红；
2. 逐个实现探针直至 dev+生产双场景 11 项全绿；
3. 落地 sqlite-driver.ts 薄封装（打开选项/busy/外键/WAL/关闭清理）+ 单测可注入
   接口形状；
4. 落地 migrations.ts 骨架（版本常量、逐级事务、rollback、未知高版本判定纯逻辑
   单测）；
5. 汇总实测证据：Electron/Node/SQLite 精确版本、ExperimentalWarning 形态、
   FTS5/trigram 可用性结论、VACUUM INTO/backup API/关闭后复制三候选的可行性
   观察——写入本任务文档「实测证据」节 + detailed-design §15 追加决议；
6. 全量验证 + 文档同步（progress/AGENTS 按任务闭环规则）。

## 实测证据（2026-08-15 已回填，B1 完成）

- **环境**：Electron 43.4.0（内置 Node 24.18.1）/ SQLite 3.53.1（dev 与生产产物
  双场景一致）；系统 Node 24.18.0（单测环境）同为 SQLite 3.53.1。
- **11 项逐项结果（dev + 生产双场景）**：① dev import ✅；② 生产产物 import ✅
  （`npm run build` 后 `out/main/index.js` 含 driver 与 `node:sqlite` 导入，
  externalize 零配置改动）；③ 文件库创建/关闭/重开/读回 ✅；④ prepared
  statements 注入串仅作数据（中文/引号/`'; DROP TABLE` 原样读回、目标表完好）✅；
  ⑤ 事务 BEGIN/COMMIT/ROLLBACK（显式回滚/回调异常/语句异常三路整体回滚）✅；
  ⑥ 外键开启拦截 + 关闭放行双证 ✅；⑦ busy_timeout 两连接锁竞争（300ms 等待下界
  证据/释放后成功/零超时立即失败）✅；⑧ FTS5 建表与查询 ✅（可用）；⑨ trigram
  建表 + 中文 ≥3 字符子串命中 ✅（可用；1–2 字符查询不命中 = trigram 语义，B3
  短查询降级路径依据）；⑩ userData 派生路径 ✅（官方验证命令
  `AIBROWSE_USER_DATA_DIR=<系统 TEMP 下临时目录>` 实测；默认矩阵运行 userData
  非临时时该项如实跳过并注明）；⑪ 关闭后重命名/删除成功 + 重复关闭幂等 + 无效
  路径中文错误安全失败 ✅。
- **ExperimentalWarning 实测形态**：Electron 43.4.0 与系统 Node 24.18.0 导入
  node:sqlite 均**不产生** warning 事件（进程 `warning` 监听零触发、无 stderr
  输出）——如实记录，未压制、未 hack。
- **冒烟运行台账**：dev 默认矩阵退出码 0；dev 官方命令（temp userData）退出码 0
  （⑩ 通过）；生产官方命令（temp userData）首跑退出码 1——失败点为**既有 S4 UI
  矩阵 9**（面板 bounds 收缩断言，位于 B-01 之前的既有场景，非本任务代码路径），
  复跑连续 2 次退出码 0（与 A7「环境瞬态」先例一致，如实登记）；生产 B-01
  ①–⑪ 全部通过（① 由 dev 场景实测，②–⑪ 由生产场景实测）。临时 userData 与
  探针目录已清理，无残留。
- **备份三候选可行性观察（B7 定稿）**：① VACUUM INTO 可用（连接打开、WAL 活跃
  时生成一致性快照，integrity_check ok）✅；② node:sqlite backup API **不存在**
  （`DatabaseSync.prototype.backup === undefined`）❌；③ 关闭后复制可行（干净
  关闭后 -wal/-shm 自动清除，仅主文件保留；WAL 活跃时文件形态 = 主文件 + -wal +
  -shm，不得只复制主文件）✅。
- **单测**：+31 用例（sqlite-driver 17 / migrations 14：文件库/注入/事务三路/外键
  双证/WAL/busy 读回/两连接锁竞争（worker 正证 + 零超时负证 + 等待下界）/重复
  关闭/重命名删除/无效路径/关闭后使用拒绝；迁移列表空/重复/乱序/缺级/非正整数/
  当前版本/未知更高版本/第 N 步失败该步整体回滚零部分状态/部分迁移续跑），全量
  test 816/816。红态证据：先写测试时 2 文件「Cannot find module」失败 +
  冒烟构建失败（Could not resolve ./sources/db/sqlite-driver），实现后全绿。
- **驱动冻结决议**：detailed-design §15 决议 #48（按决议 #46 冻结：基础能力项
  ①–⑦、⑩、⑪ 全部通过；⑧⑨ 可用 → B3 FTS5 trigram 主路径）。

## 验收标准

- 11 项探针 dev+生产双场景全部通过（冒烟退出码 0，日志含逐项通过行）；
- 驱动冻结决议落 detailed-design §15（含实测版本证据与 warning 处置）；
- 若 FTS5/trigram 实测不可用：本任务仍可完成（驱动冻结照常，但 B3 主路径按
  降级方案实施），如实登记——**不构成 B1 失败**（B1 失败仅指 node:sqlite 基础
  能力 ①–⑦、⑩、⑪ 任一失败；决议 #46）。

## 全量验证

`npm test`（全量，含新增单测）· `npm run typecheck` · `npm run lint` ·
`npm run format:check` · `npm run build` · dev+生产双场景冒烟退出码 0
（含 B1 探针与既有全矩阵回归）· 红线 grep（业务 SQL 零出现——本任务无
Repository；driver 仅连接级运维 SQL 编译期常量；探针 SQL 仅限 SMOKE_MODE
门控冒烟 B-01 与单测，决议 #47/无扩展加载/无 exec 动态串）· diff 终检。

## 提交要求

一个或少量逻辑 commit（探针红→绿 + 驱动封装 + 文档同步分开或合并按实际规模）；
提交信息 `<type>: <中文描述>`；不提交临时 userData/日志。

## 完成定义

- 11 项探针逐项实测证据（基础能力项全绿 + ⑧⑨ 如实结论）+ 驱动冻结决议 + 全量
  验证全绿 + 文档同步（progress 任务表 B1 ✅、本文件实测证据节回填）+ 双远程
  推送；
- **未满足时不得标记完成**：任一基础能力项失败 → 按停止条件处理。

## 风险与停止条件

- **任一基础能力项（①–⑦、⑩、⑪）失败 → 停止**：提交红态证据与日志，不得继续
  B2+；后续评估 better-sqlite3（native addon ABI/rebuild/electron-vite 外部化
  成本）需用户决策后另起任务。
- ⑧⑨（FTS5/trigram）失败：不停止，但 B3 按降级路径为主实现并如实登记。
- electron-vite 外部化问题（vite discussion #19278）：若生产构建 import 失败，
  先调查构建配置根因（属于本项目构建事实，可修复配置——修复属 B1 范围内），
  修复后仍失败才按停止条件处理；不得用「require 兜底绕过」掩盖根因。
- 红线：本任务不新增任何依赖、不改既有产品行为、业务 SQL 零出现（driver 仅
  连接级运维 SQL 编译期常量，探针 SQL 仅限 SMOKE_MODE 门控冒烟 B-01 与单测——
  决议 #46/#47 裁决落点）。
