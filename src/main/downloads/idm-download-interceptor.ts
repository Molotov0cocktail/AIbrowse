import type { DownloadItem, Session, WebContents, WebFrameMain } from 'electron';
import { createHash } from 'node:crypto';
import type { IdmToolResult } from '../../shared/types/downloads';
import { normalizeIdmUrl } from './idm-service';
import { normalizeIdmMetadata, type IdmDownloadMetadata } from './idm-native-service';

export interface IdmDownloadLease {
  readonly token: string;
  isCurrent(): boolean;
}
export interface IdmDownloadSnapshot {
  readonly url: string;
  readonly urlChain: readonly string[];
  readonly filename: string;
  readonly hasUserGesture: boolean;
  readonly initiatorOrigin: string;
}
interface Options {
  readonly session: Session;
  readonly service: {
    send(metadata: IdmDownloadMetadata, isCurrent: () => boolean): Promise<IdmToolResult>;
  };
  readonly getCaptureContext: (
    webContentsId: number,
    frame: WebFrameMain | null,
  ) => IdmDownloadLease | null;
  readonly consumeDownloadLease: (
    webContents: WebContents,
    frame: WebFrameMain | null,
    snapshot: IdmDownloadSnapshot,
  ) => IdmDownloadLease | null;
  readonly isUserDownloadFrame: (webContentsId: number, frame: WebFrameMain | null) => boolean;
  readonly onResult?: (result: IdmToolResult) => void;
  readonly now?: () => number;
  readonly readFallback?: (input: {
    snapshot: IdmDownloadSnapshot;
    webContents: WebContents;
    frame: WebFrameMain;
    referrer: string;
    isCurrent: () => boolean;
  }) => Promise<{ cookie: string; referer: string; userAgent: string } | null>;
}
interface RequestRecord {
  readonly requestId: number;
  readonly webContentsId: number;
  readonly frame: WebFrameMain;
  readonly lease: IdmDownloadLease;
  readonly expiresAt: number;
  readonly url: string;
  readonly method: string;
  readonly metadata: Omit<IdmDownloadMetadata, 'filename'>;
  readonly needsFallback: boolean;
  readonly referrer: string;
}
interface InFlightRequest {
  readonly requestId: number;
  readonly webContentsId: number;
  readonly frame: WebFrameMain | null;
  readonly token: string | null;
  readonly urlHash: string;
  readonly ready: boolean;
  readonly completed: boolean;
  readonly ordinaryHtml: boolean;
  readonly allGet: boolean;
}
const UNSUPPORTED: IdmToolResult = {
  ok: false,
  code: 'failed',
  message: '该次下载无法安全交给 IDM；仅支持由用户点击触发的普通 HTTP(S) GET 下载',
};

function current(lease: IdmDownloadLease): boolean {
  try {
    return lease.isCurrent() === true;
  } catch {
    return false;
  }
}
function networkUrl(value: string): string | null {
  const normalized = normalizeIdmUrl(value);
  if (normalized === null) return null;
  const url = new URL(normalized);
  url.hash = '';
  return url.href;
}
function header(headers: Record<string, string>, name: string): string | null {
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === name);
  return keys.length > 1 ? null : keys.length === 1 ? (headers[keys[0]!] ?? null) : '';
}

