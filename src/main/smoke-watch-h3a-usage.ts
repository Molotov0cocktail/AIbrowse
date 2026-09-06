import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalH3aManifest, H3A_MANIFEST, H3A_MANIFEST_CONTENT_HASH } from './smoke-watch-h3a';

export interface H3aHistoricalUsageSource {
  id: string;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  ledgerPath: string;
  ledgerHash: string;
  reportPath: string;
  reportHash: string;
  processPath: string;
  processHash: string;
  manifestPath: string;
}

export interface H3aHistoricalUsageReceipt {
  id: string;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  ledgerHash: string;
  reportHash: string;
  processHash: string;
  actualCount: number;
  rejectedCount: number;
  perCandidateCounts: Record<string, number>;
}

export interface H3aWorkflowUsageEntry {
  candidateSha: string;
  buildHash: string;
  scenarioId: string;
  candidateId: string;
  phase: 'first' | 'second';
  ordinal: number;
  totalOrdinal: number;
  purposeClass: 'robots' | 'target';
  startedAt: string;
  sourceReceiptId: string | null;
}

export interface H3aWorkflowUsageSnapshot {
  schemaVersion: 1;
  manifestHash: string;
  totalMaxRequests: 64;
  actualCount: number;
  rejectedCount: number;
  perCandidateCounts: Record<string, number>;
  receipts: H3aHistoricalUsageReceipt[];
  entries: H3aWorkflowUsageEntry[];
}

interface HistoricalRequestEntry {
  scenarioId: string;
  candidateId: string;
  phase: 'first' | 'second';
  ordinal: number;
  totalOrdinal: number;
  purposeClass: 'robots' | 'target';
  startedAt: string;
}

interface ImportedHistory {
  receipt: H3aHistoricalUsageReceipt;
  entries: HistoricalRequestEntry[];
}

const WORKFLOW_LEDGER_FILE = 'usage-ledger.json';

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isHistoricalProcessUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3,7})(?:Z|\+00:00)$/,
  );
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction!.slice(0, 3));
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, millisecond);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second &&
    parsed.getUTCMilliseconds() === millisecond
  );
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertEvidenceFile(path: string, expectedHash: string, label: string): Buffer {
  const resolved = resolve(path);
  if (!isAbsolute(path) || !existsSync(resolved)) {
    throw new Error(`H3a 历史 ${label} 文件缺失`);
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`H3a 历史 ${label} 文件类型非法`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || fileHash(resolved) !== expectedHash) {
    throw new Error(`H3a 历史 ${label} hash 不匹配`);
  }
  return readFileSync(resolved);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`H3a 历史 ${label} 无法解析`);
  }
}

function emptyCandidateCounts(): Record<string, number> {
  return Object.fromEntries(
    H3A_MANIFEST.scenarios.flatMap((scenario) =>
      scenario.candidates.map((candidate) => [candidate.id, 0] as const),
    ),
  );
}

function validateCandidateCounts(value: unknown): value is Record<string, number> {
  const record = asRecord(value);
  if (record === null || !hasExactOwnKeys(record, Object.keys(emptyCandidateCounts())))
    return false;
  return Object.values(record).every(
    (count) => Number.isSafeInteger(count) && typeof count === 'number' && count >= 0,
  );
}

function frozenCandidate(candidateId: string): { scenarioId: string; maxRequests: number } | null {
  for (const scenario of H3A_MANIFEST.scenarios) {
    const candidate = scenario.candidates.find((item) => item.id === candidateId);
    if (candidate !== undefined)
      return { scenarioId: scenario.id, maxRequests: candidate.maxRequests };
  }
  return null;
}

