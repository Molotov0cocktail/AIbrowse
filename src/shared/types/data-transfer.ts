export type DataTransferAction = 'backup' | 'restore';
export type DataTransferState =
  | 'idle'
  | 'choosing'
  | 'confirming'
  | 'draining'
  | 'validating'
  | 'verifying'
  | 'publishing'
  | 'handoff'
  | 'awaiting-restart'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'recovery-required'
  | 'recovering-original'
  | 'original-restored';
export type DataTransferCode =
  | 'none'
  | 'busy'
  | 'invalid-request'
  | 'stale-document'
  | 'cancelled'
  | 'deadline'
  | 'maintenance'
  | 'worker'
  | 'verification'
  | 'publication'
  | 'handoff'
  | 'relaunch'
  | 'recovery'
  | 'scope';

/** Renderer projection only. Native selections and file contents stay in main. */
export interface DataTransferStatus {
  operationId: string | null;
  action: DataTransferAction | null;
  state: DataTransferState;
  code: DataTransferCode;
  message: string;
  canCancel: boolean;
  canRecoverOriginal: boolean;
  availableActions: DataTransferAction[];
}
