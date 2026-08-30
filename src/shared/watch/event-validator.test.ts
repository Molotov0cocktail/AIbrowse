// D7 event-validator tests: 双侧 Evidence/Event 严格验证 + 幂等键/指纹/reversal 固定向量
//（detailed-design §9.4、#S6-047～#S6-051、§8.1/#S6-058）。纯逻辑、零 IO。
import { describe, expect, it } from 'vitest';
import {
  aggregateEventKind,
  basePairKind,
  buildChangeSet,
  computeChangeFingerprint,
  computeConditionVersion,
  computeIdempotencyKey,
  evidenceEquals,
  isReversalPair,
  validateChangeEvidencePair,
  validateEvidenceValue,
  validateWatchEventShape,
  validateRunResponseMetadata,
} from './event-validator';
import { sha256Hex } from './diff/evidence';
import type {
  ChangeEvidencePair,
  StructuredCondition,
  WatchRunResponseMetadata,
} from '../types/watch';

const T0 = '2026-08-28T00:00:00.000Z';

function present(excerpt: string, valueHash?: string): ChangeEvidencePair['after'] {
  return {
    kind: 'present',
    excerpt,
    valueHash: valueHash ?? sha256Hex(excerpt),
    normalizedBytes: Buffer.byteLength(excerpt, 'utf8'),
    truncated: false,
  };
}

function pair(over: Partial<ChangeEvidencePair> = {}): ChangeEvidencePair {
  return {
    itemId: 'it1',
    fieldKey: 'title',
    label: '标题',
    before: { kind: 'absent' },
    after: present('新标题'),
    beforeCapturedAt: T0,
    afterCapturedAt: T0,
    beforeFinalUrl: 'https://example.com',
    afterFinalUrl: 'https://example.com',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: 'it1',
    ...over,
  };
}

describe('Evidence/Pair 严格形状验证（exact own-key；fail-closed）', () => {
  it('present/absent 合法；额外键/原型链/getter 拒绝', () => {
    expect(validateEvidenceValue({ kind: 'absent' })).toEqual({ kind: 'absent' });
    expect(validateEvidenceValue(present('x'))).not.toBeNull();
    expect(validateEvidenceValue({ kind: 'present' })).toBeNull();
    expect(
      validateEvidenceValue({
        kind: 'present',
        excerpt: 'x',
        valueHash: 'h',
        normalizedBytes: 1,
        truncated: false,
        extra: 1,
      }),
    ).toBeNull();
    expect(validateEvidenceValue(Object.create({ kind: 'absent' }))).toBeNull();
  });

  it('Pair 非法（缺键/类型/时间/预算）拒绝', () => {
    expect(validateChangeEvidencePair(pair())).not.toBeNull();
    expect(validateChangeEvidencePair({ ...pair(), itemId: '' })).toBeNull();
    expect(validateChangeEvidencePair({ ...pair(), beforeCapturedAt: 'not-a-time' })).toBeNull();
    expect(validateChangeEvidencePair({ ...pair(), before: { kind: 'present' } })).toBeNull();
  });
});