function importHistoricalSource(source: H3aHistoricalUsageSource): ImportedHistory {
  if (
    !hasExactOwnKeys(source, [
      'id',
      'candidateSha',
      'buildHash',
      'manifestHash',
      'ledgerPath',
      'ledgerHash',
      'reportPath',
      'reportHash',
      'processPath',
      'processHash',
      'manifestPath',
    ]) ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(source.id) ||
    !/^[0-9a-f]{40}$/.test(source.candidateSha) ||
    !/^[0-9a-f]{64}$/.test(source.buildHash) ||
    source.manifestHash !== H3A_MANIFEST_CONTENT_HASH
  ) {
    throw new Error('H3a 历史 usage source 元数据非法');
  }
  const manifestBytes = assertEvidenceFile(source.manifestPath, source.manifestHash, 'manifest');
  if (manifestBytes.toString('utf8') !== canonicalH3aManifest()) {
    throw new Error('H3a 历史 manifest 内容不等于冻结值');
  }
  const ledger = asRecord(
    parseJson(assertEvidenceFile(source.ledgerPath, source.ledgerHash, 'ledger'), 'ledger'),
  );
  const reportWrapper = asRecord(
    parseJson(assertEvidenceFile(source.reportPath, source.reportHash, 'report'), 'report'),
  );
  const processRecord = asRecord(
    parseJson(assertEvidenceFile(source.processPath, source.processHash, 'process'), 'process'),
  );
  if (ledger === null || reportWrapper === null || processRecord === null) {
    throw new Error('H3a 历史 usage receipt 顶层类型非法');
  }
  if (
    !hasExactOwnKeys(ledger, [
      'schemaVersion',
      'candidateSha',
      'buildHash',
      'manifestHash',
      'actualCount',
      'rejectedCount',
      'entries',
    ]) ||
    ledger['schemaVersion'] !== 1 ||
    ledger['candidateSha'] !== source.candidateSha ||
    ledger['buildHash'] !== source.buildHash ||
    ledger['manifestHash'] !== source.manifestHash ||
    !Number.isSafeInteger(ledger['actualCount']) ||
    typeof ledger['actualCount'] !== 'number' ||
    ledger['actualCount'] < 0 ||
    !Number.isSafeInteger(ledger['rejectedCount']) ||
    typeof ledger['rejectedCount'] !== 'number' ||
    ledger['rejectedCount'] < 0 ||
    !Array.isArray(ledger['entries']) ||
    ledger['entries'].length !== ledger['actualCount']
  ) {
    throw new Error('H3a 历史 ledger 元数据或计数矛盾');
  }
  const entries: HistoricalRequestEntry[] = [];
  const perCandidateCounts = emptyCandidateCounts();
  for (let index = 0; index < ledger['entries'].length; index += 1) {
    const entry = asRecord(ledger['entries'][index]);
    if (entry === null) throw new Error('H3a 历史 ledger entry 类型非法');
    const candidateId = entry['candidateId'];
    const scenarioId = entry['scenarioId'];
    if (typeof candidateId !== 'string') throw new Error('H3a 历史 ledger candidate 非字符串');
    const candidate = frozenCandidate(candidateId);
    const count = candidate === null ? 0 : perCandidateCounts[candidateId]! + 1;
    if (
      !hasExactOwnKeys(entry, [
        'scenarioId',
        'candidateId',
        'phase',
        'ordinal',
        'totalOrdinal',
        'purposeClass',
        'conditionalRequest',
        'hostClass',
        'startedAt',
        'statusCode',
        'errorCode',
        'requestClosed',
        'responseClosed',
      ]) ||
      candidate === null ||
      scenarioId !== candidate.scenarioId ||
      (entry['phase'] !== 'first' && entry['phase'] !== 'second') ||
      (entry['purposeClass'] !== 'robots' && entry['purposeClass'] !== 'target') ||
      entry['ordinal'] !== count ||
      entry['totalOrdinal'] !== index + 1 ||
      count > candidate.maxRequests ||
      !isCanonicalUtc(entry['startedAt']) ||
      typeof entry['conditionalRequest'] !== 'boolean' ||
      entry['hostClass'] !== candidateId ||
      (entry['statusCode'] !== null &&
        (!Number.isSafeInteger(entry['statusCode']) ||
          typeof entry['statusCode'] !== 'number' ||
          entry['statusCode'] < 100 ||
          entry['statusCode'] > 599)) ||
      (entry['errorCode'] !== null &&
        (typeof entry['errorCode'] !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(entry['errorCode']))) ||
      typeof entry['requestClosed'] !== 'boolean' ||
      typeof entry['responseClosed'] !== 'boolean'
    ) {
      throw new Error('H3a 历史 ledger entry 身份或顺序非法');
    }
    perCandidateCounts[candidateId] = count;
    entries.push({
      scenarioId: candidate.scenarioId,
      candidateId,
      phase: entry['phase'],
      ordinal: count,
      totalOrdinal: index + 1,
      purposeClass: entry['purposeClass'],
      startedAt: entry['startedAt'],
    });
  }
  const report = asRecord(reportWrapper['report']);
  const reportRequests = report === null ? null : asRecord(report['requests']);
  if (
    report === null ||
    reportRequests === null ||
    report['candidateSha'] !== source.candidateSha ||
    report['buildHash'] !== source.buildHash ||
    report['manifestHash'] !== source.manifestHash ||
    reportRequests['beforeCount'] !== 0 ||
    reportRequests['campaignCount'] !== ledger['actualCount'] ||
    reportRequests['actualCount'] !== ledger['actualCount'] ||
    reportRequests['rejectedCount'] !== ledger['rejectedCount'] ||
    JSON.stringify(reportRequests['entries']) !== JSON.stringify(ledger['entries'])
  ) {
    throw new Error('H3a 历史 report 与 ledger 不一致');
  }
  if (
    processRecord['candidateSha'] !== source.candidateSha ||
    !Number.isSafeInteger(processRecord['exitCode']) ||
    !isHistoricalProcessUtc(processRecord['startedAt']) ||
    !isHistoricalProcessUtc(processRecord['finishedAt'])
  ) {
    throw new Error('H3a 历史 process receipt 不一致');
  }
  return {
    receipt: {
      id: source.id,
      candidateSha: source.candidateSha,
      buildHash: source.buildHash,
      manifestHash: source.manifestHash,
      ledgerHash: source.ledgerHash,
      reportHash: source.reportHash,
      processHash: source.processHash,
      actualCount: ledger['actualCount'],
      rejectedCount: ledger['rejectedCount'],
      perCandidateCounts,
    },
    entries,
  };
}

