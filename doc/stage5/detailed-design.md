# AIbrowse 第五阶段 详细设计（多源 Research、证据链与结构化展示，定稿）

> 状态：**定稿（2026-08-16，纯文档设计闭环）**。本文件是第五阶段**唯一契约源**
> ——所有接口签名、状态机、预算常量、数据契约、决议以本文件为准；实施任务 C1–C10
> 按本文落点执行；实施中发现契约问题按 §15 决议记录流程校准（先改本文与测试，
> 再改实现）。
> 安全契约源：`doc/stage5/threat-model.md`（FT-01～FT-17、FRT-01～FRT-12，先于任何
> Research 实现定稿——本闭环已满足）。
> 需求源：根目录 `Fifth_stage.md`（§9 验收标准、§10 Exit Gate 为本设计约束，
> 需求边界不被本设计削弱）。
> 现状校准原则：本设计引用的既有接口均已与当前代码 `grep -n "^export"` 逐项核对
> （2026-08-16 本会话核查：BrowserController/SearchProvider/AgentLoop/
> ConversationService/ToolRegistry/ToolExecutor/SourceService/source-tools/
> shared types 与 AGENTS.md §5 一致；AgentLoop 12/420s 为第三阶段冻结契约）。
> **本设计闭环不新增任何 npm 依赖、不修改任何产品代码；全部内容为「规划/待实现」，
> 在对应任务完成前不得宣称已实现。**

## 1. 文件布局（C1–C8 新增，规划）

```
src/
├── main/
│   ├── index.ts                      # 既有：C1/C5/C8 扩展 Research 装配（store 装配/
│   │                                 #   service 装配/IPC 通道注册/冒烟注入点）
│   └── research/                     # 第五阶段新增（主进程专属，C1 起）
│       ├── db/
│       │   ├── research-migrations.ts  # C1：research.db schema 编译期常量 +
│       │   │                           #   user_version 单调逐级迁移（复用 B1 模式）
│       │   └── research-driver.ts      # C1：openDb 薄封装（复用 sources/db/
│       │                               #   sqlite-driver.ts 的 node:sqlite 冻结模式，
│       │                               #   独立库独立句柄；零业务 SQL）
│       ├── research-store.ts         # C1：启动装配（probe → 迁移 → 检查 →
│       │                             #   normal | unavailable；运行中任务标 interrupted）
│       ├── domain/                   # 纯核心零 Electron 依赖，可单测
│       │   ├── research-task-state.ts  # C1：任务状态机纯函数（状态迁移/子相位）
│       │   ├── research-budget.ts      # C1：全部确定性预算常量与裁剪纯函数
│       │   └── research-errors.ts      # C1：ResearchErrorCode 与错误归一化映射
│       ├── repository/
│       │   └── research-repository.ts  # C1：research.db 唯一 SQL 执行点
│       │                               #   （编译期常量 + prepared statements）
│       ├── research-service.ts       # C1/C5：任务生命周期编排唯一入口
│       ├── research-workspace.ts     # C2：task-owned Tab 所有权（BrowserController
│       │                             #   集成；并发 ≤3；try/finally 清理）
│       ├── source-selector.ts        # C3：候选合并/provenance/确定性排序（纯函数）
│       ├── capture-service.ts        # C4：读取/结构化提取/capture 记录
│       ├── evidence-validator.ts     # C4：证据确定性验证纯函数
│       ├── research-runtime.ts       # C5：独立有界编排状态机（纯核心零 Electron import）
│       ├── synthesis/                # C6：综合层
│       │   ├── claim-model.ts          # Claim/Coverage/Conflict/Uncertainty 数据装配
│       │   └── research-prompts.ts     # 合成提示词编译期常量 + UNTRUSTED 块组装
│       ├── result-validator.ts       # C7：Result Schema 逐块校验纯函数
│       └── research-ipc.ts           # C8：research:* 通道适配器（参数白名单/
│                                     #   状态门控/审计；零 Electron import）
├── preload/index.ts                  # 既有：C8 扩展 research bridge 白名单
├── renderer/
│   └── src/research/                 # C7/C8：渲染层
│       ├── markdown/                 # C7：受控 Markdown 子集解析纯函数（零依赖）
│       ├── ResultView.tsx            # C7/C8：结果画布（Markdown/Table/Cards/
│       │                             #   Ranking 组件 + Evidence 下钻）
│       ├── ResearchPanel.tsx         # C8：侧栏（创建/启动/停止/进度/历史）
│       ├── csv-serializer.ts         # C8：CSV 序列化纯函数（公式注入防护/BOM/转义）
│       └── useResearch.ts            # C8：研究状态 hook（纯 reducer）
└── shared/
    ├── types/research.ts             # C1：Research 域类型 + IPC payload +
    │                                 #   预算常量（单一事实源）
    └── types/ipc.ts                  # 既有：C8 扩展 research:* 通道常量
```

依赖方向（proposal §6，不可反向或跳跃）：
`Research UI → ResearchService → ResearchRuntime → SourceSelector /
ResearchWorkspace / EvidenceValidator / ResultValidator → SourceService /
BrowserController / SearchProvider / LLMProvider → ResearchRepository`。
**Renderer 只消费已验证 Result Schema；不得访问 BrowserController、SQLite、
Electron 或 Provider。** renderer、preload、ResearchRuntime/Tool 实现不得
直接执行 SQL；Research 库的业务 SQL 仅为 ResearchRepository 编译期常量与
migration（参数绑定）——沿用决议 #47/#48 模式。

## 2. 共享类型契约（shared/types/research.ts，C1）

```ts
// ---------- 任务 ----------
export type ResearchTaskStatus =
  | 'created' // 已创建未开始（可编辑/删除）
  | 'running' // 运行中（phase 表达子相位）
  | 'completed' // 成功终态（Result 已持久化）
  | 'failed' // 致命失败终态（errorCode + 已收集 Evidence 保留）
  | 'cancelled' // 用户停止终态（部分数据保留，无最终 Result）
  | 'interrupted'; // 进程退出/崩溃时 running 任务的持久化标记（可重新开始，不自动续跑）

export type ResearchPhase =
  | 'planning' // 候选选择
  | 'reading' // 多源读取与证据收集
  | 'verifying' // 交叉核验
  | 'synthesizing'; // 综合与 Result 生成

export type ResearchErrorCode =
  | 'research-invalid-goal' // goal 空/非串（超长确定性截断 + warn，决议 #107）
  | 'research-busy' // 单 running 任务互斥
  | 'research-not-found' // 任务不存在
  | 'research-invalid-state' // 状态不允许该操作
  | 'research-unavailable' // 库 unavailable
  | 'research-sources-unavailable' // Sources 库非 normal 态拒绝启动
  | 'research-provider-unavailable' // Provider 未配置/不支持
  | 'research-budget-exhausted' // 任一确定性预算用尽（正式终态）
  | 'research-timeout' // 总超时独立错误码（决议 #108：不以 research-internal 含混代替）
  | 'research-task-limit' // 任务总数达上限且无可清理终态（决议 #104：新建拒绝）
  | 'research-internal';

export interface ResearchTask {
  id: string; // UUID（主进程生成）
  goal: string; // ≤MAX_GOAL_CHARS(2000) 字符（非串/空拒绝；超长确定性截断 + warn，决议 #107）
  status: ResearchTaskStatus;
  phase: ResearchPhase | null; // running 时的子相位
  createdAt: string; // ISO 8601
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  interruptedAt: string | null; // interrupted 标记时间
  errorCode: ResearchErrorCode | null;
  resultId: string | null;
  stats: ResearchTaskStats;
}

export interface ResearchTaskStats {
  candidateCount: number; // 合并后候选数
  selectedCount: number; // 选定来源数
  captureCount: number; // 捕获次数（含失败）
  failedReadCount: number; // 读取失败数（Fifth §7.7 明确记录）
  evidenceCount: number; // 验证通过证据数
  rejectedEvidenceCount: number; // 验证拒绝数（回注修正）
  claimCount: number; // 综合结论数
  conflictCount: number; // 显式冲突数
  stepsUsed: number; // 工具步数
  roundsUsed: number; // 模型轮次
}

// ---------- 候选来源（C3） ----------
export type CandidateOrigin = 'sources' | 'search';

export interface SourceCandidate {
  id: string; // 主进程生成（合并后唯一）
  url: string; // 展示 URL（http/https 白名单）
  displayUrl: string;
  title: string; // ≤200（Sources 名称或搜索结果标题）
  canonicalKey: string; // normalizeSourceUrl 身份键
  scope: 'origin' | 'page';
  discoveredVia: CandidateOrigin[]; // 双发现路径保留（决策 D6）
  sourceId: string | null; // Sources 命中才有
  trust: {
    value: SourceTrustValue;
    assertedBy: SourceTrustAssertedBy;
    verification: SourceTrustVerification;
  } | null;
  // 继承 Sources trust 三元组；search 命中恒 null
  priority: number | null; // 仅 Sources 命中（1–5）
  lastUsedAt: string | null; // 仅 Sources 命中
  note: string | null; // ≤200 摘录（仅 UI 展示用；不进入模型上下文）
  sortKey: string; // 确定性排序键（纯函数生成，见 §4）
}

// ---------- Capture（C4） ----------
export type CaptureFailureReason =
  | 'page-load-failed'
  | 'snapshot-degraded'
  | 'tab-closed-by-user'
  | 'timeout'
  | 'aborted'
  | 'http-scheme-rejected';

export interface CaptureSummary {
  sectionCount: number; // 可见文本章节数
  tableCount: number; // 表格数（行×列合计）
  headingCount: number;
  charCount: number; // 规范化正文总字符（≤ MAX_PAGE_CAPTURE_CHARS）
}

export interface Capture {
  captureId: string; // UUID
  taskId: string;
  candidateId: string;
  tabId: string; // 本次读取的精确 tabId
  url: string;
  title: string;
  accessTime: string; // 主进程盖章 ISO 时间（Fifth §3.4）
  documentId: string; // 快照 meta.documentId（主进程盖章，页面不可伪造）
  contentHash: string; // 规范化正文 SHA-256 前 32 hex
  summary: CaptureSummary;
  failed: boolean;
  failureReason: CaptureFailureReason | null;
}

// ---------- Evidence（C4/C6，Fifth_stage.md §3.4 字段集） ----------
export type EvidenceType = 'quote' | 'table-cell' | 'field' | 'summary-point';
export type EvidenceVerification = 'verified' | 'rejected';

export type EvidenceLocator =
  | { kind: 'text'; excerpt: string } // ≤500 字符
  | { kind: 'table'; row: number; col: number; header: string | null } // 0-based 行列；
  // header 仅允许 string | null | 缺省——object/array/number/boolean 等非法形态
  // 使整个 locator 无效（fail-closed 整体拒绝，不得静默转 null——决议 #115）
  | { kind: 'field'; fieldPath: string }; // 提取字段路径（≤200）

export interface Evidence {
  evidenceId: string;
  taskId: string;
  captureId: string; // 归属捕获（验证要求：属于当前任务）
  candidateId: string; // 来源引用（验证要求：来源存在）
  sourceId: string | null; // Sources 命中时携带
  url: string;
  title: string;
  accessTime: string; // 主进程盖章
  documentId: string;
  contentHash: string; // 快照摘要哈希
  type: EvidenceType;
  locator: EvidenceLocator;
  excerpt: string; // 受控 excerpt/字段值：≤ MAX_EVIDENCE_EXCERPT_CHARS（500），
  // 规范化后来自捕获内容（验证结果）
  value: string | null; // table-cell/field 的单元格/字段值（≤200）
  verification: EvidenceVerification; // 运行期判别联合：'rejected' 仅回注模型修正，
  // 永不进 Evidence 集合与 research.db（决议 #102：Repository 写入仅接受
  // verified 窄类型 + schema CHECK 兜底）
}

// ---------- Cross-check（C6） ----------
export type ClaimSeverity = 'high' | 'medium' | 'low'; // high = 高影响事实（必须多源）
export type CoverageKind = 'multi-source' | 'single-source';
export type SourceTypeClass = 'vendor' | 'third-party' | 'community';

export interface Claim {
  claimId: string;
  taskId: string;
  text: string; // ≤500 字符（规范化）
  severity: ClaimSeverity;
  coverage: CoverageKind; // 确定性程序计算：引用的不同 canonicalKey 来源数 ≥2
  sourceTypes: SourceTypeClass[]; // 厂商自述/第三方区分（§5 判定规则）
  evidenceIds: string[]; // 已验证证据引用
  singleSourceFields: string[]; // 单一来源字段显式标注（Fifth §5）
  conflictIds: string[];
}

export interface ConflictPosition {
  positionText: string; // ≤300 字符
  sourceRefs: string[]; // candidateId 引用
}

export interface Conflict {
  conflictId: string;
  taskId: string;
  topic: string; // ≤200 冲突主题
  positions: ConflictPosition[]; // ≥2（程序校验）
  claimIds: string[];
  resolved: 'explicit' | 'unresolved'; // v1 恒 'unresolved'（不自动裁决、不静默抹平）
}

// ---------- Result Schema（C7/C8；Fifth_stage.md §3.6/§5） ----------
export type ResultBlock =
  | { kind: 'markdown'; text: string } // ≤4000 字符/块
  | { kind: 'table'; columns: string[]; rows: string[][]; sourceRefs: string[] }
  // columns ≤ MAX_TABLE_COLUMNS(20)；rows ≤ MAX_TABLE_ROWS(200)；单元格 ≤200 字符；
  // sourceRefs = candidateId[]（每列至少映射来源语义见 §8.3）
  | {
      kind: 'cards';
      items: { title: string; subtitle: string | null; body: string; sourceRefs: string[] }[];
    }
  // items ≤ 20；title ≤120/subtitle ≤120/body ≤1000
  | {
      kind: 'ranking';
      items: { rank: number; title: string; detail: string; sourceRefs: string[] }[];
    }
  // items ≤ 20；rank 1-based 连续（程序校验）；title ≤120/detail ≤1000
  | { kind: 'uncertain'; text: string; reason: string }; // 「不确定」正式输出类型
// text/reason ≤1000

export interface ResearchResult {
  resultId: string;
  taskId: string;
  title: string; // ≤120
  summary: string; // ≤2000 摘要
  blocks: ResultBlock[]; // ≤20 块
  evidenceMap: Record<
    string,
    { candidateId: string; url: string; title: string; accessTime: string }
  >;
  // evidenceId → 展示元数据（≤ MAX_EVIDENCE_PER_TASK 项）
  conflicts: { conflictId: string; topic: string; positions: ConflictPosition[] }[];
  coverage: {
    total: number;
    multiSource: number;
    singleSource: number;
    vendor: number;
    thirdParty: number;
    community: number;
  };
  // 覆盖情况（计数类事实，非虚构百分比——Fifth §5）
  fetchedAt: string; // 数据获取时间
}
```

