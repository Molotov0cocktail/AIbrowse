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

## 实施裁决与红→绿证据（2026-08-15 回填）

### 实施前契约裁决（落 detailed-design §15 + §3.1/§10/§11/§13 + threat-model §3.2/§3.5，决议 #86–#91；本任务授权直接校准，未向用户询问）

1. **backup.ts SQL 窄契约（#86）**：`db/backup.ts` 仅允许编译期固定的存储运维
   SQL（PRAGMA user_version/quick_check/integrity_check/foreign_key_check +
   `VACUUM INTO` + 事务控制）；**VACUUM INTO 路径参数绑定实测成立**（本任务
   实测：node:sqlite `prepare('VACUUM INTO ?')` 支持绑定——比 PRAGMA 语义更
   严格地满足红线）；路径由主进程生成、严格校验（绝对/目录内/严格命名/非链接）
   后绑定；无业务 CRUD/动态 SQL。
2. **备份方案冻结 = VACUUM INTO（#87）**：B1 + 本任务双实测（WAL 活跃一致性
   快照、备份可打开且数据完整）；node:sqlite backup API 不存在（B1 实测）不
   实现；关闭后复制仅为已验证后备设计不静默启用；目标碰撞语义（VACUUM INTO
   遇已存在目标失败——实测）→ 覆盖前先移除本次生成的严格命名目标；快照校验
   （可打开 + integrity ok + 版本匹配）失败即删除部分备份。
3. **「迁移失败原库完好」逻辑恒等校准（#88）**：原路径不得被替换/截断/自动
   恢复覆盖；回滚后 user_version/schema/数据逻辑恒等；迁移前备份可打开完整；
   不要求 WAL/SHM 逐字节恒等。实现额外保证：迁移期间工作连接 `wal:false`——
   失败路径主文件字节不变（单测 + 冒烟字节哈希断言）。
4. **保留策略冻结（#89）**：仅严格命名 + backups 目录内普通文件（非链接/非
   目录）；最新 5 个 + 30 天两上界同时生效；绝不跟随链接/删除原库或无关文件；
   清理失败仅记录不阻塞启动。
5. **usage 两处投影同事务一致（#90）**：recordUsage 同事务更新 usage_events
   与 sources.last_used_at/last_usage_outcome；usage 非数据变更（零 version
   bump/零 journal/零 Undo/零 changed）；写失败安全 no-op（B6 契约不变）；
   Undo 回放不覆盖 usage 两列。
6. **rebuild 受控入口（#91）**：`sources:rebuild-index`（无 payload）→
   SourceService.rebuildSearchIndex（复用 B3 能力）——仅 Sources UI + normal
   状态；零 Agent 工具/零 L2 变更/零 Undo/零 changed/零 manual 审计；有界中文
   诊断（行数对比，无绝对路径）；详情展示「上次使用结果」（describeLastUsage：
   可达/不可达/其余「暂无可靠信号」，严禁「健康/长期可用」）。

### 红→绿

- **红态（旧结构真实失败）**：5 files failed / **16 failed / 110 passed**——
  backup.test.ts 与 sources-store.test.ts 模块缺失（Cannot find module）；
  source-service 6 例失败（recordUsage 只写 usage_events——sources 列恒 null
  （双投影/最近一次覆盖/Undo 回放保留 3 例）+ rebuildSearchIndex 不存在（3 例
  TypeError））；source-ipc 4 例失败（adapter.rebuildIndex 不存在）；sources-
  display 6 例失败（describeLastUsage/formatLocalTime 不存在）。既有 1160
  用例零删除零削弱。
- **实现后绿态**：全量 **1207/1207**（新增 47：backup 20 / sources-store 9 /
  source-service 9 / source-ipc 4 / sources-display 5）。实现期修正均为测试
  自身断言缺陷（prune 返回基名 vs 全路径期望、碰撞用例缺 expectedVersion
  参数、目录形态按裁决 #86 校准为 not-a-file→unavailable、恢复态 preview
  opsCount 按 B4 既有门控语义为 0）；**实现侧真实缺陷 3 处**（均在红→绿期间
  实测抓出并修复，各有断言固化）：① 迁移失败路径主文件字节变化——工作连接
  openDb 默认切 WAL 写文件头 → 迁移期间改 `wal:false` 连接、成功后才切换
  WAL；② VACUUM INTO 遇已存在目标失败（SQLite 语义）→ 覆盖前先移除本次
  生成的严格命名目标；③ 备份快照校验失败时 Windows 下先关只读句柄再删除
  （EPERM）。