function validateWorkflowEntry(value: unknown): value is H3aWorkflowUsageEntry {
  const entry = asRecord(value);
  if (
    entry === null ||
    !hasExactOwnKeys(entry, [
      'candidateSha',
      'buildHash',
      'scenarioId',
      'candidateId',
      'phase',
      'ordinal',
      'totalOrdinal',
      'purposeClass',
      'startedAt',
      'sourceReceiptId',
    ]) ||
    typeof entry['candidateId'] !== 'string'
  ) {
    return false;
  }
  const candidate = frozenCandidate(entry['candidateId']);
  return (
    candidate !== null &&
    entry['scenarioId'] === candidate.scenarioId &&
    /^[0-9a-f]{40}$/.test(String(entry['candidateSha'])) &&
    /^[0-9a-f]{64}$/.test(String(entry['buildHash'])) &&
    (entry['phase'] === 'first' || entry['phase'] === 'second') &&
    (entry['purposeClass'] === 'robots' || entry['purposeClass'] === 'target') &&
    Number.isSafeInteger(entry['ordinal']) &&
    typeof entry['ordinal'] === 'number' &&
    entry['ordinal'] > 0 &&
    Number.isSafeInteger(entry['totalOrdinal']) &&
    typeof entry['totalOrdinal'] === 'number' &&
    entry['totalOrdinal'] > 0 &&
    isCanonicalUtc(entry['startedAt']) &&
    (entry['sourceReceiptId'] === null || typeof entry['sourceReceiptId'] === 'string')
  );
}

