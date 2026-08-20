// Fifth Stage C4: CaptureService — task Tab read / structured extraction /
// capture records（detailed-design §5.1, adjudications #124–#128）。
//
// Tab lifecycle（#124）: ResearchWorkspace.acquire already created the tab and
// started the page load（C2 contract, browser-controller.ts createTab →
// loadURL）— C4 NEVER navigates/loadURL/reloads. The browser minimal port
// carries only the read capability { getTabs, getPageSnapshot }; creation,
// ownership, checks and release all go through ResearchWorkspace
// （acquire → ready poll → checkTab → snapshot → checkTab → finally
// release）. A failed release never claims cleanup — Workspace ownership is
// retained for the C5 terminal cleanupAll retry; when content was already
// captured, a release failure only produces a safe warning and the completed
// Capture is never discarded.
//
// Results（#125）: frozen discriminated union — expected failures are never
// thrown（unexpected internal errors are caught and normalized）. Every
// attempt produces an independent captureId (injected UUID-v4 factory, never
// model-supplied) and a fresh acquire（new tabId）. Retry matrix: page-load-
// failed / timeout / snapshot-degraded retry at most once;
// aborted / http-scheme-rejected / tab-closed-by-user never retry; Workspace
// cleanup-failed never creates more tabs（failure + safe warning）; other
// recoverable create/read errors normalize to page-load-failed（retryable）.
// C4 never touches ResearchTask.stats（C5 Runtime owns the persistence
// increments）.
//
// Failed captures（#126）: schema v1 requires NOT NULL tab_id/document_id/
// content_hash — deterministic sentinels: 'unallocated' / 'unavailable' /
// SHA-256('')[:32]; summary all-zero; url/title = validated candidate display
// values; accessTime = injected main-process clock; failed=true with a
// non-null failureReason. Sentinels may only appear on failed captures —
// EvidenceValidator rejects failed captures first and never assembles a
// sentinel into VerifiedEvidence.
//
// CaptureContent（#128）: pure in-memory, built exclusively from the existing
// PageSnapshot (url/title/visibleText/headings/links/tables) — no pipeline
// changes, no new collection channels. Normalization = NFC + trim + control/
// bidi strip + whitespace collapse（no fuzzy/semantic/case-insensitive
// matching）. canonicalText is a typed-tag, fixed-order serialization
// （visibleText → headings → tables（headers + row-major cells）→ links →
// fields）bounded by MAX_PAGE_CAPTURE_CHARS; every section/table/field value
// referenced by EvidenceValidator actually lives inside the budget and the
// hash coverage — after the budget is exhausted, no table/field/section that
// failed to enter the hash is retained. Bodies/snapshots live only in memory
// （never in Capture, Repository, logs or session files — FT-14/16）.
import { createHash, randomUUID } from 'node:crypto';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';
import type { Capture, CaptureFailureReason, SourceCandidate } from '../../shared/types/research';
import { MAX_PAGE_CAPTURE_CHARS, MAX_PAGE_READ_RETRIES } from '../../shared/types/research';
import { logWarn } from '../logger';
import { stripControlChars } from '../sources/domain/source-change-set';
import type { AcquireResult, CheckTabResult, ReleaseResult } from './research-workspace';

// ---------- 常量（决议 #125/#127：全部编译期，可注入） ----------

export const CAPTURE_READY_TIMEOUT_MS = 15000;
export const CAPTURE_POLL_INTERVAL_MS = 50;
// 决议 #126：failed Capture sentinel（仅 failed Capture 可携带）
export const CAPTURE_SENTINEL_TAB_ID = 'unallocated';
export const CAPTURE_SENTINEL_DOCUMENT_ID = 'unavailable';

// SHA-256 前 32 小写 hex（contentHash 契约）
export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

// 空正文哈希（编译期求值一次；单测固化恒等）
export const CAPTURE_EMPTY_CONTENT_HASH = sha256hex('');

// ---------- 浏览器最小端口（决议 #124：仅读取所需能力） ----------

export interface CaptureBrowserPort {
  getTabs(): Promise<TabInfo[]>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
}

