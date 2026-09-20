// Fixed H3b qualification data and scheduling: pure functions, no runtime capability.
import { createHash } from 'node:crypto';
import type { Source } from '../../../shared/types/sources';
import type {
  ConditionalResponseMetadata,
  DigestRunStats,
  DigestSchedule,
  FeedField,
  FeedFormat,
  FeedProjection,
  FeedProjectionValue,
  PageProjection,
  PageProjectionValue,
  WatchRule,
  WatchRunOutcome,
} from '../../../shared/types/watch';
import { computeSourceLocatorFingerprint } from '../../../shared/watch/watch-rule-state';
import {
  isValidFeedProjectionValue,
  isValidPageProjectionValue,
  sha256Hex,
} from '../../../shared/watch/diff/evidence';
import { normalizeSourceUrl } from '../../sources/domain/source-canonical';
import { computeJitterMs } from '../watch-scheduler';

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const H3B_DESCRIPTOR = freeze({
  accessCounts: { feedPublic: 40, pagePublic: 40, pageSession: 20 },
  acquisitionLatencyMs: 28000,
  conditionClass: 'index-mod-4',
  digestDueMinuteOffsets: [24, 46],
  digestPartitions: [
    [0, 49],
    [50, 99],
  ],
  digestSeedCompleteByOffsetMs: 3000,
  digestSourceIdOrder: 'utf8-byte-ascending-unique',
  documentRunOrdinal: 'per-entry-success-zero-based-three-digit',
  encoding: 'UTF-8',
  feedFormats: { atom: 20, rss2: 20 },
  filler: 'x',
  hostCount: 4,
  hostSuffix: 'aibrowse.invalid',
  idNamespace: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
  idSeed: 'urn:aibrowse:h3b:v1',
  latencyBoundsMs: {
    acquisitionPortTotal: 28000,
    barrierOpenClose: 2000,
    barrierRecovery: 250,
    jitter: 500,
    processingEntry: 500,
    sessionTabPublishDeadline: 1000,
    sessionTabReleaseOffset: 27000,
    writer: 500,
  },
  measurementMinutes: 60,
  measurementReleaseOffsetsMs: [0, 900000, 1845000, 2700000],
  measurementRounds: 4,
  projectionBytes: { feed: 32768, page: 24576, rawBody: 0 },
  ruleCount: 100,
  sampleDeadlinesMs: {
    frameToClose: 2000,
    frameToLinearize: 500,
    frameToSample: 750,
    logicalToSample: 250,
    sampleToClose: 1250,
  },
  scheduleIntervalMinutes: 15,
  scheduleOffsetMs: { first: 5000, waveSize: 4, waveSpacing: 33000 },
  setup: { batchSize: 4, batchSpacingMs: 31000, m0LeadMinutes: 24 },
  sourceIdAlgorithm: 'sha256-truncated-v4-shaped-v1',
  sourceIdDomain: 'watch-h3b-source-id-v1',
  stateByPhase: { initialization: 'A', measurement: ['B', 'A', 'B', 'A'], warmup: 'A' },
  version: 'watch-h3b-load-v1',
  warmupIndexRange: [33, 99],
  warmupMinutes: 10,
  waveReleaseSpacingMs: 34200,
} as const);

export type QualificationPhase = 'initialization' | 'warmup' | 'measurement';
export type QualificationState = 'state-A' | 'state-B';
export type QualificationConditionClass = 'unchanged' | 'changed-unmatched' | 'event';
export interface QualificationEntry {
  accessMode: 'public' | 'session';
  conditionClass: QualificationConditionClass;
  feedFormat: FeedFormat | null;
  hostKey: string;
  index: number;
  kind: 'feed' | 'page';
  projectionBytes: number;
  ruleId: string;
  scheduleOffsetMs: number;
  sourceId: string;
  targetUrl: string;
}
export interface QualificationDigest {
  dueMinuteOffset: number;
  id: string;
  index: 0 | 1;
  sourceEnd: number;
  sourceStart: number;
}
export interface QualificationManifest {
  descriptorSha256: string;
  digests: QualificationDigest[];
  entries: QualificationEntry[];
  version: typeof H3B_DESCRIPTOR.version;
}
export interface QualificationRunPlan {
  entry: QualificationEntry;
  phase: QualificationPhase;
  round: number | null;
  runOrdinal: number;
  state: QualificationState;
  m0Ms: number;
  scheduledFor: string | null;
  releaseAtMs: number | null;
  initializationOffsetMs: number | null;
  expectedOutcome: WatchRunOutcome['kind'];
  requestId: string | null;
  requestKey: string;
  jitterMs: number;
}
export interface QualificationDigestOracle {
  runStats: DigestRunStats;
  observations: number;
  events: number;
  runs: number;
}

