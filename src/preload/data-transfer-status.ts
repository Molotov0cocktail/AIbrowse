import type { DataTransferStatus } from '../shared/types/data-transfer';

const states = new Set([
  'idle',
  'choosing',
  'confirming',
  'draining',
  'validating',
  'verifying',
  'publishing',
  'handoff',
  'awaiting-restart',
  'completed',
  'cancelled',
  'failed',
  'recovery-required',
  'recovering-original',
  'original-restored',
]);
const codes = new Set([
  'none',
  'busy',
  'invalid-request',
  'stale-document',
  'cancelled',
  'deadline',
  'maintenance',
  'worker',
  'verification',
  'publication',
  'handoff',
  'relaunch',
  'recovery',
  'scope',
]);
const keys = [
  'operationId',
  'action',
  'state',
  'code',
  'message',
  'canCancel',
  'canRecoverOriginal',
  'availableActions',
]
  .sort()
  .join(',');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const startable = new Set([
  'idle',
  'completed',
  'cancelled',
  'failed',
  'recovery-required',
  'original-restored',
]);

/** Closed UI projection. This never authorizes an operation in main. */
export function parseDataTransferStatus(value: unknown): DataTransferStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('本地数据状态无效');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== keys ||
    (v.operationId !== null &&
      (typeof v.operationId !== 'string' ||
        v.operationId.length !== 36 ||
        !uuid.test(v.operationId))) ||
    (v.action !== null && v.action !== 'backup' && v.action !== 'restore') ||
    typeof v.state !== 'string' ||
    !states.has(v.state) ||
    typeof v.code !== 'string' ||
    !codes.has(v.code) ||
    typeof v.message !== 'string' ||
    v.message.length > 512 ||
    typeof v.canCancel !== 'boolean' ||
    typeof v.canRecoverOriginal !== 'boolean' ||
    !Array.isArray(v.availableActions) ||
    v.availableActions.length > 2 ||
    [...v.availableActions].some((action) => action !== 'backup' && action !== 'restore') ||
    new Set(v.availableActions).size !== v.availableActions.length ||
    (v.availableActions.length > 0 &&
      (!startable.has(v.state) || v.canCancel || v.canRecoverOriginal))
  )
    throw new Error('本地数据状态无效');
  return { ...v, availableActions: [...v.availableActions] } as DataTransferStatus;
}
