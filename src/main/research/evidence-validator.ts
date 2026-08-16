// Fifth Stage C4: EvidenceValidator — deterministic verification of model
// evidence proposals（detailed-design §5.2, adjudications #129/#130;
// threat-model §3.3 FT-03/04/05/06 core defense）。
//
// The model only ever PROPOSES an untrusted EvidenceProposal with exactly six
// fields（captureId/candidateId/type/locator/excerpt/value — unknown fields
// fail closed）. evidenceId is pre-allocated by the trusted caller and passed
// in as context; taskId/sourceId/url/title/accessTime/documentId/contentHash/
// verification can never come from the proposal. VerifiedEvidence provenance
// is assembled entirely from the successful Capture（main-process stamped）and
// the candidate's sourceId — the model cannot forge any of it.
//
// Verification order（#130）: proposal shape → capture belongs to the current
// task AND failed=false（sentinels rejected first）→ candidate exists and
// capture.candidateId === proposal.candidateId → CaptureContent exists and is
// bound to the same captureId → locator/value/excerpt content checks →
// program-assembled VerifiedEvidence.
//
// Content checks: text excerpts must normalize-equal the locator excerpt,
// be non-empty and ≤MAX_EVIDENCE_EXCERPT_CHARS, and be a contiguous substring
// of ONE normalized text section（no cross-section splicing, no fuzzy/
// semantic/case-insensitive matching）; table locators use tableIndex/row/col
//（0-based, row = data row excluding header）with the real cell value
// extracted by the program and the output header generated from the real
// table header（a non-empty proposal header must match it）; field paths must
// exist exactly in the closed fields map（no prefix/wildcard/dynamic/prototype
// keys — __proto__/constructor/prototype always rejected）.
//
// The function is pure: same context + same trusted evidenceId + same
// proposal → identical output（no randomness, no clock side effects）.
// Rejected results are NOT Evidence（never rendered, never collected, never
// persisted — Repository accepts only the VerifiedEvidence narrow type）.
import type {
  Capture,
  EvidenceLocator,
  EvidenceProposal,
  EvidenceRejectionCode,
  EvidenceType,
  EvidenceVerifyResult,
  SourceCandidate,
  VerifiedEvidence,
} from '../../shared/types/research';
import {
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_EVIDENCE_FIELD_VALUE_CHARS,
  MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS,
} from '../../shared/types/research';
import { normalizeCaptureText, type CaptureContent } from './capture-service';

// ---------- 闭合错误码 → 安全中文短句（≤200 字符；不回显正文/URL query/敌对字段） ----------

export const REJECTION_REASONS: Record<EvidenceRejectionCode, string> = {
  'proposal-invalid': '引用提案格式非法（字段白名单或类型组合不合法）',
  'capture-not-found': '引用的捕获记录不属于当前任务',
  'capture-failed': '引用的捕获记录为失败读取，不可作为证据',
  'candidate-mismatch': '引用的来源与捕获记录不一致',
  'content-missing': '捕获内容不可用（已过期或绑定不一致）',
  'excerpt-invalid': '摘录为空、超长或与定位摘录不一致',
  'excerpt-not-in-content': '摘录不存在于捕获内容（可能不实或脱离上下文）',
  'table-coordinate-invalid': '表格坐标越界或非法',
  'table-value-mismatch': '单元格值与捕获内容不一致',
  'table-header-mismatch': '提供的表头与真实表头不一致',
  'field-path-invalid': '字段路径不在受支持的字段集合内',
  'field-value-mismatch': '字段值与捕获内容不一致',
  'value-invalid': '字段值超长或形状非法',
};

// ---------- 校验输入（可信上下文 + 不可信 proposal） ----------

export interface EvidenceVerifyInput {
  proposal: unknown; // 不可信模型输入（JSON 解析后的任意形状）
  evidenceId: string; // 可信调用方预分配（模型不可提供）
  taskId: string; // 当前任务（可信）
  captures: readonly Capture[]; // 本任务捕获集（可信）
  candidates: readonly SourceCandidate[]; // 本任务候选集（可信）
  contents: ReadonlyMap<string, CaptureContent>; // captureId → 捕获内容（可信，纯内存）
}

// ---------- proposal 形状解析（fail-closed：未知字段/非法形状 → null） ----------

const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'quote',
  'table-cell',
  'field',
  'summary-point',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// 表格 locator 形状（决议 #129：tableIndex/row/col 0-based 非负整数；
// header 仅 string | null | 缺省——决议 #115）
function parseTableLocator(
  raw: Record<string, unknown>,
): Extract<EvidenceLocator, { kind: 'table' }> | null {
  const tableIndex = raw['tableIndex'];
  const row = raw['row'];
  const col = raw['col'];
  if (!Number.isInteger(tableIndex) || !Number.isInteger(row) || !Number.isInteger(col))
    return null;
  if ((tableIndex as number) < 0 || (row as number) < 0 || (col as number) < 0) return null;
  const header = raw['header'];
  if (header !== undefined && header !== null && typeof header !== 'string') return null;
  return {
    kind: 'table',
    tableIndex: tableIndex as number,
    row: row as number,
    col: col as number,
    header: header === undefined ? null : (header as string | null),
  };
}

