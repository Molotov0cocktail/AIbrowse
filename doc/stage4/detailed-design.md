# AIbrowse 第四阶段 详细设计（Sources 长期信源系统，定稿）

> 状态：**定稿（2026-08-15，纯文档设计闭环）**。本文件是第四阶段**唯一契约源**
> ——所有接口签名、schema、权限矩阵、预算常量、决议以本文件为准；实施任务 B1–B9
> 按本文落点执行；实施中发现契约问题按 §15 决议记录流程校准（先改本文与测试，
> 再改实现）。
> 安全契约源：`doc/stage4/threat-model.md`（威胁 ST-01～ST-12、红队 SRT-01～SRT-12）。
> 需求源：根目录 `Fourth_stage.md`（§9 验收标准、§10 Exit Gate 已按本文校准）。
> 现状校准原则：本设计引用的既有接口均已与当前代码 `grep -n "^export"` 逐项核对
> （2026-08-15 本会话核查；AGENTS.md §5 与代码一致，4 处文档滞后性遗漏不影响
> 契约，见 §15 决议 #45）。
> **本设计闭环不新增任何 npm 依赖、不修改任何产品代码；全部内容为「规划/待实现」，
> 在对应任务完成前不得宣称已实现。**

## 1. 文件布局（B1–B7 新增，规划）

```
src/
├── main/
│   ├── index.ts                      # 既有：B4/B5 扩展 Source 工具注册与 IPC 装配；
│   │                                 #   B7 recovery 态装配；冒烟 8.1 工具数断言校准
│   └── sources/                      # 第四阶段新增（主进程专属，B1 起）
│       ├── db/
│       │   ├── sqlite-driver.ts      # B1：node:sqlite 薄封装（打开/busy/外键/WAL/关闭句柄清理）
│       │   ├── migrations.ts         # B1/B2：schema 编译期常量 + user_version 单调逐级迁移
│       │   └── backup.ts             # B1/B7：一致性备份（方案 B1 实测冻结）+ integrity/恢复态判定
│       ├── domain/                   # B2/B4：纯核心零 Electron 依赖，可单测
│       │   ├── source-canonical.ts   # URL 规范化（origin/page key）
│       │   ├── source-change-set.ts  # change set 结构校验 + 确定性 before/after diff
│       │   └── source-search-query.ts# B3：FTS 查询串纯函数构造 + 安全降级 + 确定性排序器
│       ├── repository/
│       │   ├── source-repository.ts  # B2：**唯一 SQL 执行点**（编译期常量 + prepared statements）
│       │   ├── source-search-index.ts# B3：FTS5/trigram 索引维护（与主表同事务）+ rebuild
│       │   └── change-journal.ts     # B2：持久 Undo 数据（有界 100 条/30 天）
│       ├── source-service.ts         # B2：SourceService（UI 与 Agent 共用唯一入口）
│       ├── usage/usage-tracker.ts    # B7：仅 Agent 打开/读取后记录最近一次 usage
│       └── tools/source-tools.ts     # B4：四工具定义与 executor（零 Electron import）
├── preload/index.ts                  # 既有：B5 扩展 sources 通道白名单
├── renderer/src/ai/sources/          # B5：Sources 面板（列表/详情/快速添加/恢复态/Undo）
└── shared/types/
    ├── sources.ts                    # B2：Source 域类型 + change set + IPC payload（单一事实源）
    └── ipc.ts                        # 既有：B5 扩展 sources 通道常量
```

依赖方向（Fourth_stage.md §1 + proposal Q 拍板，不可反向或跳跃）：
`Sources UI / Agent Source Tools → SourceService → SourceRepository /
SourceSearchIndex / SourceChangeJournal → sqlite-driver`。
renderer、preload、AgentLoop、Tool 实现**不得直接执行 SQL**；UI 与 Agent 共用
同一 SourceService；打开网页继续 `browser_open/browser_read → BrowserController`
（Source Tool 不新增任何网络能力）。

## 2. 共享类型契约（shared/types/sources.ts，B2）

```ts
export type SourceScope = 'origin' | 'page';
export type SourceShareMode = 'full' | 'metadata' | 'blocked';
export type SourceTrustValue = 'official' | 'primary' | 'secondary' | 'community' | 'unknown';
export type SourceTrustAssertedBy = 'user' | 'ai';
export type SourceTrustVerification = 'asserted' | 'unverified';
export type SourceCreator = 'user' | 'ai';
export type SourceReadAudience = 'user' | 'agent'; // 决议 #58：显式读取视角（必填，无缺省）
export type SourceUsageOutcome =
  'unknown' | 'reachable' | 'unreachable' | 'auth-required' | 'blocked';

export interface SourceTrust {
  value: SourceTrustValue;
  assertedBy: SourceTrustAssertedBy;
  verification: SourceTrustVerification;
}

export interface Source {
  id: string; // UUID（主进程生成）
  scope: SourceScope;
  canonicalKey: string; // 唯一键（origin：规范化 origin；page：去 fragment 规范化完整 URL）
  url: string; // 原始 URL（用户视角展示）
  name: string;
  groupId: string | null;
  tags: string[]; // 规范化标签名（NFC + trim，≤32 字符）
  priority: number; // 1–5 整数（默认 3）
  enabled: boolean;
  shareMode: SourceShareMode;
  trust: SourceTrust;
  userNote: string; // 用户明确写下的自然语言备注（'' = 无）
  aiNote: string; // AI 生成的备注（'' = 无）
  createdBy: SourceCreator;
  version: number; // 乐观并发（每次提交 +1）
  createdAt: string; // ISO 8601
  updatedAt: string;
  deletedAt: string | null; // soft delete
  lastUsedAt: string | null;
  lastUsageOutcome: SourceUsageOutcome | null;
}

export interface SourceGroup {
  id: string;
  name: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface SourceTag {
  id: string;
  name: string; // NFC + trim
  createdAt: string;
}

export interface SourcePatch {
  name?: string;
  url?: string; // 变更需重新规范化（canonical key 变化按新键唯一约束）
  groupName?: string | null; // null = 移出分组；字符串 = 按名幂等 get-or-create
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode;
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue; assertedBy: SourceTrustAssertedBy };
  // enabled 不进 patch：disable/restore 为显式 op（决议 #51）
}

export type SourceChangeOp =
  | {
      kind: 'add';
      scope: SourceScope;
      url: string;
      name?: string;
      groupName?: string;
      tags?: string[];
      priority?: number;
      shareMode?: SourceShareMode;
      userNote?: string;
      aiNote?: string;
      trust?: { value: SourceTrustValue; assertedBy: SourceTrustAssertedBy };
    }
  | { kind: 'update'; sourceId: string; expectedVersion: number; patch: SourcePatch }
  | { kind: 'disable'; sourceId: string; expectedVersion: number }
  | { kind: 'restore'; sourceId: string; expectedVersion: number };

export interface SourceChangeSet {
  ops: SourceChangeOp[]; // 1–20 项
}

export interface SourceChangeOpResult {
  opIndex: number;
  ok: boolean;
  sourceId?: string;
  existingSourceId?: string; // source-duplicate 时回注既有条目 id（§7.4「可能相关」）
  errorCode?: SourceErrorCode;
}

export interface SourceChangeResult {
  ok: boolean;
  idempotencyKey: string; // 成功提交时主进程生成；整体拒绝（零写入）时为空串（决议 #53）
  errorCode?: SourceErrorCode; // ok=false 时整组失败码
  results: SourceChangeOpResult[];
}

export type SourceErrorCode =
  | 'source-invalid-change'
  | 'source-version-conflict'
  | 'source-duplicate'
  | 'source-not-found'
  | 'source-forbidden'
  | 'source-limit'
  | 'source-unavailable'
  | 'source-conflict'
  | 'source-undo-conflict' // §7.5：Undo 前当前版本与 journal after 版本不一致
  | 'source-undo-not-found'; // §7.5：未知/已消费（重复 Undo 安全无操作）幂等键

// --- 服务层视图与结果（B2 冻结；工具层 allowlist/预算/分享模式过滤由 B3/B4 在
// 序列化层裁剪，服务层类型不变） ---

export interface SourceListItem {
  id: string;
  scope: SourceScope;
  canonicalKey: string;
  url: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  tags: string[];
  priority: number;
  enabled: boolean;
  trust: SourceTrust;
  shareMode: SourceShareMode;
  lastUsedAt: string | null;
  // 永不含 note 正文（决议 #59）——note 摘录只在 SourceSearchItem 上按 §8.2 规则出现
}

export interface SourceView extends Source {
  groupName: string | null; // 服务层视图（UI 手工路径需要 version/deletedAt；工具序列化按 §8.1 裁剪）
}

export interface SourceSearchNote {
  userNote: string | null; // ≤200 字符截断 + 控制/bidi 剔除后的正文（null = 无）
  aiNote: string | null;
}

export interface SourceSearchItem extends SourceListItem {
  // note 仅 agent 视角 + shareMode='full' + 对应 note 非空时携带；
  // user 视角与 metadata 条目恒 null（零 note 字节，决议 #59/#58）
  note: SourceSearchNote | null;
}

export type SourceSearchResult =
  | { ok: true; query: string; results: SourceSearchItem[] }
  | { ok: false; errorCode: SourceErrorCode };

export type SourceListResult =
  | { ok: true; page: number; pageSize: number; total: number; items: SourceListItem[] }
  | { ok: false; errorCode: SourceErrorCode };

export type SourceResult =
  { ok: true; source: SourceView } | { ok: false; errorCode: SourceErrorCode };

export interface ManualAddInput {
  scope: SourceScope;
  url: string;
  name?: string;
  groupName?: string;
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode; // 手工通道可显式设 blocked（决议 #36 通道边界不变）
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue }; // 手工通道：assertedBy 恒 'user'、verification 恒 'asserted'
}

export interface ManualPatch {
  name?: string;
  url?: string;
  groupName?: string | null;
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode;
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue };
}

export type ManualWriteResult =
  | { ok: true; source: SourceView; idempotencyKey: string; undoable: boolean }
  | { ok: false; errorCode: SourceErrorCode };
// hardDeleteManual 成功：source = 删除前最终视图、idempotencyKey = ''、undoable = false（不可 Undo）

export type UndoResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: 'source-undo-conflict' | 'source-undo-not-found' | 'source-unavailable';
    };

export interface UndoableChange {
  idempotencyKey: string;
  changeType: 'agent-change-set' | 'manual';
  appliedAt: string;
  sourceIds: string[];
  summary: string; // 中文字段级摘要（note 正文零出现）
}
```

