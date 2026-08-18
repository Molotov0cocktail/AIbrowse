// C9（8.20 隐私扫描，2026-08-18）：运行时随机 canary 与「预期存在位置 +
// 禁止存在位置」清单（决议 #168）——禁止简单地把所有标记要求为全局零命中。
// 零 Electron 依赖；扫描 helper 只返回目标标签、命中数与布尔结果，
// 绝不打印 canary、Key、URL token 或敌对正文（FT-16）。

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type ResearchCanaryKind =
  | 'api-key' // API Key/Authorization 形态（sk- 前缀随机串）
  | 'capture-body' // capture-only 页面正文（不作为 Evidence excerpt）
  | 'reasoning-transcript' // 模型 reasoning/transcript（零落盘面）
  | 'evidence-excerpt' // Evidence 摘录（允许 research.db + Evidence drawer）
  | 'url-token' // URL query token（允许 Evidence URL/research.db/详情 DOM）
  | 'csv-formula'; // CSV 公式（只能进 CSV 且必须已加 ' 防护）

export interface ResearchCanary {
  kind: ResearchCanaryKind;
  label: string; // 安全标签（报告/日志用；不含 canary 本体）
  value: string; // 运行时随机值（仅字节比对用；绝不输出）
}

/** 运行时随机 canary 集（每轮冒烟独立；sk- 形态 Key canary 与真 Key 扫描同族） */
export function createResearchCanaries(): ResearchCanary[] {
  const hex = (n: number): string => randomBytes(n).toString('hex');
  return [
    { kind: 'api-key', label: 'API-Key 形态 canary', value: `sk-live-${hex(24)}` },
    { kind: 'capture-body', label: 'capture-only 正文 canary', value: `CAPBODY-${hex(12)}` },
    {
      kind: 'reasoning-transcript',
      label: 'reasoning/transcript canary',
      value: `REASON-${hex(12)}`,
    },
    { kind: 'evidence-excerpt', label: 'Evidence 摘录 canary', value: `EVIDEXC-${hex(12)}` },
    { kind: 'url-token', label: 'URL query token canary', value: `URLTOK-${hex(12)}` },
    { kind: 'csv-formula', label: 'CSV 公式 canary', value: `=CSVFM(${hex(8)})` },
  ];
}

// 扫描面分类（决议 #168(6) 至少覆盖：research.db/-wal/-shm、sources.db/备份/
// journal、conversation 文件、日志切片、审计收集器、UI DOM、CSV、临时 userData
// 与会话产物。C9 恢复校准（2026-08-18）：新增 provider-request-memory 面——
// 请求上下文内存态（模型提议/回放/候选元数据/捕获正文受控块），与持久化/
// 导出面严格区分；tool-output 仍按契约单独检查（工具结果序列化字节）。）
export type ResearchScanSurface =
  | 'research-db' // research.db + -wal + -shm
  | 'sources-db' // sources.db + 备份 + journal（库内字节）
  | 'conversation' // 会话文件（conversations/*.json）
  | 'log' // 日志切片
  | 'audit' // 审计收集器
  | 'ui-dom' // UI DOM（含 Evidence drawer）
  | 'csv-export' // 导出 CSV 字节
  | 'temp-other' // 临时 userData 其余文件（排除已单独扫描的库文件）
  | 'tool-output' // 工具输出（ToolResult/工具序列化文本）
  | 'provider-request-memory'; // Provider 请求内存态（模型上下文——受控块承载）

export interface ResearchScanExpectation {
  canaryKind: ResearchCanaryKind;
  surface: ResearchScanSurface;
  allowed: boolean; // true = 预期存在位置；false = 禁止存在位置
}

