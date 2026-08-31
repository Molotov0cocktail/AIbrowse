// D4 watch-row-validation tests: DB 读回二次校验矩阵（detailed-design §10.1）
// —— 规则行（schedule/target/condition/枚举/一致性）、EvidenceValue/Pair、
// RunOutcome/Health、SourceWatchProjection、affected_rule_state、intent 行。
// 非法/未来版本/原型链/getter 全部 fail-closed；零 IO。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeEventItemsBytes,
  isValidObservationId,
  parseJsonSafe,
  validateAffectedRuleStateMap,
  validateBaselineRow,
  validateBaselineValidators,
  validateChangeEvidencePair,
  validateEventRow,
  validateDigestArtifactRow,
  validateDigestRunRow,
  validateDigestScheduleRow,
  validateEvidenceValue,
  validateIntentRow,
  validateRunResponseMetadataJson,
  validateRuleRow,
  validateRunRow,
  validateSourceWatchProjection,
  validateStoredCondition,
  validateWatchHealthSnapshot,
  validateWatchRunOutcome,
  type WatchBaselineRow,
  type WatchRuleRowColumns,
} from './watch-row-validation';
import { serializeDigestArtifact } from '../../shared/watch/digest-validator';

const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function ruleRow(overrides: Partial<WatchRuleRowColumns> = {}): WatchRuleRowColumns {
  return {
    id: 'r1',
    source_id: 's1',
    kind: 'feed',
    state: 'enabled',
    pause_reason: null,
    desired_enabled: 1,
    muted: 0,
    access_mode: 'public',
    schedule_json: '{"kind":"interval","intervalMinutes":60}',
    target_json: '{"type":"feed","feedUrl":"https://example.com/rss.xml","format":"rss2"}',
    condition_json: null,
    notification_level: 'normal',
    source_row_version: 3,
    source_locator_fingerprint: FINGERPRINT,
    next_due_at: null,
    last_consumed_scheduled_for: null,
    last_daily_local_date: null,
    consecutive_failures: 0,
    backoff_until: null,
    baseline_version: 0,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateRuleRow', () => {
  it('合法 feed/page/session 行通过并还原 DTO', () => {
    expect(validateRuleRow(ruleRow()).ok).toBe(true);
    const page = validateRuleRow(
      ruleRow({
        kind: 'page',
        access_mode: 'session',
        target_json: JSON.stringify({
          type: 'page',
          pageUrl: 'https://example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: {
            version: 1,
            origin: 'https://example.com',
            grantedAt: '2026-08-28T00:00:00.000Z',
          },
        }),
      }),
    );
    expect(page.ok).toBe(true);
    if (page.ok && page.value !== null) {
      expect(page.value.target.type).toBe('page');
    }
  });

  it('kind/access 组合违反（feed+session、page+session 之外）拒绝', () => {
    expect(validateRuleRow(ruleRow({ access_mode: 'session' })).ok).toBe(false);
    expect(
      validateRuleRow(
        ruleRow({
          kind: 'page',
          access_mode: 'public',
          target_json: JSON.stringify({
            type: 'page',
            pageUrl: 'https://example.com/doc',
            regions: [{ kind: 'main-text', label: 'x' }],
            sessionConsent: null,
          }),
        }),
      ).ok,
    ).toBe(true);
  });

  it('kind 与 target 类型不一致拒绝', () => {
    expect(
      validateRuleRow(
        ruleRow({
          kind: 'page',
          target_json: '{"type":"feed","feedUrl":"https://x.com/f","format":"rss2"}',
        }),
      ).ok,
    ).toBe(false);
  });

  it('非法 JSON / 未来 schedule / 未来 condition 版本拒绝', () => {
    expect(validateRuleRow(ruleRow({ schedule_json: 'not-json' })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ schedule_json: '{"kind":"cron"}' })).ok).toBe(false);
    expect(
      validateRuleRow(ruleRow({ condition_json: '{"version":2,"combine":"all","predicates":[]}' }))
        .ok,
    ).toBe(false);
  });

  it('condition 结构非法（未知操作符/原型链键/非布尔 caseSensitive）拒绝', () => {
    expect(
      validateRuleRow(
        ruleRow({
          condition_json: JSON.stringify({
            version: 1,
            combine: 'all',
            predicates: [
              { fieldKey: 'title', operator: 'regex', operand: null, caseSensitive: true },
            ],
          }),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRuleRow(
        ruleRow({
          condition_json: JSON.stringify({
            version: 1,
            combine: 'all',
            predicates: [
              { fieldKey: '__proto__', operator: 'equals', operand: null, caseSensitive: true },
            ],
          }),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRuleRow(
        ruleRow({
          condition_json: JSON.stringify({
            version: 1,
            combine: 'all',
            predicates: [
              { fieldKey: 'title', operator: 'equals', operand: null, caseSensitive: 'yes' },
            ],
          }),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRuleRow(
        ruleRow({
          condition_json: JSON.stringify({
            version: 1,
            combine: 'all',
            predicates: [
              { fieldKey: 'title', operator: 'equals', operand: 'x', caseSensitive: true },
            ],
          }),
        }),
      ).ok,
    ).toBe(true);
  });

  it('paused 必须有 pause_reason；enabled 不得带 reason；未知 pause_reason 拒绝', () => {
    expect(validateRuleRow(ruleRow({ state: 'paused', pause_reason: null })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ state: 'paused', pause_reason: 'user' })).ok).toBe(true);
    expect(validateRuleRow(ruleRow({ state: 'enabled', pause_reason: 'user' })).ok).toBe(false);
    expect(
      validateRuleRow(ruleRow({ state: 'paused', pause_reason: 'weird-reason' as never })).ok,
    ).toBe(false);
  });

  it('fingerprint 必须 64 hex；数字列非法拒绝；时间不可解析拒绝', () => {
    expect(validateRuleRow(ruleRow({ source_locator_fingerprint: 'short' })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ source_row_version: 0 })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ baseline_version: -1 })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ created_at: 'not-a-time' })).ok).toBe(false);
    expect(validateRuleRow(ruleRow({ next_due_at: 'x' })).ok).toBe(false);
  });
});

