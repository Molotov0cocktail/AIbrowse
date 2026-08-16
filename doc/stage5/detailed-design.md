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
  sectionCount: number; // 实际保留的非空 textSections 数
  tableCount: number; // 实际保留的表格数量（决议 #128：不是单元格数量/行列合计）
  headingCount: number; // 实际保留的 heading 数
  charCount: number; // 最终 canonicalText.length（≤ MAX_PAGE_CAPTURE_CHARS）
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
  | {
      kind: 'table';
      tableIndex: number; // 决议 #129：多表唯一定位——0-based 非负整数；
      // 缺失/负数/非整数/字符串/超界全部 fail-closed
      row: number; // 0-based 数据行（不含 header）
      col: number; // 0-based
      header: string | null; // 程序由真实表头生成；proposal 提供非空 header 须与
      // 真实表头一致；仅 string | null | 缺省合法——object/array/number/boolean
      // 等非法形态使整个 locator 无效（fail-closed 整体拒绝，不得静默转 null——决议 #115）
    }
  | { kind: 'field'; fieldPath: string }; // 提取字段路径（≤200，闭合白名单）

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

// 决议 #102：Repository 写入 API 仅接受 verified 窄类型
export type VerifiedEvidence = Evidence & { verification: 'verified' };

// 决议 #130：模型只提「不可信 proposal」（C4 新增，shared/types/research.ts）——
// 仅允许六个字段；evidenceId 由可信调用方预分配；taskId/sourceId/url/title/
// accessTime/documentId/contentHash/verification 全部不得由 proposal 提供
// （未知字段 fail-closed）。模型绝不能直接构造 Evidence。
export interface EvidenceProposal {
  captureId: string;
  candidateId: string;
  type: EvidenceType;
  locator: EvidenceLocator;
  excerpt: string | null; // text/summary-point：非空摘录草案；table-cell/field：受控值草案（可与 value 二选一）
  value: string | null; // table-cell/field 的单元格/字段值草案
}

export type EvidenceRejectionCode =
  | 'proposal-invalid' // 形状/未知字段/字段长度/type-locator 组合非法
  | 'capture-not-found' // captureId 不属于当前 task（跨任务引用）
  | 'capture-failed' // failed capture（sentinel 先拒）
  | 'candidate-mismatch' // candidateId 不存在或与 capture.candidateId 不一致
  | 'content-missing' // 对应 CaptureContent 缺失/绑定错位
  | 'excerpt-invalid' // 摘录为空/超长/与 locator 不一致
  | 'excerpt-not-in-content' // 规范化后不是任一 section 的连续子串（伪造/错绑/跨 section 拼接）
  | 'table-coordinate-invalid' // tableIndex/row/col 越界或非法
  | 'table-value-mismatch' // 单元格真实值与 proposal 不一致
  | 'table-header-mismatch' // proposal 提供非空 header 且与真实表头不一致
  | 'field-path-invalid' // fieldPath 不在闭合字段白名单（含原型链键/通配符/动态路径）
  | 'field-value-mismatch' // 字段真实值与 proposal 不一致
  | 'value-invalid'; // value 形状/长度非法

export type EvidenceVerifyResult =
  | { ok: true; evidence: VerifiedEvidence }
  | { ok: false; code: EvidenceRejectionCode; reason: string }; // reason ≤200 安全中文短句

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
C5 新增常量（决议 #132/#133）：MAX_PLAN_WEB_QUERIES（1）、
RESEARCH_TOOL_RESULT_CONTENT_MAX（8000）、
`RESEARCH_TOOL_NAMES`（六工具名编译期常量，决议 #132）、
`RESEARCH_ERROR_CODES` 增 `research-runtime-unavailable`（第 12 码，
决议 #134）。C5 新增类型（决议 #133/#134/#138）：`ResearchPlan`、
`ResearchProgressEvent`、`ResearchPromptsPort`/`ResearchSynthesisPort`/
`ResearchResultValidationPort`（端口形状以 §15 决议 #134 为准）。

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

> 本节为 C3 唯一实现契约（决议 #120–#123 定稿；§15 决议为准）。旧「五档
> （tier 1–5）」描述已于 #120 废止。

### 4.1 输入契约与合并语义（决议 #122）

```ts
export type SourcesCandidateFeed =
  | {
      kind: 'source-search';
      entries: readonly { candidateId: string; item: SourceSearchItem }[];
    }
  | {
      kind: 'group-list';
      entries: readonly { candidateId: string; item: SourceListItem }[];
    };

export interface WebSearchCandidateEntry {
  candidateId: string;
  result: SearchResult;
}

export interface MergeCandidatesInput {
  sources: SourcesCandidateFeed | null; // null = 无 Sources 候选（合法输入）
  search: readonly WebSearchCandidateEntry[];
}

export type CandidateMergeErrorCode =
  | 'candidate-invalid-input' // 顶层结构非法 / candidateId 形状非法（§4.3）
  | 'candidate-id-conflict'; // 原始输入 candidateId 全局重复（§4.3）

export type MergeCandidatesResult =
  | { ok: true; candidates: SourceCandidate[]; droppedCount: number }
  | { ok: false; errorCode: CandidateMergeErrorCode; reason: string };
```

- **candidateId 预分配（决议 #122）**：C3 不生成 id；输入条目由 C5 主进程
  调用方预先分配 candidateId。candidateId 必须是小写 RFC 4122 UUID 形状
  （8-4-4-4-12 小写 hex，含 version 4/variant 位）；不得以 canonicalKey、
  URL、sourceId 或数组序号充当；不同 task 由 C5 每次生成新的 UUID。
- **身份键**：Sources 条目重新执行 `normalizeSourceUrl(item.url,
item.scope)`；`item.canonicalKey` 与重新计算值不一致 → 该 Sources 条目
  丢弃。Search 条目固定 scope='page'，`normalizeSourceUrl(result.url,
'page')`。合并键 = `${scope}\0${canonicalKey}`；origin 与 page 键空间
  独立、**永不互相合并**。
- **同键合并（决策 D6）**：同合并键的 Sources 命中与 Search 命中合并为
  **一个候选**；合并后 url/displayUrl/title/sourceId/trust/priority/
  lastUsedAt/note 取 Sources 侧，`discoveredVia = ['sources','search']`
  （固定规范顺序，不依赖数组到达顺序）；采用 Sources 条目的 candidateId
  （未采用的 Search candidateId 安全丢弃）；档位采用 Sources 档位
  （§4.2）。
- **字段来源**：
  - Sources 命中：url = item.url（B2 存储的展示 URL）；displayUrl =
    重新计算的 normalizeSourceUrl displayUrl；title = item.name；
    sourceId = item.id；trust/priority/lastUsedAt/note 按 §4.3/§4.4 校验
    映射。
  - search-only 候选：url = result.url；displayUrl = 重新计算的
    normalizeSourceUrl displayUrl；title 取 result.title；sourceId/
    trust/priority/lastUsedAt/note 恒 null（**无 trust 断言——不虚构**）。
  - title 兜底：Sources title 清洗（§4.3）后为空 → Search title；Search
    title 清洗后仍为空 → 使用安全的 URL host（`new URL(canonicalKey).host`
    防御性取用，失败为空串）。title 规范化、控制字符清洗并限制至
    MAX_CANDIDATE_TITLE_CHARS（截断不得拆 surrogate pair）。
  - snippet 恒不参与候选字段、排序或 trust。
  - **收藏/priority/用户备注不得自动等同可信**（FT-07）：候选携带字段仅
    为展示与排序输入；provenance 语义继承 Sources trust 三元组
    （official+ai+unverified 仍显示「AI 推断·未核验」）；排序档位见
    §4.2（priority 不反转档位）。
- **重复输入**：同一 feed 内相同身份重复时，保留排名更前（先到达）的合法
  条目；后续重复计入 droppedCount。不修改任何输入数组或对象。
- **纯函数**：零 randomUUID/零 idFactory/零日志/零 Electron import；相同
  输入及相同预分配 ID → 输出完全确定。

### 4.2 发现路径档位（决议 #120，确定性全序）

```
tier 1 = source-search：来自 SourceService.search(..., audience='agent')
       ——保留 SourceService 已确定的输入顺序（决议 #61 全序）；
         note 命中通过上游 #61 搜索排名参与选择；不解析 note 文本、
         不把 note 写进 sortKey
tier 2 = group-list：来自 SourceService.list(groupId, enabledOnly=true,
         audience='agent')（场景 1「只看某个分组」）——同档内 priority
         降序、lastUsedAt 降序、scope/canonicalKey/id 收尾
tier 3 = web-search：仅由 SearchProvider 发现、没有合法 Sources 身份的
         候选——保留 SearchProvider 结果顺序；trust/priority/
         lastUsedAt/note 恒 null
```

- 档位严格不可跨档（tier 1 < tier 2 < tier 3）；同档内顺序由 §4.5 sortKey
  编码精确表达；trust 三元组仅作为 provenance 元数据，**不改变基础排序**
  （这是来源选择顺序，不是可信度或质量评分）；user+asserted 不等于事实已
  由程序核验；ai+unverified 永远显示为未核验。
- official/primary/community 的进一步选择与构成控制由 C5 有界计划调整
  （模型提议、程序执行）和 C6 sourceTypes/交叉核验承担；Fifth_stage.md
  §3.2 是选择策略建议，C3 在不修改冻结 Sources 契约的前提下，通过
  source-search 上游排序、group 限定、Search 补充及 C5 有界调整实现。
- 同身份 Sources + Search 合并后采用 Sources 档位与 Sources 字段，
  discoveredVia 累积两条路径。

### 4.3 输入验证与安全降级（单条丢弃 fail-closed；零 throw 零日志正文）

- **URL 边界**：非 http/https、userinfo、控制字符、超长（>2048）或无法
  解析的 URL → 丢弃该条（normalizeSourceUrl 既有语义）。
- **Sources 条目**：scope 非法（非 'origin'/'page'）→ 丢弃；
  `item.canonicalKey` 与重算不一致 → 丢弃；disabled（enabled=false）或
  shareMode='blocked' → 纵深防御丢弃；sourceId 非法（非 UUID 形状）→
  丢弃。Sources 条目丢弃但同 URL Search 合法时，保留 search-only 候选
  （trust=null——不继承已丢弃 Sources 的任何字段）。
- **trust**：仅接受 `value ∈ {official,primary,secondary,community,
unknown}` 且（assertedBy='user' 且 verification='asserted'）或
  （assertedBy='ai' 且 verification='unverified'）；其余组合/畸形 →
  整体降级为 null（候选保留，不抛异常）。
- **priority**：非 1–5 整数 → null；**lastUsedAt**：非法 → null；
  **note**：按 §4.4 映射。
- **candidateId**：非字符串/非小写 UUID 形状 → 整次 fail-closed
  （candidate-invalid-input）；重复 → 整次 fail-closed
  （candidate-id-conflict）。
- **顶层结构**：sources 非 null 且（kind 非法或 entries 非数组）/search
  非数组/条目形状非法（候选对象缺 candidateId/item|result）→ 整次
  fail-closed（candidate-invalid-input，reason 为中文原因不含 URL/note/
  标题正文）。
- **单条非法**：只增加 droppedCount；不把 URL、note 或标题写入日志。

### 4.4 note 映射（决议 #121）

- group-list 与 search-only 候选：note = null。
- source-search 候选：userNote 非空 → `用户备注：${text}`；aiNote 非空 →
  `AI 备注：${text}`；两者都有时按「用户备注 → AI 备注」顺序以换行连接；
  每段先 NFC、trim、控制/bidi 字符清洗（复用 stripControlChars 同族规则）
  后为空 → 视为无。
- 预算：标签、换行和正文共同计入 MAX_CANDIDATE_NOTE_CHARS
  （String.length）；完整组装 ≤ 上限直接输出；超上限时逐段分配：用户段
  优先（截断至剩余预算，不拆 UTF-16 surrogate pair）；剩余预算不足
  「AI 备注：」标签 + 至少 1 字符正文时，AI 段整体丢弃——**不得留下无
  正文的作者标签**；最终 String.length 恒 ≤ MAX_CANDIDATE_NOTE_CHARS。
