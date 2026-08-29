// Sixth Stage D6: BrowserWatchReader —— task Tab → 实时 PageSnapshot 窄读取
//（detailed-design §8.1、FIXED DECISIONS 4/9/10）。零 Electron、零 timer 所有权：
//
// 固定时序（每次 attempt 由 Router 一次性冻结不可变 absolute deadline）：
//   1. 用注入 Clock 等待精确 tabId 进入 ready（轮询 getTabs；每轮等待后重新
//      检查 signal/deadline/tab 存在；error/missing/用户关闭/abort/deadline 全失败）；
//   2. ready 后读取一次实时 snapshot（迟到/终态后回调只能丢弃，零 Projection）；
//   3. snapshot 后再次检查 signal、deadline、tab 仍存在、状态仍 ready；
//   4. 元数据校验（session）：readyState==='complete'、degraded==='none'、
//      capturedAt 为有限整数 epoch ms、documentId 为 >=1 安全整数；
//   5. PageSnapshot → DocumentChannels 纯映射（visibleText→mainText、level 1..3
//      headings、tables、links.text/href；inputs/buttons 零进入——禁止读取
//      input.value）。
//
// 登录/challenge 分类只使用受控结构元数据 + 主进程 URL/降级状态（FIXED 10）：
// 单条敌手正文字符串绝不触发可信分类。
import type { Clock } from '../../shared/types/watch';
import { NETWORK_ATTEMPT_TIMEOUT_MS } from '../../shared/types/watch';
import type {
  PageSnapshot,
  SnapshotDegradation,
  SnapshotMeta,
  TabInfo,
} from '../../shared/types/browser';
import type { DocumentChannels } from '../../shared/types/watch';
import { normalizeWatchText } from '../../shared/watch/watch-budget';
import type { SourceScope } from '../../shared/types/sources';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';

export interface WatchBrowserReadPort {
  getTabs(): Promise<TabInfo[]>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
}

export const READY_POLL_INTERVAL_MS = 100;
const TAB_ID_MAX_LENGTH = 64;

export type WatchReaderFailureCode =
  | 'aborted'
  | 'timeout'
  | 'tab-error'
  | 'tab-missing'
  | 'tab-closed-by-user'
  | 'snapshot-null'
  | 'snapshot-degraded'
  | 'snapshot-invalid'
  | 'internal';

export type SnapshotSuspicion = 'login' | 'captcha' | 'unknown' | 'degraded';

export type WatchReaderResult =
  | {
      ok: true;
      channels: DocumentChannels;
      meta: { url: string; capturedAt: string; documentId: string | null };
      suspicion: SnapshotSuspicion | null;
    }
  | {
      ok: false;
      code: WatchReaderFailureCode;
      suspicion?: SnapshotSuspicion;
      reason: string;
    };

