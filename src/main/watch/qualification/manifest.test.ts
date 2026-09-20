import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSourceLocatorFingerprint } from '../../../shared/watch/watch-rule-state';
import { normalizeSourceUrl } from '../../sources/domain/source-canonical';
import { computeJitterMs } from '../watch-scheduler';
import {
  isValidFeedProjectionValue,
  isValidPageProjectionValue,
} from '../../../shared/watch/diff/evidence';
import { diffFeedProjections } from '../../../shared/watch/diff/feed-diff';
import { diffPageProjections } from '../../../shared/watch/diff/page-diff';
import {
  H3B_DESCRIPTOR_JSON,
  H3B_DESCRIPTOR,
  H3B_DESCRIPTOR_SHA256,
  H3B_EXPANDED_SHA256,
  createQualificationManifest,
  qualificationManifestJson,
  createQualificationSources,
  createQualificationRules,
  createQualificationDigestSchedules,
  getQualificationRun,
  createQualificationRuns,
  createQualificationProjection,
  getQualificationDigestOracle,
  getQualificationLoadOracle,
  qualificationM0,
  qualificationInitialNextDueAt,
  qualificationDocumentId,
  qualificationResponseMetadata,
} from './manifest';

const M0 = Date.parse('2026-09-07T12:00:00.000Z');
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('H3b 固定 manifest', () => {
  it('独立命中 descriptor 与 expanded 的全部字节 golden', () => {
    expect(Buffer.byteLength(H3B_DESCRIPTOR_JSON)).toBe(1502);
    expect(sha(H3B_DESCRIPTOR_JSON)).toBe(
      '3f59d95d74d373ef57e80eb56d05c4c9620a6e2bc2db8637ce5ddee48b5b85c3',
    );
    expect(H3B_DESCRIPTOR_SHA256).toBe(sha(H3B_DESCRIPTOR_JSON));
    const manifest = createQualificationManifest();
    const json = qualificationManifestJson();
    expect(JSON.parse(json)).toEqual(manifest);
    expect(Buffer.byteLength(json)).toBe(34252);
    expect(sha(json)).toBe('5652b57e407b728e78a090b56aa84a73bc81f6b977e8a9e6211d3a48c15b6beb');
    expect(H3B_EXPANDED_SHA256).toBe(sha(json));
    expect(manifest.entries[0]).toMatchObject({
      sourceId: 'e93ee316-71ae-4fff-a374-c0ea3ab12fdc',
      ruleId: '8a0016c2-03c6-51bc-ba81-5587a37c5a30',
      scheduleOffsetMs: 5000,
    });
    expect(manifest.entries[99]).toMatchObject({
      sourceId: '3f00bf7e-b7f0-4117-bb66-90e6732c2bf1',
      ruleId: '541c7c34-57d6-5d1e-bb0e-8da2f6eadf73',
      scheduleOffsetMs: 797000,
    });
    expect(new Set(manifest.entries.map((e) => e.sourceId)).size).toBe(100);
    expect(
      manifest.entries.every((e) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(e.sourceId),
      ),
    ).toBe(true);
  });

  it('Source/Rule 使用真实 URL normalizer、locator 和完整初始字段', () => {
    const sources = createQualificationSources(M0);
    const rules = createQualificationRules(M0);
    const entries = createQualificationManifest().entries;
    expect(sources).toHaveLength(100);
    expect(rules).toHaveLength(100);
    for (const [i, source] of sources.entries()) {
      const entry = entries[i]!;
      const rule = rules[i]!;
      expect(normalizeSourceUrl(source.url, source.scope)).toEqual({
        ok: true,
        canonicalKey: entry.targetUrl,
        displayUrl: entry.targetUrl,
      });
      expect(source).toMatchObject({
        version: 1,
        scope: 'page',
        tags: [],
        priority: 3,
        enabled: true,
        shareMode: 'full',
        trust: { value: 'unknown', assertedBy: 'user', verification: 'asserted' },
        createdAt: '2026-09-07T11:00:00.000Z',
        deletedAt: null,
        lastUsageOutcome: null,
      });
      expect(rule).toMatchObject({
        version: 1,
        baselineVersion: 0,
        nextDueAt: null,
        muted: true,
        desiredEnabled: true,
        state: 'enabled',
        schedule: { kind: 'interval', intervalMinutes: 15 },
      });
      expect(rule.sourceLocatorFingerprint).toBe(
        computeSourceLocatorFingerprint({
          sourceId: source.id,
          scope: 'page',
          canonicalKey: source.canonicalKey,
          kind: entry.kind,
          canonicalTargetUrl: entry.targetUrl,
        }),
      );
      if (rule.target.type === 'page') {
        expect(rule.target.regions).toEqual([
          { kind: 'main-text', label: 'H3b' },
          { kind: 'headings', label: 'H3b padding', levels: [1] },
        ]);
        expect(rule.target.sessionConsent).toEqual(
          i < 80
            ? null
            : { version: 1, origin: new URL(entry.targetUrl).origin, grantedAt: source.createdAt },
        );
      }
      expect(rule.condition).toEqual(
        i % 4 !== 2
          ? null
          : {
              version: 1,
              combine: 'all',
              predicates: [
                {
                  fieldKey: i < 40 ? 'title' : 'r0:main',
                  operator: 'equals',
                  operand: 'H3B-NEVER',
                  caseSensitive: true,
                },
              ],
            },
      );
    }
    sources[0]!.name = 'changed';
    rules[0]!.schedule = { kind: 'interval', intervalMinutes: 60 };
    expect(createQualificationSources(M0)[0]!.name).toBe('H3b 000');
    expect(createQualificationRules(M0)[0]!.schedule).toEqual({
      kind: 'interval',
      intervalMinutes: 15,
    });
  });

  it('Digest 成员按 UTF-8 排序，精确命中数组和 ID golden', () => {
    const schedules = createQualificationDigestSchedules(M0);
    const entries = createQualificationManifest().entries;
    const permutations = [
      [
        32, 5, 34, 40, 15, 12, 30, 49, 25, 37, 27, 19, 41, 1, 8, 47, 21, 46, 11, 16, 7, 13, 17, 42,
        20, 2, 43, 36, 9, 22, 31, 14, 35, 3, 38, 45, 26, 18, 33, 28, 48, 39, 4, 24, 10, 44, 29, 0,
        6, 23,
      ],
      [
        71, 72, 79, 93, 53, 66, 77, 74, 76, 67, 99, 65, 63, 94, 88, 69, 80, 68, 97, 89, 91, 62, 60,
        61, 56, 52, 57, 82, 96, 64, 73, 70, 59, 92, 98, 86, 58, 55, 87, 83, 78, 81, 85, 90, 50, 84,
        75, 51, 54, 95,
      ],
    ];
    for (const [i, schedule] of schedules.entries()) {
      expect(schedule.sourceIds).toEqual(permutations[i]!.map((index) => entries[index]!.sourceId));
      expect(Buffer.byteLength(JSON.stringify(schedule.sourceIds))).toBe(1951);
      expect(sha(JSON.stringify(schedule.sourceIds))).toBe(
        [
          '3b8b7861854044ac55240680dfcf76161261544cdd3ceb286e7e28f82353dd7d',
          '7225b4d9000aa989994f0784cb7245cccb46e0094b661067c2147f76c2ae44d3',
        ][i],
      );
      expect(schedule).toMatchObject({
        version: 1,
        timeZone: 'UTC',
        aiEnabled: false,
        cursor: { changeSequence: 0 },
        state: 'active',
        createdAt: new Date(M0).toISOString(),
        lastRunStats: null,
      });
    }
    expect(schedules.map((s) => [s.id, s.localTime, s.nextDueAt])).toEqual([
      ['dc6d5f93-23a3-5096-9897-5d8a3b2b960b', '12:24', '2026-09-07T12:24:00.000Z'],
      ['1a40aac3-9641-5804-925e-aad2afdb8acf', '12:46', '2026-09-07T12:46:00.000Z'],
    ]);
  });

  it('由真实 phase/round 算出 567 runs、所有 ownership 计数和 Digest 事实', () => {
    const runs = createQualificationRuns(M0);
    expect(runs).toHaveLength(567);
    expect(runs.filter((r) => r.phase === 'warmup')).toHaveLength(67);
    expect(runs.filter((r) => r.phase === 'measurement')).toHaveLength(400);
    expect(runs.filter((r) => r.entry.accessMode === 'session')).toHaveLength(120);
    expect([0, 1, 2, 3].map((h) => runs.filter((r) => r.entry.index % 4 === h).length)).toEqual([
      141, 142, 142, 142,
    ]);
    expect(getQualificationLoadOracle()).toMatchObject({
      runPairs: 567,
      taskTabs: 120,
      perHost: [141, 142, 142, 142],
      measurementRuns: 400,
    });
    expect(getQualificationDigestOracle(0)).toMatchObject({
      runStats: { changed: 48, unchanged: 52, failed: 0 },
      observations: 24,
      events: 12,
    });
    expect(getQualificationDigestOracle(1)).toMatchObject({
      runStats: { changed: 78, unchanged: 72, failed: 0 },
      observations: 39,
      events: 26,
    });
    for (const run of runs) {
      expect(run.entry).toEqual(createQualificationManifest().entries[run.entry.index]);
      if (run.scheduledFor !== null) {
        expect(run.releaseAtMs).toBeGreaterThanOrEqual(Date.parse(run.scheduledFor));
        expect(run.jitterMs).toBe(
          computeJitterMs({
            ruleId: run.entry.ruleId,
            hostKey: run.entry.hostKey,
            seed: run.scheduledFor,
          }),
        );
      }
    }
  });

  it('保留 scheduledFor 与 release 分离、warmup 边界、ordinal 和反转终态', () => {
    expect(qualificationM0(M0 + 1)).toBe(M0 + 25 * 60000);
    expect(qualificationM0(M0)).toBe(M0 + 24 * 60000);
    expect(qualificationInitialNextDueAt(32, M0)).toBe(new Date(M0 + 269000).toISOString());
    expect(qualificationInitialNextDueAt(33, M0)).toBe(new Date(M0 - 631000).toISOString());
    for (const [i, s, r] of [
      [33, -631000, -600000],
      [36, -598000, -565800],
      [96, -103000, -52800],
    ]) {
      expect(getQualificationRun(i!, 'warmup', null, M0)).toMatchObject({
        scheduledFor: new Date(M0 + s!).toISOString(),
        releaseAtMs: M0 + r!,
        runOrdinal: 1,
        state: 'state-A',
      });
    }
    expect(getQualificationRun(99, 'initialization', null, M0)).toMatchObject({
      initializationOffsetMs: 744000,
      releaseAtMs: null,
      scheduledFor: null,
      requestId: 'watch-h3b-init-v1:099',
      runOrdinal: 0,
    });
    expect(
      [0, 1, 2, 3].map((r) => getQualificationRun(99, 'measurement', r, M0).expectedOutcome),
    ).toEqual(['event-created', 'event-coalesced', 'event-created', 'event-coalesced']);
    expect(getQualificationRun(99, 'measurement', 3, M0)).toMatchObject({
      releaseAtMs: M0 + 3525800,
      runOrdinal: 5,
    });
    expect(qualificationDocumentId(40, 0)).toBe('e2840cd9-1aa9-542a-b940-589c34a80d99');
    expect(qualificationDocumentId(99, 5)).toBe('aedaaf84-df8c-598c-9a39-f5abcdbcb947');
  });

  it.each([0, 1, 2, 3, 39, 40, 42, 43, 79, 80, 99])(
    'i%d 投影精确填充，真实 validator 与 Diff 接受且 padding 不产生变化',
    (index) => {
      const before = createQualificationProjection(
        getQualificationRun(index, 'initialization', null, M0),
        new Date(M0 - 650000).toISOString(),
      );
      const after = createQualificationProjection(
        getQualificationRun(index, 'measurement', 0, M0),
        new Date(M0 + 50000).toISOString(),
      );
      for (const p of [before, after]) {
        expect(p.byteLength).toBe(index < 40 ? 32768 : 24576);
        expect(Buffer.byteLength(JSON.stringify(p.value))).toBe(p.byteLength);
        expect(sha(JSON.stringify(p.value))).toBe(p.contentHash);
        expect(
          p.value.type === 'feed'
            ? isValidFeedProjectionValue(p.value)
            : isValidPageProjectionValue(p.value),
        ).toBe(true);
      }
      const expectedChanges = index % 4 < 2 ? 0 : 1;
      if (before.value.type === 'feed' && after.value.type === 'feed') {
        expect(before.value.items[0]!.summary).toEqual(after.value.items[0]!.summary);
        expect(
          diffFeedProjections({ ...before, value: before.value }, { ...after, value: after.value })
            .pairs,
        ).toHaveLength(expectedChanges);
      } else if (before.value.type === 'page' && after.value.type === 'page') {
        expect(before.value.fields[1]).toEqual(after.value.fields[1]);
        expect(
          diffPageProjections({ ...before, value: before.value }, { ...after, value: after.value })
            .pairs,
        ).toHaveLength(expectedChanges);
      }
    },
  );

  it('非法index/phase/round/M0、日期与伪造plan均安全拒绝', () => {
    for (const index of [-1, 100, 1.5, NaN, Infinity])
      expect(() => getQualificationRun(index, 'initialization', null, M0)).toThrow();
    expect(() => getQualificationRun(32, 'warmup', null, M0)).toThrow();
    expect(() => getQualificationRun(33, 'warmup', 0, M0)).toThrow();
    expect(() => getQualificationRun(3, 'measurement', 4, M0)).toThrow();
    expect(() => getQualificationRun(3, 'measurement', null, M0)).toThrow();
    expect(() => createQualificationRules(M0 + 1)).toThrow();
    expect(() => createQualificationSources(Infinity)).toThrow();
    const plan = getQualificationRun(40, 'measurement', 0, M0);
    expect(() =>
      createQualificationProjection(
        { ...plan, entry: { ...plan.entry, targetUrl: 'https://example.com/' } },
        new Date(M0).toISOString(),
      ),
    ).toThrow();
    expect(() => createQualificationProjection(plan, '2026-09-07')).toThrow();
  });

  it('全部100项四轮内容、metadata、最小padding和边界余量保持固定', () => {
    const entries = createQualificationManifest().entries;
    expect(entries.filter((entry) => entry.feedFormat === 'rss2')).toHaveLength(20);
    expect(entries.filter((entry) => entry.feedFormat === 'atom')).toHaveLength(20);
    for (const entry of entries) {
      const baseline = createQualificationProjection(
        getQualificationRun(entry.index, 'initialization', null, M0),
        new Date(M0 - 650000).toISOString(),
      );
      const changedHashes = new Set<string>();
      for (let round = 0; round < 4; round++) {
        const projection = createQualificationProjection(
          getQualificationRun(entry.index, 'measurement', round, M0),
          new Date(M0 + round * 900000 + 50000).toISOString(),
        );
        changedHashes.add(projection.contentHash);
        expect(projection.contentHash === baseline.contentHash).toBe(
          entry.conditionClass === 'unchanged' || round % 2 === 1,
        );
      }
      expect(changedHashes.size).toBe(entry.conditionClass === 'unchanged' ? 1 : 2);
      const value = structuredClone(baseline.value);
      if (value.type === 'feed') {
        const summary = value.items[0]!.summary;
        expect(summary.text).toMatch(/^x+$/);
        summary.text = summary.text.slice(0, -1);
        summary.originalBytes = Buffer.byteLength(summary.text);
        summary.valueHash = sha(summary.text);
        expect(qualificationResponseMetadata(entry.index)).toEqual({
          httpStatus: 200,
          etag: null,
          lastModified: null,
          warnings: [],
        });
      } else {
        const heading = value.fields[1]!;
        if (heading.kind !== 'heading') throw new Error('固定heading缺失');
        expect(heading.value).toMatch(/^x+$/);
        heading.value = heading.value.slice(0, -1);
        expect(qualificationResponseMetadata(entry.index)).toBeNull();
      }
      // The monotone byte formula must also hold for the actual previous candidate.
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(entry.projectionBytes);
    }
    const bounds = H3B_DESCRIPTOR.latencyBoundsMs;
    const slotMax =
      2 * (bounds.barrierOpenClose + bounds.barrierRecovery) +
      bounds.jitter +
      bounds.acquisitionPortTotal +
      bounds.processingEntry +
      bounds.writer;
    expect(slotMax).toBe(34000);
    const waves = [0, 1, 2, 3].map((round) => [
      getQualificationRun(0, 'measurement', round, M0).releaseAtMs!,
      getQualificationRun(99, 'measurement', round, M0).releaseAtMs!,
    ]);
    expect(waves.slice(1).map((wave, i) => wave[0]! - waves[i]![1]!)).toEqual([
      79200, 124200, 34200,
    ]);
    expect(waves[3]![1]! + slotMax - M0).toBe(3559800);
    expect(M0 + H3B_DESCRIPTOR.measurementMinutes * 60000 - waves[3]![1]! - slotMax).toBe(40200);
    expect(
      createQualificationDigestSchedules(Date.parse('2026-09-07T23:59:00.000Z')).map(
        (s) => s.nextDueAt,
      ),
    ).toEqual(['2026-09-08T00:23:00.000Z', '2026-09-08T00:45:00.000Z']);
  });
});
