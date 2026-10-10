import { parseBoundedJson } from './bounded-json';
import { isTransferUuid } from './backup-container';
import { TRANSFER_FRAME_LIMITS, TRANSFER_PHASE_MS } from './transfer-budget';

export const STARTUP_PROBE_DOMAINS = ['sources', 'research', 'watch'] as const;
export type StartupProbeDomain = (typeof STARTUP_PROBE_DOMAINS)[number];
export const STARTUP_PROBE_VERSIONS = { sources: 1, research: 1, watch: 5 } as const;
export interface StartupFileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}
export interface StartupDirectoryIdentity {
  dev: string;
  ino: string;
}
export interface StartupProbeMember {
  id: StartupProbeDomain;
  state: 'missing' | 'empty' | 'current' | 'legacy';
  version: number | null;
  directory: StartupDirectoryIdentity | null;
  database: StartupFileIdentity | null;
  wal: StartupFileIdentity | null;
  journal: StartupFileIdentity | null;
}
export type StartupProbeResult =
  | { state: 'normal' | 'migrate'; root: StartupDirectoryIdentity; members: StartupProbeMember[] }
  | {
      state: 'recovery-required';
      code: 'io' | 'schema' | 'future' | 'integrity' | 'input-changed' | 'cancelled' | 'deadline';
      domain: StartupProbeDomain | null;
    };
export type StartupProbeFrame =
  | { type: 'init'; operationId: string; remainingMs: number }
  | { type: 'ready'; operationId: string }
  | { type: 'result'; operationId: string; result: StartupProbeResult };
export class StartupProbeError extends Error {
  constructor() {
    super('启动数据预检失败，原件已保留');
  }
}
function requireProbe(value: unknown): asserts value {
  if (!value) throw new StartupProbeError();
}
function closed(v: unknown, keys: string[]): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
function identity(v: unknown, file: boolean): boolean {
  const keys = file ? ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] : ['dev', 'ino'];
  return (
    closed(v, keys) && keys.every((k) => typeof v[k] === 'string' && /^[0-9]{1,40}$/u.test(v[k]))
  );
}
export function validateStartupProbeResult(value: unknown): StartupProbeResult {
  if (closed(value, ['state', 'code', 'domain']) && value.state === 'recovery-required') {
    requireProbe(
      ['io', 'schema', 'future', 'integrity', 'input-changed', 'cancelled', 'deadline'].includes(
        String(value.code),
      ) &&
        (value.domain === null ||
          STARTUP_PROBE_DOMAINS.includes(value.domain as StartupProbeDomain)),
    );
    return value as unknown as StartupProbeResult;
  }
  requireProbe(
    closed(value, ['state', 'root', 'members']) &&
      (value.state === 'normal' || value.state === 'migrate') &&
      identity(value.root, false) &&
      Array.isArray(value.members) &&
      value.members.length === 3,
  );
  let legacy = false;
  for (const [i, member] of value.members.entries()) {
    requireProbe(
      closed(member, ['id', 'state', 'version', 'directory', 'database', 'wal', 'journal']) &&
        member.id === STARTUP_PROBE_DOMAINS[i],
    );
    const current = STARTUP_PROBE_VERSIONS[STARTUP_PROBE_DOMAINS[i]!];
    requireProbe(member.directory === null || identity(member.directory, false));
    for (const field of ['database', 'wal', 'journal'])
      requireProbe(member[field] === null || identity(member[field], true));
    if (member.state === 'missing')
      requireProbe(
        member.version === null &&
          member.database === null &&
          member.wal === null &&
          member.journal === null,
      );
    else {
      requireProbe(
        member.directory !== null &&
          member.database !== null &&
          Number.isInteger(member.version) &&
          typeof member.version === 'number' &&
          member.version >= 0 &&
          member.version <= current,
      );
      if (member.state === 'empty') requireProbe(member.version === 0);
      else if (member.state === 'current') requireProbe(member.version === current);
      else {
        requireProbe(
          member.state === 'legacy' &&
            member.version > 0 &&
            (member.version < current || member.id === 'watch'),
        );
        legacy = true;
      }
    }
  }
  requireProbe((value.state === 'migrate') === legacy);
  return value as unknown as StartupProbeResult;
}
/** One duplex ledger: every inbound and outbound frame counts, including invalid frames. */
export function createStartupProbeProtocol(operationId: string) {
  requireProbe(isTransferUuid(operationId));
  let count = 0,
    bytes = 0,
    failed = false;
  function read(raw: unknown): StartupProbeFrame {
    try {
      requireProbe(!failed && typeof raw === 'string' && raw.length <= TRANSFER_FRAME_LIMITS.bytes);
      const size = Buffer.byteLength(raw);
      count++;
      bytes += size;
      requireProbe(
        size <= TRANSFER_FRAME_LIMITS.bytes &&
          count <= TRANSFER_FRAME_LIMITS.count &&
          bytes <= TRANSFER_FRAME_LIMITS.totalBytes,
      );
      const value = parseBoundedJson(raw, {
        bytes: TRANSFER_FRAME_LIMITS.bytes,
        depth: 7,
        nodes: 200,
      });
      requireProbe(typeof value === 'object' && value !== null && !Array.isArray(value));
      const v = value as Record<string, unknown>;
      requireProbe(v.operationId === operationId);
      if (v.type === 'init')
        requireProbe(
          closed(v, ['type', 'operationId', 'remainingMs']) &&
            typeof v.remainingMs === 'number' &&
            Number.isFinite(v.remainingMs) &&
            v.remainingMs > 0 &&
            v.remainingMs <= TRANSFER_PHASE_MS.sqlite,
        );
      else if (v.type === 'ready') requireProbe(closed(v, ['type', 'operationId']));
      else {
        requireProbe(v.type === 'result' && closed(v, ['type', 'operationId', 'result']));
        validateStartupProbeResult(v.result);
      }
      return v as unknown as StartupProbeFrame;
    } catch {
      failed = true;
      throw new StartupProbeError();
    }
  }
  return {
    read,
    write(frame: StartupProbeFrame): string {
      const raw = JSON.stringify(frame);
      read(raw);
      return raw;
    },
  };
}