- **冒烟 8.14 B-06 B7 部分（默认矩阵自动包含，dev+生产双场景退出码 0）**：
  真实启动装配路径——新库零备份/v0→v1 先备份后迁移/注入迁移失败回滚 + 原库
  逻辑恒等 + 主文件字节不变/未来版本零写入/坏 magic 与截断保留/恢复态读写
  Undo usage rebuild 全拒 + 四 Agent Source 工具 fail-closed + 数据库零变化
  - 浏览器其余能力继续可用（受控页加载断言）/保留清理（5+30 天上界 + 无关
    文件不动）/rebuild 诊断（行数一致 + FTS 破坏失败安全）/usage 两处投影一致
    （同事务同时钟）。**B-02 双进程扩展**：set 写入 usage → check 新进程读回
    两处投影一致 + durable Undo（生产退出码 0）；**B-05 与 SESSION 双进程
    复跑退出码 0**（启动存储路径改动回归）。
- **红线**：SQL 仍仅 Repository/migrations 编译期常量 + backup.ts 存储运维
  窄契约（决议 #86）；renderer/preload/tools/agent 零 SQL；rebuild 通道零
  payload（零 SQL/路径参数）；新代码零 any/@ts-ignore；工具注册表仍 17 工具
  （零新增）、schema v1 零改写、依赖零变化；恢复态为真实生产装配（非
  SMOKE_MODE override）；冒烟临时目录全部清理。

### 事故恢复与安全加固（2026-08-15 回填，B7 收尾闭环）

B7 主体工作完成后发生环境事故（VS Code 卡死/插件闪退/uv_spawn unknown
error/退出码 45/根目录大量零字节文档碎片文件），本闭环完成事故止损、
B7 实现安全审查与修复、可信重验：

1. **事故止损**：只读检查进程/资源（无 node/electron 残留进程、内存/CPU
   正常、node v24.18.0/npm 11.16.0 定位正常），未终止任何进程；根目录 46
   个异常文件（45 个零字节文档片段 + 1 个 npm `Unknown command:` 错误输出
   文件）与事故日志 aibrowse-2026-08-15.log（敏感扫描零命中）经四项标准
   逐项核验后同一 PowerShell 会话 `Remove-Item -LiteralPath` 精确清理（47
   项删除，零 glob 零跨 shell）；3 个红态测试夹具残留目录清理；工作区恢复
   「24 个 B7 修改 + 4 个预期新文件」干净形态。
2. **安全审查发现并修复 5 项数据安全问题（红→绿 11 failed → 41/41）**：
   ① probeDbFile 头部探测 `readFileSync` 整库读入 → 固定 16 字节
   open/read/close（readFileSync 零调用断言 + 1 GiB 稀疏坏头库快速
   bad-magic）；② createConsistentBackupAt 任意路径先删后写 → 目标已存在
   fail-closed 拒绝（绝不删除/覆盖调用前已有文件），部分文件清理仅限本次
   新建目标；③ 目标名碰撞覆盖删除 → 换新名有限重试（5 次）全碰撞
   fail-closed（randomHex 注入确定性验证）；④ backups 目录 symlink/
   junction 真实路径解析校验（解析后必须仍位于 Sources 目录内；prune 不
   跟随目录链接越界 + 删除前 lstat/realpath 复核 TOCTOU 防御）；⑤
   pruneBackups keepCount/maxAgeMs/nowMs 边界验证（非有限/负数/非整数 →
   安全空结果零删除——旧实现 keepCount=NaN 全量误删，红态实测）；备份源
   连接改只读（备份过程不写源库，WAL 活跃库主文件字节恒等断言）。
   测试自身修正 2 处：ESM 命名空间不可 spy → 模块级 vi.mock 计数包装 +
   randomHex 注入参数；junction 夹具目标须位于 root 外（独立 TEMP 目录）
   - rmdirSync 显式清理 reparse point（rmSync recursive 在 Windows 对
     junction 残留报 EPERM）。
3. **可信重验（受控串行，单 worker）**：定向 41/41 → typecheck → lint →
   format:check → build → 全量 **1219/1219**（52 文件，19.56s）→
   git diff --check → dev 冒烟退出码 0（8.14 B-06 全矩阵）→ 生产冒烟
   退出码 0 → B-02 set/check 退出码 0（usage 投影跨进程一致）→ B-05
   set/check 退出码 0 → SESSION set/check 退出码 0；进程/WAL-SHM/临时
   userData 零残留。**此前记录的 1207/1207 不作数——以本次 1219/1219
   为准**（+12 安全用例）。未调用任何付费 Provider、未发起公网请求、
   未新增依赖；schema v1/migration 零改写、工具注册表仍 17 工具。
