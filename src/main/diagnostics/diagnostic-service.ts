import type {
  DiagnosticErrorCode,
  DiagnosticExportResult,
  DiagnosticPreviewDto,
  DiagnosticPreviewResult,
} from '../../shared/types/diagnostics';
import { parseDiagnosticExportPayload } from '../../shared/types/diagnostics';
import { createDiagnosticCandidate, DiagnosticProjectionError } from './diagnostic-projection';

export const DIAGNOSTIC_CANDIDATE_TTL_MS = 5 * 60 * 1000;

export interface DiagnosticSnapshotPort {
  snapshot(): unknown;
}

export interface DiagnosticSavePort {
  showSaveDialog(defaultFileName: string): Promise<string | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export interface DiagnosticClock {
  now(): number;
}

export interface DiagnosticServiceOptions {
  readonly snapshot: DiagnosticSnapshotPort;
  readonly save: DiagnosticSavePort;
  readonly clock?: DiagnosticClock;
  readonly monotonicClock?: DiagnosticClock;
  readonly isOwnerCurrent: (owner: string) => boolean;
  readonly ttlMs?: number;
}

interface CandidateLease {
  readonly owner: string;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly expiresMonotonicAt: number;
  readonly preview: DiagnosticPreviewDto;
  invalidated: boolean;
}

export class DiagnosticService {
  private readonly clock: DiagnosticClock;
  private readonly monotonicClock: DiagnosticClock;
  private readonly ttlMs: number;
  private sequence = 0;
  private lease: CandidateLease | null = null;
  private inFlight: Promise<DiagnosticExportResult> | null = null;

  constructor(private readonly options: DiagnosticServiceOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.monotonicClock =
      options.monotonicClock ??
      (options.clock === undefined ? { now: () => performance.now() } : options.clock);
    this.ttlMs = options.ttlMs ?? DIAGNOSTIC_CANDIDATE_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error('诊断候选有效期无效');
    }
  }

  preview(owner: string): DiagnosticPreviewResult {
    if (!this.ownerIsCurrent(owner)) return failure('unavailable');
    if (this.inFlight !== null) return failure('busy');
    if (this.sequence >= Number.MAX_SAFE_INTEGER) return failure('unavailable');
    let candidate;
    try {
      candidate = createDiagnosticCandidate(this.options.snapshot.snapshot());
    } catch (error) {
      if (error instanceof DiagnosticProjectionError) return failure('unavailable');
      return failure('unavailable');
    }
    if (!this.ownerIsCurrent(owner)) return failure('stale');
    if (this.lease !== null) this.lease.invalidated = true;
    const sequence = ++this.sequence;
    let expiresAt: number;
    let expiresMonotonicAt: number;
    try {
      expiresAt = this.clock.now() + this.ttlMs;
      expiresMonotonicAt = this.monotonicClock.now() + this.ttlMs;
    } catch {
      return failure('unavailable');
    }
    if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(expiresMonotonicAt)) {
      return failure('unavailable');
    }
    const preview: DiagnosticPreviewDto = Object.freeze({
      sequence,
      expiresAt,
      digest: candidate.sha256,
      byteLength: candidate.byteLength,
      json: candidate.json,
      projection: candidate.projection,
    });
    this.lease = {
      owner,
      sequence,
      expiresAt,
      expiresMonotonicAt,
      preview,
      invalidated: false,
    };
    return Object.freeze({ ok: true, preview });
  }

  export(owner: string, payload: unknown): Promise<DiagnosticExportResult> {
    const parsed = parseDiagnosticExportPayload(payload);
    if (parsed === null) return Promise.resolve(failure('invalid-payload'));
    if (this.inFlight !== null) return Promise.resolve(failure('busy'));
    const lease = this.lease;
    const initial = this.checkLease(lease, owner, parsed.sequence, parsed.digest);
    if (initial !== null) return Promise.resolve(failure(initial));
    const operation = Promise.resolve().then(() => this.performExport(lease!));
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    return operation;
  }

  invalidate(owner: string): void {
    if (this.lease?.owner === owner) {
      this.lease.invalidated = true;
      this.lease = null;
    }
  }

  async invalidateAndDrain(owner?: string): Promise<void> {
    if (owner === undefined) {
      if (this.lease !== null) this.lease.invalidated = true;
      this.lease = null;
    } else {
      this.invalidate(owner);
    }
    const pending = this.inFlight;
    if (pending !== null)
      await pending.then(
        () => undefined,
        () => undefined,
      );
  }

  private async performExport(lease: CandidateLease): Promise<DiagnosticExportResult> {
    let path: string | null;
    try {
      path = await this.options.save.showSaveDialog('aibrowse-diagnostic.json');
    } catch {
      return failure('write-failed');
    }
    if (path === null) return failure('cancelled');
    const beforeWrite = this.checkLease(lease, lease.owner, lease.sequence, lease.preview.digest);
    if (beforeWrite !== null) return failure(beforeWrite);
    const bytes = new TextEncoder().encode(lease.preview.json);
    try {
      await this.options.save.write(path, bytes);
    } catch {
      return failure('write-failed');
    }
    return Object.freeze({
      ok: true,
      digest: lease.preview.digest,
      byteLength: lease.preview.byteLength,
    });
  }

  private checkLease(
    lease: CandidateLease | null,
    owner: string,
    sequence: number,
    digest: string,
  ): 'stale' | 'expired' | null {
    if (
      lease === null ||
      lease.invalidated ||
      this.lease !== lease ||
      lease.owner !== owner ||
      lease.sequence !== sequence ||
      lease.preview.digest !== digest ||
      !this.ownerIsCurrent(owner)
    ) {
      return 'stale';
    }
    try {
      return this.monotonicClock.now() >= lease.expiresMonotonicAt ? 'expired' : null;
    } catch {
      return 'stale';
    }
  }

  private ownerIsCurrent(owner: string): boolean {
    try {
      return owner.length > 0 && this.options.isOwnerCurrent(owner);
    } catch {
      return false;
    }
  }
}

function failure(
  errorCode: DiagnosticErrorCode,
): Readonly<{ ok: false; errorCode: DiagnosticErrorCode }> {
  return Object.freeze({ ok: false, errorCode });
}