字段红线：所有字符串按既有 sanitize 家族规则剔除控制字符/bidi（模型/网页文本
视为不可信输入）；`goal` ≤ MAX_GOAL_CHARS（2000）；Evidence.excerpt ≤
MAX_EVIDENCE_EXCERPT_CHARS（500）；单元格/字段值 ≤
MAX_EVIDENCE_FIELD_VALUE_CHARS（200）；Result 总字符 ≤ MAX_RESULT_CHARS
（200k）；禁止字段：任意 HTML/CSS/JS 形态、raw URL 之外的协议、百分比型
「可信度」数值（Fifth §5）。**常量单一事实源（决议 #110）**：§2 全部数值
上限与 §6.8 全表集中在 `shared/types/research.ts`——候选 title/note ≤
MAX_CANDIDATE_TITLE_CHARS/MAX_CANDIDATE_NOTE_CHARS（200）、Claim.text ≤
MAX_CLAIM_TEXT_CHARS（500）、冲突 topic ≤ MAX_CONFLICT_TOPIC_CHARS（200）、
positionText ≤ MAX_CONFLICT_POSITION_CHARS（300）、Result title ≤
MAX_RESULT_TITLE_CHARS（120）、summary ≤ MAX_RESULT_SUMMARY_CHARS（2000）、
Markdown 块 ≤ MAX_MARKDOWN_BLOCK_CHARS（4000）、表格单元格 ≤
MAX_TABLE_CELL_CHARS（200）、cards title ≤ MAX_CARDS_TITLE_CHARS（120）/
body ≤ MAX_CARDS_BODY_CHARS（1000）、ranking title ≤ MAX_RANKING_TITLE_CHARS
（120）/detail ≤ MAX_RANKING_DETAIL_CHARS（1000）、uncertain text/reason ≤
MAX_UNCERTAIN_TEXT_CHARS（1000）、field 路径 ≤
MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS（200）；实现与测试禁止魔法数字。

## 3. 研究任务状态机（C1 纯函数）

### 3.1 状态迁移表

| 当前状态                             | 事件                                            | 下一状态    | 说明                                                                                                                  |
| ------------------------------------ | ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| created                              | start                                           | running     | 前置：单 running 互斥 + Sources 库 normal 态 + Provider 已配置；记录 startedAt                                        |
| running                              | phase → planning/reading/verifying/synthesizing | running     | 子相位随阶段推进（phase 字段，非状态膨胀）                                                                            |
| running                              | finish(done)                                    | completed   | Result 持久化成功后唯一成功终态；记录 finishedAt/resultId                                                             |
| running                              | finish(error)                                   | failed      | 致命错误终态（provider/sources/internal/timeout）；已收集 Evidence 保留；errorCode 记录                               |
| running                              | finish(budget)                                  | failed      | 任一确定性预算用尽 = 正式终态（errorCode=research-budget-exhausted）；已收集 Evidence 保留                            |
| running                              | stop                                            | cancelled   | 用户停止；部分数据保留、无最终 Result；Workspace 清理只关本任务 Tab                                                   |
| running                              | process-exit                                    | interrupted | 启动装配时对「上次进程遗留 running」任务执行（不自动续跑）                                                            |
| interrupted                          | start（用户重新开始）                           | running     | 以同 goal 重新开始（新 run；旧 run 数据原子清理——决议 #106）                                                          |
| created/cancelled/failed/interrupted | start                                           | running     | 同 interrupted 语义（重新开始 = 新 run）；**completed 不可 start**（决议 #105：Result 已持久化，重新研究 = 新建任务） |
| completed                            | delete                                          | （删除）    | 删除任务记录（含 evidence/claims/result 行）                                                                          |
| 任意终态                             | —                                               | —           | 终态不可变（finish() 单一所有权守卫；迟到事件/写入忽略——A5 决议 #33 模式；start 为唯一例外）                          |

- **start 前置校验（确定性，缺一即拒绝）**：goal 非空（create 时已截断 ≤2000）；
  无其他 running 任务（research-busy）；Sources 库 state=mode normal
  （research-sources-unavailable）；Provider 已配置且 supportsToolCalling
  （research-provider-unavailable）。校验失败不改变任务状态（保持
  created/interrupted 可重试）。C1 以可注入状态查询实现（缺省就绪；C5 接线
  真实查询——决议 #107）。
- **delete 合法矩阵（决议 #105）**：created/completed/failed/cancelled/
  interrupted 可删除（CASCADE 清全部子行）；running 拒绝
  （research-invalid-state——§11 IPC research:delete「仅终态任务；running
  拒绝」与 §2「created 可删除」合并语义）；不存在 → research-not-found。
- **restart 原子清理（决议 #106）**：start 在 cancelled/failed/interrupted
  任务上触发时，Service 层在**单事务内**删除本任务全部旧 run 行
  （candidates/captures/evidence/claims/conflicts/result）并重置
  stats 全零/resultId=null/errorCode=null/finishedAt=null/
  interruptedAt=null/phase='planning'/startedAt=now/updatedAt=now——
  「标记废弃」以删除实现，防跨 run 混用（FT-09/15）；created 首次 start
  无旧数据仅状态迁移。
- **interrupted 持久化**：ResearchRuntime 每进入新阶段前将任务心跳
  （status=running + phase + updatedAt）落库；启动装配（research-store）
  发现遗留 running 任务 → 标 interrupted（interruptedAt=now，phase 置 null）。
  不自动续跑、不重建 Tab/浏览器态（决策 D3）。

### 3.2 状态机纯函数（research-task-state.ts）

```ts
export type ResearchTaskEvent =
  | { kind: 'start'; now: string } // 决议 #105：全部事件统一携带 now（ISO 8601，
  | { kind: 'phase'; phase: ResearchPhase; now: string } //   调用方时钟注入——纯函数确定性；
  | { kind: 'finish-done'; resultId: string; now: string } //   resultId 非空校验）
  | { kind: 'finish-error'; errorCode: ResearchErrorCode; now: string }
  | { kind: 'finish-budget'; now: string }
  | { kind: 'stop'; now: string }
  | { kind: 'mark-interrupted'; now: string };

export function transitionTask(task: ResearchTask, event: ResearchTaskEvent): ResearchTask;
// 纯函数：未知/非法事件（含非法 resultId/errorCode/now 形状）安全返回原任务副本
// （不抛异常）；终态（completed/failed/cancelled/interrupted）后除 start 外任何
// 事件零变化（单一所有权）；start 在 created/cancelled/failed/interrupted 上合法
// （→ running + phase='planning'），在 running/completed 上零变化（互斥前置在
// Service 层校验并回注错误码）。start 状态迁移只改任务行；旧 run 数据原子清理
// 由 Service 层事务完成（决议 #106）。
// now 形状（决议 #116）：ISO 8601 时间戳为**输入有效性约束**——非 ISO 8601
// 时间戳形状（垃圾字符串/非法日期/无时区等）的 now 属非法载荷，事件零变化。
// 调用方（Service.nowIso/store 装配）恒经 new Date(ms).toISOString() 产生；
// 校验纯函数 isIso8601Timestamp 导出并单测固化。
```

## 4. 候选来源合并与排序（C3 纯函数，source-selector.ts）

### 4.1 合并语义（决策 D6）

- 输入：`SourceService.search/list`（audience='agent'，既有有界语义）+
  `SearchProvider.search`（≤10 结果）+ 可选 groupId 过滤（场景 1「只看
  AI Benchmark 分组」：list(groupId) 路径）。
- 身份键：`normalizeSourceUrl(url, scope)`（复用 B2 canonicalization 纯函数）；
  origin 候选与 page 候选**不互相合并**（键空间独立，决议 #49 语义）；同
  canonicalKey 的 Sources 命中与 Search 命中合并为**一个候选**，
  `discoveredVia` 累积两条路径（保序）。
- 合并字段：url/title 取 Sources 侧（名称更可控），title 缺失取搜索标题；
  trust/priority/lastUsedAt/note 仅 Sources 侧有；search 命中这些字段为
  null（**无 trust 断言**——不虚构）。
- **收藏/priority/用户备注不得自动等同可信**：候选携带字段仅为展示与排序
  输入；provenance 语义继承 Sources trust 三元组（official+ai+unverified
  仍显示「AI 推断·未核验」）；排序档位见 4.3（priority 不反转档位）。