/** Observes actual outbound headers only while a trusted main-process lease exists. */
export class IdmDownloadInterceptor {
  private readonly records = new Map<number, RequestRecord>();
  // Request ownership outlives click leases. A DownloadItem consumes a unique
  // response; completion alone must not let old requests borrow newer cookies.
  private readonly inFlight = new Map<number, InFlightRequest>();
  private readonly saturatedFrames = new WeakSet<WebFrameMain>();
  private unknownProvenanceSaturated = false;
  private readonly poisoned = new Map<string, { lease: IdmDownloadLease; expiresAt: number }>();
  private blockedUntil = 0;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    options.session.webRequest.onSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      this.captureHeaders,
    );
    options.session.on('will-download', this.willDownload);
    options.session.webRequest.onCompleted?.(
      { urls: ['http://*/*', 'https://*/*'] },
      this.requestEnded,
    );
    options.session.webRequest.onErrorOccurred?.(
      { urls: ['http://*/*', 'https://*/*'] },
      this.requestEnded,
    );
    options.session.webRequest.onHeadersReceived?.(
      { urls: ['http://*/*', 'https://*/*'] },
      this.responseReady,
    );
    this.timer = setInterval(() => this.prune(), 1000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.records.clear();
    this.inFlight.clear();
    this.poisoned.clear();
    this.options.session.removeListener('will-download', this.willDownload);
    this.options.session.webRequest.onSendHeaders(null);
    this.options.session.webRequest.onCompleted?.(null);
    this.options.session.webRequest.onErrorOccurred?.(null);
    this.options.session.webRequest.onHeadersReceived?.(null);
  }

  private readonly requestEnded = (details: { id: number }): void => {
    const request = this.inFlight.get(details.id);
    if (!request) return;
    // Normal downloads report completion BEFORE will-download, whereas the
    // download-attribute factory reports it AFTER. Completion alone is no proof
    // that a DownloadItem cannot still arrive.
    if (request.ordinaryHtml) {
      this.inFlight.delete(details.id);
      this.records.delete(details.id);
    } else this.inFlight.set(details.id, { ...request, completed: true });
  };

  private readonly responseReady = (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ): void => {
    try {
      const request = this.inFlight.get(details.id);
      const url = networkUrl(details.url);
      if (
        !request ||
        url === null ||
        createHash('sha256').update(url).digest('hex') !== request.urlHash
      )
        return;
      const headers = details.responseHeaders ?? {};
      const types = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-type');
      const dispositions = Object.keys(headers).filter(
        (key) => key.toLowerCase() === 'content-disposition',
      );
      const values = types.length === 1 ? headers[types[0]!] : undefined;
      const ordinaryHtml =
        details.resourceType === 'mainFrame' &&
        details.statusCode >= 200 &&
        details.statusCode < 300 &&
        dispositions.length === 0 &&
        values?.length === 1 &&
        values[0]?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
      this.inFlight.set(details.id, {
        ...request,
        ready: details.statusCode < 300 || details.statusCode >= 400,
        ordinaryHtml,
      });
    } finally {
      callback({});
    }
  };

  private prune(): void {
    for (const [id, record] of this.records)
      if (record.expiresAt <= this.now() || !current(record.lease)) this.records.delete(id);
    for (const [token, rejected] of this.poisoned)
      if (rejected.expiresAt <= this.now() || !current(rejected.lease)) this.poisoned.delete(token);
    for (const [id, request] of this.inFlight) {
      try {
        if (request.frame?.detached) {
          this.inFlight.delete(id);
          this.records.delete(id);
        }
      } catch {
        this.inFlight.delete(id);
        this.records.delete(id);
      }
    }
  }

  private poison(lease: IdmDownloadLease): void {
    for (const [id, record] of this.records)
      if (record.lease.token === lease.token) this.records.delete(id);
    if (!this.poisoned.has(lease.token) && this.poisoned.size >= 8) {
      // Saturation is bounded and fails closed instead of forgetting ambiguity.
      this.blockedUntil = this.now() + 10000;
      this.records.clear();
      this.poisoned.clear();
      return;
    }
    this.poisoned.set(lease.token, { lease, expiresAt: this.now() + 10000 });
  }

  private readonly captureHeaders = (details: Electron.OnSendHeadersListenerDetails): void => {
    if (this.closed) return;
    this.prune();
    let lease: IdmDownloadLease | null = null;
    const affected = [...this.records.values()].filter(
      (record) =>
        record.requestId === details.id ||
        (record.webContentsId === details.webContentsId && record.url === networkUrl(details.url)),
    );
    // A redirected request keeps its id. Preserve enough identity to poison an
    // incomplete event instead of silently retaining a different old request.
    this.records.delete(details.id);
    const reject = (): void => {
      if (lease) this.poison(lease);
      for (const record of affected) this.poison(record.lease);
    };
    try {
      const wcId = details.webContentsId;
      const frame = details.frame ?? null;
      const url = networkUrl(details.url);
      if (wcId !== undefined) lease = this.options.getCaptureContext(wcId, frame);
      const isUserFrame = wcId !== undefined && this.options.isUserDownloadFrame(wcId, frame);
      // Track identity even without a current lease. No Cookie/header data is
      // inspected here, and a redirect retains its original token.
      if (
        wcId !== undefined &&
        url !== null &&
        (isUserFrame || this.inFlight.has(details.id)) &&
        ['mainFrame', 'subFrame', 'other'].includes(details.resourceType)
      ) {
        const existing = this.inFlight.get(details.id);
        if (!existing && this.inFlight.size >= 256) {
          if (frame) this.saturatedFrames.add(frame);
          else this.unknownProvenanceSaturated = true;
          return reject();
        }
        this.inFlight.set(details.id, {
          requestId: details.id,
          webContentsId: wcId,
          frame,
          token: existing ? existing.token : (lease?.token ?? null),
          urlHash: createHash('sha256').update(url).digest('hex'),
          ready: false,
          completed: false,
          ordinaryHtml: false,
          allGet: (existing?.allGet ?? true) && details.method === 'GET',
        });
      }
      if (
        wcId === undefined ||
        !isUserFrame ||
        !frame ||
        !['mainFrame', 'subFrame', 'other'].includes(details.resourceType)
      )
        return reject();
      if (!lease || !current(lease)) return reject();
      if (this.saturatedFrames.has(frame) || this.inFlight.get(details.id)?.token !== lease.token)
        return reject();
      if (this.now() < this.blockedUntil || this.poisoned.has(lease.token)) return reject();
      const cookie = header(details.requestHeaders, 'cookie');
      const referer = header(details.requestHeaders, 'referer');
      const userAgent = header(details.requestHeaders, 'user-agent');
      const authorization = header(details.requestHeaders, 'authorization');
      const needsFallback =
        details.resourceType === 'other' &&
        details.method === 'GET' &&
        Object.keys(details.requestHeaders).length === 0 &&
        this.options.readFallback !== undefined;
      if (
        url === null ||
        cookie === null ||
        referer === null ||
        userAgent === null ||
        (userAgent === '' && !needsFallback) ||
        authorization !== ''
      )
        return reject();
      const metadata = normalizeIdmMetadata({ url, cookie, referer, userAgent, filename: '' });
      if (!metadata) return reject();
      // At most eight request records retain less than 384 KiB of header text.
      if (this.records.size >= 8) return reject();
      this.records.set(details.id, {
        requestId: details.id,
        webContentsId: wcId,
        frame,
        lease,
        expiresAt: this.now() + 10000,
        url,
        method: details.method,
        metadata,
        needsFallback,
        referrer: details.referrer,
      });
    } catch {
      /* Missing/destroyed native state never authorizes a download. */
      reject();
    }
  };

  private readonly willDownload = (
    event: Electron.Event,
    item: DownloadItem,
    wc: WebContents,
    frame: WebFrameMain | null,
  ): void => {
    // Chromium must never write a download file, including unsupported downloads.
    event.preventDefault();
    if (this.closed) return;
    this.captureCancelledDownload(item, wc, frame);
  };

  captureCancelledDownload(item: DownloadItem, wc: WebContents, frame: WebFrameMain | null): void {
    if (this.closed) return;
    this.prune();
    let lease: IdmDownloadLease | null = null;
    try {
      // DownloadItem becomes invalid after the callback; capture every field now.
      const snapshot: IdmDownloadSnapshot = Object.freeze({
        url: item.getURL(),
        urlChain: Object.freeze([...item.getURLChain()]),
        filename: item.getFilename(),
        hasUserGesture: item.hasUserGesture(),
        initiatorOrigin: item.getInitiatorOrigin(),
      });
      const url = networkUrl(snapshot.url);
      const urlHash = url === null ? null : createHash('sha256').update(url).digest('hex');
      const pending = [...this.inFlight.values()].filter(
        (request) =>
          request.ready &&
          request.webContentsId === wc.id &&
          (request.frame === null || request.frame === frame) &&
          request.urlHash === urlHash,
      );
      // Native cancellation consumes exactly one response even without a valid
      // click. Keep ambiguous identities; never guess which request completed.
      const unique = pending.length === 1 && pending[0]?.frame === frame ? pending[0] : undefined;
      const captured = unique ? this.records.get(unique.requestId) : undefined;
      if (unique) {
        this.inFlight.delete(unique.requestId);
        this.records.delete(unique.requestId);
      }
      lease = this.options.consumeDownloadLease(wc, frame, snapshot);
      if (!lease || !current(lease)) return;
      if (this.now() < this.blockedUntil || this.poisoned.has(lease.token))
        return this.report(UNSUPPORTED);
      if (
        this.unknownProvenanceSaturated ||
        frame === null ||
        this.saturatedFrames.has(frame) ||
        pending.length !== 1 ||
        pending[0]?.token !== lease.token ||
        !pending[0]?.allGet
      ) {
        this.poison(lease);
        return this.report(UNSUPPORTED);
      }
      const record =
        captured?.lease.token === lease.token &&
        captured.webContentsId === wc.id &&
        captured.frame === frame &&
        captured.url === url &&
        current(captured.lease)
          ? captured
          : undefined;
      // One trusted click permits one handoff. Drop every related sensitive record.
      for (const [id, record] of this.records)
        if (record.lease.token === lease.token) this.records.delete(id);
      const chain = snapshot.urlChain.map(networkUrl);
      if (
        !record ||
        record.method !== 'GET' ||
        chain.length === 0 ||
        chain.length > 20 ||
        chain.some((entry) => entry === null) ||
        chain.at(-1) !== url
      )
        return this.report(UNSUPPORTED);
      const metadata = normalizeIdmMetadata({ ...record.metadata, filename: snapshot.filename });
      if (!metadata) return this.report(UNSUPPORTED);
      const acceptedLease = lease;
      const isCurrent = (): boolean => !this.closed && current(acceptedLease);
      const handoff = async (): Promise<IdmToolResult> => {
        if (record.needsFallback) {
          const recovered = await this.options.readFallback?.({
            snapshot,
            webContents: wc,
            frame,
            referrer: record.referrer,
            isCurrent,
          });
          if (!recovered || !isCurrent()) return UNSUPPORTED;
          const restored = normalizeIdmMetadata({ ...metadata, ...recovered });
          if (!restored) return UNSUPPORTED;
          return this.options.service.send(restored, isCurrent);
        }
        return this.options.service.send(metadata, isCurrent);
      };
      void handoff().then(
        (result) => {
          if (!this.closed) this.report(result);
        },
        () => {
          if (!this.closed) this.report(UNSUPPORTED);
        },
      );
    } catch {
      if (lease)
        for (const [id, record] of this.records)
          if (record.lease.token === lease.token) this.records.delete(id);
      this.report(UNSUPPORTED);
    }
  }

  private report(result: IdmToolResult): void {
    try {
      this.options.onResult?.(result);
    } catch {
      /* UI feedback cannot reopen download authorization. */
    }
  }
}