// ---------- Workspace 最小端口（结构兼容 ResearchWorkspace；typecheck 保证） ----------

export interface CaptureWorkspacePort {
  readonly taskId: string;
  acquire(url: string, signal: AbortSignal): Promise<AcquireResult>;
  checkTab(tabId: string): Promise<CheckTabResult>;
  release(tabId: string): Promise<ReleaseResult>;
}

// ---------- CaptureContent（决议 #128：纯内存，零落盘） ----------

export interface CaptureTable {
  headers: string[]; // 规范化表头
  rows: string[][]; // 规范化数据行（不含 header 行）
}

export interface CaptureContent {
  captureId: string;
  canonicalText: string; // ≤ MAX_PAGE_CAPTURE_CHARS (deterministic per-entry truncation)
  textSections: string[]; // non-empty, independently normalized sections; each is a contiguous substring of canonicalText
  tables: CaptureTable[]; // retained tables (whole-table within budget)
  fields: Record<string, string>; // closed field paths → normalized values
}

// Internal build result (C4 Replan): content + internal stats. Never exported,
// never enters the CaptureContent shape, never persisted, never leaked through
// spread/JSON/logs/Runtime map. The summary is built once from this result —
// the caller cannot pass expected counts.
interface CaptureBuildResult {
  content: CaptureContent;
  stats: {
    headingCount: number; // incremented only on the full-admission branch of a non-empty heading unit
  };
}

// Compiler state owned by the single control loop. The terminal flag is the only
// source of "no further units"; no category loop propagates a hand-written
// exhausted flag between loops.
interface CompilerState {
  canonical: string;
  sections: string[];
  tables: CaptureTable[];
  fields: Record<string, string>;
  headingCount: number;
}

// Typed capture unit (adjudication #173). Eligibility, serialized representation
// and projection metadata are bound to the same object; the source order is
// fixed: visibleText → headings → tables → links → fields (scalar fields in a
// fixed key order). A rejected-budget or partial-visible decision terminates the
// whole compile loop — canonical/projection/stats are driven by the same closed
// admission decision, never re-derived with includes/substring/slice afterwards.
type CaptureUnit =
  | { kind: 'visible'; payload: string; line: string }
  | { kind: 'heading'; text: string; line: string }
  | { kind: 'table'; headers: string[]; rows: string[][]; section: string; line: string }
  | { kind: 'link'; text: string; url: string; line: string }
  | { kind: 'field'; key: string; value: string; line: string };

// ---------- 读取结果（决议 #125：冻结判别联合，禁 throw 作预期失败控制流） ----------

export type CaptureReadResult =
  | {
      ok: true;
      attempts: Capture[];
      capture: Capture; // attempts 最后一项，恒 failed=false
      content: CaptureContent;
      warnings: string[];
    }
  | {
      ok: false;
      attempts: Capture[];
      failureReason: CaptureFailureReason;
      warnings: string[];
    };

// ---------- 规范化（决议 #128：NFC、trim、控制/bidi 清除、连续空白折叠） ----------

export function normalizeCaptureText(text: string): string {
  return stripControlChars(text.normalize('NFC')).replace(/\s+/g, ' ').trim();
}

// URL 形态字段仅 trim + NFC（不折叠空白——URL 中空白即非法）
function normalizeUrlText(text: string): string {
  return stripControlChars(text.normalize('NFC')).trim();
}

// ---------- 最终/候选 URL 验证（决议 #127：http/https、无 userinfo） ----------

export function validateCaptureUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'URL 为空' };
  if (raw.length > 2048) return { ok: false, reason: 'URL 超长' };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '仅允许 http/https' };
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, reason: 'URL 不允许包含用户信息' };
    }
    return { ok: true, url: parsed.href };
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
}

// ---------- CaptureContent 构造（纯函数，导出供单测） ----------

// 表头 + row-major 单元格的串行化（进入 canonicalText 的表格条目）。
// 结果即 table textSection 本身——保证 section 值是 canonicalText 的连续子串
// （决议 #128：可被 EvidenceValidator 引用的值都在哈希覆盖范围内）。
function serializeTable(table: CaptureTable): string {
  const parts: string[] = [table.headers.join('|')];
  for (const row of table.rows) parts.push(row.join('|'));
  return parts.join(' | ');
}

