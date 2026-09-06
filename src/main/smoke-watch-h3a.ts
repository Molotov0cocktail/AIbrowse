import { createHash } from 'node:crypto';

export type H3aScenarioKind = 'rss-or-atom' | 'public-page-no-feed' | 'network-failure';

export interface H3aCandidate {
  id: string;
  url: string;
  maxRequests: number;
}

export interface H3aScenario {
  id: string;
  kind: H3aScenarioKind;
  candidates: readonly H3aCandidate[];
}

export interface H3aManifest {
  version: 'h3a-public-product-v1';
  totalMaxRequests: 64;
  scenarios: readonly H3aScenario[];
}

export const H3A_MANIFEST: H3aManifest = {
  version: 'h3a-public-product-v1',
  totalMaxRequests: 64,
  scenarios: [
    {
      id: 'h3a-rss',
      kind: 'rss-or-atom',
      candidates: [
        {
          id: 'rss-primary',
          url: 'https://feeds.bbci.co.uk/news/rss.xml',
          maxRequests: 12,
        },
        { id: 'rss-fallback', url: 'https://www.nasa.gov/feed/', maxRequests: 12 },
      ],
    },
    {
      id: 'h3a-page',
      kind: 'public-page-no-feed',
      candidates: [
        { id: 'page-primary', url: 'https://example.com/', maxRequests: 12 },
        { id: 'page-fallback', url: 'https://example.org/', maxRequests: 12 },
      ],
    },
    {
      id: 'h3a-failure',
      kind: 'network-failure',
      candidates: [
        { id: 'failure-primary', url: 'https://httpbin.org/status/503', maxRequests: 8 },
        { id: 'failure-fallback', url: 'https://httpbingo.org/status/503', maxRequests: 8 },
      ],
    },
  ],
};

/** Frozen SHA-256 of JSON.stringify(H3A_MANIFEST); persistence must use those exact bytes. */
export const H3A_MANIFEST_CONTENT_HASH =
  '2ec5b548f7a2ff9c4aa47fe59f4730dbfaa9879f5be7369dfce271dc6fd912f0';

export function canonicalH3aManifest(manifest: H3aManifest = H3A_MANIFEST): string {
  return JSON.stringify(manifest);
}

export function hashH3aManifest(manifest: H3aManifest = H3A_MANIFEST): string {
  return createHash('sha256').update(canonicalH3aManifest(manifest), 'utf8').digest('hex');
}

export function validateH3aManifest(manifest: H3aManifest = H3A_MANIFEST): string[] {
  const errors: string[] = [];
  if (manifest.version !== 'h3a-public-product-v1') errors.push('manifest version 非冻结值');
  if (manifest.totalMaxRequests !== 64) errors.push('manifest 总请求预算必须为 64');
  if (manifest.scenarios.length !== 3) errors.push('manifest 必须恰有三个场景');
  const expected = [
    {
      id: 'h3a-rss',
      kind: 'rss-or-atom',
      candidates: [
        ['rss-primary', 'https://feeds.bbci.co.uk/news/rss.xml', 12],
        ['rss-fallback', 'https://www.nasa.gov/feed/', 12],
      ],
    },
    {
      id: 'h3a-page',
      kind: 'public-page-no-feed',
      candidates: [
        ['page-primary', 'https://example.com/', 12],
        ['page-fallback', 'https://example.org/', 12],
      ],
    },
    {
      id: 'h3a-failure',
      kind: 'network-failure',
      candidates: [
        ['failure-primary', 'https://httpbin.org/status/503', 8],
        ['failure-fallback', 'https://httpbingo.org/status/503', 8],
      ],
    },
  ] as const;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = manifest.scenarios[index];
    const wanted = expected[index]!;
    if (actual === undefined || actual.id !== wanted.id || actual.kind !== wanted.kind) {
      errors.push(`manifest 场景 ${index} 身份或类别漂移`);
      continue;
    }
    if (actual.candidates.length !== 2) {
      errors.push(`${wanted.id} 必须恰有主目标和唯一替补`);
      continue;
    }
    for (let candidateIndex = 0; candidateIndex < wanted.candidates.length; candidateIndex += 1) {
      const actualCandidate = actual.candidates[candidateIndex];
      const [id, url, maxRequests] = wanted.candidates[candidateIndex]!;
      if (
        actualCandidate === undefined ||
        actualCandidate.id !== id ||
        actualCandidate.url !== url ||
        actualCandidate.maxRequests !== maxRequests
      ) {
        errors.push(`${wanted.id} 候选 ${candidateIndex} 内容漂移`);
      }
    }
  }
  if (hashH3aManifest(manifest) !== H3A_MANIFEST_CONTENT_HASH) {
    errors.push('manifest 内容 hash 与冻结值不一致');
  }
  return errors;
}