export interface WatchReaderOptions {
  browser: WatchBrowserReadPort;
  clock: Clock;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 纯函数：PageSnapshot → DocumentChannels（与 PublicHtmlSaxReader 输出等价的
// 通道语义：body 主文本/1..3 级标题/表行列/链接 text+url；inputs/buttons 零进入）
// ---------------------------------------------------------------------------

export function pageSnapshotToChannels(
  snapshot: Readonly<PageSnapshot>,
):
  | { ok: true; channels: DocumentChannels }
  | { ok: false; code: 'snapshot-invalid'; reason: string } {
  if (snapshot === null || typeof snapshot !== 'object') {
    return { ok: false, code: 'snapshot-invalid', reason: 'snapshot-not-object' };
  }
  const mainText = normalizeWatchText(
    typeof snapshot.visibleText === 'string' ? snapshot.visibleText : '',
  );

  const headings: DocumentChannels['headings'] = [];
  if (Array.isArray(snapshot.headings)) {
    for (const h of snapshot.headings) {
      if (h === null || typeof h !== 'object') continue;
      const level = h.level;
      if (level !== 1 && level !== 2 && level !== 3) continue; // 只接受 1..3 级
      const text = normalizeWatchText(typeof h.text === 'string' ? h.text : '');
      if (text === '') continue;
      headings.push({ level, text });
    }
  }

  const tables: DocumentChannels['tables'] = [];
  if (Array.isArray(snapshot.tables)) {
    for (const t of snapshot.tables) {
      if (t === null || typeof t !== 'object') continue;
      const headers: string[] = [];
      const rows: string[][] = [];
      if (Array.isArray(t.headers)) {
        for (const h of t.headers) {
          const text = normalizeWatchText(typeof h === 'string' ? h : '');
          // R5：显式空 header 保留（列位置不漂移）
          headers.push(text);
        }
      }
      if (Array.isArray(t.rows)) {
        for (const row of t.rows) {
          if (!Array.isArray(row)) continue;
          const cells: string[] = [];
          for (const cell of row) {
            const text = normalizeWatchText(typeof cell === 'string' ? cell : '');
            // R5：显式空单元格保留列位置；不做占位正文
            cells.push(text);
          }
          // 有单元格的行（即使全空）保留；零单元格的空行无列结构，跳过
          if (cells.length > 0) rows.push(cells);
        }
      }
      if (headers.length > 0 || rows.length > 0) tables.push({ headers, rows });
    }
  }

  const links: DocumentChannels['links'] = [];
  if (Array.isArray(snapshot.links)) {
    for (const l of snapshot.links) {
      if (l === null || typeof l !== 'object') continue;
      const text = normalizeWatchText(typeof l.text === 'string' ? l.text : '');
      if (text === '') continue;
      let url: string | null = null;
      if (typeof l.href === 'string' && l.href !== '') {
        // 与 public resolveUrl 同族：绝对化 + http/https 纯 URL 校验；
        // session 链接允许任意端口（公网 80/443 闭合只约束 public 路径）
        const norm = normalizeSourceUrl(l.href, 'page' as SourceScope);
        url = norm.ok ? norm.canonicalKey : null;
      }
      if (url === null) continue;
      links.push({ text, url });
    }
  }

  return { ok: true, channels: { mainText, headings, tables, links } };
}

// ---------------------------------------------------------------------------
// 纯函数：登录/challenge 结构信号分类（FIXED 10；零敌手正文、零 input 值）
// ---------------------------------------------------------------------------

const LOGIN_PATH_SEGMENTS = new Set(['login', 'signin', 'sign-in', 'auth', 'sso', 'signin_v2']);
const CHALLENGE_PATH_SEGMENTS = new Set(['captcha', 'challenge', 'verify', 'human-verification']);

function pathSegments(url: string): string[] {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .split('/')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '' && s !== '/');
  } catch {
    return [];
  }
}

/** URL 登录/captcha/challenge path 信号（只允许与结构信号组合分类）。 */
export function urlChallengeMarkers(url: string): { login: boolean; challenge: boolean } {
  const segments = pathSegments(url);
  const login = new Set<string>();
  const challenge = new Set<string>();
  for (const seg of segments) {
    if (LOGIN_PATH_SEGMENTS.has(seg)) login.add(seg);
    if (CHALLENGE_PATH_SEGMENTS.has(seg)) challenge.add(seg);
  }
  return { login: login.size > 0, challenge: challenge.size > 0 };
}

function hasPasswordInput(snapshot: Readonly<PageSnapshot>): boolean {
  if (!Array.isArray(snapshot.inputs)) return false;
  for (const input of snapshot.inputs) {
    if (input === null || typeof input !== 'object') continue;
    if (typeof input.type === 'string' && input.type.toLowerCase() === 'password') {
      return true; // 只读取 type 存在性；绝不读取 placeholder/value
    }
  }
  return false;
}

function hasSubmitControl(snapshot: Readonly<PageSnapshot>): boolean {
  if (Array.isArray(snapshot.buttons)) {
    for (const b of snapshot.buttons) {
      if (b === null || typeof b !== 'object') continue;
      if (b.isSubmit === true) return true;
    }
  }
  if (Array.isArray(snapshot.inputs)) {
    for (const input of snapshot.inputs) {
      if (input === null || typeof input !== 'object') continue;
      if (input.isSubmit === true) return true;
    }
  }
  return false;
}

/** 任意降级（meta.degraded !== 'none'；未知降级值同样视为降级，fail-closed）。 */
function isDegraded(snapshot: Readonly<PageSnapshot>): boolean {
  const meta = snapshot.meta;
  if (meta === null || typeof meta !== 'object') return false;
  return (meta.degraded as SnapshotDegradation) !== 'none';
}

/**
 * 保守挑战分类（FIXED 10 + R4 修复）：login/captcha/unknown/degraded 闭合、互斥，
 * 同一快照恰好命中一个。优先级：
 *   1. password 结构信号（或 login URL + password/submit 结构信号）→ 'login'；
 *   2. challenge URL + 结构信号（password/submit）→ 'captcha'；
 *   3. login/challenge URL 单独出现（无可靠结构信号）→ 'unknown'；
 *   4. 任意 degraded（含 iframe 降级）→ 'degraded'；
 *   5. 其余 → null。
 * 通用 iframe warning 绝不单独触发 captcha（R4：challenge 必须由 URL/navigation
 * 信号与结构信号的可区分组合证明）；零敌手正文、零 input/form 值、零 Cookie。
 */
