import type { Identity, Scene, AcceptedSuccessor } from '../product-restore-process/protocol';
import type { Variant } from '../product-restore-fixtures/seed';

export const LIMITS = Object.freeze({
  R: 4_410_000,
  P: 2_990_000,
  ui: 30_000,
  helper: 35_000,
  boot: 60_000,
  close: 30_000,
  partial: 20_000,
  transfer: 1_500_000,
  offline: 180_000,
  actions: 32,
});
export const ACTIONS = [
  'BootHealthy',
  'BootPartial',
  'BootRecovery',
  'OpenBackup',
  'SaveBackup',
  'WaitBackupCompleted',
  'OpenRestore',
  'CancelOpen',
  'SelectRestore',
  'WaitCancelled',
  'OpenPartial',
  'ReadSources',
  'ReadResearch',
  'ReadWatch',
  'ReadConversation',
  'Close',
] as const;
export type Action = (typeof ACTIONS)[number];
export interface UiRequest {
  scene: Scene;
  sequence: number;
  action: Action;
  identity: Identity;
  deadline: number;
  target?: string;
  variant?: Variant;
}
export interface UiReceipt {
  mainWindowHandle: string;
}
export interface Observer {
  ready(): Promise<Identity>;
  arm(sequence: number): Promise<unknown>;
  decide(result: 'approved'): Promise<unknown>;
  waitSuccessor(): Promise<AcceptedSuccessor>;
  assertCurrent(): Promise<unknown>;
  finish(): Promise<void>;
  readonly pendingOwned: number;
  readonly closed: Promise<number | null>;
}
export interface OrdinaryLease {
  identity: Identity;
  /** Absolute launch deadline, including identity and lease admission. */
  bootDeadline: number;
}
export interface Retirement {
  ready(): Promise<void>;
  retired(): Promise<void>;
  readonly closed: Promise<number | null>;
  readonly pendingOwned: number;
}
export interface Ports {
  now(): number;
  stop(): void;
  prepare(scene: Scene): Promise<void>;
  launch(kind: 'initial' | 'B' | 'cold', deadline: number): Promise<OrdinaryLease>;
  holdOrdinary(identity: Identity, deadline: number): Promise<Retirement>;
  assertProductGone(deadline: number): Promise<void>;
  ui(request: UiRequest): Promise<UiReceipt>;
  confirm(request: {
    scene: Scene;
    transition: 1 | 2;
    sequence: number;
    purpose: 'restore' | 'partial';
    approved: boolean;
    identity: Identity;
    mainWindowHandle: string;
    deadline: number;
  }): Promise<void>;
  observe(identity: Identity, deadline: number): Promise<Observer>;
  installB(): Promise<void>;
  verify(variant: 'A' | 'H', cold: boolean): Promise<void>;
  verifyRecoveryEntry(): Promise<void>;
  inspectBackup(): Promise<void>;
  finalBinding(): Promise<void>;
  readonly backupA: string;
  readonly backupH: string;
}
export function need(value: unknown, message = '恢复场景契约或证据不一致'): asserts value {
  if (!value) throw new Error(message);
}