export interface H3aRequestLedgerEntry {
  scenarioId: string;
  candidateId: string;
  phase: 'first' | 'second';
  ordinal: number;
  totalOrdinal: number;
  purposeClass: 'robots' | 'target';
  conditionalRequest: boolean;
  hostClass: string;
  startedAt: string;
  statusCode: number | null;
  errorCode: string | null;
  requestClosed: boolean;
  responseClosed: boolean;
}

export interface H3aRunEvidence {
  runId: string;
  status: 'finished';
  outcomeKind: string;
  healthCode: string | null;
  httpStatus: number | null;
  validatorsPresent: boolean;
}

export interface H3aCandidateEvidence {
  candidateId: string;
  attempted: boolean;
  result: 'pass' | 'site-failure' | 'product-defect' | 'not-needed';
  startedAt: string | null;
  finishedAt: string | null;
  sourceReadback: {
    status: 'ok';
    sourceId: string;
    ruleId: string;
    rowVersion: number;
    enabled: boolean;
    locatorFingerprintMatched: boolean;
  } | null;
  baselineBeforeVersion: number | null;
  baselineAfterFirstVersion: number | null;
  baselineAfterSecondVersion: number | null;
  baselineAfterFirstValidatorsPresent: boolean | null;
  baselineAfterSecondValidatorsPresent: boolean | null;
  baselineContentChangedOnSecond: boolean | null;
  firstRun: H3aRunEvidence | null;
  secondRun: H3aRunEvidence | null;
  eventCount: number;
  typedEvidenceCount: number;
  typedEvidenceKinds: string[];
  auditReasonCodes: string[];
  notificationCount: number;
  noFeedCandidateCount: number | null;
  backoffUntil: string | null;
  requestCount: number;
  failureCode: string | null;
}

export interface H3aScenarioEvidence {
  scenarioId: string;
  kind: H3aScenarioKind;
  result: 'pass' | 'failed';
  selectedCandidateId: string | null;
  candidates: H3aCandidateEvidence[];
}

export interface H3aReport {
  schemaVersion: 1;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  mode: 'production-preview';
  startedAt: string;
  finishedAt: string;
  fatalErrorCode: string | null;
  scenarios: H3aScenarioEvidence[];
  requests: {
    beforeCount: number;
    campaignCount: number;
    actualCount: number;
    rejectedCount: number;
    entries: H3aRequestLedgerEntry[];
  };
  cleanup: {
    coordinatorActive: number;
    coordinatorPending: number;
    schedulerStopped: boolean;
    hostGateEntries: number;
    openRequests: number;
    openResponses: number;
    robotsCleared: boolean;
    watchRepositoryClosed: boolean;
    sourceServiceClosed: boolean;
    rootRemoved: boolean;
    idempotentDispose: boolean;
    errorCodes: string[];
  };
}

