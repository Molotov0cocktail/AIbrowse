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
  canonicalText: string; // ≤ MAX_PAGE_CAPTURE_CHARS（条目级确定性截断）
  textSections: string[]; // 非空、独立规范化的章节；每项都是 canonicalText 的连续子串
  tables: CaptureTable[]; // 实际保留的表格（预算内整表保留）
  fields: Record<string, string>; // 闭合字段路径 → 规范值
}

// 内部构建结果（C4 Replan）：content + internal stats。不导出、不入 CaptureContent
// 形状、不落盘、不经 spread/JSON/日志/Runtime map 泄漏。summary 由本结果一次性
// 构造——调用方不能传入期望计数。
interface CaptureBuildResult {
  content: CaptureContent;
  stats: {
    headingCount: number; // 只在非空 heading 的完整 unit admission 分支递增
  };
}

// 闭合 admission 结果（C4 Replan）：canonical 写入、projection 和 stats 只能由
// 同一次结果驱动，禁止事后用 includes/substring/slice 反推结构是否成立。
// - skipped-empty：值不合法/空/纯空白 → 零写入、零登记，不阻塞后续 unit。
// - rejected-budget：eligible 但预算不足 → 零写入、零登记，并停止后续 unit
//   （atomic unit 不允许残缺 fragment；canonicalText 可小于 60k，不用残缺标签填满）。
// - full：整 unit 完整写入。
// - partial-visible：仅 visibleText 允许；写完整 prefix + surrogate-safe payload，
//   不写 newline；登记精确 admittedPayload。
type AdmissionResult =
  | { kind: 'skipped-empty' }
  | { kind: 'rejected-budget' }
  | { kind: 'full'; serialized: string }
  | { kind: 'partial-visible'; serialized: string; admittedPayload: string };

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

// 有类型标签、顺序固定的 canonicalText 串行格式。按条目追加；超预算的条目
// 截断（surrogate-safe）后停止——之后的一切（表格/字段/章节）零保留
// （决议 #128：预算耗尽后不得保留「未进入哈希」的内容）。
// 语义保留：边界落在 high surrogate 上时整 pair 回退（不拆有效 surrogate pair）。
function truncateSurrogateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // 边界落在 high surrogate → 回退
  return text.slice(0, end);
}

// 统一 admission：budget 状态（canonical 已写入长度 + 是否已耗尽）。
interface BudgetState {
  canonical: string;
  exhausted: boolean;
}

// visibleText 专用 partial admission（Contract：唯一允许 partial payload 的 unit）。
// - prefix 未完整进入或没有一个 surrogate-safe payload 字符可进入 → 零写入、零登记。
// - payload 部分进入 → 写完整 prefix + 安全 payload，不写 newline，登记精确 admittedPayload。
// - exact/full → 整 unit 写入（含 newline）并登记完整 payload。
function admitVisible(state: BudgetState, visible: string, budget: number): AdmissionResult {
  if (state.exhausted) return { kind: 'rejected-budget' };
  const prefix = '[text] ';
  const remaining = budget - state.canonical.length;
  if (remaining < prefix.length) return { kind: 'skipped-empty' }; // prefix 未完整进入
  const line = prefix + visible + '\n';
  if (line.length <= remaining) {
    state.canonical += line;
    return { kind: 'full', serialized: line };
  }
  const admittedPayload = truncateSurrogateSafe(visible, remaining - prefix.length);
  if (admittedPayload === '') return { kind: 'skipped-empty' }; // 无 payload 字符可进入
  const serialized = prefix + admittedPayload;
  state.canonical += serialized;
  return { kind: 'partial-visible', serialized, admittedPayload };
}

// 原子 unit admission（heading/link/table/field）：eligible 且整 unit 可容纳才写入；
// 否则零写入、零登记，并停止后续预算 admission。禁止残缺 fragment。
function admitAtomic(state: BudgetState, line: string, budget: number): AdmissionResult {
  if (state.exhausted) return { kind: 'rejected-budget' };
  const remaining = budget - state.canonical.length;
  if (line.length > remaining) return { kind: 'rejected-budget' };
  state.canonical += line;
  return { kind: 'full', serialized: line };
}