- note 只展示/持久化，不进 sortKey、不进入模型上下文；不得把 userNote 与
  aiNote 混成无法识别作者的一段文本。

### 4.5 sortKey 编码（决议 #123）

```
TT|RRRRR|P|IIIIIIIIIIIIIIIIIIIIIIII|S|canonicalKey|candidateId
TT    = '01'|'02'|'03'（tier）
RRRRR = 原输入 rank（零起点、5 位补零；rank ≥ 100000 防御 clamp 99999）；
        group-list 固定 '99999'
P     = priority 1–5 → String(6−priority)（5→'1' 排最前）；null/非法 → '9'
I     = 合法 ISO 时间（isIso8601Timestamp）→ new Date(...).toISOString()
        后每个数字 d 替换为 9−d（反向时间字典序，标点原位保留——新时间
        排前）；null/非法 → '~' × 24（固定长度，恒排最后）
S     = '0'(origin) | '1'(page)
canonicalKey = normalizeSourceUrl 输出（WHATWG 序列化保持 ASCII）
candidateId  = 小写 UUID
```

- 比较用原始二元 `<`/`>`（**不得 localeCompare**）：sortKey 全 ASCII，JS
  UTF-16 code unit 序与 SQLite BINARY 排序一致；Repository
  `ORDER BY sort_key ASC, candidate_id ASC`（§9.1）与内存排序完全一致
  （真实 node:sqlite 测试证明）。sortKey 为比较键，不要求可逆解析；
  canonicalKey 内出现 `|` 不影响正确性。
- lastUsedAt 非法：Candidate 字段降级 null + sortKey 用 null sentinel，
  不抛异常。sortKey 由纯函数 buildCandidateSortKey 生成（C5 持久化时直接
  使用；同一候选的 sortKey 唯一——candidateId 收尾）。

### 4.6 有界性与选定裁剪（D12）

- merge 后先按完整排序规则排序，截取 MAX_SOURCE_CANDIDATES（24），超出
  部分计入 droppedCount（确定性：同输入同输出）。
- `selectCandidates(candidates)` 对副本按 sortKey（+ candidateId 收尾）
  排序并截取 MAX_SELECTED_SOURCES（8）；空输入成功返回空数组；不使用
  魔法数字（常量来自 shared/types/research.ts）。模型可在计划阶段要求
  调整选择（≤8 范围内）——选择意图为模型提议、程序按排序键执行裁剪。

## 5. Capture 与 Evidence 数据契约（C4）

> 本节已按决议 #124–#130 重写（2026-08-16，C4 实施前契约裁决）：旧草案的
> 「loadURL 双导航」「throw 式失败控制流」「单表 locator」「模型直接构造
> Evidence」均已废止，精确语义以下文与 §15 决议为准。

### 5.1 读取与提取（capture-service.ts）

**输入**：已合并排序的 SourceCandidate（C3 形状）——只使用候选的展示值与
身份键（url/displayUrl/title/candidateId）。

**浏览器最小端口（决议 #124）**：CaptureService 不直接拥有 BrowserController，
仅注入读取所需最小端口：

```ts
export interface CaptureBrowserPort {
  getTabs(): Promise<TabInfo[]>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
}
```

Tab 创建/归属/检查/释放全部通过 ResearchWorkspace。**禁止双导航**：
`acquire` 已通过 `createTab(url)` 创建并开始加载页面（#118 契约），
C4 绝不调用 navigate/loadURL/reload。

**每次尝试的固定时序（决议 #124/#127）**：

```
acquire(candidate.url, signal)
  → ready 轮询（getTabs 精确 tabId；READY_TIMEOUT_MS=15000/poll/sleep/
     时钟注入；AbortSignal 贯穿）
  → checkTab(tabId)（读前快照感知用户关闭）
  → getPageSnapshot(tabId)（实时采集）
  → snapshot 返回后、接纳内容前：再次检查 signal + checkTab
  → finally release(tabId)
```

**读取结果判别联合（决议 #125，禁 throw 作预期失败控制流）**：

```ts
type CaptureReadResult =
  | { ok: true; attempts: Capture[]; capture: Capture; content: CaptureContent; warnings: string[] }
  | { ok: false; attempts: Capture[]; failureReason: CaptureFailureReason; warnings: string[] };
```

- 同一候选最多 2 次尝试（MAX_PAGE_READ_RETRIES=1）；每次尝试独立 captureId
  （注入式 UUID v4 工厂，主进程可信输入）；重试必须重新 acquire（新 tabId）。
- attempts 记录每次尝试（含失败的 failed Capture）。
- C4 不修改 ResearchTask.stats（captureCount/failedReadCount 持久化递增属
  C5 Runtime）。

**重试矩阵（决议 #125 冻结）**：

| 失败原因                 | 重试                                                   |
| ------------------------ | ------------------------------------------------------ |
| page-load-failed         | ≤1 次                                                  |
| timeout                  | ≤1 次                                                  |
| snapshot-degraded        | ≤1 次                                                  |
| aborted                  | 不重试                                                 |
| http-scheme-rejected     | 不重试                                                 |
| tab-closed-by-user       | 不重试                                                 |
| Workspace cleanup-failed | 不继续创建更多 Tab（映射失败 + 无 URL/正文的 warning） |
| 其他可恢复创建/读取异常  | 归一 page-load-failed，可重试一次                      |

release 失败不得误报已清理：所有权保留供 C5 终态 cleanupAll 重试；内容已
成功捕获时 release 失败只产生安全 warning（不丢弃已完成 Capture）。

**成功路径（决议 #127）**：

- 快照阶梯：L0（none）成功；L1（partial）成功 + 降级 warning；
  L2（main-process-only）snapshot-degraded；L3（null）先再次 checkTab
  （已关闭 → tab-closed-by-user，否则 snapshot-degraded）。
- url/title 取**实际快照**（不取候选/模型输入）；最终 URL 重新验证为安全
  http/https 且无 userinfo（非法重定向 → http-scheme-rejected；
  **chrome-error:// 错误页 → page-load-failed 可重试——决议 #131**）；
  accessTime = 合法 snapshot.meta.capturedAt 转 ISO 8601（主进程盖章）；
  documentId = String(snapshot.meta.documentId)（要求非负整数）；
  非法 capturedAt/documentId/快照形状 → snapshot-degraded。

**failed Capture sentinel（决议 #126，schema v1 非空字段的确定性语义）**：

| 字段                   | 失败值                                           |
| ---------------------- | ------------------------------------------------ |
| tabId                  | `unallocated`（Tab 尚未分配）                    |
| documentId             | `unavailable`（快照不存在）                      |
| contentHash            | SHA-256(UTF-8 空串) 前 32 小写 hex（编译期常量） |
| summary                | 四项全部 0                                       |
| url/title              | 已校验的候选展示值（不取自失败页面）             |
| accessTime             | 注入主进程时钟（ISO 8601）                       |
| failed / failureReason | true / 非 null（必须）                           |

sentinel 只能出现在 failed Capture；EvidenceValidator 必须先拒绝 failed
Capture，绝不把 sentinel 组装进 VerifiedEvidence。

**结构化提取与 CaptureContent（决议 #128，纯内存、零落盘）**：

```ts
export interface CaptureContent {
  captureId: string;
  canonicalText: string; // ≤ MAX_PAGE_CAPTURE_CHARS，确定性截断
  textSections: string[]; // 非空章节（每节独立规范化）
  tables: CaptureTable[]; // { headers: string[]; rows: string[][] }（规范化）
  fields: Record<string, string>; // 闭合字段路径 → 规范值
}
```

- 只能从现有 PageSnapshot 的 url/title/visibleText/headings/links/tables
  构造；禁止修改采集管线、禁止新建采集通道。
- 规范化：NFC、trim、控制字符/bidi 清除、连续空白折叠；无模糊/语义/
  大小写猜测匹配。
- canonicalText 为有类型标签、顺序固定的串行格式，来源顺序：
  `visibleText → headings → tables（表头 + row-major 单元格）→ links`。
- 所有可被 EvidenceValidator 引用的 section/table/field 值都必须实际进入
  canonicalText 的 60k 预算和哈希覆盖范围；预算耗尽后不得保留「未进入
  哈希」的表格/字段/章节。
- 字段路径闭合集合（白名单，不支持任意网页字段）：`page.url`/
  `page.title`/`headings[0].text`/`links[0].text`/`links[0].href` +
  固定数组索引表格路径（如 `tables[0].cell[1][2]`）；不解析任意对象路径、
  原型链或表达式。
- summary：sectionCount/tableCount（表格数量，非单元格）/headingCount/
  charCount = canonicalText.length；contentHash = SHA-256(UTF-8
  canonicalText) 前 32 小写 hex。
- 正文/完整快照只在内存 CaptureContent，不进 Capture、Repository、日志或
  会话文件（FT-14/16）；任务终态丢弃。

### 5.2 Evidence 验证（evidence-validator.ts，决策 D5）

```ts
verifyEvidence(input: {
  proposal: EvidenceProposal;      // 不可信模型草案（§2 类型，仅六字段）
  evidenceId: string;              // 可信调用方预分配
  taskId: string;
  captures: Capture[];             // 本任务捕获集
  candidates: SourceCandidate[];   // 本任务候选集
  contents: Map<string, CaptureContent>; // captureId → 内容
}): EvidenceVerifyResult
```

**校验顺序（决议 #130，全部通过才组装）**：

1. proposal 形状/未知字段/字段长度/type-locator 组合合法
   （quote/summary-point → text locator 且 value 必须 null/缺省；
   table-cell → table locator；field → field locator）→ proposal-invalid；
2. capture 属于当前 task（capture-not-found）且 failed=false
   （capture-failed——sentinel 先拒，FT-03/04）；
3. candidate 存在且 capture.candidateId === proposal.candidateId
   （candidate-mismatch，FT-04/09/15）；
4. 对应 CaptureContent 存在且绑定同一 captureId（content-missing）；
5. locator/value/excerpt 内容验证（下表）；
6. 程序组装 VerifiedEvidence：evidenceId 取可信上下文；taskId/sourceId
   （从候选取）/url/title/accessTime/documentId/contentHash 全部从成功
   Capture 取——模型不可伪造。

| 类型                        | 校验                                                                                                                                                                                                                       | 失败码                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| text（quote/summary-point） | locator.excerpt 与 proposal.excerpt 规范化后一致；非空且 ≤500；必须是某一个独立 textSection 的连续规范化子串（禁跨 section 拼接/模糊/语义/大小写猜测）                                                                     | excerpt-invalid / excerpt-not-in-content                                |
| table-cell                  | tableIndex/row/col 全部在界内（row=数据行不含 header）；程序取真实单元格值，proposal.value/excerpt 规范化后必须与受控真实值完全一致；输出 locator.header 由程序按真实表头生成（proposal 提供非空 header 须与真实表头一致） | table-coordinate-invalid / table-value-mismatch / table-header-mismatch |
| field                       | fieldPath 精确存在于闭合 fields map（禁前缀/通配符/动态路径/`__proto__`/constructor/prototype）；proposal.value/excerpt 与字段规范值完全一致                                                                               | field-path-invalid / field-value-mismatch                               |

- 模型只能**提出**引用（EvidenceProposal 作为结构化请求消息内容）；模型
  绝不能直接构造 Evidence（evidenceId/provenance 全部主进程侧，未知字段
  fail-closed）。
- 验证纯函数幂等、同输入同输出（无随机、无时钟副作用）；rejected 回注
  模型修正（闭合错误码 + 安全中文 reason ≤200 字符，不回显正文/URL query/
  敌对字段）。
- 未验证引用**不渲染、不进 Evidence 集合、不进持久化**（FT-11；Repository
  写入仅接受 VerifiedEvidence 窄类型 + schema CHECK 兜底——决议 #102）。

## 6. ResearchRuntime（C5，独立有界编排状态机）

> 本节已按决议 #132–#139 重写（2026-08-16，C5 实施前契约裁决）：六工具
> 执行模型、ResearchPlan 判别联合、C6/C7 稳定端口、Service/Runtime
> 异步装配、预算计数、原子持久化与终态预留、Progress/heartbeat/竞态、
> index.ts 装配——精确语义以下文与 §15 决议为准。

