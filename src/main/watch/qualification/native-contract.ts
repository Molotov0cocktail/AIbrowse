/** Main-only, closed native qualification boundary. No object here grants runtime authority. */
declare const isolationTicketBrand: unique symbol;
declare const runtimeCapabilityBrand: unique symbol;

export interface LaunchIsolationTicket {
  readonly [isolationTicketBrand]: true;
}

export interface QualificationRuntimeCapability {
  readonly [runtimeCapabilityBrand]: true;
}

export type QpcTicks = string;
export type QualificationFileId = string;
export type QualificationPhase = 'warmup' | 'measurement' | 'drain';
export type QualificationRunPhase = 'initialization' | 'warmup' | 'measurement';
export const QUALIFICATION_REGISTRIES = [
  'host-grant',
  'coordinator-slot',
  'http-request',
  'http-response',
  'socket',
  'watch-timer',
  'digest-timer',
  'watch-owner-timer',
  'provider-attempt',
  'task-tab',
  'watch-async-operation',
  'watch-store',
  'watch-db',
  'watch-temp-lease',
] as const;
export type QualificationRegistry = (typeof QUALIFICATION_REGISTRIES)[number];
export interface QualificationRoots<T> {
  appDataRoot: T;
  localAppDataRoot: T;
  processTempRoot: T;
  runRoot: T;
  userDataRoot: T;
  watchTempRoot: T;
}
export interface PreparedLaunchIsolation {
  ticket: LaunchIsolationTicket;
  paths: QualificationRoots<string>;
  rootFileIds: QualificationRoots<QualificationFileId>;
  qualificationRunId: string;
}
export interface QualificationReady {
  appPathFileId: QualificationFileId;
  electronExeFileId: QualificationFileId;
  mainCreationFileTime: string;
  mainEntrySha256: string;
  mainPid: number;
  processExecPathSha256: string;
  processType: 'browser';
  qpcFrequency: number;
  rootFileIds: QualificationRoots<QualificationFileId>;
  serverCreationFileTime: string;
  serverPid: number;
}
export interface AuthenticatedQualificationLaunch {
  capability: QualificationRuntimeCapability;
  identity: QualificationReady;
  qpcAnchorTicks: QpcTicks;
  utcAnchorMs: number;
}
export interface QualificationCounters {
  duplicateTerminalAttemptTotal: number;
  uncaughtExceptionTotal: number;
  unhandledRejectionTotal: number;
}
export interface QualificationRegistryLive {
  registry: QualificationRegistry;
  identities: string[];
}
export interface QualificationHostGrantDetail {
  attemptOrdinal: number;
  entryIndex: number;
  grantElapsedMs: number;
  hostSlot: number;
  phase: QualificationRunPhase;
  round: number | null;
  waitedForGap: boolean;
}
export interface QualificationCoordinatorDetail {
  entryIndex: number;
  hostSlot: number;
  phase: QualificationRunPhase;
  round: number | null;
}
export type QualificationRegistryEvent =
  | { registry: 'host-grant'; identity: string; detail: QualificationHostGrantDetail }
  | { registry: 'coordinator-slot'; identity: string; detail: QualificationCoordinatorDetail }
  | {
      registry: 'watch-owner-timer';
      identity: string;
      detail: { ownerKind: 'host-gate' | 'coordinator' | 'qualification-fixture' };
    }
  | { registry: 'watch-async-operation'; identity: string; detail: null | { cleanupOf: string } }
  | {
      registry: Exclude<
        QualificationRegistry,
        'host-grant' | 'coordinator-slot' | 'watch-owner-timer' | 'watch-async-operation'
      >;
      identity: string;
      detail: null;
    };
export interface QualificationSample {
  counters: QualificationCounters;
  mainHeapUsedBytes: number;
  nodeActiveByType: { type: string; count: number }[];
  phase: QualificationPhase;
  registryLive: QualificationRegistryLive[];
  registryPrefixSequence: number;
  sampleToken: string;
  taskTabBindings: { identity: string; tabId: string; webContentsId: number }[];
  timing: {
    /** Begin/end of the synchronous main observation; no cross-process barrier. */
    linearizedQpcTicks: QpcTicks;
    slotQpcTicks: QpcTicks;
    snapshotQpcTicks: QpcTicks;
    triggerQpcTicks: QpcTicks;
  };
  watchLogicalDbBytes: number;
  webContentsIds: number[];
}
export interface QualificationPayloads {
  ready: QualificationReady;
  'gpu-info': {
    beginQpcTicks: QpcTicks;
    endQpcTicks: QpcTicks;
    devices: { active: boolean; deviceId: number; vendorId: number }[];
    softwareRendering: boolean | null;
  };
  setup: {
    descriptorSha256: string;
    expandedManifestSha256: string;
    m0QpcTicks: QpcTicks;
    m0Utc: string;
    qpcAnchorTicks: QpcTicks;
    utcAnchorMs: number;
  };
  heartbeat: { qpcTicks: QpcTicks };
  stop: { admissionClosedQpcTicks: QpcTicks; observedQpcTicks: QpcTicks; reason: 'normal-exit' };
  register: QualificationRegistryEvent;
  unregister: QualificationRegistryEvent;
  sample: QualificationSample;
  'sample-closed': {
    closeQpcTicks: QpcTicks;
    phase: QualificationPhase;
    registryPrefixSequence: number;
    sampleToken: string;
    sampleWriteCompletedQpcTicks: QpcTicks;
  };
  'sample-resumed': { phase: QualificationPhase; resumeQpcTicks: QpcTicks; sampleToken: string };
  complete: { counters: QualificationCounters; registryLive: QualificationRegistryLive[] };
}
export type QualificationFrame = {
  [K in keyof QualificationPayloads]: {
    kind: K;
    payload: QualificationPayloads[K];
    qualificationRunId: string;
    sequence: number;
    slotIndex: K extends 'sample' | 'sample-closed' | 'sample-resumed' ? number : null;
    version: 2;
  };
}[keyof QualificationPayloads];
export interface QualificationWriteReceipt {
  sequence: number;
  writeCompletedQpcTicks: QpcTicks;
}
export const QUALIFICATION_NATIVE_ERRORS = [
  'qualification-native-unavailable',
  'qualification-launch-invalid',
  'qualification-isolation-invalid',
  'qualification-peer-invalid',
  'qualification-capability-invalid',
  'qualification-frame-invalid',
  'qualification-sequence-invalid',
  'qualification-queue-limit',
  'qualification-io-timeout',
  'qualification-io-failed',
  'qualification-closed',
  'qualification-qpc-invalid',
] as const;
export interface QualificationNativeBridge {
  prepareLaunchIsolation(): PreparedLaunchIsolation;
  authenticateLaunchAndConnectTelemetry(
    ticket: LaunchIsolationTicket,
  ): Promise<AuthenticatedQualificationLaunch>;
  readQpc(): { ticks: QpcTicks; frequency: number };
  writeTelemetryFrame(
    capability: QualificationRuntimeCapability,
    frame: QualificationFrame,
  ): Promise<QualificationWriteReceipt>;
  closeTelemetry(owner: LaunchIsolationTicket | QualificationRuntimeCapability): Promise<void>;
}
