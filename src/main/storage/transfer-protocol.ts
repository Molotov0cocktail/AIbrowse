import { parseBoundedJson } from './bounded-json';
import {
  BACKUP_LIMITS,
  isTransferUuid,
  parseBackupManifest,
  type BackupManifest,
  type FileDigest,
} from './backup-container';
import { TRANSFER_FRAME_LIMITS } from './transfer-budget';

export const TRANSFER_ACTION_PHASES = Object.freeze({
  backup: ['sqlite', 'conversations', 'containerIo'],
  restore: ['containerIo', 'sqlite', 'conversations'],
  migrate: ['sqlite', 'conversations'],
} as const);
export type ValidationPhase = 'sqlite' | 'conversations' | 'containerIo';
export interface TransferJobRecord {
  readonly operationId: string;
  readonly snapshotId: string;
  readonly action: keyof typeof TRANSFER_ACTION_PHASES;
}
export interface TransferResult {
  /** Work DB fingerprints; conversations is wire for backup and a tree for restore/migrate. */
  manifest: BackupManifest;
  /** Only backup actions produce the fixed operation-root output.aibak. */
  backup: FileDigest | null;
}
export type TransferIncoming =
  | { type: 'ready'; operationId: string }
  | { type: 'phase'; operationId: string; phase: ValidationPhase }
  | { type: 'result'; operationId: string; result: TransferResult }
  | { type: 'failed'; operationId: string; code: 'validation' | 'io' | 'cancelled' };
export type TransferOutgoing =
  | ({ type: 'init' } & TransferJobRecord)
  | { type: 'phase'; operationId: string; phase: ValidationPhase }
  | { type: 'cancel'; operationId: string };
export class TransferProtocolError extends Error {
  constructor() {
    super('数据校验通信无效，原件和恢复记录已保留');
  }
}
function requireProtocol(value: unknown): asserts value {
  if (!value) throw new TransferProtocolError();
}
function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function validateTransferJob(value: unknown): TransferJobRecord {
  requireProtocol(closed(value, ['operationId', 'snapshotId', 'action']));
  requireProtocol(isTransferUuid(value.operationId) && isTransferUuid(value.snapshotId));
  requireProtocol(
    typeof value.action === 'string' && Object.hasOwn(TRANSFER_ACTION_PHASES, value.action),
  );
  return Object.freeze({
    operationId: value.operationId,
    snapshotId: value.snapshotId,
    action: value.action as TransferJobRecord['action'],
  });
}

/** A single ledger covers incoming and outgoing frames; any violation poisons it permanently. */
export function createTransferProtocol(record: TransferJobRecord): {
  receive(value: unknown): TransferIncoming;
  send(value: TransferOutgoing): string;
  counts(): { frames: number; bytes: number };
} {
  const job = validateTransferJob(record);
  let frames = 0;
  let bytes = 0;
  let poisoned = false;
  function frame(value: unknown, outgoing: boolean): Record<string, unknown> {
    try {
      requireProtocol(
        !poisoned && typeof value === 'string' && value.length <= TRANSFER_FRAME_LIMITS.bytes,
      );
      const length = Buffer.byteLength(value);
      requireProtocol(length > 0 && length <= TRANSFER_FRAME_LIMITS.bytes);
      frames++;
      bytes += length;
      requireProtocol(
        frames <= TRANSFER_FRAME_LIMITS.count && bytes <= TRANSFER_FRAME_LIMITS.totalBytes,
      );
      const parsed = parseBoundedJson(value, {
        bytes: TRANSFER_FRAME_LIMITS.bytes,
        depth: 8,
        nodes: 256,
      });
      requireProtocol(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
      const row = parsed as Record<string, unknown>;
      requireProtocol(row.operationId === job.operationId);
      switch (row.type) {
        case 'ready':
          requireProtocol(!outgoing && closed(row, ['type', 'operationId']));
          break;
        case 'phase':
          requireProtocol(
            closed(row, ['type', 'operationId', 'phase']) &&
              typeof row.phase === 'string' &&
              ['sqlite', 'conversations', 'containerIo'].includes(row.phase),
          );
          break;
        case 'result':
          requireProtocol(!outgoing && closed(row, ['type', 'operationId', 'result']));
          requireProtocol(closed(row.result, ['manifest', 'backup']));
          {
            const manifest = parseBackupManifest(Buffer.from(JSON.stringify(row.result.manifest)));
            requireProtocol(manifest.snapshotId === job.snapshotId);
            requireProtocol(
              manifest.members.every(
                (member) =>
                  member.present && member.schemaVersion === (member.id === 'watch' ? 5 : 1),
              ),
            );
            const output = row.result.backup;
            if (job.action === 'backup') {
              requireProtocol(
                closed(output, ['bytes', 'sha256']) &&
                  typeof output.bytes === 'number' &&
                  Number.isSafeInteger(output.bytes) &&
                  output.bytes > 0 &&
                  output.bytes <= BACKUP_LIMITS.container &&
                  typeof output.sha256 === 'string' &&
                  /^[a-f0-9]{64}$/.test(output.sha256),
              );
            } else requireProtocol(output === null);
            row.result = { manifest, backup: output };
          }
          break;
        case 'failed':
          requireProtocol(
            !outgoing &&
              closed(row, ['type', 'operationId', 'code']) &&
              typeof row.code === 'string' &&
              ['validation', 'io', 'cancelled'].includes(row.code),
          );
          break;
        case 'init':
          requireProtocol(
            outgoing &&
              closed(row, ['type', 'operationId', 'snapshotId', 'action']) &&
              row.snapshotId === job.snapshotId &&
              row.action === job.action,
          );
          break;
        case 'cancel':
          requireProtocol(outgoing && closed(row, ['type', 'operationId']));
          break;
        default:
          throw new TransferProtocolError();
      }
      return row;
    } catch {
      poisoned = true;
      throw new TransferProtocolError();
    }
  }
  return {
    receive(value) {
      return frame(value, false) as TransferIncoming;
    },
    send(value) {
      const text = JSON.stringify(value);
      frame(text, true);
      return text;
    },
    counts() {
      return { frames, bytes };
    },
  };
}