### 6.1 与 AgentLoop 的边界（决策 D2）

- AgentLoop（12 步/420s/防循环/确认管线）**契约零改动**，继续服务普通 Agent
  任务模式；Research 不走 AgentLoop。
- ResearchRuntime 为纯核心（零 Electron import），构造注入：provider
  （LLMProvider 接口）、sourceService、searchProvider、browser
  （BrowserController 最小接口）、workspace、captureService、repository、
  时钟/预算（可注入）+ prompts/synthesis/result-validation 三端口
  （决议 #134）。

### 6.2 阶段循环（决议 #133/#134/#136）

```
run(taskId, goal):
  phase planning：
    轮 1（候选查询计划）：planning prompt + goal + Sources 分组列表
      （groupId+name，UNTRUSTED 块）→ 模型产出 ResearchPlan JSON
      （sourceMode/sourceQuery/groupId/webQueries；selectedCandidateIds 必空）
      → 严格白名单校验 → 非法回注重提 ≤1 次 → 仍非法 → 安全默认计划
    候选收集：source-search（query, audience='agent'）或 group-list
      （enabledOnly=true, audience='agent', 有界分页）→ webQueries 每项
      SearchProvider.search（失败 → Sources-only 降级 + warnings）
      → Runtime 预分配小写 v4 candidateId → mergeCandidates → 排序
      → ≤24 → 持久化（同事务 stats.candidateCount）
    轮 2（选择意图，可选）：候选元数据（UNTRUSTED 块）→ 模型产出
      selectedCandidateIds（⊆ 已合并候选）→ 非法/缺失 → 程序默认
      → 选定 = 排序候选 ∩ 模型选择 → ≤8 → 持久化 stats.selectedCount
  phase reading：逐选定候选串行（v1 单并发读取）：CaptureService.read
    → capture 记录持久化（stats.captureCount+=attempts、
    failedReadCount+=失败 attempts）→ 模型提出 evidence proposal
    → verifyEvidence → 通过入集合/拒绝回注（stats 同步）→ 下一条
  phase verifying：verifying prompt → 模型产出 claims/冲突文本 →
    synthesis 端口 processVerification（C6 替换）→ 持久化 claims/conflicts
    （stats.claimCount/conflictCount）
  phase synthesizing：synthesizing prompt → 模型产出 Result 草案文本 →
    synthesis 端口 parseResultDraft → result-validation 端口 validate
    （C7 替换）→ 拒绝回注重提 ≤2 次 → 仍失败 → failed（research-internal，
    Evidence 保留）→ 通过 → Result + completed 同事务 → completed
  终态单一所有权（finish() 守卫）：stop/超时/预算用尽/Provider 错误
    → 各自终态；迟到模型输出/回调忽略；Workspace cleanupAll
```

### 6.3 停止/取消语义（决议 #135/#138）

- `stop(taskId)`：幂等；向对应 runToken 的 runtime 发 abort（AbortController
  - Workspace 清理（只关本任务 Tab））；数据库 cancelled 终态由 Runtime
    写入（Service 不竞争写终态——C1 语义由 C5 改造）；stop 后迟到事件/写入
    零生效。
- 进程退出：Runtime 心跳持久化 → 启动装配标 interrupted（§3.1）；应用退出
  走 shutdown 契约（决议 #135(7)）：abort → await settle → cleanupAll →
  关闭 store（幂等、零 database-closed race）。

### 6.4 失败继续（决议 #136(5) 失败映射冻结）

- 单候选读取失败：failed capture（sentinel 语义，决议 #126）+ 失败继续下一
  候选（不终止任务）；重试矩阵见 §5.1（决议 #125）。
  captureCount/failedReadCount 按 attempts 统计（决议 #137(3)）。
- Search 失败（search-failed）：候选仅剩 Sources 侧 + 如实记录（warnings）；
  Sources 检索失败：任务 failed（research-sources-unavailable）。
- Provider 失败映射（决议 #136(5) 冻结）：每逻辑模型轮最多重试一次；连续
  两次 Provider 失败终止（failed + research-provider-unavailable）；成功轮
  重置连续失败计数；context-too-long 裁剪后同轮重试 1 次、仍失败 →
  research-budget-exhausted；总期限 → research-timeout；stop 获胜 →
  cancelled；步数/轮次/持久化预算 → research-budget-exhausted；其余内部
  缺陷 → research-internal。
- 模型产出非法 Result：validate 拒绝 → 回注错误详情重提（≤2 次）；
  仍失败 → failed（research-internal，Evidence 保留）。

### 6.5 进度事件（决议 #138(1)）

`ResearchProgressEvent { taskId, status, phase, stats, finishedAt }`——确定性
运行事实（无 goal/URL/模型文本/网页正文/Evidence 内容）；仅 phase、status
或 stats 语义变化时发新快照（纯 heartbeat 的 updatedAt 改变不产生事件）；
初始 running/planning 恰好一次、终态恰好一次；listener 抛错不影响 Runtime；
C8 前不新增 Renderer IPC。

### 6.6 超时

- `RESEARCH_TOTAL_TIMEOUT_MS = 1_800_000`（30 分钟，含确认等待——Research
  v1 无 L2 确认工具，但 browser_open L1 展示与 Provider 等待计入）。
- 超时 → failed，errorCode=**'research-timeout'**（决议 #108：独立错误码，
  不以 research-internal 含混代替无法展示的原因；errorCode 文案在
  research-errors.ts 单一事实源；timeout 理由进日志，不虚构）。

### 6.7 页面变化/陈旧

- Evidence 验证基于**本次捕获内容**（内存 CaptureContent）；页面在捕获后
  变化不使已验证 Evidence 失效（accessTime + documentId 记录捕获时刻）；
  快照 documentId 世代由主进程盖章（页面不可伪造——A3 决议 #31 机制）。
- 用户关闭 task Tab：读前 checkTab / 快照后二次 checkTab 感知（决议
  #127）→ 该候选读失败（tab-closed-by-user，不重试）→ 继续（FT-09 反面
  语义：用户永远可关闭任何 Tab）。

### 6.8 确定性预算（D12 全表；编译期常量 + 可注入 + 测试断言）

| 常量                                | 值       | 语义                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAX_GOAL_CHARS                      | 2000     | goal 截断上限（截断标记计入上限——返回文本 String.length 恒 ≤2000，决议 #114；单位 = JavaScript 字符数，非 UTF-8 字节，决议 #103）                                                                                                                                                                                                                                                      |
| MAX_SOURCE_CANDIDATES               | 24       | 合并后候选上限（Sources ≤10 + Search ≤10 + 溢出裁剪）                                                                                                                                                                                                                                                                                                                                  |
| MAX_SELECTED_SOURCES                | 8        | 选定来源上限                                                                                                                                                                                                                                                                                                                                                                           |
| MAX_RESEARCH_TABS                   | 3        | 同任务同时打开的 task Tab 上限（v1 串行读取实际 1 个，上限为纵深防御）                                                                                                                                                                                                                                                                                                                 |
| MAX_PAGE_CAPTURE_CHARS              | 60000    | 单页规范化正文预算（确定性截断 + summary.charCount）                                                                                                                                                                                                                                                                                                                                   |
| MAX_PAGE_READ_RETRIES               | 1        | 同候选读取失败重试上限（最多 2 次尝试）                                                                                                                                                                                                                                                                                                                                                |
| MAX_CAPTURES_PER_TASK               | 16       | 8 候选 × 2 尝试的捕获记录上限（每次尝试独立 captureId——决议 #125；失败尝试同样计入）                                                                                                                                                                                                                                                                                                   |
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
| MAX_PLAN_WEB_QUERIES                | 1        | 规划轮 webQueries 数量上限（决议 #133：小型编译期上限，C5 基线）                                                                                                                                                                                                                                                                                                                       |
| RESEARCH_TOOL_RESULT_CONTENT_MAX    | 8000     | 单条 Research 工具结果序列化上限（决议 #132(6)：确定性截断 + 标记；只进模型回放消息，不进日志/UI/持久化）                                                                                                                                                                                                                                                                              |

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

### 6.9 Research 六工具执行模型（决议 #132，详细语义）

- `RESEARCH_TOOL_NAMES` 编译期常量六名；`RESEARCH_TOOL_DEFINITIONS`
  为 research 模块编译期常量——名称/wire 形状/参数基础形状与注册表同名
  工具一致（测试交叉断言），description 与执行器为 Research 专属；
  **不经 ToolRegistry/ToolExecutor/权限链/ConfirmManager/审计管线**。
- `browser_open`：候选集合内的 URL → CaptureService.read（计 1 步 +
  capture 记录）；`browser_read`：本 run 内存 CaptureContent 索引（tabId
  → captureId）；`search_web` → SearchProvider；`source_*` →
  SourceService（audience 恒 'agent'）。C4 每次读取释放 task Tab 契约
  不变。
- 未知工具/子集外工具/非法参数 → 安全工具结果（不执行、不 throw）；
  tool result 序列化 ≤ RESEARCH_TOOL_RESULT_CONTENT_MAX。

### 6.10 ResearchPlan 与候选生成（决议 #133，详细语义）

- 两轮计划（候选查询计划 → 收集/合并/持久化 → 选择意图）；全部模型
  字段白名单校验；groupId/candidateId 只能引用程序提供的集合；candidateId
  由 C5 预分配小写 v4 UUID（非法/重复整轮 fail-closed → 安全默认计划）；
  Sources 输入 source-search/group-list 互斥；group-list
  enabledOnly=true/audience='agent'/有界分页；Search 失败 Sources-only
  降级；Sources 不可用任务失败；合并 ≤24/选定 ≤8；模型只能在已合并集合
  内选择/重排。
- 安全默认计划（轮 1 重提仍非法）：source-search + goal 截断 500 + 零
  web 查询——不引用模型任何输出。

### 6.11 C6/C7 稳定端口（决议 #134，详细语义）

- `ResearchPromptsPort`（planning/reading/verifying/synthesizing 四槽，
  C6 提供真实常量——verifying 为 C5 引入的第四槽，C6 补
  AGENT_RESEARCH_VERIFYING_PROMPT）/ `ResearchSynthesisPort`
  （processVerification + parseResultDraft）/ `ResearchResultValidationPort`
  （validate）——精确形状见 §15 决议 #134。
- C5 测试/冒烟注入确定性 stub；产品装配无 C6/C7 → 不建立 Runtime →
  `research-runtime-unavailable`（第 12 码）；不得设置「永远有效」默认、
  不得把未验证模型输出写入 ResearchResult。

### 6.12 Service/Runtime/Provider 异步装配（决议 #135，详细语义）

- startTask：无副作用前置（互斥/Sources/Provider/Runtime 装配/goal）→
  单事务 running → 启动后台 Runtime → 立即返回；工厂/启动失败零永久
  running。
- 单一 active slot（taskId/runToken/runtime/done）；restart 屏障（旧
  run settle 前拒绝）；Runtime 是终态唯一写入者（stopTask 只 abort +
  读取状态）；slot 仅同一实例 finally 按 identity/CAS 清除；每个异步
  边界与最终提交前复检 signal/仍 running/runToken。
- shutdown（幂等 async）：abort → await settle → cleanupAll → closeDb；
  主进程退出路径使用该契约。

### 6.13 原子持久化与终态预留（决议 #137，详细语义）

- Runtime 零 SQL：`ResearchRuntimePersistencePort` 由 Repository +
  withTransaction 实现；每笔逻辑写入同事务：复验 running → 写数据 →
  同步 stats/phase/updatedAt → 500k 投影检查 → 失败整体回滚。
- 终态预留：所有子行插入与非终态任务行更新额外断言「当前 + 新增 +
  最坏终态任务行 ≤ 500k」——非终态写不恰好吃满预算导致任务永久 running
  的缺口关闭（边界测试）。
- stats 精确语义（candidateCount/selectedCount/captureCount（attempts）/
  failedReadCount（失败 attempts）/evidenceCount/rejectedEvidenceCount/
  claimCount/conflictCount/stepsUsed/roundsUsed）；Capture ≤16/Evidence
  ≤60 超限 → research-budget-exhausted（已提交 Evidence 保留）；
  Result+completed 同事务；failed/cancelled 终态与任务行更新同事务。