字段红线：`userNote`/`aiNote` 上限 2000 字符（超限确定性截断 + warning 回注）；
`name` ≤ 200；`url` ≤ 2048（与 VALIDATION_LIMITS.urlMax 一致）；tag ≤ 32 字符、
每个 Source ≤ 20 个 tag、group 名 ≤ 64；全部字符串按既有 sanitize 家族规则剔除
控制字符（页面/模型文本视为不可信输入）。

**缺省与通道语义（决议 #52 冻结）**：AI 通道（change set）add/update 的 trust
缺省 `{unknown, ai, unverified}`（缺省 assertedBy='ai' 而非 schema 默认 'user'——
AI 未断言不得落 user 通道）；手工通道缺省 `{unknown, user, asserted}`；shareMode
缺省 userNote 非空 → 'full' 否则 'metadata'（两通道一致）；`blocked` 仅手工通道
可设；list/search 不返回 note 正文（B3 按分享模式补充）；get 返回完整 SourceView；
B2 的 search 为参数化精确/前缀最小实现（FTS 检索接口由 B3 补齐）。

## 3. 数据访问边界与 SQLite driver 决策门（决策 1/2）

### 3.1 SQL 封闭规则（红线，grep 断言）

- **业务 SQL** 只能是 **Repository 层**（`source-repository.ts` /
  `source-search-index.ts`，B3 起）与 `migrations.ts` 内的**编译期常量**
  （模块级 const 字符串）或 migration 定义；
- `sqlite-driver.ts` 仅允许**连接级运维 SQL** 编译期常量（PRAGMA busy_timeout/
  foreign_keys/journal_mode 与 BEGIN/COMMIT/ROLLBACK，值仅为程序校验后的整数选项
  或编译期常量），不含任何业务语句（决议 #47）；
- 测试专用 SQL（探针建表/FTS5/trigram/测试数据）仅允许位于 SMOKE_MODE 门控的
  冒烟 B-01 场景与 `*.test.ts` 单测（测试设施，非产品数据访问路径）；
- 所有用户/网页/模型文本只能作为 prepared statement 参数绑定（`?` 占位）；
- 禁止：`exec(sql)` 接受任何动态拼接串、动态表名/列名/排序表达式、`enableLoadExtension`
  开启扩展加载、SQL 出现在 renderer/preload/tools/agent/ 目录；
- 排序/过滤只能调用编译期固定的白名单映射（列名 → 语句片段常量），不接收模型
  或网页提供的列名。

### 3.2 driver 决策门（B1 硬前置，本设计不预判结果）

- **首选候选 `node:sqlite`**（Node 内置 DatabaseSync，零 npm 依赖、无 native addon
  ABI/rebuild 问题）。官方资料现状（2026-08-15 核实）：
  - Node 24 中 `node:sqlite` 为 Stability 1.1（Active development）：无需 flag，
    导入打印 ExperimentalWarning（22.13+/23.4+ 起免 flag）；Node 25.7+ 升至 RC；
  - Node 24.18.x 内置 SQLite 3.53.1（与官方发行同步）；
  - Electron 曾真实存在 node:sqlite 缺失缺陷（37.2.0「No such binding: sqlite」，
    electron#47671 → PR #47706，36.7.3/37.2.3/38+ 修复）；本项目 Electron 43.4.0
    远在其后，但**官方声明不替代本项目实跑**；
  - electron-vite/Vite 对 main 进程 node:sqlite externalize 问题有社区报告
    （vite discussion #19278）→ **必须 dev+生产构建双场景实测 import**；
  - **Node 官方构建是否启用 SQLITE_ENABLE_FTS5（trigram tokenizer 前提）无官方
    文档确认** → B1 实测。
- **B1 实测清单（11 项，逐项独立实测与报告；冻结条件 = 基础能力项 ①–⑦、⑩、⑪
  全部通过，决议 #46）**：
  1. Electron main 进程 `import { DatabaseSync } from 'node:sqlite'` 成功
     （无 No such binding、无 externalized 错误）——dev 构建；
  2. 同上——生产构建产物（npm run build + start）；
  3. 文件库创建与重开（userData 临时路径，内容读回一致）；
  4. prepared statements 参数绑定（含中文/引号/`'; DROP TABLE` 注入串——仅作数据）；
  5. 事务 BEGIN/COMMIT/ROLLBACK（异常路径回滚后数据不变）；
  6. `PRAGMA foreign_keys=ON` 生效（违反 FK 的写入确定性报错）；
  7. `busy_timeout` 设置生效（行为可观测：锁竞争等待而非立即失败）；
  8. FTS5 建表成功（`CREATE VIRTUAL TABLE … USING fts5(…)`）；
  9. **trigram tokenizer 建表与中文子串命中**（`tokenize='trigram'` + 中文查询
     实际命中断言）；
  10. userData 路径建库（app.getPath('userData') 派生目录）；
  11. 关闭后句柄清理（close 后删除/重命名库文件成功，无锁定残留）。
- 任一**基础能力项（①–⑦、⑩、⑪）**失败 → **B1 停止**，提交实测证据（红态断言 +
  日志）→ 评估备选 better-sqlite3（native addon：需 ABI 对齐/rebuild/electron-vite
  externalize 处理）——**不得在本纯文档任务新增依赖**；上层契约（Repository/
  SourceService）因驱动薄封装而不变。
- ⑧⑨（FTS5/trigram）失败**不构成 B1 失败**：如实登记实测结论，B3 按 §8.3
  参数化精确匹配/LIKE 安全降级路径为主实现（决议 #46）。
- 冻结记录：B1 完成后在本文 §15 追加决议（驱动 = node:sqlite + 实测证据编号 +
  ExperimentalWarning 处置：如实记录不压制）。
- **driver 封装契约**（sqlite-driver.ts，屏蔽稳定性风险）：
  `openDb(path, {busyTimeoutMs, enableForeignKeys, wal}) → DbHandle` /
  `closeDb(handle)` / `withTransaction(handle, fn)`——Repository 只依赖该薄接口
  （测试可注入内存实现），SQLite 细节不扩散。

## 4. Source 身份与 URL canonicalization（决策 3）

### 4.1 作用域

- `origin`：整个站点（规范化 origin 为身份）；
- `page`：具体页面（规范化完整 URL 去 fragment 为身份）；
- 同 origin 的 page 条目只提示「可能相关」（UI 展示，不自动覆盖）；origin 与 page
  条目互不冲突（键空间不同）。

### 4.2 规范化规则（保守，纯函数 `normalizeSourceUrl`）

| 规则        | 行为                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scheme      | 仅 http/https，其余拒绝（复用 isHttpUrl 同源判定）                                                                                                                                                                                                                                                                                                                         |
| userinfo    | 含 username/password 一律拒绝                                                                                                                                                                                                                                                                                                                                              |
| scheme/host | 小写                                                                                                                                                                                                                                                                                                                                                                       |
| IDN         | 经标准 URL 解析（WHATWG URL）后的稳定 host（punycode 形态）；非 ASCII 路径经 WHATWG 百分号编码（href 形态，幂等确定——B2 测试冻结）                                                                                                                                                                                                                                         |
| 默认端口    | 去除（:80/:443 与 scheme 匹配时）                                                                                                                                                                                                                                                                                                                                          |
| fragment    | origin/page 键均去除（展示 URL 保留）                                                                                                                                                                                                                                                                                                                                      |
| 路径大小写  | 保留（不折叠大小写——path 语义由站点决定）                                                                                                                                                                                                                                                                                                                                  |
| 非默认端口  | 保留                                                                                                                                                                                                                                                                                                                                                                       |
| query       | 保留普通 query（不自动删除任意参数；_\*utm_* 等跟踪参数默认保留_*——若要移除必须使用明确白名单纯函数 + 测试证明，未证明前不启用）                                                                                                                                                                                                                                           |
| 空路径      | page 键 = WHATWG href 形态（决议 #50）：`https://example.com` 与 `https://example.com/` 解析后 pathname 恒为 `/`，二者为**同一 page 身份**（duplicate 命中同一条目）；展示 URL 保留原始输入。原「路径保留原始形态（含尾 `/` 与否按原样）」表述基于 WHATWG 解析假设错误（解析后原始形态不可恢复），按本裁决校准。origin 键恒为规范化 origin（路径/query 丢弃——origin 语义） |

- **唯一键**：`origin` 条目 unique = canonical origin；`page` 条目 unique =
  去 fragment 的规范化完整 URL；**两键空间独立由数据库复合唯一约束
  `UNIQUE(scope, canonical_key)` 显式保证**（决议 #49——canonical_key 保持纯
  规范化形态、不编码 scope）。
- **duplicate 由数据库唯一约束保证**：INSERT 冲突 → 安全返回 source-duplicate
  （不靠「先查后写」，并发/竞态下约束兜底）；冲突时向模型回注既有条目 id 与
  「可能相关」提示，不自动覆盖、不自动合并。
- 纯函数测试矩阵：大小写/默认端口/fragment/userinfo/IDN/query 变体全表（SRT-05）。

## 5. 域模型与 schema（B2，migration 版本 1）