### 4.2 候选排序（确定性全序）

```
sortKey = tier(2位) + "|" + priority(降序补齐) + "|" + lastUsedAt(降序, null=最末)
        + "|" + canonicalKey + "|" + id
tier 定义（档位严格不可跨档）：
  1 = 收藏命中且 trust.assertedBy='user'（用户标定）
  2 = 收藏命中（ai 断言或 unknown）
  3 = trust.value ∈ {official, primary} 且 verification='asserted'
  4 = 搜索命中（无 trust 断言）
  5 = 其余（secondary/community/unknown）
```

- 选定数：`MAX_SELECTED_SOURCES = 8`（候选 >8 时取前 8；模型可在计划阶段
  要求调整选择（≤8 范围内）——选择意图为模型提议、程序按排序键执行裁剪）。
- 确定性：同输入同输出；排序纯函数全表测试（含 null 字段/边界）。

## 5. Capture 与 Evidence 数据契约（C4）

### 5.1 读取与提取（capture-service.ts）

```
read(candidate)：
 ① 前置：候选 url 为 http/https（白名单，与导航白名单同源判定）
 ② Workspace 分配 task Tab（§6 所有权）→ loadURL
 ③ 等待 ready（复用 search-provider 轮询模式，READY_TIMEOUT 15s 可注入）
 ④ getPageSnapshot（实时采集；L0 正常/L1 partial/L2 降级/L3 失败阶梯沿用）
 ⑤ 结构化提取（快照结构为准，不新建采集通道）：
    - 章节 = visibleText/headings/tables/links 结构
    - 规范化正文 = 提取内容合并（≤ MAX_PAGE_CAPTURE_CHARS=60k 确定性截断）
    - 表格坐标 = 快照 tables[i] 行列（0-based）
    - 字段路径 = 提取的键路径（field 类型证据用）
 ⑥ capture 记录组装：contentHash = SHA-256(规范化正文) 前 32 hex
 ⑦ 正文仅内存保留至任务终态（不持久化——决策 D3；FT-14/16）
失败语义：load 失败/timeout/snapshot L3 → failed capture（failureReason），
 统计 failedReadCount，任务继续（Fifth §7.7）；同一候选允许重试 1 次
（MAX_PAGE_READ_RETRIES=1，即最多 2 次尝试；重试换新 tabId）
```

### 5.2 Evidence 验证（evidence-validator.ts，决策 D5）

```
verifyEvidence(proposal, captures, task): { ok: true, evidence } | { ok: false, reason }
 ① 归属校验：proposal.captureId ∈ 本任务 captures（跨任务引用 → 拒绝，
    FT-09/15）；capture.failed → 拒绝
 ② 来源存在：proposal.candidateId 存在且 capture.candidateId === candidateId
 ③ 摘录校验（text/summary-point 类）：normalizeExcerpt(excerpt)（trim/NFC/
    控制字符/bidi 剔除/连续空白折叠）后 ⊆ normalizeText(捕获对应章节)；不匹配
    → 拒绝（伪造/错绑/脱离上下文——FT-03/04/06）；excerpt 超长 → 拒绝
 ④ 坐标校验（table 类）：row < 表格行数、col < 表格列数、单元格规范化文本
    === normalizeText(proposal.value 或 excerpt 一致)；越界 → 拒绝
 ⑤ 字段校验（field 类）：fieldPath 存在于提取字段集（路径白名单匹配）
 ⑥ 通过 → Evidence 组装（verification='verified'；url/title/accessTime/
    documentId/contentHash 全部取自主进程捕获记录——模型不可伪造）
```

- 模型只能**提出**引用（evidence proposal 作为结构化请求消息内容）；
  验证纯函数幂等、同输入同输出；rejected 回注模型修正（附原因，≤200 字符）。
- 未验证引用**不渲染、不进 Evidence 集合、不进持久化**（FT-11）。

## 6. ResearchRuntime（C5，独立有界编排状态机）

### 6.1 与 AgentLoop 的边界（决策 D2）

- AgentLoop（12 步/420s/防循环/确认管线）**契约零改动**，继续服务普通 Agent
  任务模式；Research 不走 AgentLoop。
- ResearchRuntime 为纯核心（零 Electron import），构造注入：provider
  （LLMProvider 接口）、sourceService、searchProvider、browser
  （BrowserController 最小接口）、workspace、captureService、repository、
  时钟/预算（可注入）。

### 6.2 阶段循环

```
run(taskId, goal):
  phase planning：候选生成（Sources+Search）→ 排序 → 选定 ≤8
    → 计划模型轮（可选 1–2 轮；候选元数据进 UNTRUSTED 块）
  phase reading：逐候选串行（v1 单并发读取）：read → 模型提出 evidence
    → verifyEvidence → 通过入集合/拒绝回注 → 下一条
  phase verifying：模型提出 claims/冲突对 → claim-model 装配（§7）
  phase synthesizing：合成提示词 → 模型产出 Result Schema 草案
    → ResultValidator → 通过持久化 → completed
  终态单一所有权（finish() 守卫）：stop/超时/预算用尽/Provider 错误
    → 各自终态；迟到模型输出/回调忽略；Workspace 清理
```

### 6.3 停止/取消语义

- `stop(taskId)`：幂等；abort 当前模型流（AbortController）+ Workspace
  清理（只关本任务 Tab）+ 状态 cancelled；stop 后迟到事件/写入零生效。
- 进程退出：Runtime 心跳持久化 → 启动装配标 interrupted（§3.1）。

### 6.4 失败继续

- 单候选读取失败：failed capture + failedReadCount + 继续下一候选（不终止任务）。
- Search 失败（search-failed）：候选仅剩 Sources 侧 + 如实记录（warnings）。
- Sources 检索失败：任务 failed（research-sources-unavailable——启动前置
  已校验 normal 态，运行中失败属异常路径）。
- Provider 轮失败：结构化归一（复用 error-normalize）；连续 2 轮失败 →
  failed 终态；单轮失败重试 1 次（同轮请求）。
- 模型产出非法 Result：ResultValidator 拒绝 → 回注错误详情重提（≤2 次）；
  仍失败 → failed（research-internal，Evidence 保留）。

### 6.5 进度事件

`research:progress`：{ taskId, status, phase, stats, finishedAt? }——确定性
运行事实（无思维过程/无模型文本）；节流：phase 变更或 stats 变化时推送。

### 6.6 超时

- `RESEARCH_TOTAL_TIMEOUT_MS = 1_800_000`（30 分钟，含确认等待——Research
  v1 无 L2 确认工具，但 browser_open L1 展示与 Provider 等待计入）。
- 超时 → failed，errorCode=**'research-timeout'**（决议 #108：独立错误码，
  不以 research-internal 含混代替无法展示的原因；errorCode 文案在
  research-errors.ts 单一事实源；timeout 理由进日志，不虚构）。

### 6.7 页面变化/陈旧

- Evidence 验证基于**本次捕获内容**（内存快照）；页面在捕获后变化不使已
  验证 Evidence 失效（accessTime + documentId 记录捕获时刻）；快照
  documentId 世代由主进程盖章（页面不可伪造——A3 决议 #31 机制）。
- 用户关闭 task Tab：Workspace 感知 → 该候选读失败（tab-closed-by-user）→
  继续（FT-09 反面语义：用户永远可关闭任何 Tab）。

### 6.8 确定性预算（D12 全表；编译期常量 + 可注入 + 测试断言）

| 常量                                | 值       | 语义                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAX_GOAL_CHARS                      | 2000     | goal 截断上限（截断标记计入上限——返回文本 String.length 恒 ≤2000，决议 #114；单位 = JavaScript 字符数，非 UTF-8 字节，决议 #103）                                                                                                                                                                                                                                                      |
| MAX_SOURCE_CANDIDATES               | 24       | 合并后候选上限（Sources ≤10 + Search ≤10 + 溢出裁剪）                                                                                                                                                                                                                                                                                                                                  |
| MAX_SELECTED_SOURCES                | 8        | 选定来源上限                                                                                                                                                                                                                                                                                                                                                                           |
| MAX_RESEARCH_TABS                   | 3        | 同任务同时打开的 task Tab 上限（v1 串行读取实际 1 个，上限为纵深防御）                                                                                                                                                                                                                                                                                                                 |
| MAX_PAGE_CAPTURE_CHARS              | 60000    | 单页规范化正文预算（确定性截断 + summary.charCount）                                                                                                                                                                                                                                                                                                                                   |
| MAX_PAGE_READ_RETRIES               | 1        | 同候选读取失败重试上限（最多 2 次尝试）                                                                                                                                                                                                                                                                                                                                                |
| MAX_CAPTURES_PER_TASK               | 16       | 8 候选 × 2 尝试的捕获记录上限                                                                                                                                                                                                                                                                                                                                                          |
| MAX_EVIDENCE_EXCERPT_CHARS          | 500      | 单条 Evidence excerpt 上限                                                                                                                                                                                                                                                                                                                                                             |
| MAX_EVIDENCE_FIELD_VALUE_CHARS      | 200      | 单元格/字段值上限                                                                                                                                                                                                                                                                                                                                                                      |
| MAX_EVIDENCE_PER_TASK               | 60       | 任务 Evidence 总数上限（超出拒绝新提案）                                                                                                                                                                                                                                                                                                                                               |
| MAX_CLAIMS_PER_TASK                 | 30       | claims 总数上限                                                                                                                                                                                                                                                                                                                                                                        |
| MAX_CONFLICTS_PER_TASK              | 10       | 冲突数上限                                                                                                                                                                                                                                                                                                                                                                             |
| MAX_RESEARCH_ROUNDS                 | 24       | 模型轮次上限（规划 2 + 读取 8 + 核验 4 + 综合 3 + 修正余量 7）                                                                                                                                                                                                                                                                                                                         |
| MAX_RESEARCH_TOOL_STEPS             | 64       | 工具步数上限（read/open/search 计数；不注册新工具，计数语义为 Runtime 内部审计口径）                                                                                                                                                                                                                                                                                                   |
| RESEARCH_TOTAL_TIMEOUT_MS           | 1800000  | 总时长上限（30 分钟，含等待）                                                                                                                                                                                                                                                                                                                                                          |
| MAX_REQUEST_CONTEXT_CHARS           | 200000   | 单轮请求上下文字符预算（含 UNTRUSTED 块回注）                                                                                                                                                                                                                                                                                                                                          |
| MAX_TRANSCRIPT_REPLAY_ROUNDS        | 6        | transcript 回放最近轮数（更早轮压缩为摘要行）                                                                                                                                                                                                                                                                                                                                          |
| MAX_RESULT_CHARS                    | 200000   | Result JSON 总字符                                                                                                                                                                                                                                                                                                                                                                     |
| MAX_RESULT_BLOCKS                   | 20       | Result 块数                                                                                                                                                                                                                                                                                                                                                                            |
| MAX_TABLE_ROWS / MAX_TABLE_COLUMNS  | 200 / 20 | Table 块行列界（Renderer 与 Validator 同源常量）                                                                                                                                                                                                                                                                                                                                       |
| MAX_CARDS_ITEMS / MAX_RANKING_ITEMS | 20 / 20  | Cards/Ranking 条目界                                                                                                                                                                                                                                                                                                                                                                   |
| MAX_TASK_PERSISTED_CHARS            | 500000   | 单任务持久化总预算 = **UTF-8 字节数**（决议 #103：Buffer.byteLength——实际持久化大小有界，P2-3 目标）；覆盖任务全部持久化行（task+candidates+captures+evidence+claims+conflicts+result）；写库前事务内检查，超限拒绝写入                                                                                                                                                                |
| MAX_STORED_TASKS                    | 30       | **任务总数硬上限（含 created，决议 #104）**；清理对象仅最旧终态（completed/failed/cancelled/interrupted；created 永不清除、计入总数）；触发 = 任务进终态写入后 + 启动装配 interrupted 标记后 + create 总数检查；最旧排序键 = COALESCE(finished_at, interrupted_at) DESC, created_at DESC, id ASC；总数满且无可清理终态 → 新建拒绝 research-task-limit；被清理任务不可再看详情，UI 明示 |