### 6.14 Progress、heartbeat 与终态竞争（决议 #138，详细语义）

- ProgressEvent 精确语义（语义变化才发/初始与终态各恰好一次/listener
  异常隔离/事件零敏感内容）；heartbeat 仅 phase 入口；终态优先级
  stop > deadline > 预算；终态 guard 后一切迟到 no-op；cleanupAll 至少
  在所有终态执行（失败保留所有权供 shutdown 重试，不触碰用户 Tab）。

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
  `AGENT_RESEARCH_VERIFYING_PROMPT`（决议 #134(4)：verifying 轮独立槽位，
  C5 端口引入第四常量）/ `AGENT_RESEARCH_SYNTHESIS_PROMPT` 编译期常量
  （与共读 SYSTEM_PROMPT / AGENT_SYSTEM_PROMPT 互不混用；恒等断言固化）；
  四常量实现 `ResearchPromptsPort`（决议 #134 端口形状）。
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
- **failed Capture sentinel（决议 #126）**：research_captures 的 tab_id/
  document_id/content_hash 为 NOT NULL——失败记录以编译期 sentinel
  填充（tabId=`unallocated`、documentId=`unavailable`、contentHash=
  SHA-256(空串) 前 32 hex、summary 全 0、url/title 取已校验候选展示值、
  accessTime 注入主进程时钟）；migration v1 零改动；sentinel 只能出现在
  failed Capture（EvidenceValidator 先拒 failed Capture，绝不把 sentinel
  组装进 VerifiedEvidence）。
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
    `{ db: DbHandle | null, now?, getSourcesState?, getProviderState?,
runtimeFactory? }`（缺省就绪，C5 接线真实查询；runtimeFactory 为 C5
    注入的异步 Runtime 工厂——决议 #135：Provider/config/key/tool-support
    检查在进入 running 前完成；未注入 → startTask 前置拒绝
    research-runtime-unavailable，决议 #134）；createTask(goal)/getTask(id)/
    listTasks(opts)/deleteTask(id)/startTask(id)/stopTask(id)/
    shutdown()/dispose()（dispose 关闭句柄幂等；**shutdown 为 C5 新增
    幂等 async 契约——abort → await active run settle → cleanupAll →
    closeDb，dispose 只在 shutdown 完成后关闭连接**）；返回判别联合
    `{ok:true,...} | {ok:false,errorCode}`
    （ResearchCreateResult/ResearchTaskResult/ResearchListResult/
    ResearchDeleteResult/ResearchStartResult/ResearchStopResult）；非法
    输入安全返回结构化错误不抛异常；未预期异常 → 归一化
    research-internal + warn 日志；db=null 装配（disposed）→ 全部方法
    结构化 research-unavailable（与 Sources B7 模式一致）。
  - **C5 决议 #135/#137 扩展**：`ResearchRuntimeFactory`（异步
    create(ctx) → handle|null）、active slot（taskId/runToken/runtime/
    done 单槽 + CAS 清除 + restart 屏障）、
    `ResearchRuntimePersistencePort`（Runtime 零 SQL——Repository +
    withTransaction 实现每笔逻辑写入：复验 running → 写数据 → stats/
    phase/updatedAt → 预算检查 → 整体回滚）、Repository 终态预留方法
    `estimateWorstTerminalTaskRowBytes`/`assertChildInsertWithTerminal
Reserve`（决议 #137(2)）。

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

| 情况                     | 处理                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 空/超长 goal             | 校验拒绝/确定性截断（≤2000 + warn）                                                                                     |
| 取消（stop）             | 幂等；abort 流 + 只关本任务 Tab；cancelled 终态由 Runtime 唯一写入（决议 #135）                                         |
| 超时                     | failed + 理由 timeout + Evidence 保留（§6.6）                                                                           |
| 用户关 Tab               | 当前读取 failed（tab-closed-by-user）+ 继续（§10）                                                                      |
| 页面变化（捕获后）       | 已验证 Evidence 不失效（accessTime/documentId 记录捕获时刻）                                                            |
| 读取失败                 | failed capture（sentinel 语义，决议 #126）+ 按重试矩阵重试 ≤1 次 + 继续（决议 #125；stats 按 attempts 递增，决议 #137） |
| Provider 失败            | 每逻辑轮重试 1 次；连续 2 轮 → failed（research-provider-unavailable）；成功轮重置计数（决议 #136）                     |
| 重复来源                 | normalizeSourceUrl 身份键合并（discoveredVia 双路径）                                                                   |
| 冲突                     | Conflict 数据模型 + 不自动裁决（§7.2）                                                                                  |
| 预算用尽                 | 正式终态 failed + Evidence 保留（§6.8；步数/轮次超限零执行，决议 #136）                                                 |
| 进程退出                 | interrupted 标记（不自动续跑）；shutdown 契约（决议 #135(7)）                                                           |
| 迟到事件/取消后写入      | 终态单一所有权守卫 + 忽略（§3.1/§6.3/决议 #138(3)）                                                                     |
| Research 库 unavailable  | 全部 research:* 拒绝 + 中文诊断；其余子系统正常                                                                         |
| 未知/子集外/非法参数工具 | 安全工具结果，不执行不 throw（决议 #132(3)）                                                                            |
| 非终态写吃满 500k        | 终态预留检查拒绝该写入 → research-budget-exhausted → failed 仍可落库（决议 #137(2)）                                    |
| Runtime 未装配/构造失败  | startTask 前置拒绝 research-runtime-unavailable（第 12 码，决议 #134(3)）                                               |

## 13. 测试规格（红→绿纪律）

### 13.1 单测（Vitest，node 环境，纯逻辑）

| 测试文件                    | 用例要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 任务 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| research-task-state.test.ts | 状态迁移全表（§3.1 每行）/非法事件安全返回/终态不可变/start 前置矩阵                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | C1   |
| research-budget.test.ts     | 全部常量边界（§6.8 表每项 ±1）/裁剪确定性/超限标记                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | C1   |
| research-repository.test.ts | 真实 node:sqlite：CRUD/编译期 SQL + 注入串仅作数据/CASCADE/JSON 形状校验 fail-closed/字节预算拒绝/任务数清理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | C1   |
| research-store.test.ts      | 装配矩阵：新库迁移 v1/坏 magic 保留/未来版本零写入/unavailable 全拒/遗留 running 标 interrupted/其余子系统不受影响（注：完整恢复态矩阵随 C1 定稿；backup 非 v1 承诺）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | C1   |
| research-workspace.test.ts  | 注入 Fake BrowserController 替身（完全离线、可控 Promise）：精确 tabId 归属/只关本任务 Tab/用户 Tab 零关闭/已关闭安全无操作/并发上限（第 4 次 create 前拒绝 + deferred create 竞态）/abort 前与 create 期间/焦点恢复三态（未切换→恢复、已切换→零 activate、activeBefore 已关→不重建）/closeTab false 与抛错/cleanupAll 多 Tab·部分失败·重复·drain 屏障零泄漏/cleanup 后 acquire 拒绝/用户关 Tab → checkTab tab-closed-by-user/零 Electron import/常量单一事实源（决议 #118）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | C2   |
| source-selector.test.ts     | 三档可达性与互斥（1<2<3，trust/priority 不反转档位）/上游顺序保留（source-search 与 web-search 输入 rank；group-list 才按 priority/lastUsedAt）/合并矩阵（同 URL 双路径/不同 scope 不合并/键空间独立/字段优先级/discoveredVia 规范顺序/重复输入去重）/provenance 继承（search-only 恒 null 无 trust 断言；畸形 trust 降级 null）/note 映射（作者标签/清洗/截断不拆 surrogate/无空标签/不进 sortKey）/candidateId 输入契约（非法与重复 fail-closed）/sortKey 编码（priority 5 在前/新时间在前/null 末位/`<` 比较与真实 node:sqlite ORDER BY sort_key 一致）/hostile input 矩阵（javascript:/data:/userinfo/控制字符/超长 URL/canonicalKey 不一致/disabled/blocked 零 throw 零日志正文）/预算（24 裁剪/select ≤8/空输入/零修改输入）                                                                                                                                                                                                                                | C3   |
| capture-service.test.ts     | acquire 已加载零二次 navigate（browser 端口无 navigate 方法 + 断言零调用）/ready・error・missing・timeout・abort/读前・快照期间・读后用户关闭/L0–L3 阶梯映射/重试与不重试矩阵（决议 #125 全表）/重试产生新 captureId・新 tabId/每次尝试 finally release/release false・抛错保留 warning 不误报清理/redirect 后实际 URL・capturedAt・documentId 盖章/failed Capture sentinel（决议 #126 五字段）/NFC・空白・控制・bidi 规范化/60k 边界・surrogate 不拆分/table/section/field 在预算与哈希覆盖范围内/contentHash 确定性・输入零修改/正文零持久化存储探针                                                                                                                                                                                                                                                                                                                                                                                                            | C4   |
| evidence-validator.test.ts  | 正确 quote/summary/table/field（多表相同 row/col 由 tableIndex 精确区分）/缺失・非法・越界 tableIndex/伪造摘录・跨 section 拼接・空摘录・超长摘录/错 task・capture・candidate・failed capture・内容绑定错位/header 非法形状与不一致/fieldPath 不存在・通配符・`__proto__`/constructor/prototype/模型伪造 trusted metadata・未知字段/value 不一致・超预算/rejected 不产生 Evidence・不落库/同输入幂等/Repository table locator 写入・读回恒等及非法行跳过（决议 #129/#130）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | C4   |
| claim-model.test.ts         | coverage 计算/severity=high 多源强制/sourceTypes 判定矩阵/冲突结构校验（positions ≥2/refs ∈ 候选集）/uncertainty 块                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | C6   |
| research-prompts.test.ts    | 合成提示词恒等断言（编译期常量）/UNTRUSTED 块闭合转义/预算裁剪/与共读・Agent system prompt 互不混用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | C6   |
| research-runtime.test.ts    | 四阶段顺序与每 phase 心跳/六工具子集恒等 + 未知工具/非法参数/跨任务与未知 candidate/tab 安全结果/UUID v4 预分配与冲突 fail-closed/ResearchPlan 白名单矩阵（来源模式互斥/groupId·candidateId 只能引用程序集合/webQueries ≤1/重提与安全默认计划）/24 候选·8 选择·16 Capture·60 Evidence/capture attempts 与 stats 精确对应/Sources-only 与 Search-only 降级 + Sources 不可用失败/模型轮重试与连续失败计数/context-too-long 裁剪重试/step·round 边界上最后一次合法调用与溢出调用零执行/stop 与 Provider done、timeout、终态提交竞态/restart 不得与旧 run settling 重叠/late event·late tool result·late DB write 全 no-op/progress 首尾·去重·listener throw/每个终态 cleanupAll + 用户 Tab 集合恒等/shutdown·dispose 幂等与 database-closed race/Candidate·Capture·Evidence·stats 原子回滚/Result+completed 同事务/500k 终态预留边界/CaptureContent·transcript·reasoning 零持久化/终态优先级（stop>timeout>budget）/终态单一所有权与 runToken 守卫（决议 #132–#138） | C5   |
| result-validator.test.ts    | 判别联合逐块校验矩阵/长度边界/表格行列界/ranking rank 连续/evidenceId 存在与归属/sourceRefs ∈ 候选集/URL 白名单/未知 kind 拒绝/失败语义回注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C7   |
| markdown-parse.test.ts      | 子集解析矩阵/raw HTML 关闭（`<script>`/`<img onerror>` 形态纯文本）/URL 白名单（javascript:/data: 拒绝）/转义与 bidi 剔除/超预算安全降级                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | C7   |
| csv-serializer.test.ts      | 公式注入（=,+,-,@ 前缀 `'` 转义）/CRLF 与引号转义/UTF-8 BOM/空表与超长单元格截断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | C8   |
| research-ipc.test.ts        | 载荷白名单矩阵（未知字段/超长/非法 id）/状态门控（running 不可 delete）/export 通道无 renderer 路径参数/审计恰好一条脱敏                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | C8   |

