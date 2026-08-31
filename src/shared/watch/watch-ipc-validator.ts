import { utf8ByteLength } from './watch-budget';
import {
  CONDITION_OPERATORS,
  PAUSE_REASONS,
  WATCH_EVENT_KINDS,
  WATCH_NOTIFICATION_LEVELS,
} from '../types/watch';
import { parseDigestExplanation } from './digest-validator';

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
    !record(v, ['version', 'combine', 'predicates']) ||
    v['version'] !== 1 ||
    (v['combine'] !== 'all' && v['combine'] !== 'any') ||
    !Array.isArray(v['predicates']) ||
    v['predicates'].length < 1 ||
    v['predicates'].length > 10
  )
    return false;
  return v['predicates'].every(
    (p) =>
      record(p, ['fieldKey', 'operator', 'operand', 'caseSensitive']) &&
      typeof p['fieldKey'] === 'string' &&
      p['fieldKey'].length >= 1 &&
      p['fieldKey'].length <= 200 &&
      !['__proto__', 'prototype', 'constructor'].includes(p['fieldKey']) &&
      !/[.*?[\]]/u.test(p['fieldKey']) &&
      !/^\d+$/u.test(p['fieldKey']) &&
      (CONDITION_OPERATORS as readonly unknown[]).includes(p['operator']) &&
      typeof p['caseSensitive'] === 'boolean' &&
      (p['operand'] === null ||
        (typeof p['operand'] === 'string' &&
          p['operand'].length >= 1 &&
          p['operand'].length <= 500) ||
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
      return record(v, ['mode', 'sourceId', 'accessMode'])
        ? v['mode'] === 'discover-tables' &&
            uuid(v['sourceId']) &&
            (v['accessMode'] === 'public' || v['accessMode'] === 'session')
        : record(v, ['sourceId', 'accessMode', 'regions']) &&
            uuid(v['sourceId']) &&
            (v['accessMode'] === 'public' || v['accessMode'] === 'session') &&
            Array.isArray(v['regions']) &&
            v['regions'].length >= 1 &&
            v['regions'].length <= 10 &&
            v['regions'].every(region);
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
      return paged(value, false, ruleSummary);
    case 'watch:listDigestSchedules':
      return paged(value, false, digestSchedule);
    case 'watch:listDigests':
      return paged(value, false, digestListItem);
    case 'watch:listEvents':
      return paged(value, true, eventListItem) && eventDetail((value as Plain)['selected']);
    case 'watch:getRule':
      return ruleSummary(value);
    case 'watch:createRule':
      return (
        record(value, ['ruleId', 'version']) && uuid(value['ruleId']) && integer(value['version'])
      );
    case 'watch:updateRule':
      return (
        (record(value, ['ruleId', 'version']) &&
          uuid(value['ruleId']) &&
          integer(value['version'])) ||
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
        preview(value, false) ||
        (record(value, ['discoveryHandle', 'candidates']) &&
          handle(value['discoveryHandle']) &&
          Array.isArray(value['candidates']) &&
          value['candidates'].length >= 1 &&
          value['candidates'].length <= 10 &&
          value['candidates'].every(
            (candidate) =>
              record(candidate, ['candidateId', 'targetDisplay']) &&
              handle(candidate['candidateId']) &&
              boundedText(candidate['targetDisplay']),
          ))
      );
    case 'watch:previewPageRegions':
      return (
        preview(value, true) ||
        (record(value, ['tableCandidates']) &&
          Array.isArray(value['tableCandidates']) &&
          value['tableCandidates'].length <= 50 &&
          value['tableCandidates'].every(
            (candidate) =>
              record(candidate, ['fingerprint', 'occurrenceCount', 'columns']) &&
              typeof candidate['fingerprint'] === 'string' &&
              /^[0-9a-f]{64}$/u.test(candidate['fingerprint']) &&
              integer(candidate['occurrenceCount'], 1) &&
              integer(candidate['columns'], 1),
          ))
      );
    case 'watch:issueSessionGrant':
      return (
        record(value, ['previewHandle', 'sessionGrantHandle']) &&
        handle(value['previewHandle']) &&
        handle(value['sessionGrantHandle'])
      );
    case 'watch:setEventsRead':
      return record(value, ['updated']) && integer(value['updated'], 0);
    case 'watch:getDigest':
      return digestDetail(value);
    case 'watch:generateDigestPreview':
      return (
        record(value, [
          'previewHandle',
          'frozenMembers',
          'facts',
          'hasMore',
          'nextPreviewSequence',
        ]) &&
        handle(value['previewHandle']) &&
        Array.isArray(value['frozenMembers']) &&
        value['frozenMembers'].length >= 1 &&
        value['frozenMembers'].length <= 100 &&
        value['frozenMembers'].every(
          (member) =>
            record(member, ['sourceId', 'displayName']) &&
            uuid(member['sourceId']) &&
            boundedText(member['displayName'], 256),
        ) &&
        value['frozenMembers'].every(
          (member, index, all) =>
            index === 0 || String(all[index - 1]['sourceId']) < String(member['sourceId']),
        ) &&
        validateDigestFactsOutput(value['facts']) &&
        typeof value['hasMore'] === 'boolean' &&
        integer(value['nextPreviewSequence'], 0)
      );
    case 'watch:saveDigestSchedule':
      return (
        (record(value, ['created']) && value['created'] === true) ||
        (record(value, ['updated']) && value['updated'] === true)
      );
    case 'watch:exportEventsCsv':
      return (
        record(value, ['exportedRows', 'exportedBytes']) &&
        integer(value['exportedRows'], 0) &&
        integer(value['exportedBytes'], 0)
      );
    case 'watch:exportDigestMarkdown':
      return record(value, ['exportedBytes']) && integer(value['exportedBytes'], 0);
    case 'watch:subscribe':
      return false;
  }
}