export function initialH3aHistoricalUsageSources(logRoot: string): H3aHistoricalUsageSource[] {
  const root = resolve(logRoot);
  return [
    {
      id: 'h3a-0501acb9e898-20260906',
      candidateSha: '0501acb9e8987bb5a319157d465cd43dddf17bba',
      buildHash: '669f6b4a7c3587cc8cda389ce8f6debae6b1161d2b8d621d0af1cde9a0a19b87',
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      ledgerPath: join(root, 'h3a-0501acb9e898', 'request-ledger.json'),
      ledgerHash: '95a9eb885396b3acc5b70ce4186125e63eeedf34b773f8e4a10d41ea3b0469d8',
      reportPath: join(root, 'h3a-0501acb9e898', 'report-2026-09-06T07-02-40.926Z.json'),
      reportHash: '22b51b64754c7388a2a8052b0b01a936581104a32f95c3d2f1458a2b2264ad06',
      processPath: join(root, 'h3a-0501acb9e898-campaign-process.json'),
      processHash: '98812fa5790d09ee14adad53231e7ba58e720461f56689affc62d7cd5045bedd',
      manifestPath: join(root, 'h3a-0501acb9e898', 'manifest.json'),
    },
  ];
}

export class H3aWorkflowUsageLedger {
  private readonly ledgerPath: string;
  private state: H3aWorkflowUsageSnapshot;

  constructor(options: {
    workflowDir: string;
    historicalSources: readonly H3aHistoricalUsageSource[];
    requireExisting?: boolean;
  }) {
    const workflowDir = resolve(options.workflowDir);
    if (!isAbsolute(options.workflowDir)) throw new Error('H3a workflow usage 目录必须为绝对路径');
    this.ledgerPath = join(workflowDir, WORKFLOW_LEDGER_FILE);
    if (options.requireExisting === true && !existsSync(this.ledgerPath)) {
      throw new Error('H3a workflow usage ledger 必须已存在');
    }
    mkdirSync(workflowDir, { recursive: true });
    const ids = new Set<string>();
    const imported = options.historicalSources.map((source) => {
      if (ids.has(source.id)) throw new Error('H3a 历史 usage receipt 重复');
      ids.add(source.id);
      return importHistoricalSource(source);
    });
    if (existsSync(this.ledgerPath)) {
      let existing: unknown;
      try {
        existing = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as unknown;
      } catch {
        throw new Error('H3a workflow usage ledger 无法解析');
      }
      if (!this.isValidStored(existing, imported)) {
        throw new Error('H3a workflow usage ledger 不完整或计数矛盾');
      }
      this.state = existing as H3aWorkflowUsageSnapshot;
      return;
    }
    const perCandidateCounts = emptyCandidateCounts();
    const entries: H3aWorkflowUsageEntry[] = [];
    let rejectedCount = 0;
    for (const item of imported) {
      rejectedCount += item.receipt.rejectedCount;
      for (const entry of item.entries) {
        const ordinal = perCandidateCounts[entry.candidateId]! + 1;
        perCandidateCounts[entry.candidateId] = ordinal;
        entries.push({
          candidateSha: item.receipt.candidateSha,
          buildHash: item.receipt.buildHash,
          scenarioId: entry.scenarioId,
          candidateId: entry.candidateId,
          phase: entry.phase,
          ordinal,
          totalOrdinal: entries.length + 1,
          purposeClass: entry.purposeClass,
          startedAt: entry.startedAt,
          sourceReceiptId: item.receipt.id,
        });
      }
    }
    this.state = {
      schemaVersion: 1,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      totalMaxRequests: 64,
      actualCount: entries.length,
      rejectedCount,
      perCandidateCounts,
      receipts: imported.map((item) => item.receipt),
      entries,
    };
    this.persist();
  }

  get path(): string {
    return this.ledgerPath;
  }