```sql
PRAGMA user_version;  -- schema 版本，单调递增（v1 = 本表集）

CREATE TABLE sources (
  id TEXT PRIMARY KEY,                -- UUID
  scope TEXT NOT NULL CHECK (scope IN ('origin','page')),
  canonical_key TEXT NOT NULL,        -- 唯一性由 UNIQUE(scope, canonical_key) 保证（决议 #49）
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  group_id TEXT REFERENCES source_groups(id),
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  enabled INTEGER NOT NULL DEFAULT 1,
  share_mode TEXT NOT NULL DEFAULT 'metadata' CHECK (share_mode IN ('full','metadata','blocked')),
  trust_value TEXT NOT NULL DEFAULT 'unknown',
  trust_asserted_by TEXT NOT NULL DEFAULT 'user',
  trust_verification TEXT NOT NULL DEFAULT 'unverified',
  user_note TEXT NOT NULL DEFAULT '',
  ai_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','ai')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT,
  last_used_at TEXT, last_usage_outcome TEXT
);
CREATE UNIQUE INDEX idx_sources_scope_key ON sources(scope, canonical_key);
CREATE INDEX idx_sources_group ON sources(group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sources_enabled ON sources(enabled) WHERE deleted_at IS NULL;

CREATE TABLE source_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE source_tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,   -- NFC + trim
  created_at TEXT NOT NULL
);

CREATE TABLE source_tag_links (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES source_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
) WITHOUT ROWID;

CREATE TABLE change_journal (
  idempotency_key TEXT PRIMARY KEY,          -- 主进程生成 UUID（UNIQUE）
  run_id TEXT, tool_call_id TEXT,            -- manual 行恒 NULL；agent 行必填（部分唯一索引）
  change_type TEXT NOT NULL CHECK (change_type IN ('agent-change-set','manual')),
  before_payload TEXT NOT NULL,              -- JSON 快照映射 { sourceId: 行快照+tags }（决议 #55）
  after_payload TEXT NOT NULL,               -- 同上
  source_ids TEXT NOT NULL,                  -- JSON 数组字符串（决议 #55：精确全串匹配，无子串误匹配）
  request_fingerprint TEXT,                  -- agent 行：ops 规范化 SHA-256（重放识别，决议 #53）；manual 行 NULL
  result_payload TEXT,                       -- agent 行：原结果 JSON（幂等重放回放用）；manual 行 NULL
  applied_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_change_journal_run_tool ON change_journal(run_id, tool_call_id)
  WHERE change_type = 'agent-change-set';   -- 同 (run_id, tool_call_id) 恒唯一（决议 #53）
-- 有界清理：COUNT > 100 或 applied_at < now-30d（任一触发，B2 注入时间定稿）

CREATE TABLE usage_events (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown','reachable','unreachable','auth-required','blocked')),
  recorded_at TEXT NOT NULL
);  -- 每 Source 仅保留最近一次

CREATE VIRTUAL TABLE sources_fts USING fts5(
  name, url, user_note, ai_note, content='sources', content_rowid='rowid',
  tokenize='trigram'               -- B1 实测冻结；不可用则 B3 降级方案（§8.3）
);
-- group/tag 名检索走普通索引 + 参数化 LIKE/精确匹配（§8.3 排序域）
```

- **规则**：schema 变更只能追加 migration 版本（不得改已发布版本的语句）；表结构
  定义与 migration 列表均为编译期常量（migrations.ts）；FK 约束由连接级
  `PRAGMA foreign_keys=ON` 强制（B1 实测项 6）。
- **软删状态机（决议 #51 冻结）**：不变量 `enabled=0 ⟺ deleted_at≠NULL`——
  disable → enabled=0 + deleted_at=now + version+1；restore → enabled=1 +
  deleted_at=NULL + version+1；普通 update 不触碰两字段（patch 白名单无 enabled）；
  hard delete 物理删除行；检索/列表默认过滤 deleted_at IS NULL；deleted_at 同时
  供「删除时间」展示。
- **FTS 所有权（决议 #54 冻结）**：B2 落地 schema v1 建表 + **最小写同步**——
  所有写路径（add/update/disable/restore/Undo/hardDelete）在同一事务内由
  Repository 显式语句同步 FTS。冻结规则：**FTS 行 = 非 hard-deleted 行的
  name/url/user_note/ai_note 镜像**（disabled/soft-deleted 行仍镜像，查询期过滤
  归 B3）；hardDelete 同事务删 FTS 行；B3 负责查询构造/排序/rebuild/降级，不重写
  B2 同步。B2 完成时主表与 FTS 无未说明的不一致。
- **hard delete 清理（决议 #55/#56 冻结）**：仅用户手工 UI 通道（
  hardDeleteManual(id, confirmToken)——能力令牌消费通过后执行，B2 无假确认）；
  同事务删除 sources 行（CASCADE 清 tag_links 与 usage_events 行——usage_events
  有 ON DELETE CASCADE）、FTS 行、并按 JSON 精确拆分清理 change_journal 中该
  source 的条目与快照（剩余为空删除整行，其余 source 的 Undo 保留）。FTS
  content= 外部内容表模式：行 id 用 sources.rowid（sources 主键 id 为业务 UUID、
  与整数自增 rowid 并存；INSERT 的 lastInsertRowid 即 FTS 行 rowid，B2 以测试
  冻结该映射）；FTS 'delete' 命令需携带当前索引列值（同事务先读后删，值必然
  匹配——测试断言 FTS 行数与主表一致）。

## 6. SourceService 契约（B2，UI 与 Agent 共用唯一入口）

```ts
export interface SourceService {
  readonly id: string; // 'sources'
  // 检索（§8；audience 必填——决议 #58：agent 视角 blocked 不可见，user 视角可见可管理）
  search(
    query: string,
    opts: { limit?: number; audience: SourceReadAudience },
  ): Promise<SourceSearchResult>; // 默认/硬上限 10
  list(opts: {
    page: number;
    pageSize?: number;
    groupId?: string | null;
    enabledOnly?: boolean;
    audience: SourceReadAudience;
  }): Promise<SourceListResult>; // 每页 ≤20
  get(id: string, audience: SourceReadAudience): Promise<SourceResult>;
  // 写入（Agent change set，§7）
  applyChangeSet(
    cs: SourceChangeSet,
    meta: { runId: string; toolCallId: string },
  ): Promise<SourceChangeResult>;
  // 手工操作（UI 通道，同一事务/审计/journal 语义）
  addManual(input: ManualAddInput): Promise<ManualWriteResult>;
  updateManual(id: string, patch: ManualPatch, expectedVersion: number): Promise<ManualWriteResult>;
  disableManual(id: string, expectedVersion: number): Promise<ManualWriteResult>;
  restoreManual(id: string, expectedVersion: number): Promise<ManualWriteResult>;
  hardDeleteManual(id: string, confirmToken: string): Promise<ManualWriteResult>; // 二次确认，不可 Undo
  // Undo（§7.5）
  undoChange(idempotencyKey: string): Promise<UndoResult>;
  listUndoable(): Promise<UndoableChange[]>; // 最近 100 条有界
  // usage（§11）
  recordUsage(sourceId: string, outcome: SourceUsageOutcome): Promise<void>;
  // 恢复态（§10）
  getState(): { mode: 'normal' | 'readonly-recovery'; reason: string | null };
  dispose(): void;
}
```

- 构造注入：`{ db: DbHandle, now?: () => number }`（时间可注入，journal 清理/令牌
  过期测试）；唯一实例由 index.ts 装配，UI IPC handler 与 Source 工具 ctx 共享。
- **hardDeleteManual 能力令牌（决议 #56 冻结）**：Service 内置
  `ConfirmTokenIssuer`（node:crypto randomBytes 256-bit、绑定目标 sourceId、
  TTL 300s、消费即失效、时钟经 now 注入可测）——hardDeleteManual 消费通过后由
  Repository 物理删除（B2 无「非空即放行」假确认）；未签发/错绑定/过期/重用 →
  source-conflict 零删除；B5 接 UI 时复用同一签发器（二次确认 UI 先 issue 后
  消费）。
- **B2 边界（决议 #52 冻结）**：getState 恒 `{mode:'normal', reason:null}`
  （只读恢复态装配归 B7）；recordUsage 为 usage_events 最近一次最小 upsert
  （UsageTracker/巡检归 B7）；dispose 幂等关闭句柄。
- **读取视角（决议 #58，B3 冻结）**：search/list/get 的 `audience` 必填无缺省
  ——`agent` 视角：blocked 完全不可见（search 不命中/list 不列出/get 视同不存在
  source-not-found）、metadata 的 get 无 note（两字段空串）、full 的 search 命中
  才附有界 note 摘录；`user` 视角：blocked 可见可管理（B5 UI 需要）、get 恒完整
  SourceView（note 读取时防御性清洗）。audience 由 B4 工具 executor 与 B5 IPC
  handler 在主进程适配器硬编码——模型工具参数与 renderer 原始 payload 均无通道
  自行选择。
- 所有方法对非法输入安全返回（不抛异常）；不可预期异常归一化 source-unavailable
  并 logWarn（堆栈进日志，不进 ToolResult）。

## 7. 写入安全：change set / 确认 / 幂等 / 版本 / 事务 / Undo（决策 5）

### 7.1 全链路（source_apply_changes，L2）

```
ToolRegistry 校验（结构：1–20 项、字段白名单、长度/枚举/URL 形状）
→ PermissionPolicy decide → L2
→ ConfirmManager.requestConfirm(runId, toolCallId, 'source_apply_changes', summary)
    summary.detail = 主进程生成的确定性 before/after diff 纯文本（§7.3）
    ——确认前数据库零变化（diff 计算只读）
→ approve 精确一次 → SourceService.applyChangeSet：
    ① 读当前状态；逐项 expectedVersion 校验（update/disable/restore）
       任一不符 → 整体拒绝零写入（source-version-conflict）
    ② 单事务：全部变更 + FTS 同步 + journal 写入（idempotency_key UNIQUE）
    ③ 全部成功提交 / 任一异常 rollback（source-invalid-change 结构化回注）
→ ToolResult（ok + 每项结果 / ok:false + 错误码）
→ 审计恰好一条（§7.6）
```