- **§2 字段常量（决议 #110，与 §6.8 同源集中在 shared/types/research.ts）**：
  MAX_CANDIDATE_TITLE_CHARS/MAX_CANDIDATE_NOTE_CHARS = 200、
  MAX_CLAIM_TEXT_CHARS = 500、MAX_CONFLICT_TOPIC_CHARS = 200、
  MAX_CONFLICT_POSITION_CHARS = 300、MAX_RESULT_TITLE_CHARS = 120、
  MAX_RESULT_SUMMARY_CHARS = 2000、MAX_MARKDOWN_BLOCK_CHARS = 4000、
  MAX_TABLE_CELL_CHARS = 200、MAX_CARDS_TITLE_CHARS = 120、
  MAX_CARDS_BODY_CHARS = 1000、MAX_RANKING_TITLE_CHARS = 120、
  MAX_RANKING_DETAIL_CHARS = 1000、MAX_UNCERTAIN_TEXT_CHARS = 1000、
  MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS = 200。
- 预算用尽语义：来源/证据/轮次/步数/超时/持久化预算用尽 → **正式终态**
  failed（research-budget-exhausted；超时用 research-timeout，决议 #108）
  - 已收集 Evidence 保留；不自动扩预算。
- 全部常量集中在 shared/types/research.ts（单一事实源）+ research-budget.ts
  裁剪纯函数（确定性截断 + 标记）；实现与测试禁止魔法数字（决议 #110）。

## 7. Cross-check 与综合（C6）

### 7.1 Claim 数据模型（§2 类型）

- severity='high' 的 claim **必须**多源（程序校验：引用的不同 canonicalKey
  来源数 ≥2，否则降级为 single-source 并在 singleSourceFields 显式标注——
  Fifth §5「哪些字段来自单一来源」；不自动补源、不虚构）。
- sourceTypes 判定（确定性程序，不采信模型自述）：
  - vendor：候选 trust.value='official' 且来源域名与主题厂商域匹配（任务
    级厂商域列表由规划阶段模型提议、程序按候选 trust 三元组与域名比对）
    ——厂商自述 vs 第三方区分（Fifth §3.5）；
  - third-party：trust ∈ {primary, secondary} 或非厂商域官方/权威候选；
  - community：trust='community' 或论坛/社区形态（tag 承载，第四阶段语义）；
  - 未命中判定 → third-party（保守默认）。
- coverage 由程序计算（不同 canonicalKey 数 ≥2 → multi-source），模型无权
  改写；「来源数量」仅用于覆盖计数展示，**不合成质量分数/百分比**（FT-07）。

### 7.2 冲突模型

- 模型提出冲突对（claimIds + positions + sourceRefs）→ 程序校验：positions
  ≥2、sourceRefs ∈ 本任务候选集、claimIds 存在；不自动裁决、不静默抹平
  （resolved 恒 'unresolved'；展示层「冲突」视图 + Fifth §7.3）。
- 冲突计数进 stats.conflictCount 与 Result.conflicts。

### 7.3 Uncertainty 输出

- 证据不足/来源矛盾无法收敛 → `uncertain` 块（正式输出类型：text + reason）；
  禁止模型在证据不足时编造确定结论；合成提示词明确该契约。

### 7.4 合成提示词（research-prompts.ts）

- `AGENT_RESEARCH_PLANNING_PROMPT` / `AGENT_RESEARCH_READING_PROMPT` /
  `AGENT_RESEARCH_SYNTHESIS_PROMPT` 编译期常量（与共读 SYSTEM_PROMPT /
  AGENT_SYSTEM_PROMPT 互不混用；恒等断言固化）；
- 候选元数据/capture 摘录/Evidence 全部经既有 `UNTRUSTED_WEB_CONTENT` /
  `UNTRUSTED_TOOL_RESULT` 同族块序列化（闭合转义 + 确定性截断 + 预算裁剪）；
  system 恒为编译期常量（FT-01/02 结构性防线）。

## 8. Result Schema 验证与 Renderer（C7）

### 8.1 ResultValidator（result-validator.ts 纯函数）

- 逐块校验：kind 白名单、结构形状（判别联合逐字段类型）、长度边界（§6.8）、
  table 行列界、ranking rank 连续、cards/ranking 条目界、sourceRefs ∈ 本
  任务候选集、uncertain 块字段非空；
- evidenceMap：键 ∈ 已验证 evidenceId 集合、值来自主进程元数据（模型提供
  的元数据被忽略/覆盖）；
- URL 校验：Result 内任何 URL 字段仅 http/https（与导航白名单同源判定）；
- 校验失败语义（§8.4）：整体拒绝（fail-closed）→ 回注结构化错误详情
  （块索引 + 原因 ≤200）→ 模型重提 ≤2 次 → 仍失败 → failed 终态。

### 8.2 Markdown 安全子集渲染器（决策 D9，零新依赖）

- 自实现纯函数解析器（renderer/src/research/markdown/）：支持
  `# 标题(1-3)` / 段落 / `*斜体*` `**粗体**` `` `行内代码` `` / 列表（有序/
  无序） / `> 引用` / 围栏代码块 / `[文本](url)`（仅 http/https 渲染为链接，
  其余降级纯文本）/ 简单表格扩展（Result 的表格走 Table 块不靠 Markdown 表格，
  故 Markdown 表格不实现——Table 块为硬通道）。
- 安全不变量：**raw HTML 关闭**（任何 `<tag` 形态按纯文本渲染，不解析不执行）；
  URL 仅 http/https；所有模型文本经 React 纯文本节点渲染（零
  dangerouslySetInnerHTML 拼模型文本）；控制字符/bidi 剔除（复用
  sanitizeConfirmText 同族纯函数）；转义与 UNTRUSTED 块同族纪律。
- 解析失败/超预算 → 安全降级纯文本（不丢内容、不加特权）。

### 8.3 Table/Cards/Ranking 块渲染

- Table：columns/rows 白名单字段渲染；来源详情列（sourceRefs → 来源下钻）；
  排序/筛选/复制为 C8 交互层（渲染器只负责纯展示 + 数据映射纯函数）。
- Cards/Ranking：条目纯文本渲染 + sourceRefs 下钻；rank 由程序展示（模型
  提供 rank 已经 Validator 连续性校验）。
- Evidence 下钻：evidenceId → evidenceMap 元数据 + Evidence 全量（URL/
  时间/摘录/验证态）——点击结论看来源（Fifth §3.4/§7.6）。

### 8.4 结构化输出失败语义

| 失败                                      | 语义                                       |
| ----------------------------------------- | ------------------------------------------ |
| 结构非法（判别联合不匹配/未知 kind/超长） | 整体拒绝 + 块索引回注；重提 ≤2 次 → failed |
| evidenceId 不存在/不属于本任务            | 该引用拒绝 + 回注（FT-03/15）              |
| 表格越界（行列/单元格长度）               | 整体拒绝 + 边界值回注                      |
| URL 非 http/https                         | 整体拒绝 + 原因回注                        |
| 模型输出任意 HTML/CSS/JS                  | Validator 白名单外形态一律拒绝（FT-11/12） |

## 9. 存储、migration 与字节预算（C1）

### 9.1 数据库与 schema（research.db，migration v1）

```sql
PRAGMA user_version;  -- 1 = 本表集（决议 #101/#102 校准后定稿）

CREATE TABLE research_tasks (
  id TEXT PRIMARY KEY,                -- UUID
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','running','completed','failed','cancelled','interrupted')),
  phase TEXT CHECK (phase IN ('planning','reading','verifying','synthesizing') OR phase IS NULL),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, interrupted_at TEXT,
  error_code TEXT, result_id TEXT,
  stats_json TEXT NOT NULL            -- ResearchTaskStats JSON（形状校验 fail-closed）
);
CREATE INDEX idx_research_tasks_status ON research_tasks(status);

-- 决议 #101：Fifth_stage.md §3.1 上位需求（记录已用 Sources/搜索候选/成功失败
-- 读取）——独立表承载（受控 JSON 投影否决：与 §2 实体类型/id 引用/§5.2 验证
-- 锚点/CASCADE 清理不一致）；capture 正文零落盘（仅元数据行）。
CREATE TABLE research_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL, display_url TEXT NOT NULL, title TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('origin','page')),
  discovered_via_json TEXT NOT NULL,  -- CandidateOrigin[] JSON（形状校验）
  source_id TEXT,                     -- Sources 命中才有
  trust_value TEXT, trust_asserted_by TEXT, trust_verification TEXT,  -- 三元组或全 NULL
  priority INTEGER, last_used_at TEXT, note TEXT,
  sort_key TEXT NOT NULL
);
CREATE INDEX idx_research_candidates_task ON research_candidates(task_id);

CREATE TABLE research_captures (
  capture_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  tab_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  access_time TEXT NOT NULL, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,         -- CaptureSummary JSON（形状校验）
  failed INTEGER NOT NULL CHECK (failed IN (0,1)),
  failure_reason TEXT CHECK (failure_reason IN ('page-load-failed','snapshot-degraded','tab-closed-by-user','timeout','aborted','http-scheme-rejected') OR failure_reason IS NULL)
);
CREATE INDEX idx_research_captures_task ON research_captures(task_id);

CREATE TABLE research_evidence (
  evidence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL, source_id TEXT,
  capture_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  access_time TEXT NOT NULL, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('quote','table-cell','field','summary-point')),
  locator_json TEXT NOT NULL,         -- EvidenceLocator JSON（形状校验）
  excerpt TEXT NOT NULL, value TEXT,
  verification TEXT NOT NULL CHECK (verification = 'verified')  -- 决议 #102：rejected 永不落库（数据库层兜底）
);
CREATE INDEX idx_research_evidence_task ON research_evidence(task_id);

CREATE TABLE research_claims (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL, severity TEXT NOT NULL, coverage TEXT NOT NULL,
  source_types_json TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
  single_source_fields_json TEXT NOT NULL, conflict_ids_json TEXT NOT NULL
);

CREATE TABLE research_conflicts (
  conflict_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, positions_json TEXT NOT NULL, claim_ids_json TEXT NOT NULL,
  resolved TEXT NOT NULL CHECK (resolved IN ('explicit','unresolved'))
);

CREATE TABLE research_results (
  result_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES research_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, summary TEXT NOT NULL, blocks_json TEXT NOT NULL,
  evidence_map_json TEXT NOT NULL, conflicts_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
```

- 业务 SQL 仅为 ResearchRepository 编译期常量 + 参数绑定（决议 #47 模式）；
  JSON 列逐字段形状校验（复用 validateMessageShape 同族纯函数，畸形
  fail-closed 丢弃/拒绝）。
