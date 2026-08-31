import type {
  ChangeEvidencePair,
  StructuredCondition,
  WatchAccessMode,
  WatchEventKind,
  WatchNotificationLevel,
  WatchSchedule,
} from './watch';

export type WatchIpcErrorCode =
  | 'invalid-payload'
  | 'not-found'
  | 'conflict'
  | 'invalid-state'
  | 'budget-exceeded'
  | 'security-rejected'
  | 'consent-required'
  | 'preview-expired'
  | 'feature-unavailable'
  | 'cancelled'
  | 'unavailable'
  | 'write-failed';

export type WatchIpcResult<T> =
  { ok: true; value: T } | { ok: false; errorCode: WatchIpcErrorCode };

export interface InAppNotificationDto {
  notificationId: string;
  dedupeKey: string;
  subjectType: 'event' | 'digest';
  subjectId: string;
  privacyVersion: 1;
  importance: WatchNotificationLevel;
  title: string;
  body: string;
  createdAt: string;
}

export interface RuleSummaryDto {
  id: string;
  version: number;
  sourceId: string;
  sourceName: string;
  kind: 'feed' | 'page';
  state: 'enabled' | 'paused';
  pauseReason: string | null;
  desiredEnabled: boolean;
  muted: boolean;
  accessMode: WatchAccessMode;
  schedule: WatchSchedule;
  condition: StructuredCondition | null;
  notificationLevel: WatchNotificationLevel;
  showDetails: boolean;
  targetDisplay: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  nextDueAt: string | null;
  health: 'healthy' | 'degraded' | 'paused';
  backoffUntil: string | null;
}

export interface EventListItemDto {
  id: string;
  ruleId: string;
  sourceId: string;
  sourceName: string;
  eventKind: WatchEventKind;
  importance: WatchNotificationLevel;
  firstObservedAt: string;
  lastObservedAt: string;
  itemCount: number;
  read: boolean;
}

export interface EventDetailDto extends EventListItemDto {
  evidence: ChangeEvidencePair[];
}

export interface WatchStatusDto {
  mode: 'available' | 'unavailable';
  schedulerRunning: boolean;
  activeRuns: number;
  ruleCount: number;
  eventCount: number;
  unreadCount: number;
  digestCount: number;
  inAppNotification: 'available';
  windowsNotification: 'available' | 'unavailable';
  windowsReason:
    | null
    | 'not-windows'
    | 'not-packaged'
    | 'identity-not-configured'
    | 'unsupported'
    | 'probe-failed';
  appRunsOnlyWhileOpen: true;
  mainDocumentOnly: true;
  publicRetentionDays: number;
  sessionRetentionDays: number;
  publicEventsPerRule: number;
  sessionEventsPerRule: number;
}

export type WatchPushDto =
  | { type: 'status'; revision: number; status: WatchStatusDto }
  | { type: 'notification'; revision: number; notification: InAppNotificationDto };

export interface WatchBridge {
  listRules(payload: unknown): Promise<WatchIpcResult<unknown>>;
  getRule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  createRule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  updateRule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  setPaused(payload: unknown): Promise<WatchIpcResult<unknown>>;
  setMuted(payload: unknown): Promise<WatchIpcResult<unknown>>;
  deleteRule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  runNow(payload: unknown): Promise<WatchIpcResult<unknown>>;
  previewFeed(payload: unknown): Promise<WatchIpcResult<unknown>>;
  previewPageRegions(payload: unknown): Promise<WatchIpcResult<unknown>>;
  issueSessionGrant(payload: unknown): Promise<WatchIpcResult<unknown>>;
  listEvents(payload: unknown): Promise<WatchIpcResult<unknown>>;
  setEventsRead(payload: unknown): Promise<WatchIpcResult<unknown>>;
  deleteEvent(payload: unknown): Promise<WatchIpcResult<unknown>>;
  listDigestSchedules(payload: unknown): Promise<WatchIpcResult<unknown>>;
  saveDigestSchedule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  deleteDigestSchedule(payload: unknown): Promise<WatchIpcResult<unknown>>;
  listDigests(payload: unknown): Promise<WatchIpcResult<unknown>>;
  getDigest(payload: unknown): Promise<WatchIpcResult<unknown>>;
  generateDigestPreview(payload: unknown): Promise<WatchIpcResult<unknown>>;
  exportEventsCsv(payload: unknown): Promise<WatchIpcResult<unknown>>;
  exportDigestMarkdown(payload: unknown): Promise<WatchIpcResult<unknown>>;
  getStatus(): Promise<WatchIpcResult<WatchStatusDto>>;
  subscribe(listener: (push: WatchPushDto) => void): () => void;
}