describe('validateStoredCondition', () => {
  it('结构合法通过；未来版本/超谓词数/非法 operand 拒绝', () => {
    expect(
      validateStoredCondition({
        version: 1,
        combine: 'any',
        predicates: [
          { fieldKey: 'title', operator: 'contains', operand: 'x', caseSensitive: false },
        ],
      }).ok,
    ).toBe(true);
    expect(validateStoredCondition({ version: 2, combine: 'all', predicates: [] }).ok).toBe(false);
    expect(validateStoredCondition({ version: 1, combine: 'all', predicates: [] }).ok).toBe(false);
    expect(
      validateStoredCondition({
        version: 1,
        combine: 'all',
        predicates: Array.from({ length: 11 }, () => ({
          fieldKey: 'f',
          operator: 'equals',
          operand: null,
          caseSensitive: true,
        })),
      }).ok,
    ).toBe(false);
    expect(
      validateStoredCondition({
        version: 1,
        combine: 'all',
        predicates: [{ fieldKey: 'f', operator: 'equals', operand: NaN, caseSensitive: true }],
      }).ok,
    ).toBe(false);
  });
});

describe('validateEvidenceValue / validateChangeEvidencePair', () => {
  it('present/absent 双形态；预算（>4096 字节摘录）拒绝', () => {
    expect(validateEvidenceValue({ kind: 'absent' })).toEqual({ kind: 'absent' });
    const present = {
      kind: 'present',
      excerpt: '摘录',
      valueHash: 'h',
      normalizedBytes: 6,
      truncated: false,
    };
    expect(validateEvidenceValue(present)).toEqual(present);
    expect(
      validateEvidenceValue({
        ...present,
        excerpt: 'x'.repeat(4097),
      }),
    ).toBeNull();
    expect(validateEvidenceValue({ kind: 'future' })).toBeNull();
    expect(validateEvidenceValue({ ...present, truncated: 'yes' })).toBeNull();
  });

  it('pair 形状/双侧/时间/URL 校验', () => {
    const pair = {
      itemId: 'it1',
      fieldKey: 'title',
      label: '标题',
      before: { kind: 'absent' as const },
      after: {
        kind: 'present' as const,
        excerpt: '新标题',
        valueHash: 'h',
        normalizedBytes: 9,
        truncated: false,
      },
      beforeCapturedAt: '2026-08-28T00:00:00.000Z',
      afterCapturedAt: '2026-08-28T00:00:00.000Z',
      beforeFinalUrl: 'https://example.com',
      afterFinalUrl: 'https://example.com',
      beforeDocumentId: null,
      afterDocumentId: 'doc1',
      feedItemKey: null,
    };
    expect(validateChangeEvidencePair(pair)).toEqual(pair);
    expect(validateChangeEvidencePair({ ...pair, extra: 1 })).toBeNull();
    expect(validateChangeEvidencePair({ ...pair, afterCapturedAt: 'x' })).toBeNull();
    expect(validateChangeEvidencePair({ ...pair, fieldKey: '' })).toBeNull();
  });
});