- **字节预算执行（决议 #103/#113）**：任务写库前序列化合计（UTF-8 字节数）
  ≤ MAX_TASK_PERSISTED_CHARS，超限 → 事务内拒绝写入（RepositoryError
  'task-persisted-budget-exceeded' → research-budget-exhausted）——由
  C4/C6/C7 层裁剪摘录/Result 块后重试，仍失败 → failed；
  子行插入（candidates/captures/evidence/claims/conflicts/result）按
  「当前已持久化字节 + 新增行字节」检查；**任务行更新（setTaskRunning/
  setTaskCompleted/setTaskFailed/setTaskCancelled/setTaskInterrupted/
  updateTaskPhase/markAllRunningInterrupted）按「更新后的任务投影」检查**
  （决议 #113：子行字节 + 更新后任务行字节——替换写不得误算为完整新增；
  任何成功写入后的任务持久化投影不得超过上限；检查与写入处于调用方已有
  事务内；markAllRunningInterrupted 任一受影响任务投影超限 → 整体拒绝
  零写入）；MAX_STORED_TASKS 超限清理最旧终态任务（决议 #104：触发/排序键/
  拒绝语义见 §6.8；created 永不清除；CASCADE 清行）。
- **接口契约（决议 #109，§13.1 测试规格的契约源）**：
  - `ResearchRepository`（research.db 唯一 SQL 执行点，编译期常量 +
    参数绑定）：任务 CRUD（insertTask/getTaskById/getRunningTask/
    listTasks/countTasks/setTaskRunning/setTaskCompleted/setTaskFailed/
    setTaskCancelled/setTaskInterrupted/updateTaskPhase/deleteTask/
    clearTaskRunData/listOldestFinishedTasks/deleteTasksByIds/
    countFinishedTasks）+ 行集合 CRUD（candidates/captures/evidence
    （仅 VerifiedEvidence 窄类型，决议 #102）/claims/conflicts/results：
    insert/listByTask/countByTask/getResultByTaskId/deleteXByTask）+
    字节预算（computeTaskPersistedBytes + 写入前置事务内检查）+ 行↔域
    转换与 JSON 形状校验纯函数（畸形 fail-closed null，不抛穿）。
  - `ResearchStore`：`openResearchStore({dbPath, migrations?, nowMs?}) →
{ mode:'normal', service, reason:null } | { mode:'unavailable',
service:null, reason }`——probe（16 字节头部/只读 user_version）→
    新库迁移 v1 → 当前版本 quick_check → 旧版本迁移 → integrity/外键
    检查 → normal；损坏/坏 magic/未来版本/迁移失败/检查失败 →
    unavailable（中文诊断；research:* 全拒）；装配成功时**单事务**原子
    标记遗留 running → interrupted（interruptedAt=now、phase=null）+
    清理超限终态。
  - `ResearchService`（接口在 shared/types/research.ts）：构造注入
    `{ db: DbHandle | null, now?, getSourcesState?, getProviderState? }`
    （缺省就绪，C5 接线真实查询）；createTask(goal)/getTask(id)/
    listTasks(opts)/deleteTask(id)/startTask(id)/stopTask(id)/dispose()
    （幂等关闭句柄）；返回判别联合 `{ok:true,...} | {ok:false,errorCode}`
    （ResearchCreateResult/ResearchTaskResult/ResearchListResult/
    ResearchDeleteResult/ResearchStartResult/ResearchStopResult）；非法
    输入安全返回结构化错误不抛异常；未预期异常 → 归一化
    research-internal + warn 日志；db=null 装配（disposed）→ 全部方法
    结构化 research-unavailable（与 Sources B7 模式一致）。

### 9.2 启动装配（research-store.ts，复用 sources-store 模式）

```
app ready → probe（只读连接，固定 16 字节头部探测——决议 #111：复用
  sources/db/backup.ts 只读探测原语 probeDbFile/quickCheckDb/
  checkDbIntegrity，零修改）→ 缺失 → 新建 + 迁移 v1
→ 旧版本 → 单事务逐级迁移（v1 起无历史版本——模式就绪）→ 检查 → normal
→ 损坏/未来版本/迁移失败/检查失败 → unavailable（两态，无恢复态——
  Research 功能全拒 + 中文诊断；浏览器/Sources/Agent 其余能力不受影响）
→ 遗留 running 任务标 interrupted（§3.1，单事务原子）+ 清理超限终态
  （决议 #112：清理后仍超限——总数 >30 且无可清理终态（created 永不清除）
  → 单事务回滚（含 interrupted 标记）+ unavailable（溢出不得静默忽略；
  不删除 created 任务；不引入第三种模式））
```

- v1 不做备份模块（research.db 无历史迁移需求；若未来 schema 演进引入
  migration v2 时，在同一闭环补 VACUUM INTO 备份——复用 B7 冻结模式；
  本阶段任务文档不承诺）。
- 模式复用边界（决议 #111）：research-driver.ts import 复用
  `sources/db/sqlite-driver.ts` 连接级原语（openDb/closeDb/
  withTransaction/DbHandle——零修改）并提供 openResearchDb(path,
  options?) 薄封装（独立库独立句柄语义）；Research 与 Sources 独立
  数据库、独立句柄、独立迁移列表（research-migrations.ts MIGRATIONS）。

### 9.3 本地明文边界

- research.db v1 明文保存 goal/evidence/claims/result（依赖 OS 用户权限；
  README/UI 如实说明）；capture 正文**零落盘**；API Key 绝不进 research.db
  （红线 grep）。

## 10. 任务/Tab 所有权（C2，research-workspace.ts）

- **精确 tabId 所有权**（决议 #32 模式 + 决议 #118 契约）：Workspace 记录
  本任务创建的 tabId 集合（createTab 返回值，绝不按位置/标题/URL/活动
  Tab 推断）；并发 ≤ MAX_RESEARCH_TABS(3)（owned 与 in-flight createTab
  预留槽共同计数，同步段检查）；同任务 v1 串行读取（实际同时 ≤1 个页面
  读取，上限为纵深防御）。
- **用户 Tab 永不关闭**：清理只对「本任务创建的确切 tabId」执行
  （closeTab 已关闭安全无操作、不关替代 Tab）；用户手动关闭 task Tab →
  `checkTab` 显式 getTabs 快照感知（C2 零事件/计时器/监听器）→ 当前读取
  失败（tab-closed-by-user）→ 继续下一候选。
- **取消/异常清理**：stop/终态/finally 最佳努力清理本任务全部 Tab
  （cleanupAll 置 closing 屏障 + 等待 in-flight create 落定后精确关闭）；
  恢复语义沿用：不抢用户焦点、不重建不激活。
- **串任务防护**：taskId 绑定 captureId/evidenceId（§5.2 归属校验）；
  跨任务 tabId 引用在 Workspace 层拒绝（FT-09）。

### 10.1 精确接口（决议 #118 定稿；C2 唯一实现契约）

```ts
// src/main/research/research-workspace.ts（零 Electron import）
export type WorkspaceErrorCode =
  | 'invalid-task-id'
  | 'invalid-url'
  | 'workspace-busy'
  | 'tab-limit'
  | 'not-owned'
  | 'tab-closed-by-user'
  | 'tab-create-aborted'
  | 'tab-create-failed'
  | 'tab-restore-focus-failed'
  | 'cleanup-failed'
  | 'workspace-internal'; // 局部闭合联合，不扩张 C1 ResearchErrorCode

export interface WorkspaceLease {
  taskId: string;
  tabId: string; // 本次 createTab 返回的精确 id
  url: string; // normalizeSourceUrl(url,'page') 的 displayUrl（规范展示 URL）
}

export interface ResearchWorkspaceBrowser {
  // BrowserController 最小结构端口（BrowserControllerImpl 结构兼容，typecheck 保证）
  createTab(url: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
}

export type AcquireResult =
  | { ok: true; lease: WorkspaceLease; warnings?: string[] }
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

export type ReleaseResult =
  | { ok: true; closed: boolean; warnings?: string[] } // closed=false=已被用户关闭零动作
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

export type CleanupAllResult =
  | { ok: true; closedCount: number; skippedCount: number; warnings?: string[] }
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string; closedCount: number };

export type CheckTabResult =
  | { ok: true; status: 'alive'; lease: WorkspaceLease }
  | { ok: true; status: 'closed-by-user'; warnings?: string[] } // 已从所有权集合移除
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

export class ResearchWorkspace {
  constructor(taskId: string, browser: ResearchWorkspaceBrowser);
  readonly taskId: string;
  // 同步归属检查（跨任务 Lease/伪造 tabId/非本实例 owned → false，零关闭动作）
  isOwned(tabId: string): boolean;
  getOwnedTabIds(): readonly string[];
  // 创建 task Tab：URL 校验 → 同步段并发槽检查 → createTab → 所有权验证
  // （id 非空且不在 tabsBefore，优先于取消分类——决议 #119(1)）→
  // provisional 登记精确 id（决议 #119(2)）→ abort 检查 → 创建后 getTabs
  // → 焦点恢复。signal 在 create 前终止 → 零创建；create 期间终止 →
  // 清理成功返回 aborted；任何路径清理失败 → cleanup-failed 且所有权保留
  // （cleanupAll 可精确重试——决议 #119(3)/(4)）。
  acquire(url: string, signal: AbortSignal): Promise<AcquireResult>;
  // 显式快照感知：C4 在读取前后调用；owned tab 消失 → 移除所有权集合
  checkTab(tabId: string): Promise<CheckTabResult>;
  release(tabId: string): Promise<ReleaseResult>;
  cleanupAll(): Promise<CleanupAllResult>; // 置 closing + drain 屏障 + 逐个精确关闭
}
```

## 11. IPC / bridge 白名单（C8）

- 新增 invoke 通道（复用 handle() sender+主帧校验、逐参数验证、事件只发
  主窗口）：
  `research:create {goal}` / `research:start {taskId}` / `research:stop {taskId}` /
  `research:get {taskId}` / `research:result {taskId}` /
  `research:list {page, pageSize≤20}` / `research:delete {taskId}`（仅终态
  任务；running 拒绝）/ `research:export-csv {taskId, tableBlockIndex}`
  （主进程 dialog.showSaveDialog 用户选定路径 → 主进程校验扩展名 .csv/
  路径位于用户选择 → 写入；renderer 不得提供路径）。
- 事件通道：`research:progress`（§6.5 节流推送）/ `research:task-done`
  {taskId, status}。
- preload bridge 白名单：`research.{create/start/stop/get/result/list/delete/
exportCsv/onProgress/onTaskDone}`（eventRelay 模式，单次注册 + 退订）。
- 审计：create/start/stop/delete/export 各恰好一条脱敏条目（goal 长度/
  taskId/统计/导出块索引；URL/摘录/结果正文零出现——FT-16）。

## 12. 边界情况（统一处理表）

| 情况                    | 处理                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 空/超长 goal            | 校验拒绝/确定性截断（≤2000 + warn）                          |
| 取消（stop）            | 幂等；abort 流 + 作废 pending + 只关本任务 Tab + cancelled   |
| 超时                    | failed + 理由 timeout + Evidence 保留（§6.6）                |
| 用户关 Tab              | 当前读取 failed（tab-closed-by-user）+ 继续（§10）           |
| 页面变化（捕获后）      | 已验证 Evidence 不失效（accessTime/documentId 记录捕获时刻） |
| 读取失败                | failed capture + failedReadCount + 重试 1 次 + 继续          |
| Provider 失败           | 单轮重试 1 次；连续 2 轮 → failed；归一化错误码复用          |
| 重复来源                | normalizeSourceUrl 身份键合并（discoveredVia 双路径）        |
| 冲突                    | Conflict 数据模型 + 不自动裁决（§7.2）                       |
| 预算用尽                | 正式终态 failed + Evidence 保留（§6.8）                      |
| 进程退出                | interrupted 标记（不自动续跑）                               |
| 迟到事件/取消后写入     | 终态单一所有权守卫 + 忽略（§3.1/§6.3）                       |
| Research 库 unavailable | 全部 research:* 拒绝 + 中文诊断；其余子系统正常              |

