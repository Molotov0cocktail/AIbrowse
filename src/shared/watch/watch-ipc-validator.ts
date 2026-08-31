import { utf8ByteLength } from './watch-budget';
import { CONDITION_OPERATORS, WATCH_EVENT_KINDS, WATCH_NOTIFICATION_LEVELS } from '../types/watch';

export const MAX_WATCH_IPC_INPUT_BYTES = 65_536;
export const MAX_WATCH_IPC_OUTPUT_BYTES = 262_144;

export const WATCH_IPC_CHANNELS = [
  'watch:listRules',
  'watch:getRule',
  'watch:createRule',
  'watch:updateRule',
  'watch:setPaused',
  'watch:setMuted',
  'watch:deleteRule',
  'watch:runNow',
  'watch:previewFeed',
  'watch:previewPageRegions',
  'watch:issueSessionGrant',
  'watch:listEvents',
  'watch:setEventsRead',
  'watch:deleteEvent',
  'watch:listDigestSchedules',
  'watch:saveDigestSchedule',
  'watch:deleteDigestSchedule',
  'watch:listDigests',
  'watch:getDigest',
  'watch:generateDigestPreview',
  'watch:exportEventsCsv',
  'watch:exportDigestMarkdown',
  'watch:getStatus',
  'watch:subscribe',
] as const;

export type WatchIpcChannel = (typeof WATCH_IPC_CHANNELS)[number];
type Plain = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

function safeTree(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => safeTree(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      return false;
    if (!safeTree(descriptor.value, seen)) return false;
  }
  return true;
}

function record(value: unknown, keys: readonly string[]): value is Plain {
  if (
    !safeTree(value, new Set()) ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  )
    return false;
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const handle = (v: unknown): v is string => typeof v === 'string' && HANDLE.test(v);
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nullableUuid = (v: unknown): boolean => v === null || uuid(v);
const page = (r: Plain): boolean => integer(r['page']) && integer(r['pageSize'], 1, 50);

function schedule(v: unknown): boolean {
  if (record(v, ['kind', 'intervalMinutes']))
    return v['kind'] === 'interval' && [15, 60, 360, 1440].includes(v['intervalMinutes'] as number);
  if (!record(v, ['kind', 'localTime', 'timeZone'])) return false;
  if (
    v['kind'] !== 'daily' ||
    typeof v['localTime'] !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(v['localTime'])
  )
    return false;
  if (typeof v['timeZone'] !== 'string' || v['timeZone'].length > 128) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v['timeZone'] }).format();
    return true;
  } catch {
    return false;
  }
}

function condition(v: unknown): boolean {
  if (v === null) return true;
  if (
    !record(v, ['combine', 'predicates']) ||
    (v['combine'] !== 'all' && v['combine'] !== 'any') ||
    !Array.isArray(v['predicates']) ||
    v['predicates'].length < 1 ||
    v['predicates'].length > 10
  )
    return false;
  return v['predicates'].every(
    (p) =>
      record(p, ['fieldKey', 'operator', 'operand']) &&
      typeof p['fieldKey'] === 'string' &&
      p['fieldKey'].length <= 256 &&
      (CONDITION_OPERATORS as readonly unknown[]).includes(p['operator']) &&
      (p['operand'] === null ||
        typeof p['operand'] === 'string' ||
        typeof p['operand'] === 'number'),
  );
}