  get snapshot(): H3aWorkflowUsageSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as H3aWorkflowUsageSnapshot;
  }

  reserve(input: {
    candidateSha: string;
    buildHash: string;
    scenarioId: string;
    candidateId: string;
    phase: 'first' | 'second';
    purposeClass: 'robots' | 'target';
    startedAt: string;
  }): { ordinal: number; totalOrdinal: number } {
    const candidate = frozenCandidate(input.candidateId);
    const candidateCount = this.state.perCandidateCounts[input.candidateId];
    if (
      candidate === null ||
      candidate.scenarioId !== input.scenarioId ||
      candidateCount === undefined ||
      !/^[0-9a-f]{40}$/.test(input.candidateSha) ||
      !/^[0-9a-f]{64}$/.test(input.buildHash) ||
      !isCanonicalUtc(input.startedAt)
    ) {
      throw new Error('H3a workflow usage reservation 身份非法');
    }
    if (
      this.state.actualCount >= H3A_MANIFEST.totalMaxRequests ||
      candidateCount >= candidate.maxRequests
    ) {
      this.state.rejectedCount += 1;
      this.persist();
      throw Object.assign(new Error('H3a 请求预算已耗尽（未创建原生请求）'), {
        code: 'H3A_BUDGET_EXHAUSTED',
      });
    }
    const ordinal = candidateCount + 1;
    const totalOrdinal = this.state.actualCount + 1;
    this.state.entries.push({
      ...input,
      ordinal,
      totalOrdinal,
      sourceReceiptId: null,
    });
    this.state.perCandidateCounts[input.candidateId] = ordinal;
    this.state.actualCount = totalOrdinal;
    this.persist();
    return { ordinal, totalOrdinal };
  }

  private persist(): void {
    const temporary = `${this.ledgerPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });
    renameSync(temporary, this.ledgerPath);
  }

  private isValidStored(
    value: unknown,
    expectedImports: ImportedHistory[],
  ): value is H3aWorkflowUsageSnapshot {
    const expectedReceipts = expectedImports.map((item) => item.receipt);
    const ledger = asRecord(value);
    if (
      ledger === null ||
      !hasExactOwnKeys(ledger, [
        'schemaVersion',
        'manifestHash',
        'totalMaxRequests',
        'actualCount',
        'rejectedCount',
        'perCandidateCounts',
        'receipts',
        'entries',
      ]) ||
      ledger['schemaVersion'] !== 1 ||
      ledger['manifestHash'] !== H3A_MANIFEST_CONTENT_HASH ||
      ledger['totalMaxRequests'] !== 64 ||
      !Number.isSafeInteger(ledger['actualCount']) ||
      typeof ledger['actualCount'] !== 'number' ||
      ledger['actualCount'] < 0 ||
      ledger['actualCount'] > 64 ||
      !Number.isSafeInteger(ledger['rejectedCount']) ||
      typeof ledger['rejectedCount'] !== 'number' ||
      ledger['rejectedCount'] < 0 ||
      !validateCandidateCounts(ledger['perCandidateCounts']) ||
      !Array.isArray(ledger['receipts']) ||
      JSON.stringify(ledger['receipts']) !== JSON.stringify(expectedReceipts) ||
      !Array.isArray(ledger['entries']) ||
      ledger['entries'].length !== ledger['actualCount']
    ) {
      return false;
    }
    const receiptIds = new Set(expectedReceipts.map((receipt) => receipt.id));
    const derivedCounts = emptyCandidateCounts();
    const expectedHistoricalEntries: H3aWorkflowUsageEntry[] = [];
    for (const item of expectedImports) {
      for (const importedEntry of item.entries) {
        const ordinal = derivedCounts[importedEntry.candidateId]! + 1;
        derivedCounts[importedEntry.candidateId] = ordinal;
        expectedHistoricalEntries.push({
          candidateSha: item.receipt.candidateSha,
          buildHash: item.receipt.buildHash,
          scenarioId: importedEntry.scenarioId,
          candidateId: importedEntry.candidateId,
          phase: importedEntry.phase,
          ordinal,
          totalOrdinal: expectedHistoricalEntries.length + 1,
          purposeClass: importedEntry.purposeClass,
          startedAt: importedEntry.startedAt,
          sourceReceiptId: item.receipt.id,
        });
      }
    }
    const importedCounts = { ...derivedCounts };
    for (let index = 0; index < ledger['entries'].length; index += 1) {
      const entry = ledger['entries'][index];
      if (!validateWorkflowEntry(entry)) return false;
      const historical = expectedHistoricalEntries[index];
      if (historical !== undefined) {
        if (JSON.stringify(entry) !== JSON.stringify(historical)) return false;
        continue;
      }
      if (entry.sourceReceiptId !== null) return false;
      const next = derivedCounts[entry.candidateId]! + 1;
      derivedCounts[entry.candidateId] = next;
      const candidate = frozenCandidate(entry.candidateId)!;
      if (
        entry.totalOrdinal !== index + 1 ||
        entry.ordinal !== next ||
        next > candidate.maxRequests
      ) {
        return false;
      }
    }
    for (const candidateId of Object.keys(importedCounts)) {
      if (
        importedCounts[candidateId] !==
        expectedHistoricalEntries.filter((entry) => entry.candidateId === candidateId).length
      ) {
        return false;
      }
    }
    if (JSON.stringify(derivedCounts) !== JSON.stringify(ledger['perCandidateCounts']))
      return false;
    const importedCount = expectedReceipts.reduce((sum, receipt) => sum + receipt.actualCount, 0);
    const importedRejected = expectedReceipts.reduce(
      (sum, receipt) => sum + receipt.rejectedCount,
      0,
    );
    const sourceEntries = ledger['entries'].filter((entry) => entry.sourceReceiptId !== null);
    return (
      receiptIds.size === expectedImports.length &&
      sourceEntries.length === importedCount &&
      ledger['rejectedCount'] >= importedRejected
    );
  }
}

export const H3A_NASA_DIAGNOSTIC_ID = 'nasa-feed-budget-first-v1' as const;
export const H3A_NASA_DIAGNOSTIC_WORKFLOW_BEFORE_HASH =
  '613874972b765bc73f4aa6b6d81cdc98ad1001fb60c7b15aceaf9d074fe7b828';

export interface H3aNasaDiagnosticClaim {
  schemaVersion: 1;
  diagnosticId: typeof H3A_NASA_DIAGNOSTIC_ID;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  claimedAt: string;
  workflowBeforeHash: string;
  beforeCount: 4;
  perTargetBefore: Record<string, number>;
}

export function createH3aNasaDiagnosticClaim(options: {
  workflow: H3aWorkflowUsageLedger;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  expectedWorkflowHash?: string;
}): { claim: H3aNasaDiagnosticClaim; claimHash: string; path: string } {
  const snapshot = options.workflow.snapshot;
  const workflowBeforeHash = fileHash(options.workflow.path);
  const expectedWorkflowHash =
    options.expectedWorkflowHash ?? H3A_NASA_DIAGNOSTIC_WORKFLOW_BEFORE_HASH;
  const expectedCounts = emptyCandidateCounts();
  expectedCounts['rss-primary'] = 2;
  expectedCounts['rss-fallback'] = 2;
  if (
    workflowBeforeHash !== expectedWorkflowHash ||
    snapshot.actualCount !== 4 ||
    snapshot.rejectedCount !== 0 ||
    JSON.stringify(snapshot.perCandidateCounts) !== JSON.stringify(expectedCounts)
  ) {
    throw new Error('NASA 单次诊断 workflow 前置计数或 hash 不匹配');
  }
  if (!/^[0-9a-f]{40}$/.test(options.candidateSha)) {
    throw new Error('NASA 单次诊断 candidate SHA 非法');
  }
  if (!/^[0-9a-f]{64}$/.test(options.buildHash)) {
    throw new Error('NASA 单次诊断 build hash 非法');
  }
  if (options.manifestHash !== H3A_MANIFEST_CONTENT_HASH) {
    throw new Error('NASA 单次诊断 manifest hash 非法');
  }
  const claimPath = join(dirname(options.workflow.path), `${H3A_NASA_DIAGNOSTIC_ID}.claim.json`);
  if (existsSync(claimPath)) throw new Error('NASA 单次诊断 claim 已存在或不完整');
  const claim: H3aNasaDiagnosticClaim = {
    schemaVersion: 1,
    diagnosticId: H3A_NASA_DIAGNOSTIC_ID,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    manifestHash: options.manifestHash,
    claimedAt: new Date().toISOString(),
    workflowBeforeHash,
    beforeCount: 4,
    perTargetBefore: snapshot.perCandidateCounts,
  };
  try {
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch {
    throw new Error('NASA 单次诊断 claim 写入失败');
  }
  return { claim, claimHash: fileHash(claimPath), path: claimPath };
}
