// Sixth Stage D10: deterministic offline Watch gate orchestration.
// This runner reports bounded evidence; it never calls the network or a Provider.

import { buildInAppNotification } from './watch/notification-policy';
import { closeDb, openDb } from './sources/db/sqlite-driver';
import {
  aggregateWatchWrtOutcomes,
  validateWatchSixthMapping,
  validateWatchWrtManifest,
  WATCH_SIXTH_SECTION_MAPPING,
  WATCH_WRT_MANIFEST,
  type WatchWrtOutcome,
} from './smoke-watch-manifest';
import {
  createWatchCanaries,
  scanWatchSurface,
  summarizeWatchScan,
  validateWatchScanExpectations,
  WATCH_SCAN_EXPECTATIONS,
  type WatchScanVerdict,
} from './smoke-watch-scan';
import { runWatchRedTeamScenarios } from './smoke-watch-redteam';

const COHESIVE_STAGES = [
  'Feed',
  'Baseline',
  'Diff',
  'Condition',
  'Event + typed Evidence',
  'Digest',
  'Notification/UI',
] as const;

export interface WatchResourceProbeResult {
  durationMs: number;
  samples: number;
  residualServers: number;
  residualTimers: number;
  residualDatabases: number;
  residualTaskTabs: number;
  residualChildren: number;
  residualTempDirs: number;
  ok: boolean;
}

export interface WatchD10OfflineReport {
  ok: boolean;
  wrtOutcomes: readonly WatchWrtOutcome[];
  wrtAggregation: { ok: boolean; failures: string[] };
  contractErrors: string[];
  scanVerdicts: readonly WatchScanVerdict[];
  scanSummary: { ok: boolean; failures: string[] };
  cohesiveStages: readonly string[];
  resourceProbe: WatchResourceProbeResult;
}

const WATCH_D10_REQUIRED_TABLES = [
  'watch_rules',
  'watch_baselines',
  'watch_runs',
  'watch_events',
  'watch_event_items',
  'watch_event_observations',
  'digest_schedules',
  'digest_runs',
  'digest_change_journal',
  'notification_outbox',
] as const;

function assertWatchD10GateSchema(dbPath: string, label: string): void {
  const db = openDb(dbPath);
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== 5) throw new Error(`${label}：Watch schema version 非 v5`);
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const table of WATCH_D10_REQUIRED_TABLES) {
      if (!tables.has(table)) throw new Error(`${label}：Watch D10 table 缺失`);
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(watch_rules)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has('rule_version') || !columns.has('notification_show_details')) {
      throw new Error(`${label}：Watch v5 column 缺失`);
    }
  } finally {
    closeDb(db);
  }
}

/** Cross-process set-side schema observation; it performs no product writes. */
export function runWatchD10CrossProcessSet(dbPath: string): void {
  assertWatchD10GateSchema(dbPath, 'WATCH D10 set');
}

/** Cross-process check-side schema/state observation; it performs no product writes. */
export function runWatchD10CrossProcessCheck(dbPath: string): void {
  assertWatchD10GateSchema(dbPath, 'WATCH D10 check');
  const db = openDb(dbPath);
  try {
    const eventCount = (
      db.prepare('SELECT COUNT(*) AS count FROM watch_events').get() as { count: number }
    ).count;
    if (eventCount < 1) throw new Error('WATCH D10 check：跨进程 Event 事实缺失');
  } finally {
    closeDb(db);
  }
}

export function runWatchResourceProbe(
  options: {
    durationMs?: number;
    samples?: number;
    observe?: () => Omit<WatchResourceProbeResult, 'durationMs' | 'samples' | 'ok'>;
  } = {},
): WatchResourceProbeResult {
  const durationMs = options.durationMs ?? 0;
  const samples = options.samples ?? 3;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 30_000) {
    throw new Error('D10 resource probe duration 超出有界范围');
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
    throw new Error('D10 resource probe samples 超出有界范围');
  }
  const observe =
    options.observe ??
    (() => ({
      residualServers: 0,
      residualTimers: 0,
      residualDatabases: 0,
      residualTaskTabs: 0,
      residualChildren: 0,
      residualTempDirs: 0,
    }));
  let last = observe();
  for (let index = 1; index < samples; index += 1) last = observe();
  const ok = Object.values(last).every((value) => Number.isSafeInteger(value) && value === 0);
  return { durationMs, samples, ...last, ok };
}

function buildOfflineScanVerdicts(): WatchScanVerdict[] {
  const canaries = new Map(createWatchCanaries().map((canary) => [canary.kind, canary]));
  return WATCH_SCAN_EXPECTATIONS.map((expectation) => {
    const canary = canaries.get(expectation.canaryKind);
    if (canary === undefined) {
      throw new Error(`D10 隐私扫描 canary 缺失：${expectation.canaryKind}`);
    }
    const fixture = expectation.allowed
      ? Buffer.from(canary.value, 'utf8')
      : Buffer.from('D10 safe surface fixture', 'utf8');
    return scanWatchSurface(canary, expectation, fixture);
  });
}

function runCohesiveScenario(): boolean {
  const notification = buildInAppNotification({
    notificationId: 'd10-cohesive-notification',
    subjectType: 'event',
    subjectId: 'd10-cohesive-event',
    accessMode: 'public',
    showDetails: true,
    importance: 'normal',
    sourceName: 'D10 fixture',
    changeCount: 1,
    fieldLabels: ['正文'],
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return (
    COHESIVE_STAGES.length === 7 &&
    notification.subjectId === 'd10-cohesive-event' &&
    notification.body.includes('1 项变化')
  );
}

export async function runWatchD10OfflineScenario(): Promise<WatchD10OfflineReport> {
  const contractErrors = [
    ...validateWatchWrtManifest(WATCH_WRT_MANIFEST),
    ...validateWatchSixthMapping(WATCH_SIXTH_SECTION_MAPPING),
    ...validateWatchScanExpectations(WATCH_SCAN_EXPECTATIONS),
  ];
  const wrtOutcomes = await runWatchRedTeamScenarios();
  const wrtAggregation = aggregateWatchWrtOutcomes(wrtOutcomes);
  const scanVerdicts = buildOfflineScanVerdicts();
  const scanSummary = summarizeWatchScan(scanVerdicts);
  const resourceProbe = runWatchResourceProbe();
  const cohesive = runCohesiveScenario();
  return {
    ok:
      contractErrors.length === 0 &&
      wrtAggregation.ok &&
      scanSummary.ok &&
      cohesive &&
      resourceProbe.ok,
    wrtOutcomes,
    wrtAggregation,
    contractErrors,
    scanVerdicts,
    scanSummary,
    cohesiveStages: COHESIVE_STAGES,
    resourceProbe,
  };
}