### 13.2 冒烟矩阵（Electron 真实启动，临时 userData；dev+生产双场景）

| #    | 场景                  | 断言要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 任务  |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 8.16 | capture/evidence 场景 | 受控页夹具（多章节/≥2 表格/heading/link 字段）：真实 ResearchWorkspace + CaptureService 读取 → capture 记录断言（实际 documentId/accessTime/hash/summary/tableIndex）；FakeProvider 只产确定性 proposal JSON（正确引用 → verified；伪造摘录/错绑 capture/错误 tableIndex/越界 → rejected）；失败 URL 后继续读取下一候选成功（C4 内不改 failedReadCount）；Capture 元数据 + 少量 VerifiedEvidence 写入临时 research.db（未验证引用零落库）；正文零持久化探针（拆分标记只存在于 CaptureContent、不进日志，扫描 research.db/WAL/SHM/Research 文件/隔离 userData 零命中）；场景 finally 精确释放 task Tab + 关闭库 + 清理隔离目录 + 用户 Tab 集合不变 | C4    |
| 8.17 | Runtime 场景          | FakeProvider 多轮脚本驱动全阶段（planning→reading→verifying→synthesizing）→ completed + 候选/Capture/VerifiedEvidence/Result 落库读回 + CaptureContent 正文零落盘 + 用户 Tab 集合前后恒等；stop 中途 → cancelled + 本任务 Tab 清理 + 用户 Tab 保留；预算注入用尽 → failed（research-budget-exhausted）+ 此前 Evidence 保留；终态后迟到事件零影响（决议 #132–#139）                                                                                                                                                                                                                                                                                | C5    |
| 8.18 | 综合场景              | 两冲突夹具来源 + 冲突页：claims 装配/冲突显式保留/uncertainty 块产出/Result 含 coverage 计数（无百分比字段断言）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | C6    |
| 8.19 | UI DOM 场景           | 真实 DOM：侧栏创建/启动/进度渐进/停止；结果画布 Table 排序/筛选/复制/Cards/Ranking 渲染/Evidence 下钻（点击结论看来源）；敌对 Markdown 文本纯文本渲染零 DOM 注入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | C7/C8 |
| 8.20 | 红队 FRT-01～FRT-12   | threat-model §4 矩阵全表（dev+生产双场景，每项独立断言）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | C9    |

- 双进程持久化：`AIBROWSE_RESEARCH_SMOKE=set|check`（与
  SESSION/SOURCES/SOURCES_UI 门控确定性互斥；两独立生产进程共用受控共享
  临时 userData——set 经**产品 Service/Runtime 路径**（SMOKE 注入确定性
  stub 端口 + FakeProvider）创建完成一个任务（completed + Result 落库）
  再让一个任务在真实 phase heartbeat 后遗留 running 直接退出；check 新
  进程启动时验证前者可读、后者自动变 interrupted；不允许用测试 SQL 直接
  伪造核心产品状态；结束后零 Electron 进程/零临时数据库/根目录日志零
  残留）——C5 起启用（决议 #139）。
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

> 以下 #120–#123 为 C3 实施前契约裁决（2026-08-16，C3 闭环；先改本文与
> 测试、再改实现——§15 流程）。C3 任务文档「实施前复核项」四项（§4.2 五档
> 可达性/note 映射/candidate_id 生成/sortKey 字典序）逐一裁决；裁决依据
> Fifth_stage.md §3.2 上位需求、决议 #49/#58/#59/#61 既有 Sources 契约、
> §9.1 `ORDER BY sort_key ASC, candidate_id ASC` 既有存储契约与 threat-model
> FT-07（provenance 诚实）唯一裁决，无需用户拍板。**不改写 #101–#119 既有
> 结论**；§4 旧「五档（tier 1–5）」描述就此废止（档位 3/5 对合法 merge 输出
> 不可达——合法 Sources 候选的 trust 不变量为 user+asserted 或 ai+unverified，
> 档位 1/2 条件已覆盖全部收藏命中）。

120. **三档发现路径排序（废止五档描述）**：候选排序改为三个互斥、可达的
     「发现路径档位」（discovery-tier，§4.2）：
     （1）**tier 1 — source-search**：来自
     `SourceService.search(..., audience='agent')`；保留 SourceService
     已确定的输入顺序（该顺序已包含决议 #61 匹配档位、priority、
     lastUsedAt、scope/canonicalKey/id 全序）；note 命中通过上游 #61 搜索
     排名参与选择；C3 不解析 note 文本、不把 note 写进 sortKey。
     （2）**tier 2 — group-list**：来自
     `SourceService.list(groupId, enabledOnly=true, audience='agent')`
     （场景 1「只看某个分组」）；同档内 priority 降序、lastUsedAt 降序、
     scope/canonicalKey/id 收尾。
     （3）**tier 3 — web-search**：仅由 SearchProvider 发现、没有合法
     Sources 身份的候选；保留 SearchProvider 结果顺序；trust/priority/
     lastUsedAt/note 恒 null。
     Sources + Search 同一 page 身份合并后采用 **Sources 档位与 Sources
     字段**，同时保留 `discoveredVia = ['sources','search']`。
     语义说明（同步至 §4 与 threat-model）：
     - 这是**来源选择顺序**，不是可信度或质量评分；
     - trust.value/assertedBy/verification 仅作为 provenance 元数据，
       不改变基础排序；
     - user+asserted 不等于事实已由程序核验；ai+unverified 永远显示为
       未核验；
     - official/primary/community 的进一步选择与构成控制由 C5 有界计划
       调整（模型提议、程序执行）和 C6 sourceTypes/交叉核验承担；
     - Fifth_stage.md §3.2 是选择策略建议，C3 在不修改冻结 Sources 契约
       的前提下，通过 source-search 上游排序、group 限定、Search 补充及
       C5 有界调整实现；
     - 不修改 SourceService/SearchProvider 的现有类型或行为。
       旧「档位 4/5」删除；不存在「tier 4/5」可达测试。

121. **note 映射（SourceSearchItem.note → SourceCandidate.note）**：
     - group-list 与 search-only 候选：note = null；
     - source-search 候选（§4.4 精确规则）：userNote 非空 →
       `用户备注：${text}`；aiNote 非空 → `AI 备注：${text}`；两者都有时
       按「用户备注 → AI 备注」顺序以换行连接；先做 NFC、trim、控制/bidi
       字符清洗；标签、换行和正文共同计入 MAX_CANDIDATE_NOTE_CHARS
       （String.length）；截断不得拆开 UTF-16 surrogate pair；最终同时
       满足 String.length ≤ MAX_CANDIDATE_NOTE_CHARS；若第二段因预算完全
       放不下，不得留下无正文的作者标签；
     - note 只展示/持久化，不进 sortKey、不进入模型上下文；
     - 不得把 userNote 与 aiNote 混成无法识别作者的一段文本。

122. **candidate_id 输入契约（SourceSelector 保持纯函数）**：C3 不调用
     randomUUID、不接收有状态 idFactory；输入条目由未来 C5 主进程调用方
     预先分配 candidateId：
     - Sources 条目 `{ candidateId, item }`、Search 条目
       `{ candidateId, result }`；
     - candidateId 必须是小写 RFC 4122 UUID 形状（含 version 4/variant
       位，与主进程 randomUUID 输出一致；大写 UUID 拒绝）；
     - 原始输入中的 candidateId 必须全局互不重复；
     - **非法或重复 ID → 整次 merge fail-closed**（错误码
       candidate-invalid-input / candidate-id-conflict，§4.1）；
     - 不得以 canonicalKey、URL、sourceId 或数组序号充当 candidate_id；
     - 同身份 Sources + Search 合并时采用 Sources 条目的 candidateId；
       未采用的 Search candidateId 安全丢弃；
     - 不同 task 由 C5 每次生成新的 UUID，避免 research_candidates 全局
       主键冲突；
     - 相同输入及相同预分配 ID → 输出完全确定。
       §4.1 精确接口（SourcesCandidateFeed/WebSearchCandidateEntry/
       MergeCandidatesInput/MergeCandidatesResult）为 C3 实现契约，命名可
       因现有 TypeScript 风格小幅调整，语义不得改变。

123. **sortKey 编码（§4.5 精确规则）**：ResearchRepository 使用
     `ORDER BY sort_key ASC, candidate_id ASC`，因此 sortKey 必须自身以
     ASCII 字典序表达全部顺序（不得生成「看起来正确但 ASC 实际反转」的
     字符串）。固定结构
     `TT|RRRRR|P|IIIIIIIIIIIIIIIIIIIIIIII|S|canonicalKey|candidateId`：
     - TT：tier，01/02/03；
     - RRRRR：source-search/web-search 使用原输入 rank（零起点、5 位补
       零；rank ≥ 100000 防御性 clamp 至 99999——输入有界不可达）；
       group-list 使用固定 99999；
     - P：priority 1–5 编码为 6-priority（5→1、1→5）；null/非法值编码 9；
     - I：合法 ISO 时间先规范化为 UTC toISOString()；每个数字 d 替换为
       9-d，得到反向时间字典序（新时间排前）；标点原位保留；null/非法
       时间使用固定长度 `~~~~~~~~~~~~~~~~~~~~~~~~`（24 个 `~`），保证排在
       最后；
     - S：origin=0，page=1；
     - canonicalKey：必须来自 normalizeSourceUrl（WHATWG 序列化保持
       ASCII）；
     - candidateId：小写 UUID。
       比较必须使用原始二元 `<`/`>`（不得使用 localeCompare），保证与
       SQLite BINARY 排序一致（sortKey 全 ASCII，JS UTF-16 code unit 序与
       SQLite UTF-8 字节序一致）。lastUsedAt 非法时：Candidate 字段降级为
       null、sortKey 使用 null sentinel、不抛异常。必须通过真实
       node:sqlite 测试证明：内存按 sortKey ASC 的顺序 ===
       ResearchRepository.listCandidatesByTask() 顺序。

> 以下 #124–#130 为 C4 实施前契约裁决（2026-08-16，C4 闭环；先改本文与测试、
> 再改实现——§15 流程）。当前 §5 的草案（loadURL 双导航/throw 式失败控制流/
> 单表 locator/模型直接构造 Evidence）不能直接实现——逐项裁决并同步修正
> §2/§5/§6.4/§6.7/§6.8/§9.1/§13.1、threat-model 与 C4 任务文档。裁决依据
> Fifth_stage.md §3.3/§3.4 上位需求、threat-model FT-03/04/05/06/09/10/14/
> 15/16/17、决议 #118/#119 既有 Workspace 契约与 fail-closed 纪律唯一导出，
> 无需用户拍板；不改写 #101–#123 既有结论。

124. **Tab 生命周期与最小端口（禁双导航）**：C2 契约中
     `ResearchWorkspace.acquire(candidate.url, signal)` 已通过
     `BrowserController.createTab(url)` 创建任务 Tab 并开始加载页面
     （browser-controller.ts:95 `loadURL`）。C4 不得再次调用
     navigate/loadURL/reload——否则产生双导航与竞态。CaptureService 的
     浏览器最小端口只保留读取所需能力：
     `{ getTabs(): Promise<TabInfo[]>; getPageSnapshot(tabId): Promise<PageSnapshot | null> }`
     （BrowserControllerImpl 结构兼容，typecheck 保证）。Tab 的创建、归属、
     检查、释放全部通过 ResearchWorkspace（acquire/checkTab/release）；
     每次尝试必须 `acquire → ready 轮询 → checkTab → snapshot →
checkTab → finally release`。release 失败（ok:false cleanup-failed）
     不得误报已清理——保留 Workspace 所有权供 C5 终态 cleanupAll 重试；
     若内容已成功捕获，release 失败只产生安全 warning（不得丢弃已经完成的
     Capture、不得把成功改判失败）。