- **deny/timeout/cancel/迟到/未知 toolCallId → 零写入**（复用 ConfirmManager 契约：
  单 pending、cancelAll 作废、approve/deny 未知与已终结 id 幂等 false）；
- **重放（决议 #53 冻结）**：idempotency key 由主进程在首次实际提交时生成；change
  journal 对 (run_id, tool_call_id) 有部分唯一索引（仅 agent 行）+ request
  fingerprint（ops 规范化确定性 SHA-256，node:crypto 零依赖）列。重复提交同
  (runId, toolCallId)：指纹一致 → 幂等返回原结果（journal result_payload，含同
  一 key）零写入；**指纹不同 → fail-closed source-conflict 零写入**（不返回旧
  结果）；**失败提交（整体拒绝/回滚）零落 journal、不产生 key、重试视为新提交**
  （可修正重提，SRT-06）；模型**不能**提供或预知 key；
- **跨 run**：旧 run 的 toolCallId 引用无效（ConfirmManager 已作废）；新 run 重复
  提出同一变更 → expectedVersion 已变 → source-version-conflict 拒绝（结构化回注，
  模型可重读后重提）。

### 7.2 change set 结构校验（source-change-set.ts 纯函数）

- 1 ≤ ops.length ≤ 20（超限 source-limit）；
- `add`：scope/url 必填（normalizeSourceUrl 通过）；name 缺省 = URL host +
  路径截断（主进程确定性生成，模型不提供时）；groupName 缺省不建组；tags 缺省
  空；priority 缺省 3；shareMode 缺省：userNote 非空 → 'full'，否则 'metadata'
  （**模型不能显式设 blocked**——blocked 仅用户 UI 可设，防 AI 自我隐藏）；
  trust：模型只可提 `assertedBy: 'ai'` + 任意 value → 落库 verification 恒
  'unverified'；缺省 `{unknown, ai, unverified}`（决议 #52）；`assertedBy: 'user'`
  只能由用户手工 UI 通道写入（模型提供 → 拒绝 source-invalid-change，SRT-01）。
- `update`：patch 字段白名单（SourcePatch 全类型，决议 #52）；url 变更需重新
  规范化（canonical key 变化按新键唯一约束）；trust 同 add 规则；enabled 不可经
  patch 切换（disable/restore 为显式 op，决议 #51）。
- `disable`/`restore`：显式 op，状态迁移按决议 #51（disable → enabled=0 +
  deleted_at=now + version+1；restore → enabled=1 + deleted_at=NULL +
  version+1；重复执行同一方向 op 照常执行 version+1——确定性、Undo 语义统一）；
  数据保留、可恢复。
- **同一 change set 内重复 sourceId**（update/disable/restore 指向同一 id）→
  source-invalid-change 整体拒绝（expectedVersion 语义不可用，防御性冻结）。

### 7.3 确定性 before/after diff（确认展示）

- 纯函数 `buildChangeDiff(ops, currentRows)`：对每项生成字段级中文 diff
  （「字段：A → B」）；note 字段只显示长度 + 首 40 字符截断预览（不可信纯文本，
  控制字符/双向控制符剔除——复用 sanitizeConfirmText 同族函数）；
- ConfirmDialog 复用 A6 组件契约（deny 默认焦点、Escape=拒绝、approve 精确
  toolCallId 一次、无始终允许、作废自动关闭）；diff 文本为**程序生成**，
  模型/网页无任何通道提供确认文案；单 change set 的 diff 总长上限 2000 字符
  （超限确定性截断 + 「共 N 项变更」计数行）。

### 7.4 事务与唯一约束

- 单事务内：sources 行 upsert/update + tag/group 幂等 upsert + tag_links 重建 +
  FTS 同步 + journal 插入；任一失败整体 rollback（零部分写入）；
- duplicate 由 canonical_key/name UNIQUE 约束兜底（并发安全）；INSERT OR IGNORE
  仅用于 tag/group 幂等 upsert（确定性语义），sources 冲突必须显式处理为
  source-duplicate 回注（含既有条目 id）。

### 7.5 Undo（durable，重启后可用）

- journal 记录 before/after JSON payload（受影响行完整字段快照，映射
  `{sourceId: 行快照+tags}`，决议 #55）；
- `undoChange(idempotencyKey)`：单事务回放 before 快照（含 FTS 同步与 tag 关系
  重建）；前置校验：当前受影响的 Source version 与 journal 的 after 版本一致——
  不一致 → 拒绝（source-undo-conflict，提示存在后续变更，不覆盖用户修改）；
  **消费语义（决议 #52 冻结）**：Undo 成功后删除该 journal 行（消费即失效）；
  已撤销/未知 key 重复 undo → source-undo-not-found 零写入（幂等安全无操作，
  不视为数据损坏）；**Undo 不复活已 hard-deleted 的 source**（其 journal 条目
  已在 hard delete 时精确移除）；损坏/畸形 payload → source-unavailable 安全
  失败（warn 日志可诊断，不崩溃不半写）；行缺失（理论不可达）→
  source-undo-conflict fail-closed；
- **hardDeleteManual 不产生可 Undo 记录**（不可撤销），且同事务清理该 Source 的
  FTS 行、usage_events 行（FK CASCADE）与 change_journal 中的私人 payload
  （JSON 精确拆分，决议 #55）；
- journal 有界清理：条数 > 100 或最旧条目年龄 > 30 天（任一触发即清理超限旧
  payload；清理时机与年龄判定用注入时钟测试定稿，B2）；被清理的 change 不可
  Undo（UI 明示）。

### 7.6 审计与持久化脱敏

- source_apply_changes：审计恰好一条，argsSummary = `ops=N add=X update=Y …;
fields=[…]; lens=[…]; versions=[…]`（note 正文零出现；URL 变更记录规范化
  结果与长度——url 属外发审查等级，全量记录但 ≤2048 有界）；
- source_search：查询串全量审计（≤500，与 search_web 同等级）；source_list/get：
  分页参数与返回条数；手工 UI 操作：同一审计出口（decision 映射 manual 系）；
- ToolStep 持久化（v2 契约不变）：Source 工具结果仅 contentPreview 摘要，
  **不复制完整私人备注**（SRT-08 字节扫描断言）。

## 8. 有界 Retrieval、分享模式与多语言检索（决策 7/8）

### 8.1 有界性与 allowlist

- `source_search` 默认最多 10 项，**硬上限 10**（limit 参数超限拒绝
  source-limit）；`source_list` 每页 ≤20（pageSize 超限拒绝）；候选行检索同样
  有界（`SEARCH_CANDIDATE_MAX = 200`，SQL LIMIT 编译期常量——排序前的中间
  结果也不得无界）；
- 返回 allowlist：id/name/url/scope/canonicalKey 摘要/groupId 与 group 名/tags/
  priority/enabled/trust（三字段）/shareMode/provenance 标注/lastUsedAt 摘要——
  note 仅命中少量条目时按 §8.2 规则附带；**任何情况下不返回**：canonicalKey 内部
  形态之外的信息、版本号（version 仅 change set 通道语义，不回显）、deletedAt
  细节、journal 内容；
- ToolResult 预算：Source 工具统一 `SOURCE_TOOL_CONTENT_MAX = 4000`（与
  search_web 同级；contentBudgetFor 增分支），复用 truncateToolContent 确定性
  截断 + warning；
- **本地完成检索/过滤/排序**——整库绝不发模型（无任何导出通道，SRT-03 grep）。

### 8.2 分享模式（决议 #58/#59：按 audience 分列）

| 模式     | agent 视角行为（工具/B4 适配器硬编码 audience='agent'）                                                      | user 视角行为（UI/B5 适配器硬编码 audience='user'）           | 设置通道                 | 默认           |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------ | -------------- |
| full     | search 命中可返回（note 有界截断 + provenance）；get 返回 note                                               | 同左（get 恒完整视图；search 结果不含 note 正文——详情走 get） | 用户 UI；模型 change set | 用户写备注时   |
| metadata | search 命中可返回（**无 note 正文**，仅元数据——note 不参与命中与排序）；get 无 note（两字段空串）            | 同左（UI 详情走 get 完整视图）                                | 用户 UI；模型 change set | 无备注快速收藏 |
| blocked  | **完全不可见**：search 不命中、list 不列出、get 视同不存在（source-not-found）；不分页空洞/错误差异/日志泄漏 | **可见可管理**：list/get 返回（含 shareMode=blocked），可改回 | **仅用户 UI**            | 从不           |

- note 返回规则（仅 agent + full）：userNote/aiNote 各 ≤200 字符截断（Unicode
  码点计数）+ 控制字符/双向控制符剔除（读取侧防御性清洗——旧数据/损坏数据同样
  覆盖）+ provenance 由 userNote/aiNote 字段分离承载（B4 序列化层标注
  「用户备注（来源：user）/ AI 备注（来源：ai，未核验）」）；
- 写入侧清洗（B2 stripControlChars）已覆盖 C0/DEL/NEL/零宽/U+202A–U+202E/
  U+2060/BOM；**B3 补齐 U+061C 与 U+2066–U+2069**（bidi 隔离控制符——原实现
  未覆盖，读取侧同样剔除，敌手测试固化）；
- UI 必须说明三态含义并允许修改（快速收藏时明确显示默认值）。

### 8.3 多语言检索（决议 #60/#61/#62 冻结分流与排序语义）