// All canonical artifacts here contain fixed ASCII data and safe integers only.
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== 'string')) throw new Error('固定负载含非法字段');
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
        .join(',') +
      '}'
    );
  }
  throw new Error('固定负载含非法值');
}

export const H3B_DESCRIPTOR_JSON = canonical(H3B_DESCRIPTOR);
export const H3B_DESCRIPTOR_SHA256 =
  '3f59d95d74d373ef57e80eb56d05c4c9620a6e2bc2db8637ce5ddee48b5b85c3';
export const H3B_EXPANDED_SHA256 =
  '5652b57e407b728e78a090b56aa84a73bc81f6b977e8a9e6211d3a48c15b6beb';

function integer(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('固定负载序号无效');
}
function indexOf(index: number): number {
  integer(index, 0, H3B_DESCRIPTOR.ruleCount - 1);
  return index;
}
function pad3(value: number): string {
  return String(value).padStart(3, '0');
}
function iso(ms: number): string {
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > 8_640_000_000_000_000)
    throw new Error('固定负载时间无效');
  const value = new Date(ms).toISOString();
  if (value.length !== 24) throw new Error('固定负载时间超出规范范围');
  return value;
}
function validateM0(m0Ms: number): void {
  iso(m0Ms - 3_600_000);
  iso(m0Ms + 4_200_000);
  if (m0Ms % 60_000 !== 0) throw new Error('固定负载 M0 必须是 UTC 整分钟');
}
export function qualificationM0(nowMs: number): number {
  iso(nowMs);
  const m0 = Math.ceil((nowMs + H3B_DESCRIPTOR.setup.m0LeadMinutes * 60_000) / 60_000) * 60_000;
  validateM0(m0);
  return m0;
}
function uuidFromBytes(bytes: Buffer, version: 4 | 5): string {
  const result = Buffer.from(bytes.subarray(0, 16));
  result[6] = (result[6]! & 0x0f) | (version << 4);
  result[8] = (result[8]! & 0x3f) | 0x80;
  const hex = result.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
function uuid5(name: string): string {
  const namespace = Buffer.from(H3B_DESCRIPTOR.idNamespace.replaceAll('-', ''), 'hex');
  return uuidFromBytes(createHash('sha1').update(namespace).update(name, 'utf8').digest(), 5);
}
function sourceId(index: number): string {
  const seed = H3B_DESCRIPTOR.sourceIdDomain + '\0' + H3B_DESCRIPTOR.idSeed + '\0' + pad3(index);
  return uuidFromBytes(createHash('sha256').update(seed, 'utf8').digest(), 4);
}
function generateEntry(index: number): QualificationEntry {
  const kind = index < H3B_DESCRIPTOR.accessCounts.feedPublic ? 'feed' : 'page';
  const accessMode =
    index < H3B_DESCRIPTOR.accessCounts.feedPublic + H3B_DESCRIPTOR.accessCounts.pagePublic
      ? 'public'
      : 'session';
  const host = 'h' + (index % H3B_DESCRIPTOR.hostCount) + '.' + H3B_DESCRIPTOR.hostSuffix;
  const targetUrl =
    'https://' +
    host +
    '/h3b/' +
    (kind === 'feed' ? 'feed/' : accessMode === 'session' ? 'session/' : 'page/') +
    pad3(index) +
    (kind === 'feed' ? '.xml' : '');
  return {
    accessMode,
    conditionClass: index % 4 < 2 ? 'unchanged' : index % 4 === 2 ? 'changed-unmatched' : 'event',
    feedFormat: kind === 'feed' ? (index % 2 === 0 ? 'rss2' : 'atom') : null,
    hostKey: host + ':443',
    index,
    kind,
    projectionBytes: H3B_DESCRIPTOR.projectionBytes[kind],
    ruleId: uuid5(H3B_DESCRIPTOR.idSeed + ':rule:' + pad3(index)),
    scheduleOffsetMs:
      H3B_DESCRIPTOR.scheduleOffsetMs.first +
      H3B_DESCRIPTOR.scheduleOffsetMs.waveSpacing *
        Math.floor(index / H3B_DESCRIPTOR.scheduleOffsetMs.waveSize),
    sourceId: sourceId(index),
    targetUrl,
  };
}
const ENTRIES = freeze(
  Array.from({ length: H3B_DESCRIPTOR.ruleCount }, (_, index) => generateEntry(index)),
);
const DIGESTS: QualificationDigest[] = freeze(
  ([0, 1] as const).map((index) => ({
    dueMinuteOffset: H3B_DESCRIPTOR.digestDueMinuteOffsets[index],
    id: uuid5(H3B_DESCRIPTOR.idSeed + ':digest:' + pad3(index)),
    index,
    sourceEnd: H3B_DESCRIPTOR.digestPartitions[index][1],
    sourceStart: H3B_DESCRIPTOR.digestPartitions[index][0],
  })),
);
const MANIFEST: QualificationManifest = freeze({
  descriptorSha256: H3B_DESCRIPTOR_SHA256,
  digests: DIGESTS,
  entries: ENTRIES,
  version: H3B_DESCRIPTOR.version,
});
const EXPANDED_JSON = canonical(MANIFEST);
if (
  Buffer.byteLength(H3B_DESCRIPTOR_JSON) !== 1502 ||
  sha256Hex(H3B_DESCRIPTOR_JSON) !== H3B_DESCRIPTOR_SHA256 ||
  Buffer.byteLength(EXPANDED_JSON) !== 34252 ||
  sha256Hex(EXPANDED_JSON) !== H3B_EXPANDED_SHA256
) {
  throw new Error('固定负载 descriptor 或展开物校验失败');
}
export function createQualificationManifest(): QualificationManifest {
  return structuredClone(MANIFEST);
}
export function qualificationManifestJson(): string {
  return EXPANDED_JSON;
}

export function createQualificationSources(m0Ms: number): Source[] {
  validateM0(m0Ms);
  const createdAt = iso(m0Ms - 3_600_000);
  return ENTRIES.map((entry) => {
    const normalized = normalizeSourceUrl(entry.targetUrl, 'page');
    if (
      !normalized.ok ||
      normalized.canonicalKey !== entry.targetUrl ||
      normalized.displayUrl !== entry.targetUrl
    ) {
      throw new Error('固定负载 Source URL 规范化失败');
    }
    return {
      id: entry.sourceId,
      scope: 'page',
      canonicalKey: normalized.canonicalKey,
      url: normalized.displayUrl,
      name: 'H3b ' + pad3(entry.index),
      groupId: null,
      tags: [],
      priority: 3,
      enabled: true,
      shareMode: 'full',
      trust: { value: 'unknown', assertedBy: 'user', verification: 'asserted' },
      userNote: '',
      aiNote: '',
      createdBy: 'user',
      version: 1,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      lastUsedAt: null,
      lastUsageOutcome: null,
    };
  });
}
export function createQualificationRules(m0Ms: number): WatchRule[] {
  const sources = createQualificationSources(m0Ms);
  return ENTRIES.map((entry, index) => {
    const source = sources[index]!;
    const target: WatchRule['target'] =
      entry.kind === 'feed' && entry.feedFormat !== null
        ? { type: 'feed', feedUrl: entry.targetUrl, format: entry.feedFormat }
        : {
            type: 'page',
            pageUrl: entry.targetUrl,
            regions: [
              { kind: 'main-text', label: 'H3b' },
              { kind: 'headings', label: 'H3b padding', levels: [1] },
            ],
            sessionConsent:
              entry.accessMode === 'public'
                ? null
                : {
                    version: 1,
                    origin: new URL(entry.targetUrl).origin,
                    grantedAt: source.createdAt,
                  },
          };
    return {
      id: entry.ruleId,
      sourceId: entry.sourceId,
      kind: entry.kind,
      accessMode: entry.accessMode,
      schedule: { kind: 'interval', intervalMinutes: H3B_DESCRIPTOR.scheduleIntervalMinutes },
      target,
      condition:
        entry.conditionClass !== 'changed-unmatched'
          ? null
          : {
              version: 1,
              combine: 'all',
              predicates: [
                {
                  fieldKey: entry.kind === 'feed' ? 'title' : 'r0:main',
                  operator: 'equals',
                  operand: 'H3B-NEVER',
                  caseSensitive: true,
                },
              ],
            },
      version: 1,
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: true,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: source.version,
      sourceLocatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: source.id,
        scope: source.scope,
        canonicalKey: source.canonicalKey,
        kind: entry.kind,
        canonicalTargetUrl: entry.targetUrl,
      }),
      nextDueAt: null,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
    };
  });
}
export function createQualificationDigestSchedules(m0Ms: number): DigestSchedule[] {
  validateM0(m0Ms);
  return DIGESTS.map((digest) => {
    const nextDueAt = iso(m0Ms + digest.dueMinuteOffset * 60_000);
    const sourceIds = ENTRIES.slice(digest.sourceStart, digest.sourceEnd + 1)
      .map((entry) => entry.sourceId)
      .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return {
      id: digest.id,
      version: 1,
      sourceIds,
      timeZone: 'UTC',
      localTime: nextDueAt.slice(11, 16),
      aiEnabled: false,
      cursor: { changeSequence: 0 },
      state: 'active',
      nextDueAt,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      createdAt: iso(m0Ms),
      updatedAt: iso(m0Ms),
      lastCheckedAt: null,
      lastPeriod: null,
      lastRunStats: null,
    };
  });
}
export function qualificationInitialNextDueAt(index: number, m0Ms: number): string {
  validateM0(m0Ms);
  const entry = ENTRIES[indexOf(index)]!;
  return iso(
    m0Ms +
      entry.scheduleOffsetMs -
      (index >= H3B_DESCRIPTOR.warmupIndexRange[0]
        ? H3B_DESCRIPTOR.scheduleIntervalMinutes * 60_000
        : 0),
  );
}
export function getQualificationRun(
  index: number,
  phase: QualificationPhase,
  round: number | null,
  m0Ms: number,
): QualificationRunPlan {
  validateM0(m0Ms);
  const entry = ENTRIES[indexOf(index)]!;
  if (phase !== 'initialization' && phase !== 'warmup' && phase !== 'measurement')
    throw new Error('固定负载阶段无效');
  if (phase === 'measurement') {
    if (round === null) throw new Error('固定负载轮次缺失');
    integer(round, 0, H3B_DESCRIPTOR.measurementRounds - 1);
  } else if (round !== null || (phase === 'warmup' && index < H3B_DESCRIPTOR.warmupIndexRange[0])) {
    throw new Error('固定负载阶段与轮次不匹配');
  }
  const measurementRound = round ?? 0;
  const scheduledFor =
    phase === 'initialization'
      ? null
      : iso(
          m0Ms +
            entry.scheduleOffsetMs +
            H3B_DESCRIPTOR.scheduleIntervalMinutes *
              60_000 *
              (phase === 'warmup' ? -1 : measurementRound),
        );
  const wave = Math.floor(index / H3B_DESCRIPTOR.scheduleOffsetMs.waveSize);
  const warmupWave =
    wave -
    Math.floor(H3B_DESCRIPTOR.warmupIndexRange[0] / H3B_DESCRIPTOR.scheduleOffsetMs.waveSize);
  const releaseAtMs =
    phase === 'initialization'
      ? null
      : phase === 'warmup'
        ? m0Ms -
          H3B_DESCRIPTOR.warmupMinutes * 60_000 +
          warmupWave * H3B_DESCRIPTOR.waveReleaseSpacingMs
        : m0Ms +
          H3B_DESCRIPTOR.scheduleOffsetMs.first +
          wave * H3B_DESCRIPTOR.waveReleaseSpacingMs +
          H3B_DESCRIPTOR.measurementReleaseOffsetsMs[measurementRound]!;
  const state: QualificationState =
    phase === 'measurement' && entry.conditionClass !== 'unchanged'
      ? H3B_DESCRIPTOR.stateByPhase.measurement[measurementRound] === 'B'
        ? 'state-B'
        : 'state-A'
      : 'state-A';
  const expectedOutcome: WatchRunOutcome['kind'] =
    phase === 'initialization'
      ? 'baseline-established'
      : phase === 'warmup' || entry.conditionClass === 'unchanged'
        ? 'unchanged'
        : entry.conditionClass === 'changed-unmatched'
          ? 'changed-unmatched'
          : measurementRound % 2 === 0
            ? 'event-created'
            : 'event-coalesced';
  const requestId = phase === 'initialization' ? 'watch-h3b-init-v1:' + pad3(index) : null;
  const requestKey = requestId ?? entry.ruleId + '|' + scheduledFor;
  return {
    entry: structuredClone(entry),
    phase,
    round,
    runOrdinal:
      phase === 'initialization'
        ? 0
        : phase === 'warmup'
          ? 1
          : measurementRound + 1 + (index >= H3B_DESCRIPTOR.warmupIndexRange[0] ? 1 : 0),
    state,
    m0Ms,
    scheduledFor,
    releaseAtMs,
    initializationOffsetMs:
      phase === 'initialization'
        ? Math.floor(index / H3B_DESCRIPTOR.setup.batchSize) * H3B_DESCRIPTOR.setup.batchSpacingMs
        : null,
    expectedOutcome,
    requestId,
    requestKey,
    jitterMs: computeJitterMs({
      ruleId: entry.ruleId,
      hostKey: entry.hostKey,
      seed: scheduledFor ?? requestKey,
    }),
  };
}
export function createQualificationRuns(m0Ms: number): QualificationRunPlan[] {
  const runs = ENTRIES.map((entry) =>
    getQualificationRun(entry.index, 'initialization', null, m0Ms),
  );
  for (
    let index = H3B_DESCRIPTOR.warmupIndexRange[0];
    index <= H3B_DESCRIPTOR.warmupIndexRange[1];
    index++
  )
    runs.push(getQualificationRun(index, 'warmup', null, m0Ms));
  for (let round = 0; round < H3B_DESCRIPTOR.measurementRounds; round++) {
    for (const entry of ENTRIES)
      runs.push(getQualificationRun(entry.index, 'measurement', round, m0Ms));
  }
  return runs;
}
export function qualificationDocumentId(index: number, runOrdinal: number): string | null {
  indexOf(index);
  integer(
    runOrdinal,
    0,
    H3B_DESCRIPTOR.measurementRounds + (index >= H3B_DESCRIPTOR.warmupIndexRange[0] ? 1 : 0),
  );
  return ENTRIES[index]!.kind === 'feed'
    ? null
    : uuid5(H3B_DESCRIPTOR.idSeed + ':document:' + pad3(index) + ':' + pad3(runOrdinal));
}
function field(text: string): FeedField {
  return {
    text,
    truncated: false,
    originalBytes: Buffer.byteLength(text, 'utf8'),
    valueHash: sha256Hex(text),
  };
}
function projectionValue(
  entry: QualificationEntry,
  state: QualificationState,
  filler: string,
): FeedProjectionValue | PageProjectionValue {
  if (entry.kind === 'feed' && entry.feedFormat !== null) {
    return {
      type: 'feed',
      format: entry.feedFormat,
      title: field('H3b'),
      description: field(''),
      siteUrl: field(entry.targetUrl),
      feedUrl: field(entry.targetUrl),
      items: [
        {
          identity: 'urn:aibrowse:h3b:item:' + pad3(entry.index),
          identityKind: 'id',
          title: field(state),
          link: field(entry.targetUrl + '#item'),
          summary: field(filler),
          publishedAt: null,
          updatedAt: null,
          author: field(''),
        },
      ],
      itemsTruncated: false,
    };
  }
  return {
    type: 'page',
    fields: [
      { fieldKey: 'r0:main', regionIndex: 0, kind: 'main-text', label: 'H3b', value: state },
      {
        fieldKey: 'r1:heading:1',
        regionIndex: 1,
        kind: 'heading',
        label: 'H3b padding',
        level: 1,
        ordinal: 0,
        value: filler,
      },
    ],
  };
}
function filledProjectionValue(
  entry: QualificationEntry,
  state: QualificationState,
): FeedProjectionValue | PageProjectionValue {
  const emptyBytes = Buffer.byteLength(JSON.stringify(projectionValue(entry, state, '')), 'utf8');
  // For ASCII x, only text bytes and originalBytes digit width vary; hash width is constant.
  // This monotone scan is byte-equivalent to stringifying every candidate from zero.
  let length = 0;
  for (; length <= entry.projectionBytes; length++) {
    const bytes = emptyBytes + length + (entry.kind === 'feed' ? String(length).length - 1 : 0);
    if (bytes >= entry.projectionBytes) {
      if (bytes !== entry.projectionBytes) throw new Error('固定投影不存在精确填充值');
      break;
    }
  }
  const value = projectionValue(entry, state, H3B_DESCRIPTOR.filler.repeat(length));
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') !== entry.projectionBytes)
    throw new Error('固定投影字节数不符');
  if (
    value.type === 'feed' ? !isValidFeedProjectionValue(value) : !isValidPageProjectionValue(value)
  ) {
    throw new Error('固定投影未通过产品校验');
  }
  return value;
}
export function createQualificationProjection(
  plan: QualificationRunPlan,
  capturedAt: string,
): FeedProjection | PageProjection {
  if (
    canonical(plan) !==
    canonical(getQualificationRun(plan.entry.index, plan.phase, plan.round, plan.m0Ms))
  )
    throw new Error('固定采集计划不匹配');
  if (iso(Date.parse(capturedAt)) !== capturedAt) throw new Error('固定投影采集时间非规范');
  const value = filledProjectionValue(plan.entry, plan.state);
  const json = JSON.stringify(value);
  const envelope = {
    schemaVersion: 1 as const,
    ruleId: plan.entry.ruleId,
    sourceId: plan.entry.sourceId,
    finalUrl: plan.entry.targetUrl,
    capturedAt,
    documentId: qualificationDocumentId(plan.entry.index, plan.runOrdinal),
    contentHash: sha256Hex(json),
    byteLength: Buffer.byteLength(json, 'utf8'),
  };
  return value.type === 'feed' ? { ...envelope, value } : { ...envelope, value };
}
export function qualificationResponseMetadata(index: number): ConditionalResponseMetadata | null {
  return ENTRIES[indexOf(index)]!.kind === 'feed'
    ? { httpStatus: 200, etag: null, lastModified: null, warnings: [] }
    : null;
}
export function getQualificationDigestOracle(index: 0 | 1): QualificationDigestOracle {
  integer(index, 0, DIGESTS.length - 1);
  const digest = DIGESTS[index]!;
  const runStats: DigestRunStats = { changed: 0, unchanged: 0, failed: 0 };
  let observations = 0,
    events = 0,
    runs = 0;
  for (const plan of createQualificationRuns(0)) {
    if (
      plan.phase !== 'measurement' ||
      plan.entry.index < digest.sourceStart ||
      plan.entry.index > digest.sourceEnd ||
      plan.releaseAtMs === null ||
      plan.releaseAtMs + coordinatorSlotMaxMs() > digest.dueMinuteOffset * 60_000
    )
      continue;
    runs++;
    if (plan.expectedOutcome === 'unchanged') runStats.unchanged++;
    else {
      runStats.changed++;
      if (plan.expectedOutcome === 'event-created' || plan.expectedOutcome === 'event-coalesced')
        observations++;
      if (plan.expectedOutcome === 'event-created') events++;
    }
  }
  return { runStats, observations, events, runs };
}

function coordinatorSlotMaxMs(): number {
  const bounds = H3B_DESCRIPTOR.latencyBoundsMs;
  return (
    2 * (bounds.barrierOpenClose + bounds.barrierRecovery) +
    bounds.jitter +
    bounds.acquisitionPortTotal +
    bounds.processingEntry +
    bounds.writer
  );
}
export function getQualificationLoadOracle(): {
  runPairs: number;
  taskTabs: number;
  perHost: number[];
  initializationRuns: number;
  warmupRuns: number;
  measurementRuns: number;
} {
  const runs = createQualificationRuns(0);
  return {
    runPairs: runs.length,
    taskTabs: runs.filter((run) => run.entry.accessMode === 'session').length,
    perHost: Array.from(
      { length: H3B_DESCRIPTOR.hostCount },
      (_, index) =>
        runs.filter((run) => run.entry.index % H3B_DESCRIPTOR.hostCount === index).length,
    ),
    initializationRuns: runs.filter((run) => run.phase === 'initialization').length,
    warmupRuns: runs.filter((run) => run.phase === 'warmup').length,
    measurementRuns: runs.filter((run) => run.phase === 'measurement').length,
  };
}