function paged(
  value: unknown,
  selected: boolean,
  validateItem: (item: unknown) => boolean,
): boolean {
  const keys = selected
    ? ['page', 'pageSize', 'total', 'items', 'selected']
    : ['page', 'pageSize', 'total', 'items'];
  return (
    record(value, keys) &&
    integer(value['page'], 1) &&
    integer(value['pageSize'], 1, 50) &&
    integer(value['total'], 0) &&
    Array.isArray(value['items']) &&
    value['items'].length <= value['pageSize'] &&
    value['items'].every(validateItem)
  );
}

const boundedText = (value: unknown, max = 1024): value is string =>
  typeof value === 'string' && utf8ByteLength(value) <= max;
const nullableIso = (value: unknown): boolean => value === null || iso(value);

function ruleSummary(value: unknown): boolean {
  return (
    record(value, [
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
    ]) &&
    uuid(value['id']) &&
    integer(value['version']) &&
    uuid(value['sourceId']) &&
    boundedText(value['sourceName'], 512) &&
    (value['kind'] === 'feed' || value['kind'] === 'page') &&
    (value['state'] === 'enabled' || value['state'] === 'paused') &&
    (value['pauseReason'] === null ||
      (PAUSE_REASONS as readonly unknown[]).includes(value['pauseReason'])) &&
    typeof value['desiredEnabled'] === 'boolean' &&
    typeof value['muted'] === 'boolean' &&
    (value['accessMode'] === 'public' || value['accessMode'] === 'session') &&
    schedule(value['schedule']) &&
    condition(value['condition']) &&
    (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(value['notificationLevel']) &&
    typeof value['showDetails'] === 'boolean' &&
    boundedText(value['targetDisplay']) &&
    nullableIso(value['lastCheckedAt']) &&
    nullableIso(value['lastChangedAt']) &&
    nullableIso(value['nextDueAt']) &&
    (value['health'] === 'healthy' ||
      value['health'] === 'degraded' ||
      value['health'] === 'paused') &&
    nullableIso(value['backoffUntil'])
  );
}

function eventListItem(value: unknown): boolean {
  return (
    record(value, [
      'id',
      'ruleId',
      'sourceId',
      'sourceName',
      'eventKind',
      'importance',
      'firstObservedAt',
      'lastObservedAt',
      'itemCount',
      'read',
    ]) &&
    uuid(value['id']) &&
    uuid(value['ruleId']) &&
    uuid(value['sourceId']) &&
    boundedText(value['sourceName'], 512) &&
    (WATCH_EVENT_KINDS as readonly unknown[]).includes(value['eventKind']) &&
    (WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(value['importance']) &&
    iso(value['firstObservedAt']) &&
    iso(value['lastObservedAt']) &&
    integer(value['itemCount'], 0) &&
    typeof value['read'] === 'boolean'
  );
}

function eventDetail(value: unknown): boolean {
  return (
    value === null ||
    (record(value, [
      'id',
      'ruleId',
      'sourceId',
      'sourceName',
      'eventKind',
      'importance',
      'firstObservedAt',
      'lastObservedAt',
      'itemCount',
      'read',
      'evidence',
    ]) &&
      eventListItem(
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'evidence')),
      ) &&
      Array.isArray(value['evidence']) &&
      value['evidence'].every(validateEvidencePair))
  );
}