function parseLocator(raw: unknown): EvidenceLocator | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (kind === 'text') {
    const excerpt = raw['excerpt'];
    if (!isNonEmptyString(excerpt, MAX_EVIDENCE_EXCERPT_CHARS)) return null;
    return { kind: 'text', excerpt };
  }
  if (kind === 'table') return parseTableLocator(raw);
  if (kind === 'field') {
    const fieldPath = raw['fieldPath'];
    if (!isNonEmptyString(fieldPath, MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS)) return null;
    return { kind: 'field', fieldPath };
  }
  return null;
}

// 决议 #130：仅允许六字段；未知字段 fail-closed；type-locator 组合校验
function parseProposal(raw: unknown): EvidenceProposal | null {
  if (!isRecord(raw)) return null;
  const allowedKeys = new Set(['captureId', 'candidateId', 'type', 'locator', 'excerpt', 'value']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }
  const captureId = raw['captureId'];
  const candidateId = raw['candidateId'];
  const type = raw['type'];
  if (typeof captureId !== 'string' || captureId === '') return null;
  if (typeof candidateId !== 'string' || candidateId === '') return null;
  if (typeof type !== 'string' || !EVIDENCE_TYPES.has(type)) return null;
  const locator = parseLocator(raw['locator']);
  if (locator === null) return null;
  const excerpt = raw['excerpt'];
  const value = raw['value'];
  if (excerpt !== undefined && excerpt !== null && typeof excerpt !== 'string') return null;
  if (value !== undefined && value !== null && typeof value !== 'string') return null;
  const evidenceType = type as EvidenceType;
  // type-locator 组合（决议 #130）：quote/summary-point → text 且 value 必须 null/缺省；
  // table-cell → table；field → field
  if (evidenceType === 'quote' || evidenceType === 'summary-point') {
    if (locator.kind !== 'text') return null;
    if (value !== undefined && value !== null) return null;
  } else if (evidenceType === 'table-cell') {
    if (locator.kind !== 'table') return null;
  } else {
    if (locator.kind !== 'field') return null;
  }
  return {
    captureId,
    candidateId,
    type: evidenceType,
    locator,
    excerpt: excerpt === undefined ? null : (excerpt as string | null),
    value: value === undefined ? null : (value as string | null),
  };
}

// 闭合字段路径白名单（决议 #128/#130）：固定键或固定数组索引表格路径；
// 原型链键/通配符/动态路径一律非法
const FIELD_PATH_PATTERN =
  /^(?:page\.(?:url|title)|headings\[0\]\.text|links\[0\]\.(?:text|href)|tables\[\d+\]\.cell\[\d+\]\[\d+\])$/;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeFieldPath(fieldPath: string): boolean {
  if (DANGEROUS_KEYS.has(fieldPath)) return false;
  for (const segment of fieldPath.split('.')) {
    if (DANGEROUS_KEYS.has(segment)) return false;
  }
  return FIELD_PATH_PATTERN.test(fieldPath);
}

// ---------- 校验主函数（纯函数、幂等） ----------

export function verifyEvidence(input: EvidenceVerifyInput): EvidenceVerifyResult {
  // ① proposal 形状、字段长度、type/locator 组合合法（未知字段 fail-closed）
  const proposal = parseProposal(input.proposal);
  if (proposal === null) return reject('proposal-invalid');

  // ② capture 属于当前 task 且 failed=false（sentinel 先拒——决议 #126）
  const capture = input.captures.find(
    (c) => c.captureId === proposal.captureId && c.taskId === input.taskId,
  );
  if (capture === undefined) return reject('capture-not-found');
  if (capture.failed) return reject('capture-failed');

  // ③ candidate 存在且 capture.candidateId 与 proposal.candidateId 一致
  const candidate = input.candidates.find((c) => c.id === proposal.candidateId);
  if (candidate === undefined) return reject('candidate-mismatch');
  if (capture.candidateId !== proposal.candidateId) return reject('candidate-mismatch');

  // ④ 对应 CaptureContent 存在且绑定同一 captureId
  const content = input.contents.get(capture.captureId);
  if (content === undefined || content.captureId !== capture.captureId) {
    return reject('content-missing');
  }

  // ⑤ locator/value/excerpt 内容验证（按类型）
  const checked = verifyContent(proposal, content);
  if (!checked.ok) return reject(checked.code ?? 'proposal-invalid');

  // ⑥ 程序组装 VerifiedEvidence（provenance 全部从成功 Capture/候选取）
  const evidence: VerifiedEvidence = {
    evidenceId: input.evidenceId,
    taskId: input.taskId,
    captureId: capture.captureId,
    candidateId: candidate.id,
    sourceId: candidate.sourceId,
    url: capture.url,
    title: capture.title,
    accessTime: capture.accessTime,
    documentId: capture.documentId,
    contentHash: capture.contentHash,
    type: proposal.type,
    locator: checked.locator,
    excerpt: checked.excerpt,
    value: checked.value,
    verification: 'verified',
  };
  return { ok: true, evidence };
}

