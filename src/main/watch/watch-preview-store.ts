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

export class WatchPreviewStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(record: WatchPreviewRecord): string {
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

  dispose(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}