125. **精确读取结果与重试矩阵（禁 throw 作预期失败控制流）**：C4 冻结
     判别联合，任何预期失败都不以异常表达（未预期内部异常才 catch 归一）。
     读取结果必须同时返回每次尝试的 Capture：
     - 成功：`{ ok:true; attempts: Capture[]; capture: Capture; content:
CaptureContent; warnings: string[] }`（capture = attempts 最后一项，
       恒 failed=false）；
     - 失败：`{ ok:false; attempts: Capture[]; failureReason:
CaptureFailureReason; warnings: string[] }`（failureReason =
       最后一次失败尝试的 failureReason；无任何尝试完成的内部异常归一为
       page-load-failed）。
       同一候选最多 2 次尝试（MAX_PAGE_READ_RETRIES=1）；每次尝试生成独立
       captureId；重试必须重新 acquire（新 tabId），绝不复用旧 Tab。重试矩阵：
     - page-load-failed / timeout / snapshot-degraded：最多重试一次；
     - aborted / http-scheme-rejected / tab-closed-by-user：不重试；
     - Workspace cleanup-failed（acquire/checkTab/release 报出）：不继续
       创建更多 Tab——映射为失败并附不含 URL/正文的 warning（所有权保留
       由 cleanupAll 重试）；
     - 其他可恢复的创建/读取异常：归一为 page-load-failed，可重试一次。
       每个失败尝试都计入 attempts；C4 **不直接修改 ResearchTask.stats**
       （captureCount/failedReadCount 的持久化递增属于 C5 Runtime 编排——
       本任务冒烟只证明「失败后下一候选仍可继续读取」）。Capture ID 必须由
       主进程可信输入或注入式 UUID v4 工厂产生（构造注入 `createCaptureId`，
       缺省 randomUUID），模型不得提供。

126. **failed Capture 的非空字段语义（sentinel 冻结）**：schema v1 中
     tabId/documentId/contentHash 非空（NOT NULL），migration v1 不得改写，
     因此冻结失败记录的确定性语义：
     - Tab 尚未分配：tabId = 编译期 sentinel `unallocated`；
     - 快照不存在：documentId = 编译期 sentinel `unavailable`；
     - 无正文：contentHash = SHA-256(UTF-8 空字符串) 的前 32 个小写 hex
       （编译期常量，单测固化）；
     - summary 四项全部为 0；
     - url/title 使用已校验的候选展示值（不取自失败页面）；
     - accessTime 使用注入主进程时钟（ISO 8601）；
     - failed=true，failureReason 必须非 null。
       sentinel 只能出现在 failed Capture；EvidenceValidator 必须**先拒绝
       failed Capture**，绝不能把 sentinel 组装进 VerifiedEvidence（FT-03/04）。

127. **ready、L0–L3 与页面关闭映射（冻结）**：复用 SearchProvider 的
     轮询模式，但不得复制其私有实现、不得修改 SearchProvider。
     `READY_TIMEOUT_MS=15000`、poll 间隔、sleep、时钟均可注入；
     AbortSignal 必须贯穿（abort 感知睡眠，零定时器/监听器泄漏）。冻结映射：
     - Tab state=ready：允许快照；
     - state=error：page-load-failed；
     - Tab 从列表消失 / checkTab=closed：tab-closed-by-user；
     - 超时：timeout；
     - abort：aborted；
     - L0（none）：成功；
     - L1（partial）：成功并附降级 warning；
     - L2（main-process-only）：snapshot-degraded（可重试一次）；
     - getPageSnapshot=null（L3）：**再次 checkTab**——已关闭为
       tab-closed-by-user，否则 snapshot-degraded；
     - 非法 capturedAt/documentId/快照形状：snapshot-degraded。
       snapshot 返回后、接纳内容前再次检查 signal 与 checkTab——防止用户在
       快照期间关闭 Tab 或取消任务。成功 Capture：url/title 取实际快照
       （不取模型/候选输入）；最终 URL 必须重新验证为安全 http/https 且无
       userinfo（非法重定向映射 http-scheme-rejected）；
       accessTime = 合法 snapshot.meta.capturedAt 转 ISO（主进程盖章）；
       documentId = String(snapshot.meta.documentId)（要求非负整数）。

128. **CaptureContent 与字段路径（闭合集合）**：禁止修改 PageSnapshot
     采集管线，禁止新建 DOM/JS/IPC 采集通道。定义纯内存 CaptureContent
     （仅在 read 成功时随结果返回，任务终态丢弃，零落盘）：
     - canonicalText：有类型标签、顺序固定的串行格式，按固定来源顺序
       `visibleText → headings → tables（表头 + row-major 单元格）→
links` 构造，≤ MAX_PAGE_CAPTURE_CHARS（60k）确定性截断；
     - textSections：非空章节数组（每节独立规范化）；
     - tables：保留的表格数组（表头 + 数据行，规范化后）；
     - fields：闭合字段路径映射（编译期白名单，见下）。
       只能从现有 PageSnapshot 的 url/title/visibleText/headings/links/
       tables 构造。字段路径闭合集合（不支持任意网页字段）：
       `page.url` / `page.title` / `headings[0].text` / `links[0].text` /
       `links[0].href`；表格字段使用固定数组索引路径（如
       `tables[0].cell[1][2]`——tableIndex/row/col 均为非负整数字面量），
       不得解析任意对象路径、原型链或执行表达式。规范化固定为 NFC、trim、
       控制字符/bidi 清除、连续空白折叠（复用 sanitize 同族规则）；不做
       模糊匹配、大小写猜测或语义匹配。**所有可被 EvidenceValidator 引用的
       section/table/field 值都必须实际进入 canonicalText 的 60k 预算和哈希
       覆盖范围**；预算耗尽后不得继续保留「未进入哈希」的表格、字段或章节。
       固定 summary：sectionCount = 实际保留的非空 textSections 数；
       tableCount = 实际保留的表格数量（不是单元格数量——同步修正 shared
       类型中「行×列合计」的歧义注释）；headingCount = 实际保留的 heading 数；
       charCount = 最终 canonicalText.length。contentHash = SHA-256(UTF-8
       canonicalText) 前 32 个小写 hex。正文和完整快照只存在于内存
       CaptureContent，不进入 Capture、Repository、日志或会话文件（FT-14/16）。

129. **多表 Evidence locator（tableIndex 修复）**：当前
     `EvidenceLocator.table` 只有 row/col/header，多表页面无法唯一定位。
     冻结 `{ kind:'table'; tableIndex: number; row: number; col: number;
header: string | null }`——tableIndex/row/col 均为 0-based 非负整数
     （row 指数据行，不含 header）。同步修改：shared/types/research.ts、
     ResearchRepository.parseLocatorJson、对应 repository 测试、§2/§5、
     C4 测试。缺失、负数、非整数、字符串或超界 tableIndex 全部 fail-closed
     （parseLocatorJson 返回 null：读取路径跳过该行、Repository 写入对应
     Evidence 整体拒绝零落库）。header 的 #115 契约保持：仅 string/null/
     缺省合法；非法对象、数组、数字、布尔使整个 locator 无效。
     locator_json 本来就是 JSON——不修改 migration v1、不新增 SQL、
     不做 schema v2。

130. **EvidenceProposal 与验证输出（不可信 proposal 类型）**：模型输入
     必须使用独立的「不可信 proposal」类型，不能让模型直接构造 Evidence。
     proposal 只允许六个字段：`{ captureId, candidateId, type, locator,
excerpt, value }`（excerpt/value 按类型配对允许 null/缺省）；
     evidenceId 由可信调用方预分配并作为 validator 上下文传入；taskId/
     sourceId/url/title/accessTime/documentId/contentHash/verification
     全部不得由 proposal 提供——未知字段 fail-closed。验证结果冻结为：
     `{ ok:true; evidence: VerifiedEvidence }` 或
     `{ ok:false; code: EvidenceRejectionCode; reason: string }`——
     rejected 结果不是 Evidence，不进 Evidence 集合、不落库；reason 必须是
     闭合错误码对应的安全中文短句（≤200 字符），不回显正文、URL query 或
     敌对字段。校验顺序（全部通过才组装）：
     ① proposal 形状、字段长度、type/locator 组合合法；
     ② capture 属于当前 task 且 failed=false（sentinel 先拒）；
     ③ candidate 存在且 capture.candidateId === proposal.candidateId；
     ④ 对应 CaptureContent 存在且绑定同一 captureId；
     ⑤ locator/value/excerpt 内容验证；
     ⑥ 程序组装 VerifiedEvidence（evidenceId 取可信上下文，其余
     provenance 字段全部从成功 Capture 取）。
     类型配对：quote / summary-point → text locator，value 必须 null/缺省；
     table-cell → table locator；field → field locator。text 校验：
     locator.excerpt 与 proposal.excerpt 规范化后必须一致；非空且 ≤
     MAX_EVIDENCE_EXCERPT_CHARS；必须是某一个独立 canonical text
     section 的连续规范化子串（不允许跨 section 拼接，不允许模糊/语义/
     大小写猜测匹配）。table 校验：tableIndex/row/col 全部在界内；row 指
     数据行不含 header；程序取得真实单元格值——proposal.value/excerpt
     规范化后必须与受控真实值完全一致；输出 locator.header 由程序根据
     真实表头生成（无表头时为 null），若 proposal 提供非空 header 还必须
     与真实表头一致（不一致拒绝）。field 校验：fieldPath 必须精确存在于
     闭合 fields map；proposal.value/excerpt 与该字段规范值完全一致；
     禁止前缀、通配符、动态路径、原型链键（`__proto__`/constructor/
     prototype 恒拒绝）。VerifiedEvidence 的 sourceId 从候选取；验证纯
     函数在相同上下文、相同可信 evidenceId、相同 proposal 下输出恒等
     （幂等，无随机、无时钟副作用）。

131. **Chromium 错误页判定（C4 冒烟实测发现的契约缺口，2026-08-16）**：
     Chromium 加载失败（连接拒绝/重定向过多等）后渲染的内建错误页自身会
     完成 did-finish-load——tab-state 状态机 finish-load 从任意状态转
     ready，实测翻转窗口（约 8ms）小于 ready 轮询间隔（50ms），「state=error
     → page-load-failed」快速路径捕捉不到；错误页快照会被当作成功读取
     （FT-03/04：错误内容冒充页面内容）。冒烟探针实测错误页快照特征：
     `url = chrome-error://chromewebdata/`（采集脚本 location.href）、
     title = 失败 URL、readyState=complete、degraded=none（L0）、
     visibleText/headings/links 全空、documentId 世代不变。冻结判定：
     **快照最终 URL 校验失败时，若快照 url 以 `chrome-error://` 开头 →
     page-load-failed（可重试一次——网络抖动可能恢复）；其余非法目标
     （重定向到非法 scheme/userinfo）→ http-scheme-rejected（不重试）**。
     error 快速失败路径保持（覆盖 error 持续场景）；不得把错误页快照组装
     为成功 Capture。

> 以下 #132–#139 为 C5 实施前契约裁决（2026-08-16，C5 闭环；先改本文与测试、
> 再改实现——§15 流程）。当前 §6 草案不足以直接编码：六工具执行模型、
> 规划判别联合、C6/C7 端口、Service/Runtime 异步装配、预算计数、原子持久化
> 与终态预留、Progress/心跳/竞态、index.ts 装配八项缺口逐一裁决。裁决依据
> Fifth_stage.md §4/§9/§10 上位需求、threat-model FT-03/04/09/10/14/15/16/17、
> 决议 #94/#95/#96/#103/#104/#105/#106/#107/#108/#118/#122/#125 既有条款与
> fail-closed 纪律唯一导出，无需用户拍板；不改写 #94–#131 既有结论。§6 已
> 按本节重写。