// 允许/禁止位置清单（决议 #168(1)–(5) + C9 恢复校准）。未列出的 (canary,
// surface) 组合一律按禁止处理（fail-closed 默认）——evaluateResearchScan
// 对缺失组合返回 missing-expectation 失败。
// C9 校准语义（2026-08-18）：
// - provider-request-memory 为内存态模型上下文——捕获正文（受控块）、候选
//   元数据（displayUrl 含 URL token）、模型提议/回放（含摘录）按设计进入
//   （threat-model §3.4「经块按预算回注的受控摘录」）；持久化/导出面仍零命中；
// - tool-output 为工具结果序列化字节——browser_read 携带捕获正文（受控块
//   包裹后回放），故 capture-body 允许；摘录/URL token 不进入工具结果字节；
// - CSV 公式只允许进入 CSV（且必须已加 ' 防护——防护断言在场景侧字节级执行）
//   与 Result 持久化面（research.db——table 单元格是合法 Result 内容）。
export const RESEARCH_SCAN_EXPECTATIONS: readonly ResearchScanExpectation[] = [
  // API Key/Authorization：所有面零命中
  ...(
    [
      'research-db',
      'sources-db',
      'conversation',
      'log',
      'audit',
      'ui-dom',
      'csv-export',
      'temp-other',
      'tool-output',
      'provider-request-memory',
    ] as const
  ).map((surface) => ({ canaryKind: 'api-key' as const, surface, allowed: false })),
  // capture-only 正文：仅允许受控内存上下文（provider-request-memory：捕获
  // 正文受控块回注；tool-output：browser_read 工具结果携带正文）；其余全部
  // 持久化/导出/展示面零命中
  ...(['capture-body', 'reasoning-transcript'] as const).flatMap((kind) =>
    (
      [
        'research-db',
        'sources-db',
        'conversation',
        'log',
        'audit',
        'ui-dom',
        'csv-export',
        'temp-other',
        'tool-output',
        'provider-request-memory',
      ] as const
    ).map((surface) => ({
      canaryKind: kind,
      surface,
      allowed:
        kind === 'capture-body' &&
        (surface === 'tool-output' || surface === 'provider-request-memory'),
    })),
  ),
  // Evidence 摘录：允许 research.db 与 Evidence drawer（UI DOM）；候选元数据/
  // 模型提议回放（provider-request-memory）按设计承载；禁止日志/审计/会话/
  // sources.db/CSV/工具结果/无关文件
  { canaryKind: 'evidence-excerpt', surface: 'research-db', allowed: true },
  { canaryKind: 'evidence-excerpt', surface: 'ui-dom', allowed: true },
  { canaryKind: 'evidence-excerpt', surface: 'provider-request-memory', allowed: true },
  { canaryKind: 'evidence-excerpt', surface: 'sources-db', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'conversation', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'log', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'audit', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'csv-export', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'temp-other', allowed: false },
  { canaryKind: 'evidence-excerpt', surface: 'tool-output', allowed: false },
  // URL query token：允许 Evidence URL/research.db/当前详情 DOM/候选元数据
  // （provider-request-memory）；禁止日志/审计/会话/CSV/sources.db/工具结果
  { canaryKind: 'url-token', surface: 'research-db', allowed: true },
  { canaryKind: 'url-token', surface: 'ui-dom', allowed: true },
  { canaryKind: 'url-token', surface: 'provider-request-memory', allowed: true },
  { canaryKind: 'url-token', surface: 'sources-db', allowed: false },
  { canaryKind: 'url-token', surface: 'conversation', allowed: false },
  { canaryKind: 'url-token', surface: 'log', allowed: false },
  { canaryKind: 'url-token', surface: 'audit', allowed: false },
  { canaryKind: 'url-token', surface: 'csv-export', allowed: false },
  { canaryKind: 'url-token', surface: 'temp-other', allowed: false },
  { canaryKind: 'url-token', surface: 'tool-output', allowed: false },
  // CSV 公式：只能进 CSV（且必须已加 ' 防护——防护断言在场景侧字节级执行）
  // 与 Result 持久化面（research.db——table 单元格是合法 Result 内容）；
  // 禁止进入日志/审计/会话/sources.db/UI DOM/临时目录其余文件/工具输出/
  // 请求上下文
  { canaryKind: 'csv-formula', surface: 'csv-export', allowed: true },
  { canaryKind: 'csv-formula', surface: 'research-db', allowed: true },
  { canaryKind: 'csv-formula', surface: 'sources-db', allowed: false },
  { canaryKind: 'csv-formula', surface: 'conversation', allowed: false },
  { canaryKind: 'csv-formula', surface: 'log', allowed: false },
  { canaryKind: 'csv-formula', surface: 'audit', allowed: false },
  { canaryKind: 'csv-formula', surface: 'ui-dom', allowed: false },
  { canaryKind: 'csv-formula', surface: 'temp-other', allowed: false },
  { canaryKind: 'csv-formula', surface: 'tool-output', allowed: false },
  { canaryKind: 'csv-formula', surface: 'provider-request-memory', allowed: false },
];

export interface ResearchScanHit {
  canaryKind: ResearchCanaryKind;
  surface: ResearchScanSurface;
  hits: number; // 命中数（字节级相等比对计数）
}