export function classifySnapshotSuspicion(
  snapshot: Readonly<PageSnapshot>,
): SnapshotSuspicion | null {
  const markers = urlChallengeMarkers(snapshot.url);
  const passwordOnly = hasPasswordInput(snapshot);
  const submit = hasSubmitControl(snapshot);
  if (passwordOnly || (markers.login && (passwordOnly || submit))) {
    return 'login';
  }
  if (markers.challenge && (passwordOnly || submit)) {
    return 'captcha';
  }
  if (markers.login || markers.challenge) {
    return 'unknown';
  }
  if (isDegraded(snapshot)) {
    return 'degraded';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 元数据校验（session 快照；FIXED 4）
// ---------------------------------------------------------------------------

function validCapturedAtMs(meta: SnapshotMeta | undefined): number | null {
  if (meta === null || typeof meta !== 'object') return null;
  const value = meta.capturedAt;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function validDocumentId(meta: SnapshotMeta | undefined): string | null {
  if (meta === null || typeof meta !== 'object') return null;
  const value = meta.documentId;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value.toString(10); // 显式十进制转换；禁止 as string/模板隐式掩盖非法值
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class BrowserWatchReader {
  private readonly browser: WatchBrowserReadPort;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;

  constructor(options: WatchReaderOptions) {
    this.browser = options.browser;
    this.clock = options.clock;
    this.pollIntervalMs = options.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  }

  /**
   * 单次 Session attempt 读取：等待 ready → 一次实时 snapshot → 后置复验 →
   * 元数据 → 通道映射。deadline 为 Router 一次性冻结的绝对截止（不可变，
   * 禁止 retry/poll 重新计算）；本方法内所有 timer/AbortSignal listener 在
   * 结算时清除；迟到事件一律丢弃。
   */
  async read(input: {
    tabId: string;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<WatchReaderResult> {
    if (
      typeof input.tabId !== 'string' ||
      input.tabId === '' ||
      input.tabId.length > TAB_ID_MAX_LENGTH
    ) {
      return { ok: false, code: 'tab-missing', reason: 'invalid-tab-id' };
    }
    const deadlineMs = input.deadline instanceof Date ? input.deadline.getTime() : Number.NaN;
    if (!Number.isFinite(deadlineMs)) {
      return { ok: false, code: 'internal', reason: 'invalid-deadline' };
    }

    const ready = await this.waitReady(input.tabId, input.signal, deadlineMs);
    if (ready !== 'ready') {
      return this.mapReadyFailure(ready);
    }

    let snapshot: PageSnapshot | null;
    try {
      snapshot = await this.browser.getPageSnapshot(input.tabId);
    } catch {
      return { ok: false, code: 'internal', reason: 'snapshot-read-threw' };
    }
    if (snapshot === null || typeof snapshot !== 'object') {
      return { ok: false, code: 'snapshot-null', reason: 'snapshot-null' };
    }

    // 后置复验：signal/deadline/tab 仍存在/状态仍 ready
    if (input.signal.aborted) {
      return { ok: false, code: 'aborted', reason: 'aborted-after-snapshot' };
    }
    if (this.clock.now().getTime() >= deadlineMs) {
      return { ok: false, code: 'timeout', reason: 'deadline-after-snapshot' };
    }
    let tabsNow: TabInfo[];
    try {
      tabsNow = await this.browser.getTabs();
    } catch {
      return { ok: false, code: 'internal', reason: 'tabs-recheck-threw' };
    }
    const tabNow = tabsNow.find((t) => t.id === input.tabId);
    if (tabNow === undefined) {
      return { ok: false, code: 'tab-closed-by-user', reason: 'tab-gone-after-snapshot' };
    }
    if (tabNow.state !== 'ready') {
      return { ok: false, code: 'tab-error', reason: `tab-state-${tabNow.state}` };
    }

    // 元数据（session 只接受 complete + 零降级）
    const meta = snapshot.meta;
    const suspicion = classifySnapshotSuspicion(snapshot);
    if (meta === null || typeof meta !== 'object' || meta.readyState !== 'complete') {
      return {
        ok: false,
        code: 'snapshot-invalid',
        suspicion: suspicion ?? undefined,
        reason: 'ready-state-not-complete',
      };
    }
    if ((meta.degraded as SnapshotDegradation) !== 'none') {
      return {
        ok: false,
        code: 'snapshot-degraded',
        suspicion: suspicion ?? undefined,
        reason: `degraded-${meta.degraded}`,
      };
    }
    const capturedAtMs = validCapturedAtMs(meta);
    if (capturedAtMs === null) {
      return {
        ok: false,
        code: 'snapshot-invalid',
        suspicion: suspicion ?? undefined,
        reason: 'captured-at-invalid',
      };
    }
    const documentId = validDocumentId(meta);
    if (documentId === null) {
      return {
        ok: false,
        code: 'snapshot-invalid',
        suspicion: suspicion ?? undefined,
        reason: 'document-id-invalid',
      };
    }

    const mapped = pageSnapshotToChannels(snapshot);
    if (!mapped.ok) {
      return {
        ok: false,
        code: 'snapshot-invalid',
        suspicion: suspicion ?? undefined,
        reason: mapped.reason,
      };
    }
    return {
      ok: true,
      channels: mapped.channels,
      meta: {
        url: typeof snapshot.url === 'string' ? snapshot.url : '',
        capturedAt: new Date(capturedAtMs).toISOString(), // 显式 ISO 转换
        documentId,
      },
      suspicion,
    };
  }

  private mapReadyFailure(ready: 'ready' | WatchReaderFailureCode): WatchReaderResult {
    switch (ready) {
      case 'ready':
        return { ok: false, code: 'internal', reason: 'unreachable' };
      case 'aborted':
        return { ok: false, code: 'aborted', reason: 'aborted-while-waiting' };
      case 'timeout':
        return { ok: false, code: 'timeout', reason: 'ready-timeout' };
      case 'tab-error':
        return { ok: false, code: 'tab-error', reason: 'tab-state-error' };
      case 'tab-missing':
        return { ok: false, code: 'tab-missing', reason: 'tab-never-appeared' };
      case 'tab-closed-by-user':
        return { ok: false, code: 'tab-closed-by-user', reason: 'tab-gone-while-waiting' };
      case 'internal':
        return { ok: false, code: 'internal', reason: 'wait-internal' };
      default:
        return { ok: false, code: 'internal', reason: 'unexpected-ready-failure' };
    }
  }

  private async waitReady(
    tabId: string,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<'ready' | WatchReaderFailureCode> {
    // 结算 latch：任何终态后，迟到 timer/abort 事件一律丢弃、零副作用
    let settled = false;
    let timer: ReturnType<Clock['setTimeout']> | null = null;
    const sleep = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (this.clock.now().getTime() + ms >= deadlineMs) {
          resolve(false);
          return;
        }
        timer = this.clock.setTimeout(
          () => {
            timer = null;
            resolve(true);
          },
          Math.min(ms, Math.max(0, deadlineMs - this.clock.now().getTime())),
        );
      });

    return new Promise<'ready' | WatchReaderFailureCode>((resolve) => {
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('aborted');
      };
      const fail = (
        code: 'timeout' | 'tab-error' | 'tab-missing' | 'tab-closed-by-user' | 'internal',
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(code);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('ready');
      };
      const cleanup = (): void => {
        if (timer !== null) {
          try {
            this.clock.clearTimeout(timer);
          } catch {
            // 幂等
          }
          timer = null;
        }
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // 幂等
        }
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      const poll = async (): Promise<void> => {
        if (settled) return;
        if (this.clock.now().getTime() >= deadlineMs) {
          fail('timeout');
          return;
        }
        if (signal.aborted) {
          onAbort();
          return;
        }
        let tabs: TabInfo[];
        try {
          tabs = await this.browser.getTabs();
        } catch {
          fail('internal'); // getTabs 抛错 → 受控失败
          return;
        }
        if (settled) return;
        const tab = tabs.find((t) => t.id === tabId);
        if (tab === undefined) {
          fail('tab-missing');
          return;
        }
        if (tab.state === 'error') {
          fail('tab-error');
          return;
        }
        if (tab.state === 'ready') {
          succeed();
          return;
        }
        // loading/idle：等待下一轮（只使用剩余时间；不续杯 deadline）
        const canWait = await sleep(this.pollIntervalMs);
        if (!canWait) {
          fail('timeout');
          return;
        }
        if (settled) return;
        void poll();
      };
      void poll();
    });
  }
}

// Router 在 session 路径的 attempt 冻结（FIXED 9）：min(外部 deadline,
// attemptStart + NETWORK_ATTEMPT_TIMEOUT_MS)；供测试断言复用。
export function freezeAttemptDeadline(nowMs: number, externalDeadline: Date): Date {
  const ext = externalDeadline instanceof Date ? externalDeadline.getTime() : Number.NaN;
  if (!Number.isFinite(ext)) {
    return new Date(nowMs + NETWORK_ATTEMPT_TIMEOUT_MS);
  }
  return new Date(Math.min(nowMs + NETWORK_ATTEMPT_TIMEOUT_MS, ext));
}