describe('validateWatchRunOutcome / validateWatchHealthSnapshot', () => {
  it('全部 outcome 变体形状；未知 kind/缺键拒绝', () => {
    expect(validateWatchRunOutcome({ kind: 'unchanged' })).toEqual({ kind: 'unchanged' });
    expect(validateWatchRunOutcome({ kind: 'baseline-established', auditId: 'a1' })).toEqual({
      kind: 'baseline-established',
      auditId: 'a1',
    });
    expect(validateWatchRunOutcome({ kind: 'event-created', eventId: 'e1' })).toEqual({
      kind: 'event-created',
      eventId: 'e1',
    });
    expect(
      validateWatchRunOutcome({ kind: 'failed', health: 'unavailable', retryable: true }),
    ).toEqual({
      kind: 'failed',
      health: 'unavailable',
      retryable: true,
    });
    expect(validateWatchRunOutcome({ kind: 'aborted', reason: 'shutdown' })).toEqual({
      kind: 'aborted',
      reason: 'shutdown',
    });
    expect(validateWatchRunOutcome({ kind: 'future' })).toBeNull();
    expect(validateWatchRunOutcome({ kind: 'unchanged', extra: 1 })).toBeNull();
    expect(
      validateWatchRunOutcome({ kind: 'failed', health: 'weird', retryable: true }),
    ).toBeNull();
  });

  it('health 三态与 code 一致性', () => {
    expect(
      validateWatchHealthSnapshot({ state: 'healthy', acquisition: 'rss', code: null }),
    ).toEqual({ state: 'healthy', acquisition: 'rss', code: null });
    expect(
      validateWatchHealthSnapshot({ state: 'paused', acquisition: 'browser', code: 'captcha' }),
    ).toEqual({ state: 'paused', acquisition: 'browser', code: 'captcha' });
    expect(
      validateWatchHealthSnapshot({ state: 'healthy', acquisition: 'rss', code: 'captcha' }),
    ).toBeNull();
    expect(
      validateWatchHealthSnapshot({ state: 'paused', acquisition: 'rss', code: null }),
    ).toBeNull();
  });
});

describe('validateSourceWatchProjection / affected map', () => {
  it('投影形状与边界', () => {
    const proj = {
      sourceId: 's1',
      rowVersion: 2,
      enabled: true,
      deletedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
    };
    expect(validateSourceWatchProjection(proj)).toEqual(proj);
    expect(validateSourceWatchProjection({ ...proj, scope: 'weird' })).toBeNull();
    expect(validateSourceWatchProjection({ ...proj, rowVersion: 0 })).toBeNull();
    expect(validateSourceWatchProjection({ ...proj, enabled: 1 })).toBeNull();
    expect(validateSourceWatchProjection({ ...proj, extra: 1 })).toBeNull();
  });

  it('affected map 形状；非法值拒绝', () => {
    const map = {
      r1: {
        state: 'enabled',
        pauseReason: null,
        desiredEnabled: true,
        sourceRowVersion: 2,
        sourceLocatorFingerprint: FINGERPRINT,
      },
    };
    expect(validateAffectedRuleStateMap(map)).toEqual(map);
    expect(
      validateAffectedRuleStateMap({
        r1: { ...map['r1'], sourceLocatorFingerprint: 'short' },
      }),
    ).toBeNull();
    expect(validateAffectedRuleStateMap([])).toBeNull();
    expect(validateAffectedRuleStateMap({ r1: { state: 'weird' } })).toBeNull();
  });
});