function preview(value: unknown, withRegions: boolean): boolean {
  const keys = withRegions
    ? ['previewHandle', 'kind', 'accessMode', 'targetDisplay', 'fields', 'regions']
    : ['previewHandle', 'kind', 'accessMode', 'targetDisplay', 'fields'];
  return (
    record(value, keys) &&
    handle(value['previewHandle']) &&
    (value['kind'] === 'feed' || value['kind'] === 'page') &&
    (value['accessMode'] === 'public' || value['accessMode'] === 'session') &&
    boundedText(value['targetDisplay']) &&
    Array.isArray(value['fields']) &&
    value['fields'].length <= 100 &&
    value['fields'].every((field) => boundedText(field, 256)) &&
    (!withRegions ||
      (Array.isArray(value['regions']) &&
        value['regions'].length <= 100 &&
        value['regions'].every(previewRegion)))
  );
}

function previewRegion(value: unknown): boolean {
  if (record(value, ['kind', 'label', 'fieldKey']))
    return (
      ['main-text', 'heading', 'table-header', 'table-cell', 'link'].includes(
        String(value['kind']),
      ) &&
      boundedText(value['label'], 256) &&
      boundedText(value['fieldKey'], 256)
    );
  if (record(value, ['kind', 'label', 'status', 'normalizedBytes']))
    return (
      value['kind'] === 'main-text' &&
      boundedText(value['label'], 256) &&
      (value['status'] === 'matched' || value['status'] === 'not-found') &&
      integer(value['normalizedBytes'], 0)
    );
  if (record(value, ['kind', 'label', 'status', 'total', 'matching', 'levels']))
    return (
      value['kind'] === 'headings' &&
      boundedText(value['label'], 256) &&
      (value['status'] === 'matched' || value['status'] === 'not-found') &&
      integer(value['total'], 0) &&
      integer(value['matching'], 0) &&
      Array.isArray(value['levels']) &&
      value['levels'].every((level) => level === 1 || level === 2 || level === 3)
    );
  if (record(value, ['kind', 'label', 'status', 'total', 'sameOriginOnly']))
    return (
      value['kind'] === 'links' &&
      boundedText(value['label'], 256) &&
      (value['status'] === 'matched' || value['status'] === 'not-found') &&
      integer(value['total'], 0) &&
      typeof value['sameOriginOnly'] === 'boolean'
    );
  if (!record(value, ['kind', 'label', 'status', 'headerFingerprint', 'occurrence', 'groups']))
    return false;
  return (
    value['kind'] === 'table' &&
    boundedText(value['label'], 256) &&
    (value['status'] === 'matched' || value['status'] === 'not-found') &&
    boundedText(value['headerFingerprint'], 256) &&
    integer(value['occurrence'], 0) &&
    Array.isArray(value['groups']) &&
    value['groups'].every(
      (group) =>
        record(group, ['fingerprint', 'occurrenceCount', 'columns']) &&
        boundedText(group['fingerprint'], 256) &&
        integer(group['occurrenceCount'], 0) &&
        integer(group['columns'], 0),
    )
  );
}

function digestSchedule(value: unknown): boolean {
  return (
    record(value, [
      'id',
      'version',
      'sourceCount',
      'localTime',
      'timeZone',
      'aiEnabled',
      'state',
      'nextDueAt',
      'lastCheckedAt',
      'lastPeriod',
      'lastRunStats',
      'runState',
      'blockedRunId',
      'blockedAt',
      'blockedRequiredBytes',
      'blockedAvailableBytes',
    ]) &&
    uuid(value['id']) &&
    integer(value['version']) &&
    integer(value['sourceCount'], 1, 100) &&
    typeof value['localTime'] === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value['localTime']) &&
    boundedText(value['timeZone'], 128) &&
    typeof value['aiEnabled'] === 'boolean' &&
    (value['state'] === 'active' || value['state'] === 'paused') &&
    iso(value['nextDueAt']) &&
    nullableIso(value['lastCheckedAt']) &&
    digestPeriod(value['lastPeriod']) &&
    digestStats(value['lastRunStats']) &&
    (value['runState'] === null ||
      value['runState'] === 'running' ||
      value['runState'] === 'budget_exceeded') &&
    (value['blockedRunId'] === null || uuid(value['blockedRunId'])) &&
    (value['runState'] === 'budget_exceeded') === (value['blockedRunId'] !== null) &&
    nullableIso(value['blockedAt']) &&
    (value['blockedRequiredBytes'] === null || integer(value['blockedRequiredBytes'], 0)) &&
    (value['blockedAvailableBytes'] === null || integer(value['blockedAvailableBytes'], 0))
  );
}

