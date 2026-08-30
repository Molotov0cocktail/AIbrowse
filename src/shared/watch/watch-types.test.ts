// D2 watch-types tests: detailed-design §2 budget constants and closed union
// arrays (single source of truth src/shared/types/watch.ts). Every §2 table
// value asserted exactly; D1 MAX_LOG_* constants stay as regression.
import { describe, expect, it } from 'vitest';
import * as watch from '../types/watch';

describe('detailed §2 预算常量（单一事实源精确值）', () => {
  it('规则与调度常量', () => {
    expect(watch.MAX_WATCH_RULES_TOTAL).toBe(200);
    expect(watch.MAX_WATCH_RULES_ENABLED).toBe(100);
    expect(watch.MAX_GLOBAL_WATCH_RUNS).toBe(4);
    expect(watch.MAX_HOST_WATCH_RUNS).toBe(1);
    expect(watch.MIN_HOST_REQUEST_GAP_MS).toBe(5_000);
    expect(watch.MAX_DUE_STARTS_PER_TICK).toBe(20);
    expect(watch.WATCH_RUN_TIMEOUT_MS).toBe(90_000);
    expect(watch.NETWORK_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(watch.MAX_REDIRECTS).toBe(5);
  });

  it('XML/Feed 预算常量', () => {
    expect(watch.MAX_FEED_RESPONSE_BYTES).toBe(2_097_152);
    expect(watch.MAX_XML_DEPTH).toBe(64);
    expect(watch.MAX_XML_NODES).toBe(20_000);
    expect(watch.MAX_XML_NAME_BYTES).toBe(256);
    expect(watch.MAX_XML_ATTRIBUTES_PER_TAG).toBe(64);
    expect(watch.MAX_XML_ATTRIBUTE_BYTES).toBe(4_096);
    expect(watch.MAX_XML_TEXT_NODE_BYTES).toBe(8_192);
    expect(watch.MAX_XML_TOTAL_TEXT_BYTES).toBe(131_072);
    expect(watch.MAX_DISCOVERY_HTML_BYTES).toBe(262_144);
  });

  it('HTML/页面投影预算常量', () => {
    expect(watch.MAX_PAGE_HTML_RESPONSE_BYTES).toBe(2_097_152);
    expect(watch.MAX_HTML_NODES).toBe(20_000);
    expect(watch.MAX_HTML_DEPTH).toBe(64);
    expect(watch.MAX_HTML_ATTRIBUTES_PER_TAG).toBe(64);
    expect(watch.MAX_FEED_ITEMS).toBe(200);
    expect(watch.MAX_FEED_FIELD_BYTES).toBe(4_096);
    expect(watch.MAX_FEED_PROJECTION_BYTES).toBe(262_144);
    expect(watch.MAX_REGIONS_PER_RULE).toBe(10);
    expect(watch.MAX_PAGE_PROJECTION_BYTES).toBe(65_536);
    expect(watch.MAX_PROJECTION_FIELDS).toBe(50);
  });

  it('条件/证据/Digest 预算常量', () => {
    expect(watch.MAX_CONDITIONS_PER_RULE).toBe(10);
    expect(watch.MAX_EVIDENCE_VALUE_BYTES).toBe(4_096);
    expect(watch.MAX_EVENT_EVIDENCE_BYTES).toBe(32_768);
    expect(watch.MAX_DIGEST_BYTES).toBe(65_536);
    expect(watch.MAX_DIGEST_EVENTS).toBe(50);
    expect(watch.MAX_DIGEST_PROVIDER_CALLS).toBe(1);
  });

  it('存储/保留/网络/缓存常量', () => {
    expect(watch.MAX_WATCH_DB_BYTES).toBe(104_857_600);
    expect(watch.MAX_ROBOTS_RULES).toBe(1024);
    expect(watch.MAX_DISCOVERY_CANDIDATES).toBe(10);
    expect(watch.PUBLIC_EVENT_RETENTION_DAYS).toBe(90);
    expect(watch.PUBLIC_EVENTS_PER_RULE).toBe(200);
    expect(watch.SESSION_EVENT_RETENTION_DAYS).toBe(30);
    expect(watch.SESSION_EVENTS_PER_RULE).toBe(100);
    expect(watch.EVENT_COALESCE_WINDOW_MS).toBe(1_800_000);
    expect(watch.ROBOTS_CACHE_MS).toBe(86_400_000);
  });

  it('D1 日志预算常量保持（回归）', () => {
    expect(watch.MAX_LOG_LINE_BYTES).toBe(8_192);
    expect(watch.MAX_LOG_FILE_BYTES).toBe(10_485_760);
    expect(watch.MAX_LOG_FILES).toBe(10);
    expect(watch.MAX_LOG_AGE_DAYS).toBe(14);
  });

  it('§11.1 Digest Schedule 来源数上限（派生常量）', () => {
    expect(watch.MAX_DIGEST_SCHEDULE_SOURCES).toBe(100);
  });
});

describe('闭合 union 数组（编译期常量，逐项精确）', () => {
  it('WATCH_RULE_KINDS / WATCH_ACCESS_MODES / WATCH_RULE_STATES', () => {
    expect(watch.WATCH_RULE_KINDS).toEqual(['feed', 'page']);
    expect(watch.WATCH_ACCESS_MODES).toEqual(['public', 'session']);
    expect(watch.WATCH_RULE_STATES).toEqual(['enabled', 'paused', 'deleted']);
  });

  it('PAUSE_REASONS 恰十项', () => {
    expect(watch.PAUSE_REASONS).toEqual([
      'user',
      'source-disabled',
      'source-deleted',
      'source-changed',
      'login-required',
      'captcha',
      'parse-changed',
      'robots-disallowed',
      'security-rejected',
      'dependency-unavailable',
    ]);
  });

  it('WATCH_INTERVAL_MINUTES 恰四项（15/60/360/1440）', () => {
    expect(watch.WATCH_INTERVAL_MINUTES).toEqual([15, 60, 360, 1440]);
  });

  it('CONDITION_OPERATORS 闭合十项（§5）', () => {
    expect(watch.CONDITION_OPERATORS).toEqual([
      'equals',
      'not-equals',
      'contains',
      'not-contains',
      'changed',
      'increased',
      'decreased',
      'crosses-above',
      'crosses-below',
      'event-kind-is',
    ]);
  });

  it('WATCH_FAILURE_CODES 闭合十项（§3.3/D7 #S6-053）', () => {
    expect(watch.WATCH_FAILURE_CODES).toEqual([
      'login_required',
      'captcha',
      'parse_changed',
      'unavailable',
      'robots_disallowed',
      'security_rejected',
      'budget_exceeded',
      'dependency_unavailable',
      'interrupted',
      'condition_error',
    ]);
  });

  it('WATCH_EVENT_KINDS / WATCH_NOTIFICATION_LEVELS（§9.4）', () => {
    expect(watch.WATCH_EVENT_KINDS).toEqual(['added', 'removed', 'changed', 'reversal', 'mixed']);
    expect(watch.WATCH_NOTIFICATION_LEVELS).toEqual(['normal', 'important']);
  });

  it('WATCH_HEALTH_STATES / WATCH_ACQUISITIONS（§3.3）', () => {
    expect(watch.WATCH_HEALTH_STATES).toEqual(['healthy', 'degraded', 'paused']);
    expect(watch.WATCH_ACQUISITIONS).toEqual(['rss', 'browser']);
  });

  it('REGION_KINDS / FEED_FORMATS / COMBINE_MODES（§3.2/§5）', () => {
    expect(watch.REGION_KINDS).toEqual(['main-text', 'headings', 'table', 'links']);
    expect(watch.FEED_FORMATS).toEqual(['rss2', 'atom']);
    expect(watch.COMBINE_MODES).toEqual(['all', 'any']);
  });

  it('SOURCE_WATCH_OPERATIONS / WATCH_SHARING_MODES / DIGEST_EVENT_REF_STATES（§10.3/§11）', () => {
    expect(watch.SOURCE_WATCH_OPERATIONS).toEqual([
      'create',
      'update',
      'disable',
      'restore',
      'undo',
      'hard-delete',
    ]);
    expect(watch.WATCH_SHARING_MODES).toEqual(['full', 'metadata', 'blocked']);
    expect(watch.DIGEST_EVENT_REF_STATES).toEqual(['active', 'expired', 'user-deleted']);
  });
});

describe('判别联合 DTO 形状（编译期/结构自检）', () => {
  it('WatchSchedule 判别联合（intervalMinutes 字面量闭合）', () => {
    // 类型级：interval 只接受 15|60|360|1440；daily 需要 localTime+timeZone
    const interval: watch.WatchSchedule = { kind: 'interval', intervalMinutes: 15 };
    const daily: watch.WatchSchedule = { kind: 'daily', localTime: '09:00', timeZone: 'UTC' };
    expect(interval.kind).toBe('interval');
    expect(daily.kind).toBe('daily');
    expect(watch.WATCH_INTERVAL_MINUTES).toContain(interval.intervalMinutes);
  });

  it('WatchRule 全字段存在（§3.1 契约）', () => {
    const rule: watch.WatchRule = {
      id: 'r1',
      sourceId: 's1',
      kind: 'feed',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target: { type: 'feed', feedUrl: 'https://example.com/feed.xml', format: 'rss2' },
      condition: null,
      notificationLevel: 'normal',
      sourceRowVersion: 3,
      sourceLocatorFingerprint: 'fp',
      nextDueAt: null,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(rule.id).toBe('r1');
    expect(rule.state).toBe('enabled');
  });

  it('EvidenceValue / ChangeEvidencePair（§9.3）', () => {
    const absent: watch.EvidenceValue = { kind: 'absent' };
    const present: watch.EvidenceValue = {
      kind: 'present',
      excerpt: 'x',
      valueHash: 'hash',
      normalizedBytes: 1,
      truncated: false,
    };
    const pair: watch.ChangeEvidencePair = {
      itemId: 'i1',
      fieldKey: 'title',
      label: '标题',
      before: absent,
      after: present,
      beforeCapturedAt: 't0',
      afterCapturedAt: 't1',
      beforeFinalUrl: 'u0',
      afterFinalUrl: 'u1',
      beforeDocumentId: null,
      afterDocumentId: null,
      feedItemKey: null,
    };
    expect(pair.before.kind).toBe('absent');
    expect(pair.after.kind).toBe('present');
  });

  it('WatchEvent（§9.4 契约）与 WatchRun（watch_runs 表投影）', () => {
    const ev: watch.WatchEvent = {
      id: 'e1',
      ruleId: 'r1',
      sourceId: 's1',
      eventKind: 'changed',
      importance: 'normal',
      idempotencyKey: 'ik',
      changeFingerprint: 'cf',
      firstObservedAt: 't0',
      lastObservedAt: 't1',
      itemCount: 1,
      readAt: null,
    };
    expect(ev.eventKind).toBe('changed');
    const run: watch.WatchRun = {
      id: 'run1',
      ruleId: 'r1',
      requestKey: 'r1|slot',
      trigger: 'scheduled',
      scheduledFor: 't0',
      startedAt: null,
      finishedAt: null,
      outcome: null,
      health: null,
    };
    expect(run.trigger).toBe('scheduled');
  });

  it('Digest DTO（§11.1/§11.2/§11.4）', () => {
    const sched: watch.DigestSchedule = {
      id: 'd1',
      sourceIds: ['s1', 's2'],
      localTime: '08:00',
      timeZone: 'Asia/Shanghai',
      aiEnabled: false,
      cursor: null,
      createdAt: 't0',
      updatedAt: 't0',
      lastCheckedAt: null,
    };
    expect(sched.sourceIds.length).toBeLessThanOrEqual(watch.MAX_DIGEST_SCHEDULE_SOURCES);
    const facts: watch.DigestFacts = {
      scheduleId: 'd1',
      period: { from: 't0', to: 't1' },
      eventCount: 1,
      runStats: { changed: 1, failed: 0, unchanged: 0 },
      events: [],
      evidenceMap: {},
      referenceStates: {},
      fetchedAt: 't1',
    };
    expect(facts.runStats.changed).toBe(1);
    const draft: watch.ExplanationDraft = {
      sections: [{ eventIds: ['e1'], explanation: '解释' }],
    };
    expect(draft.sections[0]?.eventIds).toEqual(['e1']);
  });
});