function listEventFilter(v: unknown): boolean {
  return (
    record(v, [
      'ruleId',
      'sourceId',
      'eventKind',
      'importance',
      'readState',
      'fromInclusive',
      'toExclusive',
    ]) &&
    nullableUuid(v['ruleId']) &&
    nullableUuid(v['sourceId']) &&
    (v['eventKind'] === null ||
      (WATCH_EVENT_KINDS as readonly unknown[]).includes(v['eventKind'])) &&
    (v['importance'] === null ||
      (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(v['importance'])) &&
    ['all', 'read', 'unread'].includes(v['readState'] as string) &&
    (v['fromInclusive'] === null || iso(v['fromInclusive'])) &&
    (v['toExclusive'] === null || iso(v['toExclusive']))
  );
}

function region(v: unknown): boolean {
  if (record(v, ['kind', 'label']))
    return (
      v['kind'] === 'main-text' &&
      typeof v['label'] === 'string' &&
      v['label'].length >= 1 &&
      v['label'].length <= 128
    );
  if (record(v, ['kind', 'label', 'levels']))
    return (
      v['kind'] === 'headings' &&
      typeof v['label'] === 'string' &&
      v['label'].length >= 1 &&
      v['label'].length <= 128 &&
      Array.isArray(v['levels']) &&
      v['levels'].length >= 1 &&
      v['levels'].length <= 3 &&
      v['levels'].every((n) => n === 1 || n === 2 || n === 3)
    );
  if (record(v, ['kind', 'label', 'headerFingerprint', 'occurrence']))
    return (
      v['kind'] === 'table' &&
      typeof v['label'] === 'string' &&
      v['label'].length >= 1 &&
      v['label'].length <= 128 &&
      typeof v['headerFingerprint'] === 'string' &&
      /^[0-9a-f]{64}$/u.test(v['headerFingerprint']) &&
      integer(v['occurrence'], 0, 1000)
    );
  return (
    record(v, ['kind', 'label', 'sameOriginOnly']) &&
    v['kind'] === 'links' &&
    typeof v['label'] === 'string' &&
    v['label'].length >= 1 &&
    v['label'].length <= 128 &&
    typeof v['sameOriginOnly'] === 'boolean'
  );
}

function manualFeedUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      (url.port === '' || url.port === '80' || url.port === '443')
    );
  } catch {
    return false;
  }
}

function saveDigest(v: unknown): boolean {
  if (record(v, ['action', 'previewHandle', 'localTime', 'timeZone', 'aiEnabled', 'confirmed']))
    return (
      v['action'] === 'create' &&
      handle(v['previewHandle']) &&
      typeof v['localTime'] === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/u.test(v['localTime']) &&
      typeof v['timeZone'] === 'string' &&
      schedule({ kind: 'daily', localTime: v['localTime'], timeZone: v['timeZone'] }) &&
      typeof v['aiEnabled'] === 'boolean' &&
      v['confirmed'] === true
    );
  if (record(v, ['action', 'scheduleId', 'expectedVersion', 'state']))
    return (
      v['action'] === 'set-state' &&
      uuid(v['scheduleId']) &&
      integer(v['expectedVersion']) &&
      (v['state'] === 'active' || v['state'] === 'paused')
    );
  if (record(v, ['action', 'scheduleId', 'expectedVersion', 'aiEnabled']))
    return (
      v['action'] === 'set-ai' &&
      uuid(v['scheduleId']) &&
      integer(v['expectedVersion']) &&
      typeof v['aiEnabled'] === 'boolean'
    );
  return record(v, ['action', 'runId']) && v['action'] === 'retry-budget' && uuid(v['runId']);
}

function digestSelector(v: unknown): boolean {
  if (record(v, ['kind', 'sourceIds']))
    return (
      v['kind'] === 'sources' &&
      Array.isArray(v['sourceIds']) &&
      v['sourceIds'].length >= 1 &&
      v['sourceIds'].length <= 100 &&
      v['sourceIds'].every(uuid)
    );
  return record(v, ['kind', 'groupId']) && v['kind'] === 'group' && uuid(v['groupId']);
}