## 13. 测试规格（红→绿纪律）

### 13.1 单测（Vitest，node 环境，纯逻辑）

| 测试文件                    | 用例要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 任务 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| research-task-state.test.ts | 状态迁移全表（§3.1 每行）/非法事件安全返回/终态不可变/start 前置矩阵                                                                                                                                                                                                                                                                                                                                                                                                         | C1   |
| research-budget.test.ts     | 全部常量边界（§6.8 表每项 ±1）/裁剪确定性/超限标记                                                                                                                                                                                                                                                                                                                                                                                                                           | C1   |
| research-repository.test.ts | 真实 node:sqlite：CRUD/编译期 SQL + 注入串仅作数据/CASCADE/JSON 形状校验 fail-closed/字节预算拒绝/任务数清理                                                                                                                                                                                                                                                                                                                                                                 | C1   |
| research-store.test.ts      | 装配矩阵：新库迁移 v1/坏 magic 保留/未来版本零写入/unavailable 全拒/遗留 running 标 interrupted/其余子系统不受影响（注：完整恢复态矩阵随 C1 定稿；backup 非 v1 承诺）                                                                                                                                                                                                                                                                                                        | C1   |
| research-workspace.test.ts  | 注入 Fake BrowserController 替身（完全离线、可控 Promise）：精确 tabId 归属/只关本任务 Tab/用户 Tab 零关闭/已关闭安全无操作/并发上限（第 4 次 create 前拒绝 + deferred create 竞态）/abort 前与 create 期间/焦点恢复三态（未切换→恢复、已切换→零 activate、activeBefore 已关→不重建）/closeTab false 与抛错/cleanupAll 多 Tab·部分失败·重复·drain 屏障零泄漏/cleanup 后 acquire 拒绝/用户关 Tab → checkTab tab-closed-by-user/零 Electron import/常量单一事实源（决议 #118） | C2   |
| source-selector.test.ts     | 合并矩阵（同 URL 双路径/不同 scope 不合并/键空间独立）/provenance 继承（search 无 trust）/排序全序（档位不可跨档/priority 不反转/null 末位/确定性）                                                                                                                                                                                                                                                                                                                          | C3   |
| capture-service.test.ts     | 读取失败矩阵/重试语义/L0–L3 阶梯/正文不持久化（存储探针零命中）/contentHash 确定性/表格坐标与字段路径提取                                                                                                                                                                                                                                                                                                                                                                    | C4   |
| evidence-validator.test.ts  | 敌手矩阵：伪造（excerpt 不在捕获内容）/错绑（captureId 跨任务）/坐标越界/超长 excerpt/规范化匹配（空白折叠/NFC）/rejected 原因回注                                                                                                                                                                                                                                                                                                                                           | C4   |
| claim-model.test.ts         | coverage 计算/severity=high 多源强制/sourceTypes 判定矩阵/冲突结构校验（positions ≥2/refs ∈ 候选集）/uncertainty 块                                                                                                                                                                                                                                                                                                                                                          | C6   |
| research-prompts.test.ts    | 合成提示词恒等断言（编译期常量）/UNTRUSTED 块闭合转义/预算裁剪/与共读・Agent system prompt 互不混用                                                                                                                                                                                                                                                                                                                                                                          | C6   |
| research-runtime.test.ts    | 阶段循环全路径（FakeProvider 脚本注入）/终态单一所有权/stop 幂等/超时/预算用尽终态/失败继续/迟到事件忽略/心跳落库                                                                                                                                                                                                                                                                                                                                                            | C5   |
| result-validator.test.ts    | 判别联合逐块校验矩阵/长度边界/表格行列界/ranking rank 连续/evidenceId 存在与归属/sourceRefs ∈ 候选集/URL 白名单/未知 kind 拒绝/失败语义回注                                                                                                                                                                                                                                                                                                                                  | C7   |
| markdown-parse.test.ts      | 子集解析矩阵/raw HTML 关闭（`<script>`/`<img onerror>` 形态纯文本）/URL 白名单（javascript:/data: 拒绝）/转义与 bidi 剔除/超预算安全降级                                                                                                                                                                                                                                                                                                                                     | C7   |
| csv-serializer.test.ts      | 公式注入（=,+,-,@ 前缀 `'` 转义）/CRLF 与引号转义/UTF-8 BOM/空表与超长单元格截断                                                                                                                                                                                                                                                                                                                                                                                             | C8   |
| research-ipc.test.ts        | 载荷白名单矩阵（未知字段/超长/非法 id）/状态门控（running 不可 delete）/export 通道无 renderer 路径参数/审计恰好一条脱敏                                                                                                                                                                                                                                                                                                                                                     | C8   |

### 13.2 冒烟矩阵（Electron 真实启动，临时 userData；dev+生产双场景）

| #    | 场景                  | 断言要点                                                                                                                                                                                                                                                      | 任务  |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 8.16 | capture/evidence 场景 | 受控页夹具（多节/表格/字段）：真实 BrowserController 快照 → 提取 → capture 记录（documentId/哈希/accessTime 主进程盖章）；FakeProvider 提出正确引用 → verified；伪造/错绑/越界 → rejected；读取失败页 → failedReadCount 继续；正文零落盘（userData 字节扫描） | C4    |
| 8.17 | Runtime 场景          | FakeProvider 多轮脚本驱动全阶段（planning→reading→verifying→synthesizing）→ completed + Result 落库；stop 中途 → cancelled + 本任务 Tab 清理 + 用户 Tab 保留；预算注入用尽 → failed + Evidence 保留；迟到事件零生效                                           | C5    |
| 8.18 | 综合场景              | 两冲突夹具来源 + 冲突页：claims 装配/冲突显式保留/uncertainty 块产出/Result 含 coverage 计数（无百分比字段断言）                                                                                                                                              | C6    |
| 8.19 | UI DOM 场景           | 真实 DOM：侧栏创建/启动/进度渐进/停止；结果画布 Table 排序/筛选/复制/Cards/Ranking 渲染/Evidence 下钻（点击结论看来源）；敌对 Markdown 文本纯文本渲染零 DOM 注入                                                                                              | C7/C8 |
| 8.20 | 红队 FRT-01～FRT-12   | threat-model §4 矩阵全表（dev+生产双场景，每项独立断言）                                                                                                                                                                                                      | C9    |

- 双进程持久化：`AIBROWSE_RESEARCH_SMOKE=set|check`（与既有门控互斥；
  set 完成任务并退出 → check 新进程读回 task/evidence/result + interrupted
  标记路径）——C5 起启用。
- 真实 Provider 验收（C9；决议 #117 长期授权，无需逐次申请，凭据可用
  即执行）：`AIBROWSE_LIVE_RESEARCH=1` 门控 + harness 开关（与既有 LIVE
  门控互斥）；真实主题多源任务（Fifth §7 场景映射）+ 真实敌对页观察场景
  （FRT 观察性子集）+ 真 Key 零暴露扫描 + 调用台账（沿用第三/四阶段纪律；
  凭据不可用如实记录「凭据不可用」，不得写「未获授权」）。

## 14. 验收核对清单（Fifth_stage.md §9 → 本阶段落点，C10 实施）

| 组          | 条目                             | 落点                                                    |
| ----------- | -------------------------------- | ------------------------------------------------------- |
| Research    | 可组合 Sources + Web Search      | C3/C4/C9（候选合并端到端）                              |
| Research    | 可读取多个来源                   | C4（capture 矩阵 + 8.16）                               |
| Research    | 可处理来源失败                   | C4/C5（失败继续 + failedReadCount）                     |
| Research    | 可显示进度和停止                 | C5/C8（progress 事件 + UI）                             |
| Evidence    | 重要结论可追踪来源               | C1/C4/C6（Evidence 模型 + 下钻）                        |
| Evidence    | 冲突不静默抹平                   | C6（Conflict 模型 + 视图）                              |
| Evidence    | 可查看 URL/时间/证据             | C7/C8（下钻视图）                                       |
| Rendering   | Markdown/Table/Cards             | C7/C8（8.19 UI 断言）                                   |
| Rendering   | 结构化 schema 渲染               | C7（ResultValidator → Renderer 单一通道）               |
| Rendering   | 不执行任意 HTML/JS               | C7/C9（FRT-06/07 + grep 断言）                          |
| UX          | Chat 与 Research 区分清楚        | C8（模式互斥 UI + 8.19）                                |
| UX          | Research Tabs 不严重干扰用户浏览 | C2/C8（所有权 + 恢复语义）                              |
| Engineering | 全量测试/构建/冒烟               | 每个任务闭环（AGENTS.md 附 A 矩阵）                     |
| Engineering | 真实多源任务验收                 | C9（真实 Provider，决议 #117 长期授权；凭据可用即执行） |

## 15. 决议记录（2026-08-16）

> 编号承接第四阶段决议 #93 之后（#94 起）。本设计闭环的决策表见
> proposal §10（D1–D13）；以下为本文件内落地的细化决议。

94. **Research 不走 ToolRegistry**：Research 的读取/打开/搜索复用既有服务
    （BrowserController/SearchProvider/SourceService）直调，权限语义沿用
    对应工具契约（read L0/open L1/search L0/检索 L0）；不新增任何注册工具
    ——工具注册表保持 17（8.1 冒烟断言零回归）。ResearchRuntime 的工具步
    计数为 Runtime 内部审计口径（read/open/search 调用计数），与
    ToolExecutor 审计不重叠不冲突。
95. **Research v1 无 L2 确认工具**：候选打开为只读浏览（browser_open 的
    L1 展示语义沿用）；不存在「批量写入/发布」类确认需求；若模型尝试
    click/fill 等交互工具 → 不在 Research 能力集内（ResearchRuntime 的
    模型请求 tools 仅含只读浏览/检索能力——工具白名单为 Research 专属
    编译期子集，见 §16）。
96. **Research 模型工具子集**：Research 轮次请求的 tools 仅为注册表中
    browser_open/browser_read/search_web/source_search/source_list/
    source_get 六个只读/L1 能力（编译期常量子集）；不提供
    browser_navigate/back/forward/reload/get_tabs/get_active_tab/find/
    scroll/click/fill/source_apply_changes——Research 打开/读取经
    Runtime 编排直调（决议 #94），模型经工具子集触发的读取同样经
    CaptureService 记账（防绕过 capture 验证）。工具请求仍满足 wire 契约
    （TOOL_NAME_PATTERN，决议 #35 双闸门零改动）。
97. **interrupted 不自动续跑**：跨重启 resume 需要重建 Tab/浏览器态/
    transcript 与捕获内容（正文不持久化故不可重建）——v1 标 interrupted +
    重新开始（决策 D3）；「resume」作为 Seventh Stage 后评估项登记（如
    未来实现，需先解决捕获内容重建或改持久化策略，届时重新走设计链）。
98. **Research 排序不虚构可信度**：候选排序键为「来源档位 + 确定性键」
    （§4.2），与「可信度」无关；Result coverage 为计数类事实（§2 类型）；
    任何百分比/分数型「可信度」字段不进 Result Schema（Fifth §5 红线）。
99. **Markdown 表格不实现**：Result 的表格数据走 Table 块（结构化硬通道，
    可排序/筛选/导出）；Markdown 子集不含表格语法（解析为纯文本段落），
    避免双通道不一致（§8.2）。