132. **Research 六工具专属执行模型（不经 ToolRegistry/ToolExecutor）**：
     （1）**编译期固定集合**：`RESEARCH_TOOL_NAMES =
['browser_open','browser_read','search_web','source_search',
'source_list','source_get']`（shared/types/research.ts 常量，单一
     事实源）。Research 模型轮请求的 tools 恒为该集合序列化（`RESEARCH_
TOOL_DEFINITIONS`，research 模块编译期常量）——**名称、wire 形状
     （TOOL_NAME_PATTERN，决议 #35）与参数基础形状（属性名/类型/required）
     与注册表同名工具一致**（单元测试交叉断言：注册表 getTool(name)
     存在且参数 schema 与 Research 定义逐项一致——运行时**不 import** 注册表，
     零耦合）；**description 与执行器为 Research 专属**（语义不同：描述按
     Research 语义重写；执行器不经 ToolExecutor/权限链/ConfirmManager/
     审计管线——决议 #94/#95 保持）。六工具全部只读：无 click/fill/scroll/
     navigate/apply_changes（决议 #96 保持）。
     （2）**执行语义冻结**：
     - `browser_open`（参数 `{ url }` 必填）：**只能读取已进入当前任务候选
       集合的 URL**——url 与候选 displayUrl 或 url 精确匹配（规范化比较），
       未命中候选集合 → 安全工具结果（`not-allowed-url` 语义），零 Tab 创建、
       零网络。命中 → 经 `CaptureService.read(candidate, signal)` 执行
       （acquire→ready→checkTab→snapshot→release 全链路，C4 契约），每次
       调用产生 Capture 记录（含失败 sentinel）并计 1 步。
     - `browser_read`（参数 `{ tabId }` 可选）：**只能返回当前任务、当前
       运行中已由 CaptureService 获取并保存在内存的 CaptureContent**
       （Runtime 维护 tabId→captureId 内容索引）。不得直接调用
       BrowserController；未知 tabId/跨任务 tabId/已过期（本 run 未捕获过
       的）tabId → 安全工具结果（`not-found` 语义），零浏览器调用。返回
       内容为确定性有界序列化（不返回 canonicalText 全文——按
       RESEARCH_TOOL_RESULT_CONTENT_MAX 截断摘要形态），且**只进
       UNTRUSTED_TOOL_RESULT 块**。
     - `search_web`（参数 `{ query }` 必填）：直接调用注入的
       `SearchProvider.search(query, signal)`；查询串 ≤
       SEARCH_QUERY_MAX_LENGTH（500，复用 A4 常量语义）；失败返回安全工具
       结果（结构化失败，不 throw）。
     - `source_search`/`source_list`/`source_get`：直接调用注入的
       `SourceService.search/list/get`，**audience 恒 'agent'**
       （Runtime 硬编码，模型参数不可选择）；参数形状与注册表一致
       （source_search {query,limit?} / source_list {groupId?,page?,
       pageSize?} / source_get {id}）；结果经 Research 专属有界序列化。
       （3）**未知工具/子集外工具/非法参数**：返回安全的工具结果文本
       （结构化 JSON 形状 `{ok:false, error:'unknown-tool'|'invalid-args'}`），
       **不执行、不 throw、不产生失控 rejection**（逐条 try/catch 归一）。
       非法参数判定复用 Research 工具定义的参数白名单（类型/长度/URL 形状/
       query 上限），不 import ToolRegistry。
       （4）_\*browser_* 不得绕过预算_*：browser_open 的每次 CaptureService.read
       计 1 步（stepsUsed 前置检查，超限零执行）；browser_read 零外部调用
       （内存读取不计步）。
       （5）**C4 release 契约不变**：每次读取结束释放 task Tab（C4 决议
       #124/#125）；browser_read 读取的是内存 CaptureContent，不重新 acquire、
       不为 C5 修改为长期保留 Tab。
       （6）工具结果文本预算：单条 tool result 序列化 ≤
       RESEARCH_TOOL_RESULT_CONTENT_MAX（8000 字符，编译期常量，shared/
       types/research.ts）——确定性截断 + 标记；不进日志/UI/持久化（只进
       模型回放消息）。

133. **ResearchPlan 判别联合与候选生成**：
     （1）**类型冻结**（shared/types/research.ts）：

     ```ts
     export const MAX_PLAN_WEB_QUERIES = 1; // C5 基线（决议 #133：小型编译期上限）
     export interface ResearchPlan {
       sourceMode: 'search' | 'group';
       sourceQuery: string; // search 模式必填非空 ≤SEARCH_QUERY_MAX_LENGTH；group 模式必须空串/缺省
       groupId: string | null; // 仅 group 模式非 null；必须 ∈ 程序提供的 group 集合
       webQueries: string[]; // ≤MAX_PLAN_WEB_QUERIES；每项非空 ≤SEARCH_QUERY_MAX_LENGTH
       selectedCandidateIds: string[]; // ≤MAX_SELECTED_SOURCES；必须 ⊆ 已合并候选集合（引用集合不存在时（轮 1）必须空）
     }
     ```

     （2）**两轮计划（决议 #96/§6.2「可选 1–2 轮」落点）**：
     - **轮 1（候选查询计划）**：planning 上下文 = goal + Sources 分组列表
       （groupId+name，经有界序列化进 UNTRUSTED 块）→ 模型产出 plan JSON；
       `selectedCandidateIds` 在轮 1 必须空/缺省（引用的候选集合尚不存在，
       非空 → 整计划非法）。Runtime 按 plan 执行候选收集。
     - **轮 2（选择意图，候选合并后）**：候选元数据（≤24 条、白名单字段、
       有界序列化）进 UNTRUSTED 块 → 模型产出 `selectedCandidateIds`；
       其余字段在轮 2 忽略。轮 2 缺失/解析非法 → 程序默认（§133(6)）。
     - **每逻辑模型轮最多重试一次**（解析失败回注安全原因重提；决议 #136）。
       （3）**所有模型字段视为不可信输入**：逐字段类型/白名单/长度/字符清洗
       校验（JSON.parse 失败/非对象/未知字段/数量超限/字符串未通过清洗后
       为空 → 整计划非法）。`groupId` 只能引用程序在轮 1 上下文提供的 group
       集合（未命中 → 整计划非法）；`candidateId`（selectedCandidateIds）
       只能引用已合并候选集合（未命中 → 整计划非法——模型不得重新发明 URL、
       不得绕过 provenance 与基础边界）。
       （4）**candidateId 预分配（决议 #122 落点）**：C5 为每个 Sources feed
       条目与每个 Search 条目预分配**全局唯一的小写 RFC 4122 v4 candidateId**
       （主进程 randomUUID；同一次 merge 输入内互不相同）；非法或重复 →
       整轮 fail-closed（candidate-invalid-input/candidate-id-conflict →
       该轮归一为安全默认计划 + warn，不终止任务）。
       （5）**候选收集**：
     - `sourceMode='search'` → `SourceService.search(sourceQuery,
{audience:'agent'})`（limit ≤10）；`sourceMode='group'` →
       `SourceService.list({groupId, enabledOnly:true, audience:'agent',
page:0, pageSize:≤20})`（有界分页）。
     - **Sources 输入一次只能是 source-search 或 group-list**（判别联合
       `SourcesCandidateFeed` 互斥，C3 契约；不得伪造两者同时输入）。
     - `webQueries` 每项 → `SearchProvider.search(query, signal)`；
       **SearchProvider 失败（search-failed）允许 Sources-only 降级**
       （warnings 记录，任务继续）；**SourceService 检索异常/错误 → 任务
       failed（research-sources-unavailable）**（启动前置已校验 normal
       态，运行中失败属异常路径——§6.4 既有语义）。
     - 合并 `mergeCandidates` → 排序 → 截断 ≤MAX_SOURCE_CANDIDATES(24) →
       持久化候选（同事务 stats.candidateCount=持久化候选数）。
       （6）**选定裁剪**：最终选定 = 程序按 sortKey（+candidateId 收尾）排序
       的合并候选 ∩（模型轮 2 提供的 selectedCandidateIds 非空时为该 id
       集合）→ 截断 ≤MAX_SELECTED_SOURCES(8)；轮 2 缺失/非法 → 程序默认
       前 8（§4.6 selectCandidates）。持久化 selectedCount=最终选定数。
       （7）**计划非法兜底**：轮 1 重提仍非法 → 安全默认计划
       `{sourceMode:'search', sourceQuery: truncateWithMark(goal,
SEARCH_QUERY_MAX_LENGTH), groupId:null, webQueries:[], selected
CandidateIds:[]}`（零网络搜索、仅 Sources 检索——Sources-only 合法
       降级语义；Sources 亦不可用 → research-sources-unavailable 终态）。
       安全默认计划不引用模型任何输出。

134. **C6/C7 稳定端口与 fail-closed 装配（C5 定义、C6/C7 替换）**：
     （1）**Runtime 职责**：生命周期、Provider 轮次、Research 工具调度、
     预算、持久化编排与终态单一所有权。规划/提取/Claim/Conflict/综合的
     提示词与解析（C6）、Result 校验（C7）经注入端口消费。
     （2）**端口冻结**（定义于 research-runtime.ts，形状进 shared/types/
     research.ts 供 C6/C7 引用）：

     ```ts
     // 阶段提示词（C6 research-prompts 提供真实常量；四槽）
     export interface ResearchPromptsPort {
       planning: string;
       reading: string;
       verifying: string;
       synthesizing: string;
     }
     // 合成端口（C6 claim-model/research-prompts 替换实现）
     export interface ResearchSynthesisPort {
       // verifying 轮模型文本 → 已确定性装配、可持久化的 claims/conflicts
       // （coverage/sourceTypes/positions≥2/refs∈候选集校验全部在端口内完成）
       processVerification(
         raw: string,
         ctx: ResearchSynthesisContext,
       ): { ok: true; claims: Claim[]; conflicts: Conflict[] } | { ok: false; reason: string }; // 安全中文 ≤200
       // synthesizing 轮模型文本 → Result 草案（原始 JSON，交 C7 端口校验）
       parseResultDraft(raw: string): { ok: true; draft: unknown } | { ok: false; reason: string };
     }
     // C7 结果校验端口（result-validator 实现）
     export interface ResearchResultValidationPort {
       validate(
         draft: unknown,
         ctx: ResearchResultValidationContext,
       ): { ok: true; result: ResearchResult } | { ok: false; reasons: string[] }; // 回注：块索引 + 安全中文原因
     }
     ```

     （3）**fail-closed 装配**：C5 单元测试与 8.17/双进程冒烟注入**确定性
     stub**（测试设施）；产品装配（index.ts）在真实 C6/C7 不存在时必须
     **不提供端口 → 不建立 Runtime**——不得设置「永远有效」的生产默认
     实现，不得把未验证模型输出写入 ResearchResult。新增错误码
     `research-runtime-unavailable`（ResearchErrorCode 第 12 码，扩展决议
     #108 的 11 码结论——#108 不改写）：Runtime 未装配/无法构造（生产
     C6/C7 端口缺失或端口构造失败）→ startTask 拒绝（前置检查层，不改变
     任务状态）；中文文案进 research-errors.ts 单一事实源。
     （4）**C6/C7 任务文档替换边界校准**（本轮登记，不实现 C6/C7）：
     - C6 的 research-prompts 常量由三个扩展为**四个**（新增
       `AGENT_RESEARCH_VERIFYING_PROMPT`——verifying 轮独立槽位；
       §7.4 与 C6 任务文档同步）；claim-model 实现
       `ResearchSynthesisPort.processVerification`；parseResultDraft
       为 C6 范围（解析 JSON 草案形状，语义校验归 C7）。
     - C7 的 result-validator 实现 `ResearchResultValidationPort.
validate`（§8.1 校验规则不变）；C7 任务文档登记端口形状来源。