- **查询归一化与分流（决议 #60，纯函数 source-search-query.ts）**：查询
  trim + NFC + 控制字符剔除后按 **Unicode 码点**计数——
  - **1 字符**：仅精确匹配（name/url/canonicalKey）；
  - **2 字符**：精确 + 前缀 + 参数化字面子串 `LIKE ? ESCAPE '\'`
    （name/url/canonicalKey/tag/group）——**中文 2 字符子串经降级路径诚实交付，
    测试不得声称 trigram 原生支持两字符**（B1 实测 trigram 仅 ≥3 字符命中）；
  - **≥3 字符（含 3）**：FTS5 trigram 主路径；`buildFtsQuery` 仅对 **≥3 字符
    token** 短语包裹（1–2 字符 token 不产生子串命中——trigram 语义，如实登记）；
    同时候选集含 name/url/canonicalKey 精确与前缀 + tag/group 精确与子串
    （精确/前缀命中不依赖 FTS 可用性）；
  - **特殊 URL 查询（确定性判定集合）**：`normalizeSourceUrl(query, 'page')`
    可解析，或 trim 后以 `http://`、`https://` 开头（含解析失败的 URL 形态——
    只作数据，安全不命中）→ canonicalKey/url 精确 + 前缀路径；
  - **大小写语义（如实登记）**：SQLite `=` 与 FTS trigram 区分大小写；LIKE
    为 ASCII 不区分大小写（SQLite 默认）——排序档位判定与 SQL 语义一一对应
    （精确判定区分大小写、前缀/子串判定 ASCII 不区分大小写）。