// Typed-tag, fixed-order canonicalText serialization format. Appended
// per-entry; an over-budget entry is truncated (surrogate-safe) then stops —
// everything after it (tables/fields/sections) is retained as zero
// (adjudication #128: nothing outside the hash coverage may be retained).
// Semantics preserved: when the boundary lands on a high surrogate, the whole
// pair backs off (a valid surrogate pair is never split).
function truncateSurrogateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // boundary on high surrogate → back off
  return text.slice(0, end);
}

// Materialize eligible typed units in the fixed source order
// (visibleText → headings → tables → links → fields). Eligibility is decided
// here: empty/whitespace/malformed values become skipped-empty (zero write,
// zero projection, zero stats, never blocking later units). Each unit carries
// its full serialized line so the same serialization is used for budget
// admission and canonical commit.
function materializeCaptureUnits(snapshot: PageSnapshot): CaptureUnit[] {
  const units: CaptureUnit[] = [];

  // 1. visibleText (first text section; the only unit allowed a partial payload)
  const visible = normalizeCaptureText(snapshot.visibleText ?? '');
  if (visible !== '') {
    units.push({ kind: 'visible', payload: visible, line: `[text] ${visible}\n` });
  }

  // 2. headings (snapshot order; empty/whitespace skipped and never blocking)
  const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
  for (const heading of headings) {
    const text = normalizeCaptureText(heading.text);
    if (text === '') continue;
    units.push({ kind: 'heading', text, line: `[heading] ${text}\n` });
  }

  // 3. tables (headers + row-major cells; whole table admitted atomically or
  //    written not at all). Eligibility: at least one non-empty normalized
  //    header/cell makes the table eligible; an all-empty table is skipped
  //    whole (zero canonical/table/section/field, never blocking). Empty
  //    headers may remain as column placeholders in a meaningful table; empty
  //    rows/cells keep their geometry but are not copied into fields. The
  //    table index is generated from the retained tables array (a skipped
  //    empty table never leaves a tables[1] hole).
  const rawTables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
  for (const raw of rawTables) {
    if (raw === undefined || raw === null) continue;
    const headers = (Array.isArray(raw.headers) ? raw.headers : []).map((h) =>
      normalizeCaptureText(String(h)),
    );
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row) =>
      (Array.isArray(row) ? row : []).map((c) => normalizeCaptureText(String(c))),
    );
    const hasNonEmpty =
      headers.some((h) => h !== '') || rows.some((row) => row.some((c) => c !== ''));
    if (!hasNonEmpty) continue; // all-empty table: skip the whole table
    const section = normalizeCaptureText(serializeTable({ headers, rows }));
    units.push({ kind: 'table', headers, rows, section, line: `[table] ${section}\n` });
  }

  // 4. links (snapshot order; atomic admission. A link with empty/whitespace
  //    text or an empty URL is skipped as a whole unit)
  const links = Array.isArray(snapshot.links) ? snapshot.links : [];
  for (const link of links) {
    const text = normalizeCaptureText(link.text);
    const url = normalizeUrlText(link.href);
    if (text === '' || url === '') continue;
    units.push({ kind: 'link', text, url, line: `[link] ${text} ${url}\n` });
  }

  // 5. Closed scalar fields (fixed key order: page.url → page.title →
  //    headings[0].text → links[0].text → links[0].href). A field unit only
  //    forms for a closed key with a non-empty normalized value.
  const link0 = links[0];
  const pageUrl = normalizeUrlText(snapshot.url);
  const pageTitle = normalizeCaptureText(snapshot.title);
  const fieldEntries: Array<[string, string]> = [];
  if (pageUrl !== '') fieldEntries.push(['page.url', pageUrl]);
  if (pageTitle !== '') fieldEntries.push(['page.title', pageTitle]);
  const heading0 = headings[0];
  if (heading0 !== undefined) {
    const t = normalizeCaptureText(heading0.text);
    if (t !== '') fieldEntries.push(['headings[0].text', t]);
  }
  if (link0 !== undefined) {
    const t = normalizeCaptureText(link0.text);
    const h = normalizeUrlText(link0.href);
    if (t !== '') fieldEntries.push(['links[0].text', t]);
    if (h !== '') fieldEntries.push(['links[0].href', h]);
  }
  for (const [key, value] of fieldEntries) {
    if (value === '') continue; // empty/whitespace value: no field unit
    units.push({ kind: 'field', key, value, line: `[field] ${key}=${value}\n` });
  }

  return units;
}