function isCanonicalUtc(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validateSuccessfulSecondRun(candidate: H3aCandidateEvidence, errors: string[]): void {
  const outcome = candidate.secondRun?.outcomeKind;
  if (outcome === 'unchanged') {
    if (
      candidate.baselineAfterFirstVersion !== candidate.baselineAfterSecondVersion ||
      candidate.baselineContentChangedOnSecond !== false ||
      candidate.eventCount !== 0 ||
      !candidate.auditReasonCodes.includes('unchanged')
    ) {
      errors.push(`${candidate.candidateId} unchanged 未保持 Baseline/Event 不变量`);
    }
    return;
  }
  if (outcome !== 'event-created') {
    errors.push(`${candidate.candidateId} 第二次运行不是合法 unchanged/变化终态`);
    return;
  }
  if (candidate.eventCount < 1 || candidate.typedEvidenceCount < 1) {
    errors.push(`${candidate.candidateId} 变化终态缺少 Event 或 typed old/new Evidence`);
  }
  if (
    candidate.baselineAfterFirstVersion === null ||
    candidate.baselineAfterSecondVersion !== candidate.baselineAfterFirstVersion + 1 ||
    candidate.baselineContentChangedOnSecond !== true ||
    !candidate.auditReasonCodes.includes(outcome)
  ) {
    errors.push(`${candidate.candidateId} 变化终态未同事务推进 Baseline 或缺少对应 audit`);
  }
  if (
    candidate.typedEvidenceKinds.some(
      (kind) =>
        kind !== 'present->present' && kind !== 'present->absent' && kind !== 'absent->present',
    )
  ) {
    errors.push(`${candidate.candidateId} Evidence old/new 类型不在闭合集`);
  }
}

export function validateH3aReport(report: H3aReport): string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push('report schemaVersion 非 1');
  if (!/^[0-9a-f]{40}$/.test(report.candidateSha)) errors.push('candidate SHA 非 40 位小写 hex');
  if (!/^[0-9a-f]{64}$/.test(report.buildHash)) errors.push('build hash 非 64 位小写 hex');
  if (report.manifestHash !== H3A_MANIFEST_CONTENT_HASH) errors.push('report manifest hash 不匹配');
  if (report.mode !== 'production-preview')
    errors.push('H3a 真实 campaign 必须来自 production preview');
  if (!isCanonicalUtc(report.startedAt) || !isCanonicalUtc(report.finishedAt)) {
    errors.push('campaign UTC 时间戳不规范');
  }
  if (report.fatalErrorCode !== null) errors.push(`campaign fatal：${report.fatalErrorCode}`);
  if (
    report.scenarios.length !== 3 ||
    report.scenarios.some((scenario) => scenario.result !== 'pass')
  ) {
    errors.push('三类真实产品场景必须各有一个合格结果');
  }
  for (const scenario of report.scenarios) {
    const frozenScenario = H3A_MANIFEST.scenarios.find((item) => item.id === scenario.scenarioId);
    if (
      frozenScenario === undefined ||
      frozenScenario.kind !== scenario.kind ||
      scenario.candidates.length !== frozenScenario.candidates.length ||
      scenario.candidates.some(
        (candidate, index) => candidate.candidateId !== frozenScenario.candidates[index]?.id,
      )
    ) {
      errors.push(`${scenario.scenarioId} 场景或候选顺序不符合冻结 manifest`);
      continue;
    }
    for (const candidate of scenario.candidates) {
      if (
        (candidate.attempted &&
          (candidate.startedAt === null ||
            candidate.finishedAt === null ||
            !isCanonicalUtc(candidate.startedAt) ||
            !isCanonicalUtc(candidate.finishedAt))) ||
        (!candidate.attempted && (candidate.startedAt !== null || candidate.finishedAt !== null)) ||
        !Number.isSafeInteger(candidate.requestCount) ||
        candidate.requestCount < 0 ||
        !Number.isSafeInteger(candidate.eventCount) ||
        candidate.eventCount < 0 ||
        !Number.isSafeInteger(candidate.typedEvidenceCount) ||
        candidate.typedEvidenceCount < 0 ||
        !Number.isSafeInteger(candidate.notificationCount) ||
        candidate.notificationCount < 0
      ) {
        errors.push(`${candidate.candidateId} 候选时间或计数证据非法`);
      }
    }
    const selected = scenario.candidates.find(
      (candidate) => candidate.candidateId === scenario.selectedCandidateId,
    );
    if (selected === undefined || selected.result !== 'pass') {
      errors.push(`${scenario.scenarioId} 缺少唯一通过候选`);
      continue;
    }
    const selectedIndex = scenario.candidates.indexOf(selected);
    if (
      !selected.attempted ||
      scenario.candidates
        .slice(0, selectedIndex)
        .some((candidate) => !candidate.attempted || candidate.result !== 'site-failure') ||
      scenario.candidates
        .slice(selectedIndex + 1)
        .some((candidate) => candidate.attempted || candidate.result !== 'not-needed')
    ) {
      errors.push(`${scenario.scenarioId} 主目标/唯一替补执行顺序不合法`);
    }
    if (
      selected.sourceReadback === null ||
      !isUuid(selected.sourceReadback.sourceId) ||
      !isUuid(selected.sourceReadback.ruleId) ||
      selected.sourceReadback.rowVersion < 1 ||
      !selected.sourceReadback.enabled ||
      !selected.sourceReadback.locatorFingerprintMatched ||
      selected.baselineBeforeVersion !== null ||
      selected.notificationCount !== 0 ||
      selected.requestCount < 1
    ) {
      errors.push(`${selected.candidateId} 未证明真实 Source 身份、初始状态或物理请求`);
    }
    if (scenario.kind === 'rss-or-atom' || scenario.kind === 'public-page-no-feed') {
      if (
        selected.firstRun?.outcomeKind !== 'baseline-established' ||
        selected.baselineAfterFirstVersion !== 1 ||
        !selected.auditReasonCodes.includes('baseline-established')
      ) {
        errors.push(
          `${selected.candidateId} 未证明 Source→Coordinator→Processing 首次 Baseline 全链路`,
        );
      }
      validateSuccessfulSecondRun(selected, errors);
    }
    if (scenario.kind === 'public-page-no-feed' && selected.noFeedCandidateCount !== 0) {
      errors.push(`${selected.candidateId} 未证明实际页面无 feed discovery 候选`);
    }
    if (
      scenario.kind === 'public-page-no-feed' &&
      (selected.baselineAfterFirstValidatorsPresent !== false ||
        selected.baselineAfterSecondValidatorsPresent !== false)
    ) {
      errors.push(`${selected.candidateId} Page Baseline validator 未保持 null`);
    }
    if (scenario.kind === 'network-failure') {
      const actualFailureTransport = report.requests.entries.some(
        (entry) =>
          entry.totalOrdinal > report.requests.beforeCount &&
          entry.candidateId === selected.candidateId &&
          entry.purposeClass === 'target' &&
          (entry.statusCode === 503 || entry.errorCode !== null),
      );
      if (
        selected.firstRun?.outcomeKind !== 'failed' ||
        selected.firstRun.healthCode !== 'unavailable' ||
        selected.secondRun !== null ||
        selected.baselineAfterFirstVersion !== null ||
        selected.baselineAfterSecondVersion !== null ||
        selected.eventCount !== 0 ||
        selected.typedEvidenceCount !== 0 ||
        selected.notificationCount !== 0 ||
        selected.backoffUntil === null ||
        !isCanonicalUtc(selected.backoffUntil) ||
        !actualFailureTransport
      ) {
        errors.push(`${selected.candidateId} 未证明真实失败分类、退避、Baseline/Event 不变量`);
      }
    }
  }
  const requestLimits = new Map(
    H3A_MANIFEST.scenarios.flatMap((scenario) =>
      scenario.candidates.map((candidate) => [candidate.id, candidate.maxRequests] as const),
    ),
  );
  if (
    !Number.isSafeInteger(report.requests.beforeCount) ||
    report.requests.beforeCount < 0 ||
    report.requests.beforeCount > report.requests.actualCount ||
    !Number.isSafeInteger(report.requests.campaignCount) ||
    report.requests.campaignCount < 1 ||
    report.requests.campaignCount !== report.requests.actualCount - report.requests.beforeCount ||
    !Number.isSafeInteger(report.requests.actualCount) ||
    report.requests.actualCount < 1 ||
    report.requests.actualCount > H3A_MANIFEST.totalMaxRequests ||
    report.requests.actualCount !== report.requests.entries.length
  ) {
    errors.push('实际物理请求总数非法或与 ledger 不一致');
  }
  if (report.requests.rejectedCount !== 0) errors.push('campaign 发生请求预算拒绝');
  const perCandidate = new Map<string, number>();
  for (let entryIndex = 0; entryIndex < report.requests.entries.length; entryIndex += 1) {
    const entry = report.requests.entries[entryIndex]!;
    const candidateOrdinal = (perCandidate.get(entry.candidateId) ?? 0) + 1;
    perCandidate.set(entry.candidateId, candidateOrdinal);
    if (
      entry.ordinal !== candidateOrdinal ||
      entry.totalOrdinal !== entryIndex + 1 ||
      !entry.requestClosed ||
      (entry.statusCode !== null && !entry.responseClosed)
    ) {
      errors.push(`${entry.candidateId} 存在未闭合 request/response`);
    }
    if (!isCanonicalUtc(entry.startedAt))
      errors.push(`${entry.candidateId} request UTC 非 canonical`);
    const scenario = H3A_MANIFEST.scenarios.find((item) => item.id === entry.scenarioId);
    if (
      scenario === undefined ||
      !scenario.candidates.some((candidate) => candidate.id === entry.candidateId) ||
      entry.hostClass !== entry.candidateId ||
      (entry.phase !== 'first' && entry.phase !== 'second') ||
      (entry.purposeClass !== 'robots' && entry.purposeClass !== 'target') ||
      typeof entry.conditionalRequest !== 'boolean' ||
      (entry.statusCode !== null &&
        (!Number.isSafeInteger(entry.statusCode) ||
          entry.statusCode < 100 ||
          entry.statusCode > 599)) ||
      (entry.errorCode !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(entry.errorCode))
    ) {
      errors.push(`${entry.candidateId} request ledger 身份或枚举非法`);
    }
  }
  for (const [candidateId, count] of perCandidate) {
    const limit = requestLimits.get(candidateId);
    if (limit === undefined || count > limit) errors.push(`${candidateId} 超出逐候选请求预算`);
  }
  for (const scenario of report.scenarios) {
    const selected = scenario.candidates.find(
      (candidate) => candidate.candidateId === scenario.selectedCandidateId,
    );
    if (selected === undefined) continue;
    const campaignEntries = report.requests.entries.filter(
      (entry) => entry.totalOrdinal > report.requests.beforeCount,
    );
    const candidateEntries = campaignEntries.filter(
      (entry) => entry.candidateId === selected.candidateId,
    );
    for (const candidate of scenario.candidates) {
      const actualCandidateCount = campaignEntries.filter(
        (entry) => entry.candidateId === candidate.candidateId,
      ).length;
      if (candidate.requestCount !== actualCandidateCount) {
        errors.push(`${candidate.candidateId} requestCount 与累计 ledger 不一致`);
      }
    }
    if (scenario.kind === 'rss-or-atom') {
      if (
        selected.firstRun?.httpStatus !== 200 ||
        (selected.secondRun?.httpStatus !== 200 && selected.secondRun?.httpStatus !== 304) ||
        selected.baselineAfterFirstValidatorsPresent !== true ||
        selected.baselineAfterSecondValidatorsPresent !== true ||
        !candidateEntries.some(
          (entry) =>
            entry.phase === 'second' && entry.purposeClass === 'target' && entry.conditionalRequest,
        )
      ) {
        errors.push(`${selected.candidateId} 未证明 Feed 200→条件 200/304 产品链`);
      }
    }
    if (scenario.kind === 'public-page-no-feed') {
      if (
        selected.firstRun?.httpStatus !== 200 ||
        selected.secondRun?.httpStatus !== 200 ||
        candidateEntries.some(
          (entry) => entry.purposeClass === 'target' && entry.conditionalRequest,
        )
      ) {
        errors.push(`${selected.candidateId} Page HTTP 终态或零条件请求事实非法`);
      }
    }
  }
  if (
    report.cleanup.coordinatorActive !== 0 ||
    report.cleanup.coordinatorPending !== 0 ||
    !report.cleanup.schedulerStopped ||
    report.cleanup.hostGateEntries !== 0 ||
    report.cleanup.openRequests !== 0 ||
    report.cleanup.openResponses !== 0 ||
    !report.cleanup.robotsCleared ||
    !report.cleanup.watchRepositoryClosed ||
    !report.cleanup.sourceServiceClosed ||
    !report.cleanup.rootRemoved ||
    !report.cleanup.idempotentDispose ||
    report.cleanup.errorCodes.length !== 0
  ) {
    errors.push('campaign cleanup 未完全闭合');
  }
  return errors;
}