function reject(code: EvidenceRejectionCode): EvidenceVerifyResult {
  return { ok: false, code, reason: REJECTION_REASONS[code] };
}

// 内容验证结果：验证后的 locator/excerpt/value（全部为受控真实值）
interface ContentCheckResult {
  ok: boolean;
  code: EvidenceRejectionCode | null;
  locator: EvidenceLocator;
  excerpt: string;
  value: string | null;
}

function verifyContent(proposal: EvidenceProposal, content: CaptureContent): ContentCheckResult {
  if (proposal.type === 'quote' || proposal.type === 'summary-point') {
    const locator = proposal.locator as Extract<EvidenceLocator, { kind: 'text' }>;
    const excerpt = proposal.excerpt;
    if (excerpt === null) return bad('excerpt-invalid', locator);
    const normalized = normalizeCaptureText(excerpt);
    if (normalized === '') return bad('excerpt-invalid', locator);
    if (normalized.length > MAX_EVIDENCE_EXCERPT_CHARS) return bad('excerpt-invalid', locator);
    // locator.excerpt 与 proposal.excerpt 规范化后必须一致
    if (normalizeCaptureText(locator.excerpt) !== normalized)
      return bad('excerpt-invalid', locator);
    // 必须是某一个独立 section 的连续规范化子串（禁跨 section 拼接）
    let matched = false;
    for (const section of content.textSections) {
      if (section.includes(normalized)) {
        matched = true;
        break;
      }
    }
    if (!matched) return bad('excerpt-not-in-content', locator);
    return {
      ok: true,
      code: null,
      locator: { kind: 'text', excerpt: normalized },
      excerpt: normalized,
      value: null,
    };
  }

  if (proposal.type === 'table-cell') {
    const locator = proposal.locator as Extract<EvidenceLocator, { kind: 'table' }>;
    const table = content.tables[locator.tableIndex];
    if (table === undefined) return bad('table-coordinate-invalid', locator);
    const row = table.rows[locator.row];
    if (row === undefined || locator.col >= row.length)
      return bad('table-coordinate-invalid', locator);
    const real = row[locator.col] ?? '';
    // value/excerpt 与受控真实值完全一致（value 与 excerpt 分别校验）
    const value = proposal.value;
    const excerpt = proposal.excerpt;
    if (value === null && excerpt === null) return bad('table-value-mismatch', locator);
    if (value !== null) {
      if (value.length > MAX_EVIDENCE_FIELD_VALUE_CHARS) return bad('value-invalid', locator);
      if (normalizeCaptureText(value) !== real) return bad('table-value-mismatch', locator);
    }
    if (excerpt !== null) {
      if (excerpt.length > MAX_EVIDENCE_EXCERPT_CHARS) return bad('value-invalid', locator);
      if (normalizeCaptureText(excerpt) !== real) return bad('table-value-mismatch', locator);
    }
    // header 由程序根据真实表头生成；proposal 提供非空 header 须与真实表头一致
    const realHeader =
      locator.col < table.headers.length ? (table.headers[locator.col] ?? null) : null;
    const proposalHeader = locator.header;
    if (proposalHeader !== null && proposalHeader !== '') {
      if (proposalHeader !== realHeader) return bad('table-header-mismatch', locator);
    }
    return {
      ok: true,
      code: null,
      locator: {
        kind: 'table',
        tableIndex: locator.tableIndex,
        row: locator.row,
        col: locator.col,
        header: realHeader,
      },
      excerpt: real,
      value: real,
    };
  }

  // field
  const locator = proposal.locator as Extract<EvidenceLocator, { kind: 'field' }>;
  const fieldPath = locator.fieldPath;
  if (!isSafeFieldPath(fieldPath)) return bad('field-path-invalid', locator);
  if (!Object.prototype.hasOwnProperty.call(content.fields, fieldPath)) {
    return bad('field-path-invalid', locator);
  }
  const real = content.fields[fieldPath] ?? '';
  const value = proposal.value;
  const excerpt = proposal.excerpt;
  if (value === null && excerpt === null) return bad('field-value-mismatch', locator);
  if (value !== null) {
    if (value.length > MAX_EVIDENCE_FIELD_VALUE_CHARS) return bad('value-invalid', locator);
    if (normalizeCaptureText(value) !== real) return bad('field-value-mismatch', locator);
  }
  if (excerpt !== null) {
    if (excerpt.length > MAX_EVIDENCE_EXCERPT_CHARS) return bad('value-invalid', locator);
    if (normalizeCaptureText(excerpt) !== real) return bad('field-value-mismatch', locator);
  }
  return { ok: true, code: null, locator, excerpt: real, value: real };
}

function bad(code: EvidenceRejectionCode, locator: EvidenceLocator): ContentCheckResult {
  return { ok: false, code, locator, excerpt: '', value: null };
}