100.  **CSV 仅导出 Table 块**：export-csv 绑定具体 tableBlockIndex；不导出
      Evidence 摘录正文/claims/冲突（最小导出面）；主进程 dialog 安全通道 +
      路径校验（扩展名 .csv、位于用户选定路径）；renderer 零路径参数
      （§11）。

> 以下 #101–#111 为 C1 实施前契约裁决（2026-08-16，C1 闭环；先改本文与
> 测试、再改实现——§15 流程）。七项契约缺口均由 Fifth_stage.md 上位需求、
> threat-model 安全契约与本文既有条款唯一裁决，无需用户拍板。

101.  **schema v1 补全候选与捕获表**：Fifth_stage.md §3.1 上位需求（记录
      已用 Sources、搜索候选、成功/失败读取）由 `research_candidates` /
      `research_captures` 两张独立表承载（受控 JSON 投影否决——与 §2 实体
      类型/id 引用/§5.2 验证锚点/CASCADE 清理语义不一致）；capture 正文
      仍零落盘（仅元数据行：url/title/accessTime/documentId/contentHash/
      summary/failed/failureReason）；行数有界由 MAX_SOURCE_CANDIDATES/
      MAX_CAPTURES_PER_TASK 强制（C3/C4）。
102.  **rejected Evidence 三重一致**：`Evidence.verification` 判别联合保留
      （'rejected' 为运行期回注事实）；Repository 写入 API 仅接受
      verification='verified' 的窄类型（`VerifiedEvidence = Evidence & {
verification:'verified' }`）；schema CHECK 收窄为
      `verification = 'verified'`（数据库层兜底）——rejected 不进 Evidence
      集合、不进 research.db（FT-11/§5.2），类型/API/CHECK/测试一致。
103.  **持久化预算 = UTF-8 字节**：MAX_TASK_PERSISTED_CHARS（500000）=
      UTF-8 字节数（Buffer.byteLength——实际持久化大小有界，P2-3 目标）；
      其余 CHARS 常量 = JavaScript 字符数（String.length）。预算覆盖任务
      全部持久化行（task+candidates+captures+evidence+claims+conflicts+
      result）；写库前事务内检查，超限拒绝写入（RepositoryError
      'task-persisted-budget-exceeded' → research-budget-exhausted）。
104.  **MAX_STORED_TASKS 总数硬上限**：30 = 任务总数上限（created 计入
      总数、永不清除——「created 除外」仅指清理对象除外；无界增长封闭）。
      触发 = 任务进终态写入后 + 启动装配 interrupted 标记后 + create
      总数检查；最旧排序键 = COALESCE(finished_at, interrupted_at) DESC,
      created_at DESC, id ASC（全序）；清理对象仅 completed/failed/
      cancelled/interrupted（CASCADE）；总数满且无可清理终态 → 新建拒绝
      research-task-limit（新增码）。
105.  **状态机矩阵定稿**：start 合法状态 = created/cancelled/failed/
      interrupted（completed 不可 start——Result 已持久化，重新研究 = 新建
      任务）；delete 合法状态 = created/completed/failed/cancelled/
      interrupted（running 拒绝 research-invalid-state）；终态集合 =
      completed/failed/cancelled/interrupted（对 finish/stop/phase/
      mark-interrupted 不可变，start 为唯一例外）；transitionTask 纯函数
      全部事件统一携带 now（ISO 8601，调用方时钟注入——确定性；§3.2
      事件类型补齐 now 字段）。
106.  **restart 原子清理**：start 在 cancelled/failed/interrupted 任务上
      触发时，Service 层在**单事务内**删除本任务全部旧 run 行（candidates/
      captures/evidence/claims/conflicts/result）并重置 stats 全零/
      resultId=null/errorCode=null/finishedAt=null/interruptedAt=null/
      phase='planning'/startedAt=now/updatedAt=now——「标记废弃」以删除
      实现（v1 无历史 run 保留），防跨 run 混用（FT-09/15）；created
      首次 start 无旧数据仅状态迁移。
107.  **goal 语义统一**：createTask 输入非字符串/trim 后空串 → 拒绝
      research-invalid-goal（错误码注释校准为「goal 空/非串」）；超长 >
      MAX_GOAL_CHARS → 确定性截断至 2000 + warn 日志（§2 字段注释
      「确定性截断 + warn」优先于 §12 二选一表述）；start 前置校验
      goal 非空（create 时已截断）+ 单 running 互斥（research-busy）+
      Sources 库 normal（research-sources-unavailable）+ Provider 已配置
      且 supportsToolCalling（research-provider-unavailable）——C1 以
      可注入状态查询实现（缺省就绪；C5 接线真实查询）；前置失败不改变
      任务状态。
108.  **总超时独立错误码**：超时 → failed + errorCode='research-timeout'
      （新增码；不以 research-internal 含混代替无法展示的原因；§6.6
      校准）；ResearchErrorCode 共 11 码（增 research-timeout /
      research-task-limit）；错误码中文文案表在 research-errors.ts
      单一事实源。
109.  **接口契约补齐**：ResearchRepository/ResearchStore/ResearchService
      精确签名与返回判别联合见 §9.1 校准段落（错误映射/dispose 幂等/
      unavailable 全拒语义）；service dispose 幂等关闭 db 句柄（driver
      closeDb 幂等）；store unavailable 返回 service=null（research:*
      全拒）；Service 构造支持 db=null（disposed 门控全拒
      research-unavailable——与 Sources B7 模式一致）。
110.  **常量单一事实源**：§2 字段注释全部数值上限进入 shared/types/
      research.ts 常量（MAX_CANDIDATE_TITLE_CHARS/MAX_CANDIDATE_NOTE_
      CHARS/MAX_CLAIM_TEXT_CHARS/MAX_CONFLICT_TOPIC_CHARS/MAX_CONFLICT_
      POSITION_CHARS/MAX_RESULT_TITLE_CHARS/MAX_RESULT_SUMMARY_CHARS/
      MAX_MARKDOWN_BLOCK_CHARS/MAX_TABLE_CELL_CHARS/MAX_CARDS_TITLE_
      CHARS/MAX_CARDS_BODY_CHARS/MAX_RANKING_TITLE_CHARS/MAX_RANKING_
      DETAIL_CHARS/MAX_UNCERTAIN_TEXT_CHARS/MAX_EVIDENCE_LOCATOR_FIELD_
      PATH_CHARS——值见 §6.8 校准段落）；实现与测试禁止魔法数字。
111.  **模式复用边界**：research-driver.ts import 复用
      `sources/db/sqlite-driver.ts` 连接级原语（openDb/closeDb/
      withTransaction/DbHandle 等，零修改）并提供 openResearchDb 薄封装；
      research-store 复用 `sources/db/backup.ts` 只读探测原语
      （probeDbFile/quickCheckDb/checkDbIntegrity，零修改）；research
      v1 无 backup/恢复态（损坏/未来版本/迁移失败/检查失败 →
      unavailable 两态）；Research 与 Sources 独立数据库、独立句柄、
      独立迁移列表。

> 以下 #112–#116 为 C1 定向修复与契约边界复核决议（2026-08-16；先写红态
> 测试 → 改契约与测试 → 再改实现，§15 流程）。五个边界缺口均由
> C1 定向复核审计发现，裁决依据 #103/#104/#105 既有条款与 fail-closed
> 纪律唯一导出，无需用户拍板。

112.  **启动装配总数硬上限缺口**：§9.2 装配的「清理超限终态」步骤在
      cleanupOldestFinishedOverflow 返回 overflowRemaining > 0 时不得
      静默忽略。裁决（依据 #104「总数硬上限」+ normal|unavailable 两态）：
      标记 interrupted 与清理超限终态同在单事务内，清理后仍超限（总数 >30
      且无可清理终态——created 永不清除）→ **事务回滚（含 interrupted
      标记）+ unavailable**（= §9.2「检查失败 → unavailable」语义：装配
      后置条件「总数 ≤30」无法恢复即装配失败；零业务写入、created 零删除、
      不引入第三种模式；中文诊断明示根因）。产品代码无法产生该形态
      （create 路径总数检查先行），仅外部/遗留库触发；可清理形态（含
      running 标记后转为终态）不受影响。
113.  **持久化预算未覆盖任务状态更新路径**：setTaskRunning/setTaskCompleted/
      setTaskFailed/setTaskCancelled/setTaskInterrupted/updateTaskPhase/
      markAllRunningInterrupted 全部按**更新后的任务投影**做字节预算检查
      （子行字节 + 更新后任务行字节 ≤ MAX_TASK_PERSISTED_CHARS——替换写
      不是新增行，不得把既有任务行重复计入造成假拒绝，也不得因无检查而
      突破上限）；检查与写入处于调用方已有事务内（超限整体回滚零残留）；
      任何成功写入后的任务持久化投影不得超过上限；超限 →
      RepositoryError('task-persisted-budget-exceeded') →
      research-budget-exhausted（映射 #109 不变）；markAllRunningInterrupted
      任一受影响任务投影超限 → 整体拒绝零写入（store 装配将其归一化
      unavailable）。畸形行读取路径跳过 → 不计入（与 #103 既有语义一致）。
      不得依赖 C4/C5 将来裁剪掩盖 Repository 硬边界缺口。
114.  **goal 截断标记计入上限**：truncateWithMark 截断标记必须计入
      maxChars——返回文本 JavaScript String.length 恒 ≤ maxChars（前缀 =
      maxChars − 标记长；标记放不下时仅按 maxChars 截断原文、绝不输出
      半截标记）；单位保持 JavaScript 字符数（#103 CHARS 单位不改为
      UTF-8 字节）；中文/多字节字符/边界/确定性均有单测。修正
      research-budget 与 ResearchService 中固化「maxChars + 标记长」
      的错误测试期望。
115.  **EvidenceLocator.table.header fail-open**：header 仅允许 string |
      null | 缺省（undefined → null）；object/array/number/boolean 等
      非法形态使**整个 locator 无效**（parseLocatorJson 返回 null——
      读取路径跳过该行、Repository 写入对应 Evidence 整体拒绝零落库），
      不得静默转换为 null。
116.  **now 的 ISO 8601 输入有效性约束**：决议 #105「全部事件携带 now
      （ISO 8601）」为**输入有效性约束**——transitionTask 以确定性纯函数
      `isIso8601Timestamp`（形状 + 可解析 + 日历回滚拒绝）校验 now，非法
      （任意非空垃圾/非法日期/无时区/非 ISO 形状）→ 事件零变化；合法 ISO
      时间（毫秒 Z/无毫秒 Z/偏移形态）→ 正常迁移。调用方责任边界：now 仅
      由受控调用方产生（ResearchService.nowIso / research-store 装配，
      恒 `new Date(ms).toISOString()`，单测断言精确输出）——注释声称 ISO
      而实现只查非空的漂移就此关闭。
      **实现说明（2026-08-16 二次补修补充，不改写以上结论）**：Z 与偏移
      形态均进行日历字段校验——偏移形态原仅做 Date.parse 值级往返（对已
      成功解析的时间近似恒真，无法甄别 JS 日期回滚：2026-02-30+08:00 →
      2026-03-01T16:00:00.000Z、2026-04-31-05:00 → 2026-05-01T17:00:00.000Z）；
      补修为确定性纯函数显式校验年月日时分秒（月份范围/闰年/各月最大天数/
      时≤23/分≤59/秒≤59）与既有偏移边界（±HH:MM 且 HH≤23、MM≤59——实测
      与 Date.parse 既有接受范围一致，不收缩不扩张）；校验不参与本地时区
      （纯字段范围判定）；Z 形态保留字符串级日历往返。24:00 与闰秒 60
      不属既有语法范围（拒绝）。