// Commit one typed unit. Returns true when the compile loop must stop
// (rejected-budget or partial-visible). The decision and the canonical/
// projection/stats commit are handled in this single owner: a terminal return
// makes the loop break structurally — no later unit can ever be admitted.
function admitUnit(state: CompilerState, unit: CaptureUnit): boolean {
  if (unit.kind === 'visible') return admitVisibleUnit(state, unit);

  const remaining = MAX_PAGE_CAPTURE_CHARS - state.canonical.length;
  if (unit.line.length > remaining) return true; // rejected-budget → global stop
  state.canonical += unit.line;
  switch (unit.kind) {
    case 'heading':
      state.sections.push(unit.text);
      state.headingCount += 1;
      break;
    case 'table': {
      const admittedIndex = state.tables.length; // compact retained index
      state.tables.push({ headers: unit.headers, rows: unit.rows });
      state.sections.push(unit.section);
      unit.rows.forEach((row, rIdx) => {
        row.forEach((cell, cIdx) => {
          if (cell === '') return; // empty cell: geometry kept, no field entry
          state.fields[`tables[${admittedIndex}].cell[${rIdx}][${cIdx}]`] = cell;
        });
      });
      break;
    }
    case 'link':
      state.sections.push(unit.text);
      break;
    case 'field':
      state.fields[unit.key] = unit.value;
      break;
  }
  return false; // continue to the next unit
}

// visibleText is the only unit allowed a partial payload. A prefix that cannot
// fully enter, or a payload with no surrogate-safe character that can enter,
// is a zero-write terminal stop; a partial payload commits the full prefix +
// admittedPayload (no newline) and is also terminal; full/exact commits the
// whole unit (with newline) and lets the loop continue.
function admitVisibleUnit(
  state: CompilerState,
  unit: Extract<CaptureUnit, { kind: 'visible' }>,
): boolean {
  const remaining = MAX_PAGE_CAPTURE_CHARS - state.canonical.length;
  const prefix = '[text] ';
  if (remaining < prefix.length) return true; // prefix cannot fully enter → terminal
  if (unit.line.length <= remaining) {
    state.canonical += unit.line;
    state.sections.push(unit.payload);
    return false; // full/exact → continue
  }
  const admittedPayload = truncateSurrogateSafe(unit.payload, remaining - prefix.length);
  if (admittedPayload === '') return true; // no surrogate-safe payload char → terminal
  state.canonical += prefix + admittedPayload;
  state.sections.push(admittedPayload);
  return true; // partial-visible → terminal
}

// Internal build (with internal stats). The exported buildCaptureContent only
// takes .content (five fields); the summary is built once by CaptureService
// from this result. A single owner loop owns unit order, budget remaining,
// terminal stop, canonical commit and projection/stats commit.
function buildCaptureInternal(snapshot: PageSnapshot, captureId: string): CaptureBuildResult {
  const state: CompilerState = {
    canonical: '',
    sections: [],
    tables: [],
    fields: {},
    headingCount: 0,
  };
  const units = materializeCaptureUnits(snapshot);
  for (const unit of units) {
    if (admitUnit(state, unit)) break; // terminal: rejected-budget / partial-visible
  }
  const content: CaptureContent = {
    captureId,
    canonicalText: state.canonical,
    textSections: state.sections,
    tables: state.tables,
    fields: state.fields,
  };
  return { content, stats: { headingCount: state.headingCount } };
}