function digestPeriod(value: unknown): boolean {
  return (
    value === null ||
    (record(value, ['fromExclusive', 'toInclusive']) &&
      iso(value['fromExclusive']) &&
      iso(value['toInclusive']))
  );
}
function digestStats(value: unknown): boolean {
  return (
    value === null ||
    (record(value, ['changed', 'failed', 'unchanged']) &&
      integer(value['changed'], 0) &&
      integer(value['failed'], 0) &&
      integer(value['unchanged'], 0))
  );
}
function digestListItem(value: unknown): boolean {
  return (
    record(value, [
      'id',
      'scheduleId',
      'providerState',
      'providerResultCode',
      'createdAt',
      'eventCount',
    ]) &&
    uuid(value['id']) &&
    uuid(value['scheduleId']) &&
    digestProviderPair(value['providerState'], value['providerResultCode']) &&
    iso(value['createdAt']) &&
    integer(value['eventCount'], 0)
  );
}
function digestDetail(value: unknown): boolean {
  if (
    !record(value, [
      'id',
      'scheduleId',
      'facts',
      'explanation',
      'providerState',
      'providerResultCode',
      'createdAt',
    ]) ||
    !uuid(value['id']) ||
    !uuid(value['scheduleId']) ||
    !validateDigestFactsOutput(value['facts']) ||
    !digestProviderPair(value['providerState'], value['providerResultCode']) ||
    !iso(value['createdAt'])
  )
    return false;
  if (value['explanation'] === null) return true;
  const facts = value['facts'] as Plain;
  const events = facts['events'] as Plain[];
  return (
    parseDigestExplanation(
      JSON.stringify(value['explanation']),
      events.map((event) => String(event['eventId'])),
    ) !== null
  );
}

const DIGEST_PROVIDER_STATES = [
  'disabled',
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'uncertain',
  'skipped',
] as const;
const DIGEST_PROVIDER_RESULT_CODES = [
  'disabled',
  'success',
  'provider-error',
  'timeout',
  'aborted',
  'invalid-output',
  'uncertain-after-restart',
  'no-visible-events',
  'request-budget',
  'key-unavailable',
] as const;
const digestProviderState = (value: unknown): boolean =>
  (DIGEST_PROVIDER_STATES as readonly unknown[]).includes(value);
const digestProviderResultCode = (value: unknown): boolean =>
  value === null || (DIGEST_PROVIDER_RESULT_CODES as readonly unknown[]).includes(value);
const digestProviderPair = (state: unknown, code: unknown): boolean => {
  if (!digestProviderState(state) || !digestProviderResultCode(code)) return false;
  switch (state) {
    case 'disabled':
      return code === 'disabled';
    case 'pending':
    case 'claimed':
      return code === null;
    case 'succeeded':
      return code === 'success';
    case 'failed':
      return ['provider-error', 'timeout', 'aborted', 'invalid-output'].includes(String(code));
    case 'uncertain':
      return code === 'uncertain-after-restart';
    case 'skipped':
      return ['no-visible-events', 'request-budget', 'key-unavailable'].includes(String(code));
    default:
      return false;
  }
};

function validateEvidenceValue(value: unknown): boolean {
  if (record(value, ['kind'])) return value['kind'] === 'absent';
  return (
    record(value, ['kind', 'excerpt', 'valueHash', 'normalizedBytes', 'truncated']) &&
    value['kind'] === 'present' &&
    boundedText(value['excerpt'], 32_768) &&
    boundedText(value['valueHash'], 128) &&
    String(value['valueHash']).length > 0 &&
    integer(value['normalizedBytes'], 0) &&
    typeof value['truncated'] === 'boolean'
  );
}

function safeEvidenceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function validateEvidencePair(value: unknown): boolean {
  return (
    record(value, [
      'itemId',
      'fieldKey',
      'label',
      'before',
      'after',
      'beforeCapturedAt',
      'afterCapturedAt',
      'beforeFinalUrl',
      'afterFinalUrl',
      'beforeDocumentId',
      'afterDocumentId',
      'feedItemKey',
    ]) &&
    boundedText(value['itemId'], 500) &&
    String(value['itemId']).length > 0 &&
    boundedText(value['fieldKey'], 200) &&
    String(value['fieldKey']).length > 0 &&
    boundedText(value['label'], 200) &&
    String(value['label']).length > 0 &&
    validateEvidenceValue(value['before']) &&
    validateEvidenceValue(value['after']) &&
    iso(value['beforeCapturedAt']) &&
    iso(value['afterCapturedAt']) &&
    safeEvidenceUrl(value['beforeFinalUrl']) &&
    safeEvidenceUrl(value['afterFinalUrl']) &&
    (value['beforeDocumentId'] === null || boundedText(value['beforeDocumentId'], 512)) &&
    (value['afterDocumentId'] === null || boundedText(value['afterDocumentId'], 512)) &&
    (value['feedItemKey'] === null || boundedText(value['feedItemKey'], 512))
  );
}

function recordOfUnknown(value: unknown): value is Plain {
  return (
    safeTree(value, new Set()) &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateDigestFactsOutput(value: unknown): boolean {
  if (
    !record(value, [
      'schemaVersion',
      'scheduleId',
      'digestRunId',
      'batchIndex',
      'period',
      'eventCount',
      'runStats',
      'events',
      'evidenceMap',
      'referenceStates',
      'fetchedAt',
    ]) ||
    value['schemaVersion'] !== 1 ||
    !boundedText(value['scheduleId'], 128) ||
    !boundedText(value['digestRunId'], 128) ||
    !integer(value['batchIndex'], 0) ||
    value['period'] === null ||
    !digestPeriod(value['period']) ||
    value['runStats'] === null ||
    !digestStats(value['runStats']) ||
    !Array.isArray(value['events']) ||
    value['events'].length < 1 ||
    value['events'].length > 50 ||
    value['eventCount'] !== value['events'].length ||
    !iso(value['fetchedAt']) ||
    !recordOfUnknown(value['evidenceMap']) ||
    !recordOfUnknown(value['referenceStates'])
  )
    return false;
  const eventIds: string[] = [];
  for (const event of value['events']) {
    if (
      !record(event, [
        'eventId',
        'ruleId',
        'sourceId',
        'eventKind',
        'importance',
        'firstIncludedAt',
        'lastIncludedAt',
        'observationCount',
        'itemCount',
      ]) ||
      !uuid(event['eventId']) ||
      eventIds.includes(event['eventId']) ||
      !uuid(event['ruleId']) ||
      !uuid(event['sourceId']) ||
      !(WATCH_EVENT_KINDS as readonly unknown[]).includes(event['eventKind']) ||
      !(WATCH_NOTIFICATION_LEVELS as readonly unknown[]).includes(event['importance']) ||
      !iso(event['firstIncludedAt']) ||
      !iso(event['lastIncludedAt']) ||
      !integer(event['observationCount']) ||
      !integer(event['itemCount'])
    )
      return false;
    eventIds.push(event['eventId']);
  }
  if (Object.keys(value['referenceStates']).join('\0') !== eventIds.join('\0')) return false;
  const activeIds: string[] = [];
  for (const eventId of eventIds) {
    const state = value['referenceStates'][eventId];
    if (state !== 'active' && state !== 'expired' && state !== 'user-deleted') return false;
    if (state === 'active') activeIds.push(eventId);
  }
  if (Object.keys(value['evidenceMap']).join('\0') !== activeIds.join('\0')) return false;
  const evidenceMap = value['evidenceMap'] as Plain;
  const events = value['events'] as Plain[];
  return activeIds.every((eventId) => {
    const evidence = evidenceMap[eventId];
    const event = events.find((candidate) => candidate['eventId'] === eventId)!;
    return (
      Array.isArray(evidence) &&
      evidence.length === event['itemCount'] &&
      evidence.every(validateEvidencePair)
    );
  });
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
    'filepath',
    'databasepath',
    'cookie',
    'cookies',
    'sql',
    'rawbody',
    'tabid',
    'previewtabid',
    'apikey',
    'authorization',
    'factsjson',
    'factshash',
    'claimtoken',
    'requestkey',
    'explanationjson',
  ]);
  return Object.entries(value).some(
    ([key, child]) => forbidden.has(key.toLowerCase()) || hasForbiddenOutputKey(child),
  );
}
