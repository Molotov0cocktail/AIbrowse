import { randomBytes } from 'node:crypto';

export const WATCH_PREVIEW_TTL_MS = 300_000;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface WatchPreviewRecord {
  sourceId: string;
  sourceRowVersion: number;
  locatorFingerprint: string;
  finalOrigin: string;
  accessMode: 'public' | 'session';
  target: unknown;
  projection: unknown;
  fieldCatalog: readonly string[];
  validator: unknown;
  previewTabId?: string;
}

interface Entry {
  expiresAt: number;
  record: WatchPreviewRecord;
}

interface DiscoveryEntry {
  expiresAt: number;
  sourceId: string;
  candidates: Map<string, string>;
}

export const MAX_WATCH_PREVIEWS = 128;
export const MAX_WATCH_DISCOVERIES = MAX_WATCH_PREVIEWS;

export class WatchPreviewStore {
  private readonly entries = new Map<string, Entry>();
  private readonly discoveries = new Map<string, DiscoveryEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(record: WatchPreviewRecord): string | null {
    this.pruneExpired();
    if (this.size >= MAX_WATCH_PREVIEWS) return null;
    let handle: string;
    do {
      handle = randomBytes(32).toString('base64url');
    } while (this.entries.has(handle));
    this.entries.set(handle, { expiresAt: this.now() + WATCH_PREVIEW_TTL_MS, record });
    return handle;
  }

  consume(handle: string): WatchPreviewRecord | null {
    if (!HANDLE_PATTERN.test(handle)) return null;
    const entry = this.entries.get(handle);
    this.entries.delete(handle);
    if (entry === undefined || this.now() >= entry.expiresAt) return null;
    return entry.record;
  }

  issueDiscovery(
    sourceId: string,
    urls: readonly string[],
  ): {
    discoveryHandle: string;
    candidates: Array<{ candidateId: string; feedUrl: string }>;
  } | null {
    this.pruneExpired();
    if (this.size >= MAX_WATCH_DISCOVERIES) return null;
    const discoveryHandle = this.newHandle(new Set(this.discoveries.keys()));
    const candidateIds = new Set<string>();
    const candidates = urls.map((feedUrl) => {
      const candidateId = this.newHandle(candidateIds);
      candidateIds.add(candidateId);
      return { candidateId, feedUrl };
    });
    this.discoveries.set(discoveryHandle, {
      expiresAt: this.now() + WATCH_PREVIEW_TTL_MS,
      sourceId,
      candidates: new Map(
        candidates.map((candidate) => [candidate.candidateId, candidate.feedUrl]),
      ),
    });
    return { discoveryHandle, candidates };
  }

  consumeDiscovery(
    discoveryHandle: string,
    candidateId: string,
  ): { sourceId: string; feedUrl: string } | null {
    if (!HANDLE_PATTERN.test(discoveryHandle) || !HANDLE_PATTERN.test(candidateId)) return null;
    const entry = this.discoveries.get(discoveryHandle);
    this.discoveries.delete(discoveryHandle);
    if (entry === undefined || this.now() >= entry.expiresAt) return null;
    const feedUrl = entry.candidates.get(candidateId);
    return feedUrl === undefined ? null : { sourceId: entry.sourceId, feedUrl };
  }

  dispose(): void {
    this.entries.clear();
    this.discoveries.clear();
  }
  get size(): number {
    return this.entries.size + this.discoveries.size;
  }

  private newHandle(existing: ReadonlySet<string>): string {
    let handle: string;
    do {
      handle = randomBytes(32).toString('base64url');
    } while (existing.has(handle));
    return handle;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [handle, entry] of this.entries)
      if (now >= entry.expiresAt) this.entries.delete(handle);
    for (const [handle, entry] of this.discoveries)
      if (now >= entry.expiresAt) this.discoveries.delete(handle);
  }
}