describe('idempotencyKey 固定向量（#S6-050）', () => {
  it('域分离前缀 + 五段 \0 连接；newProjectionHash 取 envelope contentHash', () => {
    const key = computeIdempotencyKey({
      ruleId: 'r1',
      baselineVersion: 3,
      newProjectionHash: 'abc',
      conditionVersion: 'none',
    });
    expect(key).toBe(sha256Hex('watch-event-idem-v1\u0000r1\u00003\u0000abc\u0000none'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('conditionVersion：none 或条件 canonical JSON 的 SHA-256', () => {
    expect(computeConditionVersion(null)).toBe('none');
    const cond: StructuredCondition = {
      version: 1,
      combine: 'all',
      predicates: [{ fieldKey: 'title', operator: 'contains', operand: 'x', caseSensitive: false }],
    };
    const canonical = JSON.stringify({
      version: 1,
      combine: 'all',
      predicates: [
        JSON.stringify({
          fieldKey: 'title',
          operator: 'contains',
          operand: 'x',
          caseSensitive: false,
        }),
      ],
    });
    expect(computeConditionVersion(cond)).toBe(sha256Hex(canonical));
  });
});

describe('changeFingerprint 固定向量（#S6-050）', () => {
  it('元组按 UTF-8 字节序排序、\0 连接、token=absent 或 p:+valueHash', () => {
    const a = pair({ itemId: 'b', before: { kind: 'absent' }, after: present('B') });
    const b = pair({ itemId: 'a', before: present('A'), after: { kind: 'absent' } });
    const fp = computeChangeFingerprint([
      { itemKey: 'b', fieldKey: 'title', pairKind: 'added', before: a.before, after: a.after },
      { itemKey: 'a', fieldKey: 'title', pairKind: 'removed', before: b.before, after: b.after },
    ]);
    const tupleA = `a\u0001title\u0001removed\u0001p:${sha256Hex('A')}\u0001absent`;
    const tupleB = `b\u0001title\u0001added\u0001absent\u0001p:${sha256Hex('B')}`;
    const sorted = [tupleA, tupleB].sort((x, y) =>
      Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')),
    );
    expect(fp).toBe(sha256Hex(`watch-change-fp-v1\u0000${sorted.join('\u0000')}`));
  });

  it('basePairKind：absent→present=added；present→absent=removed；双侧 present=changed', () => {
    expect(basePairKind(pair())).toBe('added');
    expect(basePairKind(pair({ before: present('x'), after: { kind: 'absent' } }))).toBe('removed');
    expect(basePairKind(pair({ before: present('x'), after: present('y') }))).toBe('changed');
  });
});

describe('reversal 镜像（#S6-048）', () => {
  it('P 为 Q 的 typed 镜像 → reversal；无历史对必非 reversal', () => {
    const q = pair({ before: present('v2'), after: present('v1') });
    const p = pair({ before: present('v1'), after: present('v2') });
    expect(isReversalPair(p, q)).toBe(true);
    expect(isReversalPair(p, null)).toBe(false);
    // absent↔absent
    const q2 = pair({ before: { kind: 'absent' }, after: { kind: 'absent' } });
    const p2 = pair({ before: { kind: 'absent' }, after: { kind: 'absent' } });
    expect(isReversalPair(p2, q2)).toBe(true);
    // 非镜像
    expect(isReversalPair(pair({ before: present('x'), after: present('y') }), q)).toBe(false);
  });

  it('evidenceEquals：present 按 valueHash 相等', () => {
    expect(evidenceEquals({ kind: 'absent' }, { kind: 'absent' })).toBe(true);
    expect(evidenceEquals(present('a'), present('a'))).toBe(true);
    expect(evidenceEquals(present('a'), present('b'))).toBe(false);
    expect(evidenceEquals({ kind: 'absent' }, present('a'))).toBe(false);
  });
});

describe('Event kind 聚合（#S6-049）与 ChangeSet 构造', () => {
  it('全 added/removed/changed/reversal；其余 mixed；空 mixed', () => {
    expect(aggregateEventKind(['added', 'added'])).toBe('added');
    expect(aggregateEventKind(['removed'])).toBe('removed');
    expect(aggregateEventKind(['changed', 'changed'])).toBe('changed');
    expect(aggregateEventKind(['reversal'])).toBe('reversal');
    expect(aggregateEventKind(['added', 'changed'])).toBe('mixed');
    expect(aggregateEventKind(['changed', 'reversal'])).toBe('mixed');
    expect(aggregateEventKind([])).toBe('mixed');
  });

  it('buildChangeSet：每 pair 一条 ChangeField（同 fieldKey 多 pair 保留）', () => {
    const cs = buildChangeSet('added', [
      pair({ fieldKey: 'title' }),
      pair({ fieldKey: 'title', itemId: 'it2' }),
    ]);
    expect(cs.eventKind).toBe('added');
    expect(cs.fields.length).toBe(2);
    expect(cs.fields[0]!.before).toEqual({ kind: 'absent' });
    expect(cs.fields[0]!.after).toEqual({ kind: 'present', value: '新标题' });
  });
});

describe('WatchEvent 形状验证', () => {
  it('合法 Event 通过；非法 eventKind/itemCount 拒绝', () => {
    const ev = {
      id: 'e1',
      ruleId: 'r1',
      sourceId: 's1',
      eventKind: 'mixed',
      importance: 'important',
      idempotencyKey: 'ik',
      changeFingerprint: 'cf',
      firstObservedAt: T0,
      lastObservedAt: T0,
      itemCount: 2,
      readAt: null,
    };
    expect(validateWatchEventShape(ev)).not.toBeNull();
    expect(validateWatchEventShape({ ...ev, eventKind: 'bogus' })).toBeNull();
    expect(validateWatchEventShape({ ...ev, itemCount: 0 })).toBeNull();
    expect(validateWatchEventShape({ ...ev, extra: 1 })).toBeNull();
  });
});

describe('WatchRunResponseMetadata exact-key（§8.1/#S6-058）', () => {
  it('合法通过；额外键/未排序 warning/超限拒绝', () => {
    const ok: WatchRunResponseMetadata = {
      schemaVersion: 1,
      http: {
        httpStatus: 200,
        etag: '"a"',
        lastModified: null,
        warnings: ['etag-oversize'],
      },
      conditionWarnings: ['field-absent', 'operator-not-applicable'],
    };
    expect(validateRunResponseMetadata(ok)).not.toBeNull();
    expect(validateRunResponseMetadata({ ...ok, extra: 1 })).toBeNull();
    expect(
      validateRunResponseMetadata({
        ...ok,
        conditionWarnings: ['operator-not-applicable', 'field-absent'],
      }),
    ).toBeNull(); // 未按编译期顺序
    expect(validateRunResponseMetadata({ ...ok, conditionWarnings: ['bogus'] })).toBeNull();
    expect(
      validateRunResponseMetadata({ ...ok, conditionWarnings: ['field-absent', 'field-absent'] }),
    ).toBeNull(); // 重复
  });
});