// 内部构建（含 internal stats）。导出的 buildCaptureContent 只取 .content（五字段）；
// summary 由 CaptureService 从本结果一次性构造。
function buildCaptureInternal(snapshot: PageSnapshot, captureId: string): CaptureBuildResult {
  const budget = MAX_PAGE_CAPTURE_CHARS;
  const state: BudgetState = { canonical: '', exhausted: false };
  const textSections: string[] = [];
  const tables: CaptureTable[] = [];
  const fields: Record<string, string> = {};
  let headingCount = 0;

  // 1. visibleText（第一个 text section；唯一允许 partial payload）
  const visible = normalizeCaptureText(snapshot.visibleText ?? '');
  if (visible !== '') {
    const r = admitVisible(state, visible, budget);
    if (r.kind === 'full') {
      textSections.push(visible);
    } else if (r.kind === 'partial-visible') {
      textSections.push(r.admittedPayload);
    } else if (r.kind === 'rejected-budget') {
      state.exhausted = true;
    }
    // skipped-empty：零登记、不阻塞
  }

  // 2. headings（快照顺序；空/纯空白跳过且不阻塞后续）
  const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
  for (const heading of headings) {
    const text = normalizeCaptureText(heading.text);
    if (text === '') continue;
    const line = `[heading] ${text}\n`;
    const r = admitAtomic(state, line, budget);
    if (r.kind === 'full') {
      textSections.push(text);
      headingCount += 1;
    } else if (r.kind === 'rejected-budget') {
      state.exhausted = true;
      break; // 停止后续 unit
    }
  }

  // 3. tables（表头 + row-major 单元格；整表原子保留，否则整表零写入）
  // eligibility：至少一个非空规范化 header/cell 才 eligible；全空表整表跳过
  // （canonicalText/tables/textSections/fields/tableCount 全零、不阻塞后续）。
  // 空 header 可在有意义表格中作列位置占位保留；空 row/cell 保留几何但不复制到 fields。
  // 表格索引以「已登记 tables 数组」生成（被跳过空表不造成 tables[1] 空洞）。
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
    if (!hasNonEmpty) continue; // 全空表：整表跳过
    const table: CaptureTable = { headers, rows };
    const tableSection = normalizeCaptureText(serializeTable(table));
    const line = `[table] ${tableSection}\n`;
    const r = admitAtomic(state, line, budget);
    if (r.kind === 'full') {
      const admittedIndex = tables.length; // 已登记索引（紧凑）
      tables.push(table);
      textSections.push(tableSection);
      rows.forEach((row, rIdx) => {
        row.forEach((cell, cIdx) => {
          if (cell === '') return; // 空 cell 不复制到 fields（几何仍保留在 tables）
          fields[`tables[${admittedIndex}].cell[${rIdx}][${cIdx}]`] = cell;
        });
      });
    } else if (r.kind === 'rejected-budget') {
      state.exhausted = true;
      break; // 后续表格/章节/字段零保留
    }
  }

  // 4. links（快照顺序；原子接纳。text 空/纯空白或 URL 空 → 跳过整个 link unit）
  const links = Array.isArray(snapshot.links) ? snapshot.links : [];
  for (const link of links) {
    const text = normalizeCaptureText(link.text);
    if (text === '') continue;
    const url = normalizeUrlText(link.href);
    if (url === '') continue; // 防御：空 URL → 不可登记 link
    const line = `[link] ${text} ${url}\n`;
    const r = admitAtomic(state, line, budget);
    if (r.kind === 'full') {
      textSections.push(text);
    } else if (r.kind === 'rejected-budget') {
      state.exhausted = true;
      break;
    }
  }

  // 5. 闭合字段（固定键序；key 必须来自闭合编译期集合，value 规范化后非空；
  //    整 unit 可容纳才写入并登记 fields）
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
    if (value === '') continue; // 空/纯空白 value → 不产生 field unit
    const line = `[field] ${key}=${value}\n`;
    const r = admitAtomic(state, line, budget);
    if (r.kind === 'full') {
      fields[key] = value;
    } else if (r.kind === 'rejected-budget') {
      state.exhausted = true;
      break;
    }
  }

  const content: CaptureContent = {
    captureId,
    canonicalText: state.canonical,
    textSections,
    tables,
    fields,
  };
  return { content, stats: { headingCount } };
}

// 导出纯函数（供单测）：只返回精确五字段 CaptureContent（stats 不进入运行时对象）。
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

      // 7. 成功 Capture 组装（主进程盖章）
      // C4 Replan：canonical 写入、projection、stats 来自同一次闭合 admission 结果。
      // summary 由内部 build result（content + stats）一次性构造——禁止扫描
      // canonicalText、禁止按原始 snapshot 数量计数、禁止调用方传入期望数字。
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