> 以下 #117 为真实 Provider 长期授权与保密规则（2026-08-16，用户明确要求
> 的长期规则变更，面向后续所有任务生效）。历史阶段当时「未授权/NOT RUN/
> 后来授权」的记录原位保留，不改写为当时已有长期授权。

117. **真实 Provider 长期授权与保密规则（2026-08-16 起长期生效）**：
     用户已于 2026-08-16 给出真实 Provider **长期授权**——后续 Agent 在
     后续任务中可按需使用真实 Provider，**无需逐次申请授权、不设固定调用
     次数**。同时生效的纪律（每条都是硬约束）：
     **调用目的**：每次真实调用必须服务于明确的开发、验收、定位或复验
     目的；禁止无界循环、无诊断依据的重复请求和无关测试；授权不等于
     强制调用——没有真实 Provider 产品链路的任务（如 C2）正常预期为
     0 次，不得为了「展示授权」发起无关调用。
     **凭据通道**：凭据只能通过既有仓库外本地说明文件、DPAPI 密文和
     受控 harness 注入；不得要求用户在聊天中粘贴 Key；Key/base URL/
     认证头不得进入命令行、源码、Git、日志、prompt、DOM、research.db、
     sources.db、会话文件、报告或工具输出；应用读取环境变量后立即移除；
     运行结束清理子进程、环境变量和临时目录。
     **报告纪律**：完成报告登记实际调用次数与每次用途，但不登记凭据或
     机器专属配置。
     **凭据缺失语义**：本地凭据缺失时记录「凭据不可用」，不得再写
     「未获授权」。
     **失败分类**：Provider 失败必须区分余额、权限、网络、服务端、模型
     兼容与产品缺陷，不得混为单一「Provider 错误」。
     **C9 契约调整**：实现基础设施后，如本地凭据和 Provider 可用，真实
     执行属于 C9 范围（不再等待授权）；凭据/服务不可用则如实记录「凭据
     不可用/NOT RUN」。**C10 契约调整**：不得再因「未授权」判 HOLD，只能
     因真实验证未完成、凭据/服务不可用或验证失败而如实 HOLD/PENDING。
     FakeProvider 仍不能冒充真实 Provider 证据（离线矩阵与真实验收分离，
     观察性结果如实登记）。

> 以下 #118 为 C2 实施前契约裁决（2026-08-16，C2 闭环；先改本文与测试、
> 再改实现——§15 流程）。§10 原只有行为描述没有精确接口；实测
> BrowserController.createTab 会自动激活新 Tab（browser-controller.ts:92
> `this.activeTabId = entry.info.id`），任务文档遗漏焦点恢复所需的
> activateTab。以下八项均由 Fifth_stage.md §9 UX「Research Tabs 不严重
> 干扰用户手动浏览」、threat-model FT-09/§3.6、§10 既有条款与决议 #32
> 模式唯一裁决，无需用户拍板。

118. **C2 ResearchWorkspace 契约裁决（2026-08-16，C2 闭环）**：
     （1）**Workspace 形态与接口**：一个 ResearchWorkspace 实例绑定唯一
     taskId（构造参数；非串/空串使实例进入 invalid 态，全部操作返回
     invalid-task-id，构造不抛异常）；浏览器能力以最小结构接口
     `ResearchWorkspaceBrowser` 构造注入（BrowserControllerImpl 结构兼容，
     typecheck 保证，不修改其产品契约）。错误码为 Workspace 局部闭合联合
     `WorkspaceErrorCode`（invalid-task-id/invalid-url/workspace-busy/
     tab-limit/not-owned/tab-closed-by-user/tab-create-aborted/
     tab-create-failed/tab-restore-focus-failed/cleanup-failed/
     workspace-internal 十一码），**不扩张 C1 ResearchErrorCode**
     （错误码映射归 C5 Runtime）。Lease 绑定 {taskId, tabId, url}
     （url = normalizeSourceUrl 的 displayUrl——规范化展示 URL）。
     （2）**BrowserController 最小端口**：ResearchWorkspaceBrowser 恰含
     createTab(url)/closeTab(tabId)/activateTab(tabId)/getTabs()/
     getActiveTab() 五方法；模块零 Electron import；不修改
     BrowserController/TabManager 产品契约。
     （3）**URL 边界**：acquire 创建前复用 `normalizeSourceUrl(url,'page')`
     校验（http/https、userinfo、长度 ≤2048、控制字符）；javascript:/
     data:/file:/about:/畸形/空 URL 一律 invalid-url 在 createTab 前拒绝；
     地址栏「非法输入转搜索」语义（resolveAddressBarInput）**不进入**
     Workspace；日志仅记录 tabId/taskId 与 URL host（零 query 值）。
     （4）**精确所有权**：acquire 创建前读取 tabsBefore/activeBefore
     快照；createTab 返回 id ∈ tabsBefore → 敌手/异常实现 →
     tab-create-failed、不登记所有权、**绝不关闭该 Tab**；不按位置/标题/
     URL/活动状态/create 前后集合差推断所有权；成功所有权仅来自本次
     createTab 返回的全新精确 id；创建后 getTabs 快照确认存在——不存在
     → tab-closed-by-user（不登记为存活资源）。
     （5）**并发上限**：MAX_RESEARCH_TABS=3（shared/types/research.ts
     单一事实源，实现零魔法数字）同时约束已登记 owned 与 in-flight
     createTab 预留槽；acquire 在**第一个 await 前**（同步段）检查
     `owned.size + inFlightCount ≥ MAX_RESEARCH_TABS` → tab-limit 确定性
     拒绝（不调用 createTab）；inFlightCount 在发起 createTab 前原子 +1、
     resolve 后 -1；禁止「先 await、后计数」（并发四次 acquire 时第 4 次
     必须在调用 createTab 前被拒绝）。
     （6）**创建后的焦点恢复**（createTab 自动激活新 Tab 的实测契约）：
     创建后读取 activeNow——activeNow === 新 tabId（用户未切换）且
     activeBefore 仍存在 → 立即 activateTab(activeBefore)；activeBefore
     已关闭 → 不重建、不激活猜测对象（成功 + 中文 warning）；用户已主动
     切换到其他 Tab → 零 activate（成功、无 warning）；activateTab 返回
     false（activeBefore 仍在但激活失败 = 未预期异常）→ **精确关闭新
     Tab + tab-restore-focus-failed**——不允许新 Tab 无声留在前台仍声称
     满足契约；task Tab 仍可出现在标签栏（UI 标识归 C8）。
     （7）**用户关闭感知**：BrowserController 无 Tab 事件订阅接口
     （tab-manager.ts onChanged 为内部推送通道）→ C2 不新增任何后台事件、
     计时器或监听器；提供显式快照方法 `checkTab(tabId)`——owned tab 从
     getTabs 快照消失 → 从所有权集合移除 + ok status='closed-by-user'；
     C4 在读取前后调用；任务文档删除「事件回调」承诺与「时钟注入」要求
     （无实际时间逻辑）。
     （8）**释放、取消与竞态**：release/cleanupAll 幂等；release 非本实例
     owned tabId（跨任务 Lease/伪造/已释放）→ not-owned 零关闭动作；owned
     但快照已消失（用户已关）→ ok closed:false 零 closeTab；closeTab 返回
     false 或抛错 → 保留所有权集合（可重试）+ ok:false cleanup-failed
     （不误报已清理）；cleanupAll 置 closing 标志（此后 acquire →
     workspace-busy）+ **等待全部 in-flight createTab 落定**（drain 屏障
     ——create 完成后的新 Tab 必须被精确关闭，cleanupAll 返回后零 task Tab
     泄漏）；AbortSignal：create 前终止 → 零创建 tab-create-aborted；
     create 期间终止 → 创建完成后精确关闭再返回 aborted；多次 release/
     cleanup 不重复关闭、不关闭替代 Tab；清理异常零用户 Tab 触碰、零未
     处理 Promise rejection（catch 归一安全返回）。

> 以下 #119 为 C2 定向安全修复契约裁决（2026-08-16；先写红测 → 改契约与
> 测试 → 再改实现，§15 流程）。独立复核发现 C2 acquire 的 abort/异常清理
> 路径存在两类 Tab 所有权漏洞（① abort 检查先于 tabsBefore 所有权验证，
> 可能关闭用户 Tab；② closeBestEffort 忽略 closeTab=false/抛错且调用方
> 已撤销/未登记所有权，清理失败后 task Tab 永久失联），依据 #118(4)/(8)、
> threat-model FT-09/§3.6「用户 Tab 永不关闭」与「清理失败不得误报已
> 清理」唯一裁决，无需用户拍板；不改写 #118 既有结论。

119. **C2 取消/异常清理的 Tab 所有权漏洞修复（2026-08-16，C2 定向修复）**：
     （1）**所有权验证优先**：createTab 返回后必须先检查 id 是否为非空
     字符串且不存在于 tabsBefore；属于 tabsBefore → tab-create-failed，
     即使 signal 此时已 aborted，也不得关闭、登记或修改该 Tab——用户
     Tab 集合及 URL/title/active 状态保持不变；所有权安全优先于取消结果
     分类。
     （2）**临时所有权（provisional ownership）**：一旦 createTab 返回
     不属于 tabsBefore 的全新精确 id，在进行 abort 检查、创建后 getTabs、
     焦点恢复等任何可能失败的步骤**之前**，先把该精确 id 登记进内部
     所有权集合——不得出现「已知全新精确 id 但尚未登记、best-effort
     清理失败后永久失联」的窗口；AcquireResult 失败时无 Lease，保留的
     provisional id 仍由 Workspace 内部持有，供 cleanupAll() 补清理。
     （3）**清理事实语义**：只有满足任一条件才能从 owned/ownedUrls 移除
     ——getTabs 明确确认该 id 已不存在，或 closeTab(id) 明确返回 true。
     closeTab 返回 false 或抛错 → 不移除所有权、返回 cleanup-failed、
     后续 cleanupAll() 必须可以只针对该精确 id 重试、不得关闭任何替代
     Tab 或同 URL/同标题用户 Tab。
     （4）**错误优先级**：fresh id + abort + 清理成功 → tab-create-
     aborted；fresh id + 焦点恢复失败 + 清理成功 → tab-restore-focus-
     failed；fresh id + 后置内部异常 + 清理成功 → workspace-internal；
     上述任一路径清理失败 → cleanup-failed（内部所有权保留）。不新增
     WorkspaceErrorCode。
     （5）**禁止不经所有权证明调用 closeTab**：不得把任意 createTab
     返回值直接交给 best-effort close；任何清理 helper 都只接收已确认
     「不属于 tabsBefore」的精确 id，并遵守「确认关闭后才移除所有权」——
     消除 closeBestEffort 式忽略 closeTab=false/抛错的失真语义。

- C1（契约+存储基座）→ C2/C3（并行，均仅依赖 C1）→ C4（依赖 C1–C3）→
  C5（依赖 C1–C4）→ C6（依赖 C1/C4）/C7（依赖 C1，可与 C6 并行）→
  C8（依赖 C5–C7）→ C9（依赖 C1–C8）→ C10（依赖全部且独立复验）。
- 每任务闭环边界、红态测试、验收标准、停止条件见 `doc/stage5/tasks/C1–C10`。
- C10 通过后停止，不实现 RSS/Watch/Sixth Stage；等待用户指令。
