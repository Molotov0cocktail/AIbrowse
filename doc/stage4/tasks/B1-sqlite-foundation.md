# B1 — Electron node:sqlite 决策门 spike + SQLite/migration 基座

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§3 决策门/§1 文件布局/
> §5 schema 原则）；安全契约源 `doc/stage4/threat-model.md`（先于本任务定稿）。

## 目标

在 Electron 43.4.0 main 进程的 **dev 与生产构建**中实测 `node:sqlite` 的 11 项
能力（detailed-design §3.2），全部通过后冻结 driver 并落地薄封装
（sqlite-driver.ts）+ migration 引擎骨架（user_version 单调逐级 + 事务 + 备份
触发点）。本任务是第四阶段**硬前置**：通过前禁止任何 Source 域模型/Repository/
Tool/UI 实现。

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

## 验收标准

- 11 项探针 dev+生产双场景全部通过（冒烟退出码 0，日志含逐项通过行）；
- 驱动冻结决议落 detailed-design §15（含实测版本证据与 warning 处置）；
- 若 FTS5/trigram 实测不可用：本任务仍可完成（驱动冻结照常，但 B3 主路径按
  降级方案实施），如实登记——**不构成 B1 失败**（B1 失败仅指 node:sqlite 基础
  能力 ①–⑦、⑩、⑪ 任一失败）。

## 全量验证

`npm test`（全量，含新增单测）· `npm run typecheck` · `npm run lint` ·
`npm run format:check` · `npm run build` · dev+生产双场景冒烟退出码 0
（含 B1 探针与既有全矩阵回归）· 红线 grep（无 SQL 出现在 sources/db 之外/
无扩展加载/无 exec 动态串）· diff 终检。

## 提交要求

一个或少量逻辑 commit（探针红→绿 + 驱动封装 + 文档同步分开或合并按实际规模）；
提交信息 `<type>: <中文描述>`；不提交临时 userData/日志。

## 完成定义

- 11 项探针全绿证据 + 驱动冻结决议 + 全量验证全绿 + 文档同步（progress 任务表
  B1 ✅、本文件实测证据节回填）+ 双远程推送；
- **未满足时不得标记完成**：任一基础能力项失败 → 按停止条件处理。

## 风险与停止条件

- **任一基础能力项（①–⑦、⑩、⑪）失败 → 停止**：提交红态证据与日志，不得继续
  B2+；后续评估 better-sqlite3（native addon ABI/rebuild/electron-vite 外部化
  成本）需用户决策后另起任务。
- ⑧⑨（FTS5/trigram）失败：不停止，但 B3 按降级路径为主实现并如实登记。
- electron-vite 外部化问题（vite discussion #19278）：若生产构建 import 失败，
  先调查构建配置根因（属于本项目构建事实，可修复配置——修复属 B1 范围内），
  修复后仍失败才按停止条件处理；不得用「require 兜底绕过」掩盖根因。
- 红线：本任务不新增任何依赖、不改既有产品行为、SQL 不出 sources/db。