describe('validateRunRow / validateEventRow / validateIntentRow', () => {
  it('run 行 outcome/health 经共享 validator 二次校验', () => {
    const base = {
      id: 'run1',
      ruleId: 'r1',
      requestKey: 'k1',
      status: 'finished',
      trigger: 'scheduled',
      scheduledFor: null,
      startedAt: null,
      finishedAt: null,
      outcome: { kind: 'unchanged' },
      health: { state: 'healthy', acquisition: 'rss', code: null },
      responseMetadataJson: null,
    };
    expect(validateRunRow(base).ok).toBe(true);
    expect(validateRunRow({ ...base, status: 'weird' }).ok).toBe(false);
    expect(validateRunRow({ ...base, outcome: { kind: 'future' } }).ok).toBe(false);
    expect(validateRunRow({ ...base, responseMetadataJson: 'not-json' }).ok).toBe(false);
  });

  it('event 行枚举/整数/时间校验', () => {
    const base = {
      id: 'e1',
      rule_id: 'r1',
      source_id: 's1',
      event_kind: 'added',
      importance: 'normal',
      idempotency_key: 'ik1',
      change_fingerprint: 'fp1',
      first_observed_at: '2026-08-28T00:00:00.000Z',
      last_observed_at: '2026-08-28T00:00:00.000Z',
      item_count: 1,
      read_at: null,
    };
    expect(validateEventRow(base).ok).toBe(true);
    expect(validateEventRow({ ...base, event_kind: 'weird' }).ok).toBe(false);
    expect(validateEventRow({ ...base, item_count: 0 }).ok).toBe(false);
    expect(validateEventRow({ ...base, read_at: 'x' }).ok).toBe(false);
  });

  it('intent 行投影/affected 经共享 validator 二次校验', () => {
    const proj = {
      sourceId: 's1',
      rowVersion: 1,
      enabled: true,
      deletedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
    };
    const base = {
      mutationId: 'm1',
      sourceId: 's1',
      operation: 'hard-delete',
      beforeProjection: proj,
      afterProjection: null,
      affectedRuleState: {},
      state: 'prepared',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    expect(validateIntentRow(base).ok).toBe(true);
    expect(validateIntentRow({ ...base, operation: 'purge' }).ok).toBe(false);
    expect(validateIntentRow({ ...base, beforeProjection: { ...proj, scope: 'x' } }).ok).toBe(
      false,
    );
    expect(validateIntentRow({ ...base, affectedRuleState: 'not-a-map' }).ok).toBe(false);
  });
});

describe('parseJsonSafe / 预算工具', () => {
  it('parseJsonSafe 非法输入安全 null', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonSafe('not-json')).toBeNull();
    expect(parseJsonSafe(null)).toBeNull();
    expect(parseJsonSafe(undefined)).toBeNull();
  });

  it('computeEventItemsBytes 按 UTF-8 字节累计', () => {
    expect(computeEventItemsBytes(['{"a":"你好"}'])).toBe(
      Buffer.byteLength('{"a":"你好"}', 'utf8'),
    );
    expect(computeEventItemsBytes([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R2-1 Run response metadata canonical validator（#S6-058 §8.1）
// ---------------------------------------------------------------------------

describe('validateRunResponseMetadataJson', () => {
  const http200 = { httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] };
  const canonical = (http: unknown = null, warnings: string[] = []): string =>
    JSON.stringify({ schemaVersion: 1, http, conditionWarnings: warnings });

  it('合法 canonical（http=null 与 http=200）接受', () => {
    expect(validateRunResponseMetadataJson(canonical(null))).toEqual({ ok: true, reason: null });
    expect(validateRunResponseMetadataJson(canonical(http200))).toEqual({
      ok: true,
      reason: null,
    });
    // R3-1：oversize warning 存在时对应字段必须为 null（oversize 头被清空并标记）
    expect(
      validateRunResponseMetadataJson(
        canonical(
          {
            ...http200,
            etag: null,
            lastModified: null,
            warnings: ['etag-oversize', 'last-modified-oversize'],
          },
          ['field-absent', 'numeric-value-unavailable', 'operator-not-applicable'],
        ),
      ),
    ).toEqual({ ok: true, reason: null });
    // 非 null 字段不得声明对应 oversize warning（矛盾拒绝）
    expect(
      validateRunResponseMetadataJson(canonical({ ...http200, warnings: ['etag-oversize'] })).ok,
    ).toBe(false);
  });

  it('null / 非 JSON 拒绝', () => {
    expect(validateRunResponseMetadataJson(null).ok).toBe(false);
    expect(validateRunResponseMetadataJson('not-json').ok).toBe(false);
  });

  it('额外/缺失 key、非 canonical key order 拒绝', () => {
    expect(validateRunResponseMetadataJson('{"schemaVersion":1,"http":null}').ok).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":null,"conditionWarnings":[],"x":1}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson('{"http":null,"schemaVersion":1,"conditionWarnings":[]}').ok,
    ).toBe(false);
  });

  it('未来 schemaVersion 拒绝', () => {
    expect(
      validateRunResponseMetadataJson('{"schemaVersion":2,"http":null,"conditionWarnings":[]}').ok,
    ).toBe(false);
  });

  it('http 非法（httpStatus/类型/乱序重复 warning）拒绝', () => {
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":{"httpStatus":201,"etag":null,"lastModified":null,"warnings":[]},"conditionWarnings":[]}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson('{"schemaVersion":1,"http":"oops","conditionWarnings":[]}')
        .ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["last-modified-oversize","etag-oversize"]},"conditionWarnings":[]}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["etag-oversize","etag-oversize"]},"conditionWarnings":[]}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["nope"]},"conditionWarnings":[]}',
      ).ok,
    ).toBe(false);
  });

  it('conditionWarnings 乱序/重复/未知拒绝', () => {
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":null,"conditionWarnings":["operator-not-applicable","field-absent"]}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":null,"conditionWarnings":["field-absent","field-absent"]}',
      ).ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson(
        '{"schemaVersion":1,"http":null,"conditionWarnings":["nope"]}',
      ).ok,
    ).toBe(false);
  });

  it('etag 单字段边界：1024 字节接受、1025 拒绝（不得用大 etag 证明整体 4096）', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: '', lastModified: null, warnings: [] },
      conditionWarnings: [] as string[],
    };
    const at1024 = JSON.stringify({
      ...base,
      http: { ...base.http, etag: 'a'.repeat(1024) },
    });
    expect(Buffer.byteLength(at1024, 'utf8')).toBeGreaterThan(1024); // 整体 > 字段上限仍合法
    expect(validateRunResponseMetadataJson(at1024)).toEqual({ ok: true, reason: null });
    const at1025 = JSON.stringify({
      ...base,
      http: { ...base.http, etag: 'a'.repeat(1025) },
    });
    expect(validateRunResponseMetadataJson(at1025).ok).toBe(false);
  });

  it('lastModified 单字段边界：1024 字节接受、1025 拒绝', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: null, lastModified: '', warnings: [] },
      conditionWarnings: [] as string[],
    };
    const at1024 = JSON.stringify({
      ...base,
      http: { ...base.http, lastModified: 'a'.repeat(1024) },
    });
    expect(validateRunResponseMetadataJson(at1024)).toEqual({ ok: true, reason: null });
    const at1025 = JSON.stringify({
      ...base,
      http: { ...base.http, lastModified: 'a'.repeat(1025) },
    });
    expect(validateRunResponseMetadataJson(at1025).ok).toBe(false);
  });

  it('多字节 UTF-8 以实际 bytes 判定字段预算（3 字节字符）', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: '', lastModified: null, warnings: [] },
      conditionWarnings: [] as string[],
    };
    // 341×3 字节 + 1 ASCII = 1024 字节 → 接受
    const exact = JSON.stringify({
      ...base,
      http: { ...base.http, etag: '你'.repeat(341) + 'a' },
    });
    expect(Buffer.byteLength('你'.repeat(341) + 'a', 'utf8')).toBe(1024);
    expect(validateRunResponseMetadataJson(exact)).toEqual({ ok: true, reason: null });
    // 342×3 字节 = 1026 字节 → 拒绝（字符数接近但字节超限）
    const over = JSON.stringify({
      ...base,
      http: { ...base.http, etag: '你'.repeat(342) },
    });
    expect(Buffer.byteLength('你'.repeat(342), 'utf8')).toBe(1026);
    expect(validateRunResponseMetadataJson(over).ok).toBe(false);
  });

  it('whitespace / 非 canonical 编码（重编码不逐字节相等）拒绝', () => {
    expect(
      validateRunResponseMetadataJson('{"schemaVersion":1,"http":null,"conditionWarnings":[]} ').ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson('{"schemaVersion":1, "http":null, "conditionWarnings":[]}')
        .ok,
    ).toBe(false);
    expect(
      validateRunResponseMetadataJson('{"schemaVersion":1,"http":null,"conditionWarnings":[]}').ok,
    ).toBe(true);
  });

  it('warning/字段矛盾拒绝：oversize 存在时字段必须为 null；非 null 不得同时声明 oversize', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: 'x', lastModified: null, warnings: [] as string[] },
      conditionWarnings: [] as string[],
    };
    // etag 非 null + etag-oversize → 拒绝
    expect(
      validateRunResponseMetadataJson(
        JSON.stringify({
          ...base,
          http: { ...base.http, warnings: ['etag-oversize'] },
        }),
      ).ok,
    ).toBe(false);
    // lastModified 非 null + last-modified-oversize → 拒绝
    expect(
      validateRunResponseMetadataJson(
        JSON.stringify({
          ...base,
          http: { ...base.http, lastModified: 'y', warnings: ['last-modified-oversize'] },
        }),
      ).ok,
    ).toBe(false);
    // 字段 null + 对应 oversize warning → 接受（oversize 头被清空并标记）
    expect(
      validateRunResponseMetadataJson(
        JSON.stringify({
          ...base,
          http: { ...base.http, etag: null, warnings: ['etag-oversize'] },
        }),
      ),
    ).toEqual({ ok: true, reason: null });
    // 字段 null 且无 warning → 接受（服务器未发送该头）
    expect(
      validateRunResponseMetadataJson(
        JSON.stringify({
          ...base,
          http: { ...base.http, etag: null, lastModified: null, warnings: [] },
        }),
      ),
    ).toEqual({ ok: true, reason: null });
  });

  it('总体 >4096 字节拒绝（整体预算；闭合字段预算下超限必然同时命中单字段）', () => {
    const over = JSON.stringify({
      schemaVersion: 1,
      http: { httpStatus: 200, etag: 'a'.repeat(4096), lastModified: null, warnings: [] },
      conditionWarnings: [],
    });
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(4096);
    expect(validateRunResponseMetadataJson(over).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3-1/R3-3 Baseline conditional validator 运行时边界
// ---------------------------------------------------------------------------

describe('validateBaselineRow / validateBaselineValidators', () => {
  const base: WatchBaselineRow = {
    ruleId: 'r1',
    version: 1,
    projectionType: 'feed',
    projectionJson: '{"format":"rss2"}',
    contentHash: 'h',
    byteLength: 17,
    finalUrl: 'https://example.com',
    capturedAt: '2026-08-28T00:00:00.000Z',
    documentId: null,
    conditionalEtag: null,
    conditionalLastModified: null,
  };

  it('feed 条件列 string|null；Page 两列恒 null', () => {
    expect(
      validateBaselineRow({ ...base, conditionalEtag: '"v1"', conditionalLastModified: null }).ok,
    ).toBe(true);
    expect(validateBaselineRow({ ...base, conditionalEtag: 123 }).ok).toBe(false);
    expect(validateBaselineRow({ ...base, conditionalLastModified: 123 }).ok).toBe(false);
    const page = validateBaselineRow({
      ...base,
      projectionType: 'page',
      conditionalEtag: null,
      conditionalLastModified: null,
    });
    expect(page.ok).toBe(true);
    expect(
      validateBaselineRow({
        ...base,
        projectionType: 'page',
        conditionalEtag: '"x"',
        conditionalLastModified: null,
      }).ok,
    ).toBe(false);
    expect(
      validateBaselineRow({
        ...base,
        projectionType: 'page',
        conditionalEtag: null,
        conditionalLastModified: 'x',
      }).ok,
    ).toBe(false);
  });

  it('非 null 条件列 UTF-8 ≤1024 字节；1025 拒绝（多字节按实际 bytes）', () => {
    expect(validateBaselineRow({ ...base, conditionalEtag: 'a'.repeat(1024) }).ok).toBe(true);
    expect(validateBaselineRow({ ...base, conditionalEtag: 'a'.repeat(1025) }).ok).toBe(false);
    expect(validateBaselineRow({ ...base, conditionalLastModified: 'a'.repeat(1024) }).ok).toBe(
      true,
    );
    expect(validateBaselineRow({ ...base, conditionalLastModified: '你'.repeat(342) }).ok).toBe(
      false,
    );
  });

  it('validateBaselineValidators 写前复用同一 runtime 规则', () => {
    expect(
      validateBaselineValidators({
        projectionType: 'feed',
        etag: 'a'.repeat(1024),
        lastModified: null,
      }),
    ).toBe(true);
    expect(
      validateBaselineValidators({
        projectionType: 'feed',
        etag: 'a'.repeat(1025),
        lastModified: null,
      }),
    ).toBe(false);
    expect(
      validateBaselineValidators({
        projectionType: 'feed',
        etag: null,
        lastModified: '你'.repeat(342),
      }),
    ).toBe(false);
    expect(
      validateBaselineValidators({ projectionType: 'page', etag: null, lastModified: null }),
    ).toBe(true);
    expect(
      validateBaselineValidators({ projectionType: 'page', etag: 'x', lastModified: null }),
    ).toBe(false);
    expect(
      validateBaselineValidators({ projectionType: 'page', etag: null, lastModified: 'x' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3-4 observation ID 闭合形状
// ---------------------------------------------------------------------------

describe('isValidObservationId', () => {
  const UUID_V4 = '01234567-89ab-4def-8a9b-0c1d2e3f4a5b';
  const EVENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('小写 UUID v4 与 v2:<eventId> 两种合法形态', () => {
    expect(isValidObservationId(UUID_V4, EVENT)).toBe(true);
    expect(isValidObservationId(`v2:${EVENT}`, EVENT)).toBe(true);
  });

  it('拒绝敌手形态：任意 v2: suffix、大小写 UUID、非 v4 UUID、c- 前缀、eventId-obs0', () => {
    expect(isValidObservationId('v2:whatever', EVENT)).toBe(false);
    expect(isValidObservationId(`v2:${UUID_V4}`, EVENT)).toBe(false); // suffix 不等于所属 Event
    expect(isValidObservationId(UUID_V4.toUpperCase(), EVENT)).toBe(false);
    expect(isValidObservationId('01234567-89ab-5def-8a9b-0c1d2e3f4a5b', EVENT)).toBe(false); // 非 v4
    expect(isValidObservationId('01234567-89ab-4def-6a9b-0c1d2e3f4a5b', EVENT)).toBe(false); // 非 v4 variant
    expect(isValidObservationId(`c-${UUID_V4}`, EVENT)).toBe(false);
    expect(isValidObservationId(`${EVENT}-obs0`, EVENT)).toBe(false);
  });
});

describe('D8 Digest v4 runtime validators', () => {
  const facts = JSON.stringify({
    schemaVersion: 1,
    scheduleId: 's1',
    digestRunId: 'r1',
    batchIndex: 0,
    period: { fromExclusive: '2026-08-28T00:00:00.000Z', toInclusive: '2026-08-29T00:00:00.000Z' },
    eventCount: 1,
    runStats: { changed: 1, failed: 0, unchanged: 0 },
    events: [
      {
        eventId: 'e1',
        ruleId: 'wr1',
        sourceId: 'src1',
        eventKind: 'added',
        importance: 'normal',
        firstIncludedAt: '2026-08-28T01:00:00.000Z',
        lastIncludedAt: '2026-08-28T01:00:00.000Z',
        observationCount: 1,
        itemCount: 1,
      },
    ],
    evidenceMap: {
      e1: [
        {
          itemId: 'i1',
          fieldKey: 'title',
          label: '标题',
          before: { kind: 'absent' },
          after: {
            kind: 'present',
            excerpt: 'x',
            valueHash: 'h',
            normalizedBytes: 1,
            truncated: false,
          },
          beforeCapturedAt: '2026-08-28T01:00:00.000Z',
          afterCapturedAt: '2026-08-28T01:00:00.000Z',
          beforeFinalUrl: 'https://example.com',
          afterFinalUrl: 'https://example.com',
          beforeDocumentId: null,
          afterDocumentId: null,
          feedItemKey: null,
        },
      ],
    },
    referenceStates: { e1: 'active' },
    fetchedAt: '2026-08-29T00:00:00.000Z',
  });
  const hash = createHash('sha256').update(facts).digest('hex');
  const base = {
    id: 'd1',
    schedule_id: 's1',
    run_id: 'r1',
    batch_index: 0,
    first_sequence: 1,
    last_sequence: 1,
    facts_json: facts,
    facts_hash: hash,
    facts_revision: 1,
    explanation_json: null,
    byte_length: serializeDigestArtifact(facts, null).byteLength,
    provider_state: 'pending',
    provider_result_code: null,
    claimed_facts_revision: null,
    claimed_facts_hash: null,
    claimed_at: null,
    provider_finished_at: null,
    created_at: '2026-08-29T00:00:00.000Z',
  };

  it('Schedule/Run canonical JSON 与闭合状态矩阵', () => {
    expect(
      validateDigestScheduleRow({
        id: 's1',
        version: 1,
        source_ids_json: '["a","b"]',
        schedule_json: '{"kind":"daily","localTime":"09:00","timeZone":"UTC"}',
        ai_enabled: 0,
        cursor_sequence: 0,
        state: 'active',
        next_due_at: '2026-08-29T09:00:00.000Z',
        last_consumed_scheduled_for: null,
        last_daily_local_date: null,
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
        last_checked_at: null,
        last_period_json: null,
        last_run_stats_json: null,
      }),
    ).toBe(true);
    expect(
      validateDigestRunRow({
        id: 'r1',
        schedule_id: 's1',
        request_key: 'k',
        logical_date: '2026-08-29',
        lower_sequence: 0,
        upper_sequence: 1,
        next_sequence: 0,
        period_json:
          '{"fromExclusive":"2026-08-28T00:00:00.000Z","toInclusive":"2026-08-29T00:00:00.000Z"}',
        run_stats_json: '{"changed":1,"failed":0,"unchanged":0}',
        state: 'running',
        blocked_at: null,
        blocked_required_bytes: null,
        blocked_available_bytes: null,
        created_at: '2026-08-29T00:00:00.000Z',
        finished_at: null,
      }),
    ).toBe(true);
  });

  it('Provider §11.5 合法状态逐类接受、表外组合拒绝', () => {
    const claimed = {
      claimed_facts_revision: 1,
      claimed_facts_hash: hash,
      claimed_at: '2026-08-29T00:00:01.000Z',
    };
    const finished = { provider_finished_at: '2026-08-29T00:00:02.000Z' };
    expect(validateDigestArtifactRow(base)).toBe(true);
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'disabled',
        provider_result_code: 'disabled',
        ...finished,
      }),
    ).toBe(true);
    expect(validateDigestArtifactRow({ ...base, provider_state: 'claimed', ...claimed })).toBe(
      true,
    );
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'failed',
        provider_result_code: 'timeout',
        ...claimed,
        ...finished,
      }),
    ).toBe(true);
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'uncertain',
        provider_result_code: 'uncertain-after-restart',
        ...claimed,
        ...finished,
      }),
    ).toBe(true);
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'skipped',
        provider_result_code: 'key-unavailable',
        ...finished,
      }),
    ).toBe(true);
    const explanation = '{"sections":[{"eventIds":["e1"],"explanation":"变化"}]}';
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'succeeded',
        provider_result_code: 'success',
        explanation_json: explanation,
        byte_length: serializeDigestArtifact(facts, explanation).byteLength,
        ...claimed,
        ...finished,
      }),
    ).toBe(true);
    expect(
      validateDigestArtifactRow({
        ...base,
        provider_state: 'pending',
        provider_result_code: 'provider-error',
        ...finished,
      }),
    ).toBe(false);
  });
});