- **查询串纯函数构造**（source-search-query.ts）：原始查询绝不拼接进 MATCH 表达
  式——`buildFtsQuery(raw)` 将 raw 逐 token 短语包裹并转义内部双引号；引号/
  通配符/FTS 操作符（AND/OR/NOT/NEAR/*/^/数字）**只作为数据**；查询串同样
  参数绑定（`MATCH ?`）；FTS 候选与精确/前缀/标签/分组候选在同一条编译期常量
  SQL 内取并集（`SEARCH_CANDIDATE_MAX = 200` 有界），档位与排序全部在本地
  纯函数计算（无动态 ORDER BY）。
- **安全降级（必须可用，决议 #62）**：FTS 不可用**仅指**已成功建库（schema v1
  迁移完成、sources_fts 存在）后的 MATCH 查询构造/执行失败或 FTS 表被破坏——
  降级路径接管（参数化精确/前缀 LIKE，note 检索随之不可用并如实登记，不伪装
  成功）；**不承诺无 FTS5 编译的构建可完成迁移**——schema v1 已按决议 #54 冻结
  不改写（B1 实测 Electron 43.4.0 与系统 Node 24.18.0 均含 FTS5）；数据库整体
  不可用（连接关闭/损坏）→ source-unavailable 安全失败；降级路径是完整交付
  实现（FTS 为增强，SRT-04 覆盖）；
- **普通索引**：canonical_key（UNIQUE 已建）、group（部分索引）、tag（经
  source_tag_links）、name（LIKE 前缀可用）；
- **排序确定性（决议 #61，纯函数全序）**：档位严格不可跨档——精确匹配 > 前缀
  匹配 > tag/group 命中 > name/domain 命中 > note 命中（priority **不得**反转
  档位）；priority（1–5）仅同档内降序；同 priority 下 lastUsedAt 降序、
  lastUsedAt=null 恒排最末；最终以 **scope ASC + canonicalKey ASC + id ASC**
  收尾（origin/page 同 canonicalKey 也全序）。同输入同输出。
- **索引一致性**：add/update/disable/restore/undo/rollback 与主表同事务同步
  （Repository 显式语句，B2 定稿并测试，B3 不重写）；诊断性 rebuild 与一致性
  校验（`INSERT INTO sources_fts(sources_fts) VALUES('rebuild')` + 主表/FTS
  行数比对）为 B3 内部能力（仅测试/诊断入口；UI 诊断按钮归 B7），rebuild 失败
  不得破坏现有索引（单事务回滚）。

## 9. Source Tools v1 与权限矩阵（决策 6/5）

### 9.1 工具清单（wire-safe 名，满足 TOOL_NAME_PATTERN，决议 #35 契约）

| 工具名               | schema 要点                                     | 权限 | 说明                                                    |
| -------------------- | ----------------------------------------------- | ---- | ------------------------------------------------------- |
| source_search        | {query ≤500 非空}                               | L0   | 硬上限 10；分享模式过滤；allowlist；查询串全量审计      |
| source_list          | {page ≥0, pageSize ≤20, groupId?, enabledOnly?} | L0   | 每页 ≤20；blocked 不列出；不含 note                     |
| source_get           | {sourceId UUID 形状}                            | L0   | 单条；blocked 视同不存在；note 按分享模式               |
| source_apply_changes | {ops ≤20 项, 结构见 §7.2}                       | L2   | 确认门 + 幂等键 + 版本 + 单事务 + journal；审计恰好一条 |

- **禁具（不存在，grep 断言）**：source_sql / source_delete_hard / source_export_all /
  任意路径导入 / 任意网络抓取 / 任意通用数据库工具；打开网页继续 browser_open
  （L1 既有）与 browser_read（L0 既有）——Source Tool 不新增网络能力。
- ToolDefinition 四条目注册于 index.ts 注册区（既有 13 工具 → 17 工具）；
  executor 只经 `ctx.sourceService`（新增注入点，类比 `ctx.searchProvider`；
  tool-types.ts ToolExecutionContext 扩展 `sourceService?: SourceService`，
  AgentLoop 装配透传）；Source 工具 executor 零 Electron import。
- 错误码映射：source-invalid-change/source-version-conflict/source-duplicate/
  source-not-found/source-forbidden（blocked 引用）/source-limit/source-unavailable/
  source-conflict → ToolResult.errorCode（扩展 shared ToolResultErrorCode 枚举 +
  conversation-store TOOL_RESULT_ERROR_CODES + agent-display 中文文案）；
  权限决策映射沿用 ToolStepDecision 六值单一事实源。

### 9.2 权限矩阵（TOOL_BASE_RISK 增 4 条目，编译期常量）

| 工具                 | 基础级别 | 判定                                      |
| -------------------- | -------- | ----------------------------------------- |
| source_search        | L0       | 无条件（有界 + 分享模式过滤为执行层保证） |
| source_list          | L0       | 无条件（分页/allowlist 为执行层保证）     |
| source_get           | L0       | 无条件（单条/分享模式为执行层保证）       |
| source_apply_changes | L2       | 无条件（任何 change set 都必须确认）      |

- 模型/网页/note 无任何通道修改权限矩阵（编译期常量 + decide 纯函数不变式）；
- L0 工具仍计入防循环签名（读操作重复 3 次同样触发 loop-detected，决议 #24 无
  白名单例外）。

## 10. migration、backup 与恢复（决策 9）

- **路径**：数据库路径只能由主进程在 Electron userData 下确定
  （`<userData>/sources/sources.db` 与 `<userData>/sources/backups/`）；renderer/
  preload 不得感知路径。
- **单调逐级迁移**：`PRAGMA user_version` 为 schema 版本；migration 列表
  `[{ version, statements }]` 编译期常量；启动时逐级执行（每级单事务，异常明确
  rollback + 日志）；未知更高版本（user_version > 程序版本）→ Sources 进入
  **只读恢复态**（§10.3）。
- **迁移前一致性备份**：不得在 WAL 活跃时只复制主数据库文件；具体方案由 B1
  实测冻结三候选——① `VACUUM INTO '…backups/vN.db'`（SQLite ≥3.27 官方文档
  支持，生成一致性快照，主连接可用）；② node:sqlite backup API（若实测存在且
  稳定）；③ 关闭连接后复制主文件 + -wal/-shm（迁移时机为启动早期，可行）——
  B1 报告实测结论，B7 定稿保留策略（备份文件有界保留：最近 5 个版本 + 30 天）。
- **完整性检查**：迁移后 `PRAGMA integrity_check` + `PRAGMA foreign_key_check`
  ——失败 → 不得覆盖原库（保留原文件与备份）→ 只读恢复态 + 中文诊断。
- **只读恢复态**：SourceService 全部写入口拒绝（source-unavailable）；
  读入口同样拒绝或受限（B7 定稿：v1 读入口一并拒绝，UI 显示恢复说明——避免
  半损坏库读出误导数据；「只读」指磁盘文件不被写，不代表允许读取）；**浏览器
  其余能力继续安全可用**（恢复态仅影响 Sources 子系统）；恢复流程保留原库
  （UI 中文诊断：检测结果/原库位置/备份位置/建议动作）。
- 数据库、备份、change journal **不进入模型上下文**。

## 11. 本地明文边界与 usage/health（决策 10/11）

- **v1 本地明文**：URL/分组/标签/备注按明文保存（本地检索所需），依赖操作系统
  用户权限保护；本阶段**不承诺数据库静态加密**；README 与 Sources UI 必须如实
  说明（「备注与 URL 以明文保存在本机」）。
- **API Key 绝不进入 Sources 数据库**（红线 grep 断言；Key 仍只走既有
  safeStorage/DPAPI）。
- **usage/health**：无后台巡检、无定时请求。仅当 Browser Agent 实际经某 Source
  打开/读取后才记录最近一次（§12 高层数据流 4.4 的 SourceSearchHintStore 关联
  机制，B7）：outcome ∈ unknown/reachable/unreachable/auth-required/blocked；
  v1 可靠信号仅为「打开成功 → reachable」「导航失败 → unreachable」，其余三态
  为枚举占位（无可靠触发信号，宁缺勿错如实登记）；不保存网页正文；**最近一次
  结果不宣称长期健康状态**（UI 文案「上次使用结果」）。

## 12. 安全契约（引用 threat-model）

- 契约源 `doc/stage4/threat-model.md`：§3 防线（结构/能力/决策/审计/运行时 +
  检索与持久化防线 + 数据完整防线）为本阶段所有实现任务的强制约束；§4 红队
  矩阵 SRT-01～SRT-12 为 B8 的验收断言清单；§5 诚实边界声明为验收范围校准
  （六类残余风险，不宣称免疫）；§6 兼容声明逐项保持。
- 各任务红线重申（proposal §10）：B1 决策门通过前禁止任何 Source 实现；无万能
  工具（grep 断言清单扩展：source_sql/source_delete_hard/source_export_all/
  任意导入/任意抓取/任意通用数据库工具/SQL 动态拼接/扩展加载）；Electron 安全
  边界、Key 零暴露红线、第三阶段权限/确认/审计契约零放宽。

## 13. 测试规格（红→绿纪律）

### 13.1 单测（Vitest，node 环境，纯逻辑）

| 测试文件                    | 用例要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 任务  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| source-canonical.test.ts    | 规范化矩阵：大小写/默认端口/fragment/userinfo 拒绝/IDN/query 保留/非默认端口/空路径（决议 #50：两形态同身份）；origin 与 page 键独立性（决议 #49）；确定性同输入同输出                                                                                                                                                                                                                                                                                                                                                                                                             | B2    |
| source-change-set.test.ts   | 结构校验（1–20 边界/字段白名单/长度/枚举/URL 形状/trust 通道规则——模型不能 assertedBy=user、不能设 blocked；缺省冻结决议 #52；同 set 重复 sourceId 拒绝）                                                                                                                                                                                                                                                                                                                                                                                                                          | B2    |
| source-search-query.test.ts | FTS 查询纯函数转义（引号/操作符/通配符只作数据、短语包裹/双引号转义/短 token 过滤）；归一化与分流判定（trim/NFC/码点计数、1/2/3 字符边界、URL 判定集合，决议 #60）；排序器全序（档位不可跨档 + priority/recency 同档内 + lastUsedAt=null 末位 + scope/canonicalKey/id 收尾，决议 #61）；note 摘录（200/201 码点边界、C0/换行/零宽/U+061C/U+202A–U+202E/U+2066–U+2069 剔除）                                                                                                                                                                                                        | B3    |
| source-search-index.test.ts | 候选集 SQL（FTS/LIKE/短查询/URL 四条编译期常量路径）注入串仅作数据；FTS 可用性判定与降级（决议 #62：MATCH/构造失败降级、数据库不可用 source-unavailable）；rebuild 前后行数与内容一致、失败不破坏现有索引；FTS 与主表同事务同步回归（B2 路径不重写）                                                                                                                                                                                                                                                                                                                               | B3    |
| migrations.test.ts          | 逐级事务性/异常 rollback/版本单调/未知高版本判定；**schema v1 契约断言**（表集/约束/索引/部分唯一索引/user_version=1 恒等，决议 #49/#51/#54/#55）                                                                                                                                                                                                                                                                                                                                                                                                                                  | B2/B7 |
| change-journal.test.ts      | 有界清理（条数/年龄任一触发，注入时钟，恰好 30 天保留、超过清理）/Undo 消费幂等（决议 #52）/版本冲突拒绝/payload 形状校验/畸形 payload 安全失败/hard delete 精确拆分（决议 #55）                                                                                                                                                                                                                                                                                                                                                                                                   | B2    |
| source-service.test.ts      | 注入真实 node:sqlite：CRUD/唯一约束并发（双连接同 canonical 仅一成功）/change set 事务回滚（第 N 项冲突整体零写入）/幂等键重放（同指纹幂等、异指纹 fail-closed，决议 #53）/expectedVersion/undo/hardDelete 清理（FTS/journal/usage 字节级）/非法输入安全返回/异常归一化/dispose 幂等；**B3 扩展**：search/list/get 的 audience 完整矩阵（agent blocked 不可见·metadata 零 note 字节·full 摘录有界；user 可见可管理）、硬上限 10/每页 20/分页 total 与过滤一致、多语言命中（中/日/英/混合）、排序全序证据（priority 上下界/origin+page 同 canonicalKey）、disposed/句柄关闭安全返回 | B2/B3 |
| source-tools.test.ts        | 四工具 schema 校验/serialize 纯文本零特权/错误码映射/ctx.sourceService 优先于注入/audit 摘要形状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | B4    |
| usage-tracker.test.ts       | 命中登记/URL 比对/仅最近一次/未知来源不记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | B7    |

### 13.2 冒烟矩阵（Electron 真实启动，临时 userData；dev+生产双场景）

| #    | 场景                  | 断言要点                                                                                                                                                                                                                                                                                                                                                                                                                                       | 任务  |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| B-01 | B1 决策门 11 项探针   | §3.2 清单逐项断言（含中文 trigram 命中与生产构建 import）；失败即红并停止                                                                                                                                                                                                                                                                                                                                                                      | B1    |
| B-02 | CRUD 持久化           | 专属门控 `AIBROWSE_SOURCES_SMOKE=set\|check`（决议 #57：与 SESSION_SMOKE 并列互斥）；set 进程临时 userData 建库迁移 v1 → SourceService CRUD+journal+disable → 干净退出；check 进程新进程读回全量断言（行数/内容/版本）→ 执行 Undo → 断言 Undo 生效 → 退出码 0；唯一约束冲突安全返回                                                                                                                                                            | B2    |
| B-03 | change set 确认全链路 | 模型（FakeProvider 脚本）提 change set → L2 确认必现 → deny 零写入/approve 单事务提交 → 审计恰好一条 → Undo 生效；迟到/未知 toolCallId 零写入                                                                                                                                                                                                                                                                                                  | B4    |
| B-04 | 有界检索              | **B3/B4 分段完成（决议 #63）**——B3 子集（默认矩阵 dev+production 双场景，真实 Electron 内置 node:sqlite/FTS5/trigram）：source_search 硬上限 10/分享模式过滤（agent blocked 不可见、metadata 零 note 字节、full 摘录 ≤200 + provenance）/allowlist/中·日·英命中/短查询降级/rebuild 一致性；B4 待完成：SOURCE_TOOL_CONTENT_MAX=4000 结果预算截断/ToolResult 序列化/UNTRUSTED_TOOL_RESULT 块隔离（含注入 note 夹具）/审计——B3 不得宣称 B-04 全过 | B3/B4 |
| B-05 | 快速添加 UI 端到端    | 当前页快速收藏（默认 metadata）→ 列表出现 → 修改分享模式/备注 → 手工 Undo → 永久删除二次确认后消失且不可 Undo                                                                                                                                                                                                                                                                                                                                  | B5    |
| B-06 | migration/恢复        | 旧版本库自动迁移（备份生成）；注入迁移失败 → rollback + 原库完好；损坏库/更高版本 → 只读恢复态 + 中文诊断 + 浏览器其余能力正常（既有冒烟场景回归）                                                                                                                                                                                                                                                                                             | B7    |
| B-07 | usage 记录            | 同 run source_search 命中 → browser_open 该 URL → usage 落库 reachable；无关 URL 不记录；无后台请求（日志断言零巡检）                                                                                                                                                                                                                                                                                                                          | B7    |
| B-08 | 红队 SRT-01～SRT-12   | §4 矩阵全表（dev+生产双场景）+ RT-01～RT-11 全量回归                                                                                                                                                                                                                                                                                                                                                                                           | B8    |
| B-09 | 共读与工具层回归      | 既有矩阵 1–12/8.1（注册表 17 工具）/8.2/8.3/8.4/8.5/8.6 全量回归；日志敏感扫描零命中                                                                                                                                                                                                                                                                                                                                                           | B4/B8 |

- 真实 Provider 可选验证（B6/B8，需用户提供 Key，询问边界）：AI 自然语言管理
  端到端（「收藏这个网站/把它改到日本购物组并备注只用于中古价格/把这个来源标
  成官方/以后不要再优先用这个站」→ change set → 确认 → 持久化 → 重启读回）+ 真实
  网页诱导场景（SRT-01/SRT-02 观察性证据）；门控
  `AIBROWSE_LIVE_AGENT_SOURCES=1` + harness `-Sources`（与既有 LIVE 门控互斥），
  沿用第三阶段凭据流程与真 Key 零暴露扫描；不设固定调用次数。

## 14. 验收核对清单（Fourth_stage.md §9 → 本阶段落点，B9 实施）

| 组          | 条目                                 | 落点                                       |
| ----------- | ------------------------------------ | ------------------------------------------ |
| Storage     | SQLite 与 migration 稳定             | B1 决策门 + B7 冒烟 B-06 + migrations 单测 |
| Storage     | Source CRUD 走 Service/Repository    | B2 单测 + grep 断言（SQL 仅 Repository）   |
| Storage     | 重启后数据保留                       | B2/B7 跨进程冒烟（B-02）                   |
| Sources     | 可分组/标签/备注/优先级              | B2 单测 + B5 UI 冒烟                       |
| Sources     | 可手工管理                           | B5 UI 端到端冒烟                           |
| Sources     | 可自然语言让 AI 添加/修改            | B4/B6（离线确定性 + 真实 Provider 可选）   |
| Sources     | 可搜索长期信源                       | B3 单测 + B-04 冒烟（中文/英文/日文/子串） |
| AI          | Agent 能优先检索相关 Sources         | B3/B4（检索 + 工具）+ B6 端到端            |
| AI          | Source 用户备注能影响检索/使用策略   | B3 排序器单测（note 域参与排序，有限度）   |
| AI          | 用户备注不能突破安全政策             | B8 SRT-02 + 权限矩阵恒等断言               |
| Engineering | migration/FTS/SourceService 自动测试 | 各任务单测 + 冒烟                          |
| Engineering | 全量验证通过                         | 每个任务闭环（AGENTS.md 附 A 矩阵）        |
| Engineering | 数据库失败有可诊断日志               | B7：中文诊断 + 日志链（B-06）              |

## 15. 决议记录（2026-08-15）

### proposal Q1–Q12 拍板

| #   | 决议                                                                | 理由                                                                   |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Q1  | node:sqlite 首选 + B1 决策门实测（11 项，dev+生产构建）             | 零依赖；官方资料不足以放行（Electron 曾有缺失缺陷、FTS5 编译项无确认） |
| Q2  | origin/page 双作用域；唯一约束保证 duplicate                        | 域模型最小表达；并发安全                                               |
| Q3  | 保守 canonicalization（保留 query/路径大小写；utm_* 默认保留）      | 不丢用户数据；白名单移除未证明前不启用                                 |
| Q4  | 最小 4 工具（写入统一 change set）                                  | 权限面最小；一次确认看全 diff；事务化可 Undo                           |
| Q5  | search/list/get L0、apply_changes L2                                | 读有界即安全；写必须确认                                               |
| Q6  | 三态分享模式 + 默认规则（blocked 仅用户 UI 可设）                   | 私人备注默认不外发；防 AI 自我隐藏                                     |
| Q7  | FTS5 trigram 主路径 + 参数化降级为完整交付                          | 多语言子串检索零外部依赖；降级路径保证可用性                           |
| Q8  | journal 有界 100 条/30 天（任一触发清理）                           | Undo 数据暴露面与磁盘占用有界                                          |
| Q9  | 备份方案 B1 实测冻结（VACUUM INTO / backup API / 关闭后复制三候选） | 官方支持存在但需本项目实测；WAL 一致性约束                             |
| Q10 | SourceSearchHintStore 关联 usage（每 run 独立）                     | 类比 InteractionSemanticsStore；无后台巡检                             |
| Q11 | Sources 面板（AI 侧栏并列切换，380px 同模式）                       | 与既有布局契约一致                                                     |
| Q12 | B/ST/SRT 编号体系                                                   | 避免与历史 T/S/A/RT/R 编号重名                                         |

### 相对第四阶段草案与实施前的细化

> 编号承接第三阶段决议 #21–#35 之后（#36 起），避免与历史决议重号。

36. **blocked 仅用户 UI 可设**：模型 change set 不能把 Source 设为 blocked
    （防 AI 自我隐藏/对抗审计）——shareMode 白名单规则（§7.2）。
37. **trust 通道规则**：模型只可提 assertedBy='ai'（verification 恒 unverified）；
    assertedBy='user' 仅用户手工 UI 通道（SRT-01 结构性保证）。
38. **version 不回显工具**：version 仅为 change set 通道语义，source_get/list/
    search 返回不携带（侧信道最小化）。
39. **恢复态 v1 读入口一并拒绝**：避免半损坏库读出误导数据；「只读」指磁盘文件
    不被写（§10.3）。
40. **Source 数据复用 UNTRUSTED_TOOL_RESULT 块**：不新增特权块类型（threat-model
    §3.1）；Source 检索结果与其他 ToolResult 同等不可信、同等转义截断。
41. **模型不得生成 name/group 之外的确定性字段**：add 缺省 name/priority/shareMode
    由主进程确定性生成（模型文本只进 name/note 等明确字段，§7.2）。
42. **usage 五态中三态为枚举占位**：v1 可靠信号仅 reachable/unreachable
    （宁缺勿错，§11）；auth-required/blocked/unknown 不伪造。
43. **B9 不采信 B1–B8 完成报告**：在当前 HEAD 上重新独立复验（test/typecheck/
    lint/format:check/build + 冒烟全矩阵 + §14 清单 + SRT 全表 + 红线 grep +
    文档一致性），证据缺口按 Third Stage A7 补验同模式处理。
44. **node:sqlite ExperimentalWarning 处置**：如实记录（启动日志信息行），
    不压制、不 hack；B1 冻结记录附实测版本与警告形态。
45. **既有文档滞后性遗漏登记（2026-08-15 代码核对发现，本设计闭环不改历史文档，
    留待 AGENTS.md §5 下一轮速查回填时一并校准）**：① Second Stage bullet 的
    ConversationStore「version 1」表述未回填 A5 的 v2 写入（§5 Third Stage 段落
    已正确）；② ToolRegistry bullet 未提 wire 名称契约（决议 #35）双闸门；
    ③ shared/types/agent.ts 枚举清单遗漏 ClickAllowedKind/ElementSemanticsBinding
    两个导出类型名；④ AgentRuntime bullet 未列 verifyReasoningReplay、审计 bullet
    未列 formatAgentRunAuditMessage。均为文档滞后，与代码契约无冲突。
46. **B1 决策门冻结语义校准（2026-08-15，B1 实施前用户裁决）**：⑧⑨（FTS5 建表/
    trigram 中文命中）**不构成 B1 冻结硬门槛**——11 项全部逐项实测与独立报告；
    驱动冻结仅要求基础能力项 ①–⑦、⑩、⑪ 全部通过；⑧⑨ 失败不停止，B3 按 §8.3
    参数化精确匹配/LIKE 安全降级路径为主实现并如实登记。原 §3.2「任一失败 → B1
    停止」与 B1 任务文档「⑧⑨ 不构成失败」及 high-level-design §8 两处表述矛盾，
    按此裁决校准（§3.2/AGENTS/Fourth_stage/HLD/proposal 已同步）。
47. **SQL 封闭边界校准（2026-08-15，B1 实施前用户裁决）**：SQL 封闭的永久红线
    目标不变（模型/网页/用户文本零 SQL 通道、无动态串、无扩展加载）；实施边界
    校准为——业务 SQL 仅 Repository/migrations 编译期常量；**driver 仅允许连接级
    运维 SQL 编译期常量**（PRAGMA busy_timeout/foreign_keys/journal_mode +
    BEGIN/COMMIT/ROLLBACK；PRAGMA 实测不支持参数绑定，值只能为程序校验后的整数
    选项或编译期常量，绝不接收任何文本）；测试专用 SQL 仅限 SMOKE_MODE 门控冒烟
    B-01 与 `*.test.ts`。原 §3.1「SQL 只能位于 Repository/migrations」与
    high-level-design「driver 无 SQL 语句定义」及 B1 实测需求（busy timeout/外键/
    WAL/withTransaction/探针）矛盾，按此裁决校准（§3.1/§3.2/HLD/threat-model/
    proposal/B1 任务文档已同步）。
48. **B1 决策门实测结论：node:sqlite 冻结（2026-08-15，dev+生产双场景实测通过）**：
    驱动 = `node:sqlite`（Electron 43.4.0 内置 Node 24.18.1 / SQLite 3.53.1，实测；
    系统 Node 24.18.0 同为 SQLite 3.53.1）。11 项逐项实测结果——① dev 构建 import ✅
    ② 生产构建产物 import ✅（electron-vite externalize 无问题，零配置改动）③ 文件库
    创建/关闭/重开/读回一致 ✅ ④ prepared statements 参数绑定（中文/引号/`'; DROP
TABLE` 注入串仅作数据）✅ ⑤ BEGIN/COMMIT/ROLLBACK（回调与语句异常整体回滚）✅
    ⑥ PRAGMA foreign_keys=ON 拦截非法外键 + OFF 放行双证 ✅（本机 SQLite 构建默认
    SQLITE_DEFAULT_FOREIGN_KEYS=1，与 stock 默认 OFF 不同——driver 显式双分支保证
    跨构建确定性）⑦ busy_timeout 两连接锁竞争（等待下界证据/释放后成功/零超时立即
    失败）✅ ⑧ FTS5 建表与查询 ✅（可用）⑨ trigram 建表与中文 ≥3 字符子串命中 ✅
    （可用；1–2 字符查询不命中为 trigram 语义，B3 短查询降级路径依据）⑩ 数据库位于
    app.getPath('userData') 派生目录 ✅（官方验证命令 AIBROWSE_USER_DATA_DIR=<系统
    TEMP 下临时目录> 实测）⑪ 关闭后重命名/删除成功 + 重复关闭幂等 + 无效路径中文
    错误安全失败 ✅。**ExperimentalWarning 实测形态**：Electron 43.4.0 与系统 Node
    24.18.0 导入 node:sqlite 均**不产生** warning 事件（进程 warning 监听零触发、
    无 stderr 输出）——如实记录，未做任何压制（决议 #44 处置）。**基础能力项
    ①–⑦、⑩、⑪ 全部通过 → 按决议 #46 冻结**；⑧⑨ 可用 → B3 以 FTS5 trigram 为
    主路径。**备份三候选可行性观察**（B7 定稿）：① VACUUM INTO 可用（连接打开、
    WAL 活跃时生成一致性快照，integrity ok）✅；② node:sqlite backup API
    **不存在**（DatabaseSync.prototype.backup === undefined）❌；③ 关闭后复制
    可行（干净关闭后 -wal/-shm 自动清除，仅主文件；WAL 活跃时文件形态 = 主文件 +
    -wal + -shm，不得只复制主文件）✅。落地：sqlite-driver.ts
    （openDb(path, {busyTimeoutMs, enableForeignKeys, wal}) → DbHandle /
    closeDb 幂等 / withTransaction 同步语义·异常整体回滚·连接可诊断）+ migrations.ts
    骨架（validateMigrationList/planMigration/readUserVersion/runMigrations：
    每级单事务、失败回滚保留原库、未知更高版本 newer-than-program 零写入）。
    单测 +31 用例（sqlite-driver 17 / migrations 14，真实 node:sqlite + worker
    两连接锁竞争正证），全量 test 816/816。

### B2 实施前契约裁决（2026-08-15，九项缺口逐项核验 + 用户裁决，全部采纳推荐）

49. **origin/page 唯一性（schema v1）**：`UNIQUE(scope, canonical_key)` 复合唯一
    约束显式表达两键空间独立；canonical_key 保持纯规范化形态、不编码 scope。
    原 §4.1「键空间不同」声明与 §5 单列 `canonical_key UNIQUE` 矛盾，按此裁决
    校准（§4.2/§5 schema）。
50. **空路径与尾斜杠**：page 键 = WHATWG href 形态——`https://example.com` 与
    `https://example.com/` 解析后 pathname 恒为 `/`，二者为同一 page 身份
    （duplicate 命中同一条目）；展示 URL 保留原始输入。原「路径保留原始形态
    （含尾 `/` 与否按原样）」基于 WHATWG 解析假设错误（原始形态解析后不可恢复），
    按此裁决校准（§4.2 规则矩阵与测试期望）。
51. **disable/restore 状态机**：单一软删状态·双字段联动——不变量
    `enabled=0 ⟺ deleted_at≠NULL`；disable → enabled=0 + deleted_at=now +
    version+1；restore → enabled=1 + deleted_at=NULL + version+1；普通 update
    不触碰两字段（patch 白名单移除 enabled，消除原 §2 类型含 `enabled?` 与
    §7.2「不可经 patch 切换」矛盾）；hard delete 物理删除行；检索/列表默认过滤
    deleted_at IS NULL；重复执行同一方向 op 照常执行 version+1（确定性、Undo
    语义统一）（§2/§5/§7.2）。
52. **共享类型完整定型**：SourcePatch 补全字段类型；新增 SourceTag/SourceListItem/
    SourceView/SourceSearchResult/SourceListResult/SourceResult/ManualAddInput/
    ManualPatch/ManualWriteResult/UndoResult/UndoableChange（判别联合
    `{ok:true,…}|{ok:false,errorCode}`）；错误码统一 `SourceErrorCode`（原
    SourceToolErrorCode 更名 + 增 source-undo-conflict/source-undo-not-found）；
    SourceChangeResult 增顶层 errorCode?、results 条目增 existingSourceId?
    （duplicate 回注既有 id）；缺省与通道语义——AI 通道 trust 缺省
    `{unknown, ai, unverified}`、手工通道缺省 `{unknown, user, asserted}`、
    shareMode 缺省 userNote 非空 → full 否则 metadata、blocked 仅手工通道；
    list/search 不返回 note 正文（B3 按分享模式补充）、get 返回完整 SourceView、
    B2 search 为参数化精确/前缀最小实现（FTS 归 B3）、getState 恒 normal
    （B7 接管 recovery）、recordUsage 最小 upsert（tracker 归 B7）（§2/§6/§7.5）。
53. **幂等重放识别（journal 指纹列 + 部分唯一索引）**：change_journal 增
    `UNIQUE(run_id, tool_call_id) WHERE change_type='agent-change-set'` 部分
    唯一索引（manual 行两列 NULL）+ `request_fingerprint`（ops 规范化确定性
    SHA-256，node:crypto 零依赖）+ `result_payload`（原结果 JSON）。语义：同
    (runId, toolCallId) 指纹一致 → 幂等返回原结果（含同 key）零写入；指纹不同 →
    fail-closed source-conflict 零写入（不返回旧结果）；失败提交（整体拒绝/
    回滚）零落 journal、不产生 key、重试视为新提交（可修正重提，SRT-06）
    （§5 schema/§7.1）。
54. **FTS 所有权（B2 最小写同步）**：B2 落地 schema v1 建表 + 所有写路径
    （add/update/disable/restore/Undo/hardDelete）在同一事务内由 Repository
    显式语句同步 FTS；冻结规则——FTS 行 = 非 hard-deleted 行的 name/url/
    user_note/ai_note 镜像（disabled/soft-deleted 行仍镜像，查询期过滤归 B3）；
    hardDelete 同事务删 FTS 行；B3 负责查询构造/排序/rebuild/降级，不重写 B2
    同步；B2 完成时主表与 FTS 无未说明的不一致（§5/§7.4/§7.5）。
55. **journal 精确关联与 hard delete 清理**：source_ids 改 JSON 数组字符串、
    before/after payload 为 `{sourceId: 行快照+tags}` 映射；hard delete 同事务
    精确移除该 sourceId 条目与快照（UUID 全串相等匹配，零子串误匹配）；剩余为
    空 → 删除整条 journal 行；其余 source 的 Undo 保留（不牺牲）；Undo 只回放
    仍存在的 source、不复活已 hard-deleted 的 source（§5/§7.5）。
56. **hardDeleteManual 能力令牌**：Service 内置 ConfirmTokenIssuer
    （node:crypto randomBytes 256-bit、绑定目标 sourceId、TTL 300s、消费即
    失效、时钟经 now 注入可测）；消费通过后由 Repository 物理删除（B2 无
    「非空即放行」假确认）；未签发/错绑定/过期/重用 → source-conflict 零删除；
    B5 接 UI 时复用同一签发器（二次确认 UI 先 issue 后消费）（§6）。
57. **B-02 跨进程专属门控**：`AIBROWSE_SOURCES_SMOKE=set|check`（与
    AIBROWSE_SESSION_SMOKE 并列、同时设置互斥报错退出）；index.ts 最小路由
    （renderer-ready 后运行专属场景，跳过 UI 矩阵，不接 Source IPC/Tool）；
    set：临时 userData 建库迁移 v1 → SourceService CRUD+journal+disable →
    finally 关库干净退出；check：同目录新进程读回全量断言（行数/内容/版本）→
    执行 Undo → 断言 Undo 生效 → 退出码 0；两进程均需 AIBROWSE_SMOKE=1 +
    已核验系统 TEMP 子目录（AIBROWSE_USER_DATA_DIR）（§13.2/B2 任务文档）。

### B3 实施前契约裁决（2026-08-15，六项冲突逐项核验 + 用户裁决，全部采纳推荐）

58. **读取视角显式化**：search/list/get 增加**必填** `audience: 'user' | 'agent'`
    （无缺省——调用方必须显式声明，防漏传方向性错误）。agent 视角：blocked 完全
    不可见（search 不命中/list 不列出/get 视同不存在 source-not-found）；user
    视角：blocked 可见可管理（B5 UI 需要）。audience 由 B4 工具 executor 与 B5
    IPC handler 在**主进程适配器硬编码**——模型工具参数与 renderer 原始 payload
    均无通道自行选择；禁止让全局 list/get 永久过滤 blocked 导致 UI 无法管理
    （§2/§6/§8.2）。
59. **搜索条目类型独立化**：新增 `SourceSearchItem`（独立于 `SourceListItem`）+
    `SourceSearchNote` 摘录类型——full 模式命中条目的有界 note（userNote/aiNote
    各 ≤200 字符 + provenance 由字段分离承载）只出现在该类型；`SourceListItem`
    永不含 note；`SourceSearchResult.results` 改为 `SourceSearchItem[]`；
    metadata 条目与 user 视角恒无 note 字段（零 note 字节）。不得依靠
    TypeScript 结构外的临时字段（§2/§8.2）。
60. **短查询与 FTS 分流语义**：查询 trim + NFC + 控制字符剔除后按 Unicode 码点
    计数——1 字符：仅精确匹配（name/url/canonicalKey）；2 字符：精确 + 前缀 +
    参数化字面子串 LIKE ESCAPE（中文 2 字符子串经降级路径诚实交付，**测试不得
    声称 trigram 原生支持两字符**——B1 实测 trigram 仅 ≥3 字符命中）；≥3 字符
    （含 3）：FTS5 trigram 主路径（buildFtsQuery 仅对 ≥3 字符 token 短语包裹，
    短 token 不产生子串命中，如实登记）；特殊 URL 查询确定性判定集合 =
    normalizeSourceUrl 可解析，或 trim 后以 http://、https:// 开头（§8.3）。
61. **排序全序**：档位严格不可跨档——精确 > 前缀 > tag/group > name/domain >
    note（priority **不得**反转档位）；priority（1–5）仅同档内降序；同
    priority 下 lastUsedAt 降序、lastUsedAt=null 恒排最末；最终以 scope ASC +
    canonicalKey ASC + id ASC 收尾（origin/page 同 canonicalKey 也全序）
    （§8.3）。
62. **「FTS 不可用」范围界定**：仅指已成功建库（schema v1 迁移完成、sources_fts
    存在）后的 MATCH 查询构造/执行失败或 FTS 表被破坏——B3 查询降级路径接管
    （参数化精确/前缀 LIKE，note 检索随之不可用并如实登记）；**不承诺无 FTS5
    编译的构建可完成迁移**——schema v1 已按决议 #54 冻结，B3 不改写；B1 实测
    Electron 43.4.0 与系统 Node 24.18.0 均含 FTS5；若未来需支持无 FTS5 构建，
    须另立 migration v2 并在 B7 备份/恢复配套内评估兼容性影响（§8.3）。
63. **B-04 分段记录**：B-04 冒烟断言记为 B3/B4 分段完成——B3 完成数据库/Service
    子集（多语言检索/短查询降级/硬上限 10/每页 20/分享模式/note 清洗与
    provenance/rebuild/一致性，默认矩阵 dev+production 双场景真实 node:sqlite
    实测）；SOURCE_TOOL_CONTENT_MAX=4000、ToolResult 序列化、
    UNTRUSTED_TOOL_RESULT 块接线与审计为 **B4 待完成**——B3 不提前实现 Source
    Tools/工具预算/Agent 接线（工具注册表保持既有 13 个），不宣称 B-04 全过
    （§13.2/B3 任务文档）。

## 16. 实现顺序与范围边界（B1–B9 映射）

- B1（硬前置）→ B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9；B7 依赖 B2/B6；
  B8 依赖 B1–B7；B9 依赖全部且独立复验。
- 每任务闭环边界、红态测试、验收标准、停止条件见 `doc/stage4/tasks/B1–B9`。
- B9 完成后停止，不实现 Fifth Stage 任何代码；等待用户指令。