// Exported pure function (for unit tests): returns the exact five-field
// CaptureContent only (stats never enter the runtime object).
export function buildCaptureContent(snapshot: PageSnapshot, captureId: string): CaptureContent {
  return buildCaptureInternal(snapshot, captureId).content;
}

// ---------- CaptureService ----------

export interface CaptureServiceOptions {
  workspace: CaptureWorkspacePort;
  browser: CaptureBrowserPort;
  now?: () => number; // 轮询时钟（epoch ms，可注入）
  nowIso?: () => string; // failed Capture 的 accessTime（主进程 ISO 时钟，可注入）
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // abort 感知睡眠
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  createCaptureId?: () => string; // 决议 #125：注入式 UUID v4 工厂（主进程可信）
}

type WaitOutcome = 'ready' | 'error' | 'missing' | 'aborted' | 'timeout';

// 一次尝试的内部结果：capture 记录（成功或失败）+ 内容（仅成功）
interface AttemptOutcome {
  capture: Capture;
  content: CaptureContent | null;
  retryable: boolean;
  warnings: string[];
}

const RELEASE_FAILED_WARNING = '任务标签页释放失败（所有权已保留，可由任务终态清理重试）';
const CLEANUP_FAILED_WARNING =
  '任务标签页清理失败（所有权已保留，可由任务终态清理重试），本次读取中止';

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve();
    };
    const onAbort = (): void => done();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class CaptureService {
  private readonly workspace: CaptureWorkspacePort;
  private readonly browser: CaptureBrowserPort;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly createCaptureId: () => string;

  constructor(options: CaptureServiceOptions) {
    this.workspace = options.workspace;
    this.browser = options.browser;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? defaultSleep;
    this.readyTimeoutMs = options.readyTimeoutMs ?? CAPTURE_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? CAPTURE_POLL_INTERVAL_MS;
    this.createCaptureId = options.createCaptureId ?? (() => randomUUID());
  }

  async read(candidate: SourceCandidate, signal: AbortSignal): Promise<CaptureReadResult> {
    const warnings: string[] = [];
    const attempts: Capture[] = [];

    // 前置：候选展示 URL 校验（决议 #127）——非法 → http-scheme-rejected，
    // 零 acquire、sentinel capture（不重试）
    const preCheck = validateCaptureUrl(candidate.displayUrl);
    if (!preCheck.ok) {
      const failedCapture = this.makeFailedCapture(
        this.createCaptureId(),
        candidate,
        null,
        'http-scheme-rejected',
      );
      return {
        ok: false,
        attempts: [failedCapture],
        failureReason: 'http-scheme-rejected',
        warnings,
      };
    }

    for (let attempt = 0; attempt <= MAX_PAGE_READ_RETRIES; attempt++) {
      const captureId = this.createCaptureId();
      const outcome = await this.runAttempt(candidate, captureId, signal);
      attempts.push(outcome.capture);
      warnings.push(...outcome.warnings);

      if (!outcome.capture.failed && outcome.content !== null) {
        return {
          ok: true,
          attempts,
          capture: outcome.capture,
          content: outcome.content,
          warnings,
        };
      }
      if (!outcome.retryable || attempt >= MAX_PAGE_READ_RETRIES) {
        return {
          ok: false,
          attempts,
          failureReason: outcome.capture.failureReason ?? 'page-load-failed',
          warnings,
        };
      }
      // 可重试且未达上限 → 下一次尝试（重新 acquire 新 tabId、新 captureId）
    }
    // 不可达（MAX_PAGE_READ_RETRIES ≥ 0 保证循环必有返回值）
    return { ok: false, attempts, failureReason: 'page-load-failed', warnings };
  }

  // 单次尝试（决议 #124/#127 固定时序）；所有预期失败走失败 capture，
  // 不抛异常（未预期内部异常 catch 归一）。outcome 为 finally 可修改的
  // 外部变量：release 报 cleanup-failed 时置 retryable=false（决议 #125：
  // 不继续创建更多 Tab）——return 值即该引用，修改对调用方生效。
  private async runAttempt(
    candidate: SourceCandidate,
    captureId: string,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    let tabId: string | null = null;
    const warnings: string[] = [];
    let outcome: AttemptOutcome | null = null;

    try {
      // 1. acquire（Workspace 内部 createTab 已开始加载——零二次导航）
      let acquire: AcquireResult;
      try {
        acquire = await this.workspace.acquire(candidate.displayUrl, signal);
      } catch (err) {
        logWarn('research', `任务标签页创建异常（candidateId=${candidate.id}）`, err);
        outcome = this.failedOutcome(
          candidate,
          captureId,
          null,
          'page-load-failed',
          true,
          warnings,
        );
        return outcome;
      }
      if (!acquire.ok) {
        outcome = this.acquireFailedOutcome(candidate, captureId, acquire, warnings);
        return outcome;
      }
      tabId = acquire.lease.tabId;

      // 2. ready 轮询（复用 SearchProvider 轮询模式；不复制其私有实现）
      let ready: WaitOutcome;
      try {
        ready = await this.waitForReady(tabId, signal);
      } catch (err) {
        // getTabs 可恢复异常 → 归一 page-load-failed（决议 #125 重试矩阵）
        logWarn('research', `等待页面就绪异常（candidateId=${candidate.id}）`, err);
        ready = 'error';
      }
      if (ready === 'aborted') {
        outcome = this.failedOutcome(candidate, captureId, tabId, 'aborted', false, warnings);
        return outcome;
      }
      if (ready === 'missing') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'tab-closed-by-user',
          false,
          warnings,
        );
        return outcome;
      }
      if (ready === 'error') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'page-load-failed',
          true,
          warnings,
        );
        return outcome;
      }
      if (ready === 'timeout') {
        outcome = this.failedOutcome(candidate, captureId, tabId, 'timeout', true, warnings);
        return outcome;
      }

      // 3. 读前 checkTab（用户关闭感知）
      const check1 = await this.safeCheckTab(tabId);
      if (check1 === 'closed') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'tab-closed-by-user',
          false,
          warnings,
        );
        return outcome;
      }
      if (check1 === 'error') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'page-load-failed',
          true,
          warnings,
        );
        return outcome;
      }

      // 4. 实时快照
      let snapshot: PageSnapshot | null;
      try {
        snapshot = await this.browser.getPageSnapshot(tabId);
      } catch (err) {
        logWarn('research', `页面快照采集异常（candidateId=${candidate.id}）`, err);
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'page-load-failed',
          true,
          warnings,
        );
        return outcome;
      }
      if (snapshot === null) {
        // L3：再次 checkTab——已关闭为 tab-closed-by-user，否则 snapshot-degraded
        const check2 = await this.safeCheckTab(tabId);
        if (check2 === 'closed') {
          outcome = this.failedOutcome(
            candidate,
            captureId,
            tabId,
            'tab-closed-by-user',
            false,
            warnings,
          );
          return outcome;
        }
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'snapshot-degraded',
          true,
          warnings,
        );
        return outcome;
      }
      // L0–L2 阶梯与形状合法性
      const degraded = snapshot.meta?.degraded;
      if (degraded !== 'none' && degraded !== 'partial') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'snapshot-degraded',
          true,
          warnings,
        );
        return outcome;
      }
      if (!this.isValidSnapshotMeta(snapshot)) {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'snapshot-degraded',
          true,
          warnings,
        );
        return outcome;
      }

      // 5. snapshot 返回后、接纳内容前：再次检查 signal 与 checkTab
      if (signal.aborted) {
        outcome = this.failedOutcome(candidate, captureId, tabId, 'aborted', false, warnings);
        return outcome;
      }
      const check3 = await this.safeCheckTab(tabId);
      if (check3 === 'closed') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'tab-closed-by-user',
          false,
          warnings,
        );
        return outcome;
      }
      if (check3 === 'error') {
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          'snapshot-degraded',
          true,
          warnings,
        );
        return outcome;
      }

      // 6. 最终 URL 重新验证（redirect 后实际快照 URL）。
      // 决议 #131：chrome-error://chromewebdata/ 是 Chromium 加载失败后的
      // 内建错误页（title 为失败 URL、集合全空、tab 状态被 finish-load 翻回
      // ready——冒烟探针实证）→ page-load-failed（可重试一次，网络抖动可能
      // 恢复）；其余非法目标（重定向到非法 scheme/userinfo）→
      // http-scheme-rejected（不重试）。
      const urlCheck = validateCaptureUrl(snapshot.url);
      if (!urlCheck.ok) {
        const isChromiumErrorPage =
          typeof snapshot.url === 'string' && snapshot.url.startsWith('chrome-error://');
        outcome = this.failedOutcome(
          candidate,
          captureId,
          tabId,
          isChromiumErrorPage ? 'page-load-failed' : 'http-scheme-rejected',
          isChromiumErrorPage,
          warnings,
        );
        return outcome;
      }

      // 7. Successful Capture assembly (main-process stamped).
      // C4 Replan: canonical write, projection and stats come from the same
      // closed admission result. The summary is built once from the internal
      // build result (content + stats) — never by scanning canonicalText, never
      // by counting raw snapshot entries, never from caller-supplied numbers.
      const built = buildCaptureInternal(snapshot, captureId);
      const capture: Capture = {
        captureId,
        taskId: this.workspace.taskId,
        candidateId: candidate.id,
        tabId,
        url: urlCheck.url,
        title: normalizeCaptureText(snapshot.title),
        accessTime: new Date(snapshot.meta.capturedAt).toISOString(),
        documentId: String(snapshot.meta.documentId),
        contentHash: sha256hex(built.content.canonicalText),
        summary: {
          sectionCount: built.content.textSections.length,
          tableCount: built.content.tables.length,
          headingCount: built.stats.headingCount,
          charCount: built.content.canonicalText.length,
        },
        failed: false,
        failureReason: null,
      };
      if (degraded === 'partial') {
        warnings.push('页面快照为部分采集（L1 降级），引用验证仅覆盖已采集内容');
      }
      outcome = { capture, content: built.content, retryable: false, warnings };
      return outcome;
    } finally {
      // 8. finally release（每次尝试恰好一次；失败不误报清理）。release 报
      // cleanup-failed → 内容已捕获只附安全 warning（不丢弃 Capture——
      // 决议 #124）；尝试失败时同时置 retryable=false（不继续创建更多
      // Tab——决议 #125）。
      if (tabId !== null) {
        const releaseWarning = await this.releaseSafely(tabId);
        if (releaseWarning !== null) {
          warnings.push(releaseWarning);
          if (outcome !== null && outcome.capture.failed) outcome.retryable = false;
        }
      }
    }
  }

  // 轮询精确 tabId 就绪（决议 #127 冻结映射；不注册事件监听器）。
  // Chromium 加载失败后渲染的内建错误页自身会完成 did-finish-load 并把状态
  // 从 error 翻回 ready（tab-state 状态机 finish-load 从任意状态 → ready，
  // 实测翻转窗口 <50ms 轮询间隔）——error 立即失败只是快速路径；翻转漏网的
  // 错误页由快照 url 判定兜底（chrome-error://chromewebdata/ → page-load-
  // failed，决议 #131）。
  private async waitForReady(tabId: string, signal: AbortSignal): Promise<WaitOutcome> {
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      if (signal.aborted) return 'aborted';
      if (this.now() > deadline) return 'timeout';
      const tabs = await this.browser.getTabs();
      const tab = tabs.find((t) => t.id === tabId);
      if (tab === undefined) return 'missing';
      if (tab.state === 'ready') return 'ready';
      if (tab.state === 'error') return 'error';
      await this.sleep(this.pollIntervalMs, signal);
    }
  }

  // checkTab 归一：'alive' | 'closed' | 'error'（closed 已由 Workspace 移除所有权）
  private async safeCheckTab(tabId: string): Promise<'alive' | 'closed' | 'error'> {
    try {
      const result: CheckTabResult = await this.workspace.checkTab(tabId);
      if (result.ok && result.status === 'alive') return 'alive';
      if (result.ok && result.status === 'closed-by-user') return 'closed';
      return 'error';
    } catch (err) {
      logWarn('research', `checkTab 异常（tabId=${tabId}）`, err);
      return 'error';
    }
  }

  // finally release（决议 #124/#125）：ok 恒安全；cleanup-failed/异常 →
  // 安全 warning（不含 URL/正文）+ 标记不重试（由调用侧按 capture 失败与否处理）
  private async releaseSafely(tabId: string): Promise<string | null> {
    try {
      const result: ReleaseResult = await this.workspace.release(tabId);
      if (result.ok) return null;
      logWarn('research', `release 报出清理失败（tabId=${tabId}），所有权保留可重试`);
      return result.errorCode === 'cleanup-failed'
        ? RELEASE_FAILED_WARNING
        : '任务标签页释放失败（所有权已保留，可由任务终态清理重试）';
    } catch (err) {
      logWarn('research', `release 异常（tabId=${tabId}），所有权保留可重试`, err);
      return RELEASE_FAILED_WARNING;
    }
  }

  private isValidSnapshotMeta(snapshot: PageSnapshot): boolean {
    const meta = snapshot.meta;
    if (meta === undefined || meta === null) return false;
    // capturedAt：有限 epoch ms 且可转合法 ISO（越界会 RangeError）
    if (typeof meta.capturedAt !== 'number' || !Number.isFinite(meta.capturedAt)) return false;
    if (Math.abs(meta.capturedAt) > 8.64e15) return false;
    // documentId：非负整数（主进程世代）
    if (
      typeof meta.documentId !== 'number' ||
      !Number.isInteger(meta.documentId) ||
      meta.documentId < 0
    ) {
      return false;
    }
    if (typeof snapshot.url !== 'string' || typeof snapshot.title !== 'string') return false;
    return true;
  }

  // acquire 失败映射（决议 #125 重试矩阵）
  private acquireFailedOutcome(
    candidate: SourceCandidate,
    captureId: string,
    acquire: AcquireResult & { ok: false },
    warnings: string[],
  ): AttemptOutcome {
    switch (acquire.errorCode) {
      case 'invalid-url':
        return this.failedOutcome(
          candidate,
          captureId,
          null,
          'http-scheme-rejected',
          false,
          warnings,
        );
      case 'tab-create-aborted':
        return this.failedOutcome(candidate, captureId, null, 'aborted', false, warnings);
      case 'cleanup-failed':
        // 不继续创建更多 Tab：映射为失败 + 无 URL/正文的 warning + 不重试
        warnings.push(CLEANUP_FAILED_WARNING);
        return this.failedOutcome(candidate, captureId, null, 'page-load-failed', false, warnings);
      case 'tab-closed-by-user':
        return this.failedOutcome(
          candidate,
          captureId,
          null,
          'tab-closed-by-user',
          false,
          warnings,
        );
      default:
        // tab-limit / workspace-busy / tab-create-failed / tab-restore-focus-failed /
        // workspace-internal / invalid-task-id / not-owned → 可恢复异常
        return this.failedOutcome(candidate, captureId, null, 'page-load-failed', true, warnings);
    }
  }

  // 失败 capture 组装（决议 #126：sentinel 五字段确定性）
  private makeFailedCapture(
    captureId: string,
    candidate: SourceCandidate,
    tabId: string | null,
    failureReason: CaptureFailureReason,
  ): Capture {
    return {
      captureId,
      taskId: this.workspace.taskId,
      candidateId: candidate.id,
      tabId: tabId ?? CAPTURE_SENTINEL_TAB_ID,
      url: candidate.displayUrl,
      title: candidate.title,
      accessTime: this.nowIso(),
      documentId: CAPTURE_SENTINEL_DOCUMENT_ID,
      contentHash: CAPTURE_EMPTY_CONTENT_HASH,
      summary: { sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 },
      failed: true,
      failureReason,
    };
  }

  private failedOutcome(
    candidate: SourceCandidate,
    captureId: string,
    tabId: string | null,
    failureReason: CaptureFailureReason,
    retryable: boolean,
    warnings: string[],
  ): AttemptOutcome {
    return {
      capture: this.makeFailedCapture(captureId, candidate, tabId, failureReason),
      content: null,
      retryable,
      warnings,
    };
  }
}