function validate(channel: WatchIpcChannel, v: unknown): boolean {
  switch (channel) {
    case 'watch:getStatus':
      return record(v, []);
    case 'watch:getRule':
    case 'watch:runNow':
      return record(v, ['ruleId']) && uuid(v['ruleId']);
    case 'watch:getDigest':
    case 'watch:exportDigestMarkdown':
      return record(v, ['digestId']) && uuid(v['digestId']);
    case 'watch:issueSessionGrant':
      return record(v, ['previewHandle']) && handle(v['previewHandle']);
    case 'watch:deleteEvent':
      return record(v, ['eventId', 'confirmed']) && uuid(v['eventId']) && v['confirmed'] === true;
    case 'watch:deleteRule':
      return (
        record(v, ['ruleId', 'expectedVersion', 'confirmed']) &&
        uuid(v['ruleId']) &&
        integer(v['expectedVersion']) &&
        v['confirmed'] === true
      );
    case 'watch:setPaused':
      return (
        record(v, ['ruleId', 'expectedVersion', 'paused']) &&
        uuid(v['ruleId']) &&
        integer(v['expectedVersion']) &&
        typeof v['paused'] === 'boolean'
      );
    case 'watch:setMuted':
      return (
        record(v, ['ruleId', 'expectedVersion', 'muted']) &&
        uuid(v['ruleId']) &&
        integer(v['expectedVersion']) &&
        typeof v['muted'] === 'boolean'
      );
    case 'watch:listRules':
      return (
        record(v, ['page', 'pageSize', 'filter']) &&
        page(v) &&
        record(v['filter'], ['state', 'sourceId']) &&
        (v['filter']['state'] === null ||
          v['filter']['state'] === 'enabled' ||
          v['filter']['state'] === 'paused') &&
        nullableUuid(v['filter']['sourceId'])
      );
    case 'watch:listEvents':
      return (
        record(v, ['page', 'pageSize', 'filter', 'selectedEventId']) &&
        page(v) &&
        listEventFilter(v['filter']) &&
        nullableUuid(v['selectedEventId'])
      );
    case 'watch:exportEventsCsv':
      return record(v, ['filter']) && listEventFilter(v['filter']);
    case 'watch:setEventsRead':
      return (
        record(v, ['eventIds', 'read']) &&
        Array.isArray(v['eventIds']) &&
        v['eventIds'].length >= 1 &&
        v['eventIds'].length <= 50 &&
        v['eventIds'].every(uuid) &&
        typeof v['read'] === 'boolean'
      );
    case 'watch:listDigestSchedules':
      return record(v, ['page', 'pageSize']) && page(v);
    case 'watch:listDigests':
      return (
        record(v, ['page', 'pageSize', 'scheduleId']) && page(v) && nullableUuid(v['scheduleId'])
      );
    case 'watch:deleteDigestSchedule':
      return (
        record(v, ['scheduleId', 'expectedVersion', 'confirmed']) &&
        uuid(v['scheduleId']) &&
        integer(v['expectedVersion']) &&
        v['confirmed'] === true
      );
    case 'watch:previewFeed':
      if (record(v, ['mode', 'sourceId'])) return v['mode'] === 'source' && uuid(v['sourceId']);
      if (record(v, ['mode', 'discoveryHandle', 'candidateId']))
        return (
          v['mode'] === 'candidate' && handle(v['discoveryHandle']) && handle(v['candidateId'])
        );
      return (
        record(v, ['mode', 'sourceId', 'feedUrl']) &&
        v['mode'] === 'manual' &&
        uuid(v['sourceId']) &&
        manualFeedUrl(v['feedUrl'])
      );
    case 'watch:previewPageRegions':
      return (
        record(v, ['sourceId', 'accessMode', 'regions']) &&
        uuid(v['sourceId']) &&
        (v['accessMode'] === 'public' || v['accessMode'] === 'session') &&
        Array.isArray(v['regions']) &&
        v['regions'].length >= 1 &&
        v['regions'].length <= 10 &&
        v['regions'].every(region)
      );
    case 'watch:createRule':
      return (
        record(v, [
          'previewHandle',
          'sessionGrantHandle',
          'schedule',
          'condition',
          'notificationLevel',
          'showDetails',
          'confirmed',
        ]) &&
        handle(v['previewHandle']) &&
        (v['sessionGrantHandle'] === null || handle(v['sessionGrantHandle'])) &&
        schedule(v['schedule']) &&
        condition(v['condition']) &&
        (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(v['notificationLevel']) &&
        typeof v['showDetails'] === 'boolean' &&
        v['confirmed'] === true
      );
    case 'watch:updateRule':
      return typeof v === 'object' && v !== null && (v as Plain)['mode'] === 'settings'
        ? record(v, [
            'mode',
            'ruleId',
            'expectedVersion',
            'schedule',
            'condition',
            'notificationLevel',
            'showDetails',
          ]) &&
            uuid(v['ruleId']) &&
            integer(v['expectedVersion']) &&
            schedule(v['schedule']) &&
            condition(v['condition']) &&
            (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(v['notificationLevel']) &&
            typeof v['showDetails'] === 'boolean'
        : record(v, [
            'mode',
            'ruleId',
            'expectedVersion',
            'previewHandle',
            'sessionGrantHandle',
            'schedule',
            'condition',
            'notificationLevel',
            'showDetails',
            'resumeAfterConfirm',
            'confirmed',
          ]) &&
            v['mode'] === 'rebaseline' &&
            uuid(v['ruleId']) &&
            integer(v['expectedVersion']) &&
            handle(v['previewHandle']) &&
            (v['sessionGrantHandle'] === null || handle(v['sessionGrantHandle'])) &&
            schedule(v['schedule']) &&
            condition(v['condition']) &&
            (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(v['notificationLevel']) &&
            typeof v['showDetails'] === 'boolean' &&
            typeof v['resumeAfterConfirm'] === 'boolean' &&
            v['confirmed'] === true;
    case 'watch:saveDigestSchedule':
      return saveDigest(v);
    case 'watch:generateDigestPreview':
      return (
        record(v, ['selector', 'fromExclusive', 'toInclusive', 'afterSequence']) &&
        digestSelector(v['selector']) &&
        iso(v['fromExclusive']) &&
        iso(v['toInclusive']) &&
        integer(v['afterSequence'], 0) &&
        v['fromExclusive'] < v['toInclusive']
      );
    case 'watch:subscribe':
      return record(v, ['action']) && (v['action'] === 'start' || v['action'] === 'stop');
  }
}

export function validateWatchIpcPayload(
  channel: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (!(WATCH_IPC_CHANNELS as readonly string[]).includes(channel)) return { ok: false };
  if (!safeTree(value, new Set())) return { ok: false };
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { ok: false };
  }
  if (utf8ByteLength(encoded) > MAX_WATCH_IPC_INPUT_BYTES) return { ok: false };
  return validate(channel as WatchIpcChannel, value) ? { ok: true, value } : { ok: false };
}

export function validateWatchIpcOutput(value: unknown, channel?: WatchIpcChannel): boolean {
  if (!safeTree(value, new Set())) return false;
  if (hasForbiddenOutputKey(value)) return false;
  try {
    if (utf8ByteLength(JSON.stringify(value)) > MAX_WATCH_IPC_OUTPUT_BYTES) return false;
  } catch {
    return false;
  }
  if (record(value, ['ok', 'errorCode'])) {
    return (
      value['ok'] === false &&
      [
        'invalid-payload',
        'not-found',
        'conflict',
        'invalid-state',
        'budget-exceeded',
        'security-rejected',
        'consent-required',
        'preview-expired',
        'feature-unavailable',
        'cancelled',
        'unavailable',
        'write-failed',
      ].includes(value['errorCode'] as string)
    );
  }
  if (record(value, ['ok', 'value']))
    return value['ok'] === true && channel !== undefined && successValue(channel, value['value']);
  if (record(value, ['type', 'revision', 'status']))
    return value['type'] === 'status' && integer(value['revision']) && watchStatus(value['status']);
  if (record(value, ['type', 'revision', 'notification']))
    return (
      value['type'] === 'notification' &&
      integer(value['revision']) &&
      notification(value['notification'])
    );
  return false;
}

function successValue(channel: WatchIpcChannel, value: unknown): boolean {
  switch (channel) {
    case 'watch:getStatus':
      return watchStatus(value);
    case 'watch:listRules':
    case 'watch:listDigestSchedules':
    case 'watch:listDigests':
      return paged(value, false);
    case 'watch:listEvents':
      return paged(value, true);
    case 'watch:getRule':
      return record(value, [
        'id',
        'version',
        'sourceId',
        'sourceName',
        'kind',
        'state',
        'pauseReason',
        'desiredEnabled',
        'muted',
        'accessMode',
        'schedule',
        'condition',
        'notificationLevel',
        'showDetails',
        'targetDisplay',
        'lastCheckedAt',
        'lastChangedAt',
        'nextDueAt',
        'health',
        'backoffUntil',
      ]);
    case 'watch:createRule':
    case 'watch:updateRule':
      return (
        record(value, ['ruleId', 'version']) ||
        (record(value, ['updated']) && value['updated'] === true)
      );
    case 'watch:setPaused':
    case 'watch:setMuted':
    case 'watch:deleteRule':
    case 'watch:deleteEvent':
    case 'watch:deleteDigestSchedule':
      return record(value, ['updated']) && value['updated'] === true;
    case 'watch:runNow':
      return record(value, ['runId']) && uuid(value['runId']);
    case 'watch:previewFeed':
      return (
        record(value, ['previewHandle', 'kind', 'accessMode', 'targetDisplay', 'fields']) ||
        record(value, ['discoveryHandle', 'candidates'])
      );
    case 'watch:previewPageRegions':
      return record(value, [
        'previewHandle',
        'kind',
        'accessMode',
        'targetDisplay',
        'fields',
        'regions',
      ]);
    case 'watch:issueSessionGrant':
      return record(value, ['previewHandle', 'sessionGrantHandle']);
    case 'watch:setEventsRead':
      return record(value, ['updated']) && integer(value['updated'], 0);
    case 'watch:getDigest':
      return record(value, [
        'id',
        'scheduleId',
        'facts',
        'explanation',
        'providerState',
        'providerResultCode',
        'createdAt',
      ]);
    case 'watch:generateDigestPreview':
      return record(value, ['previewHandle', 'facts', 'hasMore', 'nextPreviewSequence']);
    case 'watch:saveDigestSchedule':
      return (
        (record(value, ['created']) && value['created'] === true) ||
        (record(value, ['updated']) && value['updated'] === true)
      );
    case 'watch:exportEventsCsv':
      return record(value, ['exportedRows', 'exportedBytes']);
    case 'watch:exportDigestMarkdown':
      return record(value, ['exportedBytes']);
    case 'watch:subscribe':
      return false;
  }
}

function paged(value: unknown, selected: boolean): boolean {
  const keys = selected
    ? ['page', 'pageSize', 'total', 'items', 'selected']
    : ['page', 'pageSize', 'total', 'items'];
  return (
    record(value, keys) &&
    integer(value['page'], 1) &&
    integer(value['pageSize'], 1, 50) &&
    integer(value['total'], 0) &&
    Array.isArray(value['items']) &&
    value['items'].length <= 50
  );
}

function notification(v: unknown): boolean {
  return (
    record(v, [
      'notificationId',
      'dedupeKey',
      'subjectType',
      'subjectId',
      'privacyVersion',
      'importance',
      'title',
      'body',
      'createdAt',
    ]) &&
    uuid(v['notificationId']) &&
    typeof v['dedupeKey'] === 'string' &&
    v['dedupeKey'] === `in-app|${String(v['subjectType'])}|${String(v['subjectId'])}|1` &&
    (v['subjectType'] === 'event' || v['subjectType'] === 'digest') &&
    uuid(v['subjectId']) &&
    v['privacyVersion'] === 1 &&
    (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(v['importance']) &&
    typeof v['title'] === 'string' &&
    typeof v['body'] === 'string' &&
    iso(v['createdAt'])
  );
}

function watchStatus(v: unknown): boolean {
  return (
    record(v, [
      'mode',
      'schedulerRunning',
      'activeRuns',
      'ruleCount',
      'eventCount',
      'unreadCount',
      'digestCount',
      'inAppNotification',
      'windowsNotification',
      'windowsReason',
      'appRunsOnlyWhileOpen',
      'mainDocumentOnly',
      'publicRetentionDays',
      'sessionRetentionDays',
      'publicEventsPerRule',
      'sessionEventsPerRule',
    ]) &&
    (v['mode'] === 'available' || v['mode'] === 'unavailable') &&
    typeof v['schedulerRunning'] === 'boolean' &&
    integer(v['activeRuns'], 0) &&
    integer(v['ruleCount'], 0) &&
    integer(v['eventCount'], 0) &&
    integer(v['unreadCount'], 0) &&
    integer(v['digestCount'], 0) &&
    v['inAppNotification'] === 'available' &&
    ((v['windowsNotification'] === 'available' && v['windowsReason'] === null) ||
      (v['windowsNotification'] === 'unavailable' &&
        [
          'not-windows',
          'not-packaged',
          'identity-not-configured',
          'unsupported',
          'probe-failed',
        ].includes(v['windowsReason'] as string))) &&
    v['appRunsOnlyWhileOpen'] === true &&
    v['mainDocumentOnly'] === true &&
    integer(v['publicRetentionDays']) &&
    integer(v['sessionRetentionDays']) &&
    integer(v['publicEventsPerRule']) &&
    integer(v['sessionEventsPerRule'])
  );
}

function hasForbiddenOutputKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenOutputKey);
  if (typeof value !== 'object' || value === null) return false;
  const forbidden = new Set([
    'path',
    'filePath',
    'databasePath',
    'cookie',
    'cookies',
    'sql',
    'rawBody',
    'tabId',
    'previewTabId',
    'apiKey',
    'authorization',
  ]);
  return Object.entries(value).some(
    ([key, child]) => forbidden.has(key) || hasForbiddenOutputKey(child),
  );
}
