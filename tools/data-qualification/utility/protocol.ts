// Qualification-only protocol. No paths, SQL, scripts, or provider configuration.
export const QUALIFICATION = Object.freeze({
  appName: 'aibrowse-e2-utility-qualification',
  executable: 'AIbrowseE2UtilityQualification.exe',
  nativeRounds: 3,
  nativeObservationMs: 1000,
  exitConfirmationMs: 2000,
  caseMs: 7000,
  applicationMs: 65000,
  jobMs: 90000,
  totalWithJobCleanupMs: 120000,
  messageBytes: 256,
  messageCount: 32,
  totalMessageBytes: 8192,
  uiSampleMs: 50,
  uiRoundTripMs: 750,
  uiGapMs: 1000,
  minimumNativeUiSamples: 6,
  diskBytes: 768 * 1024 * 1024,
});

export const MODES = ['control', 'native', 'late', 'flood', 'malformed'] as const;
export type Mode = (typeof MODES)[number];
export const UI_SCHEME = 'e2qualification';
export const UI_ENTRY = 'e2qualification://app/ui.html';
export function resolveUiAsset(url: string, method: string): 'ui.html' | 'renderer.js' | null {
  if (method !== 'GET') return null;
  if (url === UI_ENTRY) return 'ui.html';
  if (url === 'e2qualification://app/renderer.js') return 'renderer.js';
  return null;
}
export const FIXTURE_DIGEST = '8'.repeat(64);
export type MessageKind = 'ready' | 'heartbeat' | 'entered' | 'validated';
export interface WorkerMessage {
  id: number;
  kind: MessageKind;
  count: number;
  digest: string;
}

export function parseMessage(raw: unknown, id: number): WorkerMessage | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > QUALIFICATION.messageBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'count,digest,id,kind' ||
    item.id !== id ||
    !['ready', 'heartbeat', 'entered', 'validated'].includes(String(item.kind)) ||
    !Number.isSafeInteger(item.count) ||
    Number(item.count) < 0 ||
    Number(item.count) > 1000 ||
    item.digest !== FIXTURE_DIGEST
  )
    return null;
  return item as unknown as WorkerMessage;
}

export class OperationGate {
  phase: 'running' | 'failed' | 'validated' | 'exited' = 'running';
  failure: 'none' | 'deadline' | 'protocol' | 'flood' | 'exit' = 'none';
  messages = 0;
  bytes = 0;
  late = 0;
  exited = false;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }

  fail(reason: Exclude<OperationGate['failure'], 'none'>): void {
    if (this.phase === 'failed') return;
    this.phase = 'failed';
    this.failure = reason;
  }

  receive(raw: unknown): WorkerMessage | null {
    if (this.phase === 'failed' || this.phase === 'exited') {
      this.late++;
      return null;
    }
    this.messages++;
    this.bytes += typeof raw === 'string' ? Math.min(Buffer.byteLength(raw), 257) : 257;
    if (
      this.messages > QUALIFICATION.messageCount ||
      this.bytes > QUALIFICATION.totalMessageBytes
    ) {
      this.fail('flood');
      return null;
    }
    const value = parseMessage(raw, this.id);
    if (value === null || (this.phase === 'validated' && value.kind === 'validated')) {
      this.fail('protocol');
      return null;
    }
    if (value.kind === 'validated') this.phase = 'validated';
    return value;
  }

  confirmExit(code: number): void {
    this.exited = true;
    if (this.phase === 'validated' && code === 0) this.phase = 'exited';
    else if (this.phase !== 'failed') this.fail('exit');
  }

  canSwitch(): boolean {
    return this.exited && this.phase === 'exited';
  }
}