export interface ResearchScanVerdict {
  label: string; // 安全标签（canary 类别 + 扫描面——不含 canary 本体）
  hits: number;
  ok: boolean;
}

/**
 * 逐条评估扫描结果（纯函数）：只返回标签/命中数/布尔——绝不回显 canary 值。
 * allowed 面要求 hits ≥1（预期存在）；禁止面要求 hits === 0；缺失期望组合
 * fail-closed 判失败。
 */
export function evaluateResearchScan(
  expectation: ResearchScanExpectation,
  hits: number,
): ResearchScanVerdict {
  const label = `${expectation.canaryKind}@${expectation.surface}`;
  const ok = expectation.allowed ? hits >= 1 : hits === 0;
  return { label, hits, ok };
}

/** 汇总全部评估：任一失败 → 整体失败（失败清单只含标签与命中数） */
export function summarizeResearchScan(verdicts: readonly ResearchScanVerdict[]): {
  ok: boolean;
  failures: string[];
} {
  const failures = verdicts
    .filter((v) => !v.ok)
    .map((v) => `${v.label}：命中 ${v.hits} 次（与期望位置清单不符）`);
  return { ok: failures.length === 0, failures };
}

/** 期望表完整性校验（纯函数）：每个 canary 类别 × 全部扫描面恰好一条 */
export function validateResearchScanExpectations(
  expectations: readonly ResearchScanExpectation[],
): string[] {
  const errors: string[] = [];
  const kinds: readonly ResearchCanaryKind[] = [
    'api-key',
    'capture-body',
    'reasoning-transcript',
    'evidence-excerpt',
    'url-token',
    'csv-formula',
  ];
  const surfaces: readonly ResearchScanSurface[] = [
    'research-db',
    'sources-db',
    'conversation',
    'log',
    'audit',
    'ui-dom',
    'csv-export',
    'temp-other',
    'tool-output',
    'provider-request-memory',
  ];
  for (const kind of kinds) {
    for (const surface of surfaces) {
      const found = expectations.filter((e) => e.canaryKind === kind && e.surface === surface);
      if (found.length !== 1) {
        errors.push(`${kind}@${surface}：期望条目缺失或重复（${found.length} 条）`);
      }
    }
  }
  return errors;
}

// ---------- 字节级扫描（C9 恢复校准，2026-08-18） ----------
// 纪律：Buffer/字节序列搜索（不把二进制文件拼成 UTF-8 字符串后搜索——SQLite
// 库可能含任意字节序列）；读取失败必须 fail-closed（先正确关闭/flush 句柄
// 再扫描；仍不可读则该扫描面失败，不得静默跳过/写「主文件已覆盖」）；helper
// 只输出标签/命中数/布尔，绝不输出标记值。

/** 在 Buffer 中统计 token 出现次数（字节级、非重叠） */
export function countTokenInBuffer(buf: Buffer, token: string): number {
  const needle = Buffer.from(token, 'utf8');
  if (needle.length === 0) return 0;
  let hits = 0;
  let index = buf.indexOf(needle);
  while (index !== -1) {
    hits += 1;
    index = buf.indexOf(needle, index + needle.length);
  }
  return hits;
}

/** 在字符串中统计 token 出现次数（受控内存面——UI DOM/请求内存/审计文本） */
export function countTokenInText(text: string, token: string): number {
  return countTokenInBuffer(Buffer.from(text, 'utf8'), token);
}

export interface SurfaceReadResult {
  data: Buffer; // 扫描面字节（多个文件拼接）
  readFailures: string[]; // 读取失败的目标标签（非空 = 该面失败，fail-closed）
}

/**
 * 批量读取扫描面文件为字节序列：任何单个文件读取失败 → 记入 readFailures
 * （调用方必须把该面视为失败，不得静默跳过）；目录枚举失败同样计入。
 */
export function readSurfaceFiles(
  targets: Array<{ label: string; path: string }>,
): SurfaceReadResult {
  const chunks: Buffer[] = [];
  const readFailures: string[] = [];
  for (const target of targets) {
    try {
      const data = readFileBuffer(target.path);
      chunks.push(data);
    } catch {
      readFailures.push(target.label);
    }
  }
  return { data: Buffer.concat(chunks), readFailures };
}

// 文件读取封装：真实 fs.readFileSync 返回 Buffer（零字符串转换）。
function readFileBuffer(path: string): Buffer {
  return readFileSync(path);
}