135. **Service/Runtime/Provider 异步装配与单一 active run**：
     （1）**startTask 异步语义**：全部**无副作用前置检查**（单 running 互斥/
     Sources normal/Provider 已配置且 supportsToolCalling/**Runtime 已装配**
     /goal 非空）成功后：单事务内把任务切换为 running（C1 既有
     setTaskRunning 路径）+ 启动后台 Runtime（`void run().catch(...)`），
     **startTask 立即返回**（不等待最长 30 分钟）；前置失败不改变任务状态
     （决议 #107 保持）。
     （2）**Provider/config/key/tool-support 检查在进入 running 前完成**：
     注入**异步** `ResearchRuntimeFactory`（`create(ctx) →
Promise<ResearchRuntimeHandle | null>`，null=Provider 不可用）与
     `ProviderResolver`（异步解析 LLMProvider：config+credential 检查、
     supportsToolCalling 检查、无 Key → null）。resolve 失败 →
     startTask 返回 research-provider-unavailable（任务保持原状态，零
     running 残留）。factory/launch 异常 → 立即写 failed（errorCode=
     research-runtime-unavailable 或归一化码）+ 释放 active slot——
     **不得留下永久 running**。
     （3）**active slot**：Service 内存单槽 `{ taskId, runToken, runtime,
done: Promise<void> } | null`；同时最多一个 active run；runToken =
     每次启动新生成的 UUID（运行身份）。**restart 屏障**：stop 请求后、
     且数据库已写 cancelled 时，**旧 run 的 done 完全 settle 前 startTask
     拒绝（research-busy）**——schema 没有 runId，旧 run 的迟到写入只能
     靠「旧 run 完全退出后才允许新 run」+ 运行身份守卫防污染。
     （4）**终态单一写入者**：Runtime 是 completed/failed/cancelled 终态
     的唯一写入者；`Service.stopTask` 只**请求 abort**（幂等：向对应
     runToken 的 runtime 发 abort）并读取/返回最新任务状态，**不与
     Runtime 竞争写终态**（C1 的 stopTask 直接写 cancelled 语义由 C5 改造：
     数据库终态写入移交给 Runtime；stopTask 返回当前状态快照）。
     （5）**active slot 清除**：只能由同一运行实例在 `finally` 中按
     identity/CAS 清除（`if (slot?.runToken === myToken) slot = null`）。
     （6）**异步边界守卫**：每个异步边界与最终提交前重新检查——signal
     未 aborted、数据库任务仍 running（重新读任务行）、运行身份仍有效
     （runToken 匹配）；任一不满足 → 中止写入、走终态收敛。
     （7）**dispose/shutdown**：Service.dispose 不能立即关闭数据库连接。
     新增**幂等 async `shutdown()`**：① 标记 shutting down；② 对 active
     run 发 abort；③ await active run 的 done（abort 贯穿所有异步边界，
     有界收敛）；④ Workspace cleanupAll（已由 Runtime 终态执行，此处为
     补漏重试）；⑤ 关闭 store（closeDb 幂等）。主进程退出路径
     （index.ts before-quit）使用该契约（先 abort 等收敛再关库，零
     database-closed race）。shutdown 幂等：重复调用安全返回同一
     Promise。
     （8）stopTask 对非 active run/已终态任务的幂等语义保持（决议 #105）。

136. **步数、轮次、上下文预算与 Provider 失败映射（冻结）**：
     （1）**计数语义**：
     - `roundsUsed`：每次 `provider.stream` 调用前递增；**重试也计数**。
     - `stepsUsed`：每次直接外部能力调用前递增——一次 SourceService 检索
       （search 或 list）、一次 SearchProvider 搜索、一次 CaptureService
       .read、一次模型发出的 Research tool call 各计 1 步。
     - **CaptureService 内部重试形成多个 Capture attempt（captureCount 计
       attempts 数），但不额外重复计算 Runtime tool step**（一次 read =
       1 步）。
     - 纯合并（mergeCandidates）、Evidence 程序验证（verifyEvidence）、
       Repository 写入、心跳、端口 stub 调用**不计 tool step**。
     - **超预算的那次调用不得执行**：执行前检查 `stepsUsed <
MAX_RESEARCH_TOOL_STEPS` / `roundsUsed < MAX_RESEARCH_ROUNDS`，
       不满足 → 不发起调用 → research-budget-exhausted 终态。
     - MAX_TOOL_STEPS/MAX_MODEL_ROUNDS/MAX_REQUEST_CONTEXT_CHARS/回放轮
       数上限只引用 shared/types/research.ts 编译期常量（禁止魔法数字）。
       （2）**C5 专属 context builder**（research 模块，零 Electron）：
       模型消息（候选元数据/capture 摘录/tool result/Evidence 回注）与
       tool result 都做**有界序列化**（白名单字段 + 确定性截断 + 标记 +
       UNTRUSTED 块闭合转义，复用既有块纪律）；每轮请求总上下文 ≤
       MAX_REQUEST_CONTEXT_CHARS；回放最近 ≤MAX_TRANSCRIPT_REPLAY_ROUNDS
       轮；网页内容继续位于不可信数据边界（只进 user 消息 UNTRUSTED 块）。
       （3）**reasoning 零持久化**：reasoning 增量不记录、不显示、不持久化；
       如 Provider 协议需要（tool 轮回传），仅作当前运行内不透明回放
       （ProviderMessage.reasoning，决议 #35 语义；不进日志/UI/库）。
       （4）**安全工具结果**：未知工具、子集外工具、非法参数返回安全工具
       结果（#132(3)），不得执行、不得 throw 形成失控 rejection。
       （5）**Provider 失败映射（冻结）**：
     - 总期限到达（RESEARCH_TOTAL_TIMEOUT_MS）→ failed +
       `research-timeout`；
     - 用户 stop 获胜（终态竞争胜出）→ cancelled；
     - 未配置、无 Key、不支持 tools、invalid-key、rate-limit、网络错误、
       Provider 错误、Provider 超时 → failed +
       `research-provider-unavailable`；
     - context-too-long（normalizeProviderError 判定）→ 按
       MAX_REQUEST_CONTEXT_CHARS 裁剪上下文后**同轮重试 1 次** → 仍
       context-too-long → failed + `research-budget-exhausted`；
     - 步数/轮次/持久化字节预算用尽 → failed +
       `research-budget-exhausted`；
     - 其余真正内部缺陷 → failed + `research-internal`。
     - **每个逻辑模型轮最多重试一次**（Provider 流错误/context-too-long/
       解析失败各一）；**连续两次 Provider 失败终止**（failed +
       research-provider-unavailable）；**成功轮（done 正常到达）将连续
       失败计数重置为 0**（「连续」语义冻结）。
     - abort 引起的 Provider 中断不算 Provider 失败（走 stop 路径）。

137. **原子持久化、stats 与终态预留预算**：
     （1）**Runtime 零 SQL**：增加窄的 `ResearchRuntimePersistencePort`
     （research 模块接口，Repository + DbHandle 事务实现——Runtime 只
     import 该端口）。每次逻辑写入在同一事务内：① 重读任务行确认任务仍
     running 且属于当前 run（runToken 守卫由 Runtime 在事务外先做；
     事务内再读任务行 status='running' 复验）；② 写候选/Capture/
     Evidence/Claim/Conflict/Result；③ 同步更新 stats、phase、updatedAt
     （updateTaskPhase 或 setTaskXxx）；④ 500k UTF-8 投影预算检查
     （Repository 既有 assertPersistedBudget/assertProjectedTaskBudget
     全链路）；⑤ 任一步失败整体回滚（withTransaction 既有语义）。
     （2）**终态预留（500k 吃满不可卡 running）**：Repository 新增编译期
     常量方法 `estimateWorstTerminalTaskRowBytes(taskId)`（最坏终态任务
     行投影 = goal 固定 + status='failed' + 最长 errorCode + stats_json
     最大形态（全字段 10 位数值）的 UTF-8 字节上界）与
     `assertChildInsertWithTerminalReserve(taskId, domainObject)`——
     **所有子行插入与所有非终态任务行更新**在既有预算检查之上额外断言
     「当前持久化字节 + 新增字节 + 最坏终态任务行字节 ≤
     MAX_TASK_PERSISTED_CHARS」，超限 → RepositoryError（映射
     research-budget-exhausted）——保证任何非终态提交后仍至少可写
     failed/cancelled 终态（终态路径自身按决议 #113 投影检查，允许
     completed 因 Result 过大失败——failed 可落库）。边界测试：构造接近
     500k 的任务，非终态提交被预留拒绝 → failed 终态仍成功写入。
     （3）**stats 冻结**：candidateCount=已持久化的合并候选数；
     selectedCount=选定候选数；captureCount+=CaptureService 返回的
     attempts 数（含失败尝试）；failedReadCount+=**失败 attempts 数**
     （不是只统计最终失败的 candidate）；evidenceCount=verified Evidence
     数；rejectedEvidenceCount=rejected proposal 数；claimCount/
     conflictCount=注入 synthesis port 结果产生；stepsUsed/roundsUsed 按
     决议 #136 计数。
     （4）**数量上限**：Capture ≤MAX_CAPTURES_PER_TASK(16)、Evidence ≤
     MAX_EVIDENCE_PER_TASK(60)；超限 → failed（research-budget-
     exhausted），**此前已成功提交的 Evidence 保留**。
     （5）**终态原子性**：Result 插入与 completed 终态（setTaskCompleted
     - cleanupOldestFinishedOverflow）**同事务**；failed/cancelled 终态
       与相应任务行更新（+ stats + 保留清理）**同事务**。
       （6）**SQL 纪律**：新增 SQL 只能是 Repository 内编译期常量（参数
       绑定）；migration v1 禁止改写。

138. **Progress、heartbeat 与终态竞争（冻结）**：
     （1）**ProgressEvent**（shared/types/research.ts）：

     ```ts
     export interface ResearchProgressEvent {
       taskId: string;
       status: ResearchTaskStatus;
       phase: ResearchPhase | null;
       stats: ResearchTaskStats;
       finishedAt: string | null;
     }
     ```
     - 只在 phase、status 或 stats 发生**语义变化**时发出新快照（
       lastSnapshot 比对）；纯 heartbeat 的 updatedAt 改变**不产生 UI
       事件**；
     - 初始 running/planning 恰好一次；终态恰好一次（终态快照
       finishedAt 非空）；
     - listener 抛错不得影响 Runtime（逐 listener try/catch + 脱敏 warn）；
     - 事件中不得出现 goal、URL、模型文本、网页正文或 Evidence 内容
       （仅确定性运行事实）。
     - C8 前不新增 Renderer IPC（progress 事件仅内部监听器消费，冒烟
       断言用）。
       （2）**heartbeat**：按现有设计只在 phase 入口写入（updateTaskPhase
     * stats 同事务），不新增周期计时器；应用下次启动由 store 将遗留
       running 标 interrupted（C1 既有）。
       （3）**终态优先级（冻结）**：最终提交前已观察到明确 stop → cancelled；
       否则总 deadline 到达 → research-timeout；否则预算 → research-budget-
       exhausted；终态 guard（finish() 守卫，A5 决议 #33 模式）之后的
       Provider delta、tool result、promise 完成和重复 stop 均为 no-op。
       （4）**cleanupAll**：至少在所有终态执行一次（Workspace cleanupAll；
       失败只记录有界脱敏诊断（tabId 数、错误码）并保留所有权供 shutdown
       再精确重试，**不得触碰用户 Tab**）；不得为此新增模糊错误码。

139. **index.ts 最小生产装配（C5）**：
     （1）`<userData>/research/research.db`：app ready 后经
     `openResearchStore` 装配（C1 既有）；unavailable 时浏览器/Sources/
     普通 Agent 零影响（store 契约）。
     （2）生命周期装配：ResearchStore → ResearchService（C1 既有）→
     **RuntimeFactory**（仅当 Sources/SearchProvider/config/credential/
     provider 全部可用且 C6/C7 端口存在时建立——生产在 C6/C7 落地前不
     建立，startTask → research-runtime-unavailable，决议 #134(3)）。
     （3）SMOKE_MODE 装配：冒烟注入确定性 stub 端口 + FakeProvider +
     受控夹具建立 RuntimeFactory（仅测试设施，生产行为不变）。
     （4）零新增：工具注册表仍 17；AgentLoop 12/420s 零变化；不新增
     Research IPC（C8）；零新依赖。
     （5）应用退出走安全 shutdown（决议 #135(7)）：before-quit →
     research shutdown（abort → await settle → cleanupAll → closeDb）
     → 其余既有清理；幂等。

- C1（契约+存储基座）→ C2/C3（并行，均仅依赖 C1）→ C4（依赖 C1–C3）→
  C5（依赖 C1–C4）→ C6（依赖 C1/C4/C5 端口）/C7（依赖 C1/C5 端口，可与
  C6 并行）→ C8（依赖 C5–C7）→ C9（依赖 C1–C8）→ C10（依赖全部且独立复验）。
- 每任务闭环边界、红态测试、验收标准、停止条件见 `doc/stage5/tasks/C1–C10`。
- C10 通过后停止，不实现 RSS/Watch/Sixth Stage；等待用户指令。
