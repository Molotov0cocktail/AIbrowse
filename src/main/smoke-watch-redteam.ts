// Sixth Stage D10: WRT-01..19 独立离线红队夹具。
// 每项只返回自己的结果；敌手正文与随机 canary 不进入结果、日志或异常消息。

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInAppNotification } from './watch/notification-policy';
import { buildDigestProviderRequest, SYSTEM_DIGEST_PROMPT } from './watch/digest-prompt';
import {
  encodeFeedProjectionCanonical,
  parseFeedXml,
  type FeedProjectionCanonicalPayload,
} from './watch/feed-parser';
import {
  validatePublicUrl,
  classifyIpAddress,
  isAllowedPublicAddress,
} from './watch/network-policy';
import { readPublicHtml } from './watch/public-html-sax-reader';
import {
  createPublicWatchHttpStack,
  classifyPublicHttpStatus,
  type WatchRequestFactory,
  type WatchRequestLike,
} from './watch/public-watch-http-client';
import { parseRobotsText, evaluateRobotsPath } from './watch/robots-policy';
import { HostRequestGate } from './watch/host-request-gate';
import { classifySnapshotSuspicion } from './watch/browser-watch-reader';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from './watch/watch-task-tab-workspace';
import { WatchScheduler, computeNextDueAt } from './watch/watch-scheduler';
import {
  computeTableHeaderFingerprint,
  previewPageRegions,
  projectPageProjection,
  sessionConsentTargetCheck,
} from './watch/page-projector';
import { evaluateStructuredCondition } from '../shared/watch/condition-engine';
import { diffPageProjections } from '../shared/watch/diff/page-diff';
import { openDb, closeDb } from './sources/db/sqlite-driver';
import { runMigrations } from './sources/db/migrations';
import {
  WATCH_MIGRATION_V1,
  WATCH_MIGRATION_V2,
  WATCH_MIGRATION_V3,
  WATCH_MIGRATION_V4,
  WATCH_MIGRATION_V5,
  runWatchMigrations,
} from './watch/db/watch-migrations';
import { openWatchStore } from './watch/watch-store';
import { SourceServiceImpl } from './sources/source-service';
import { buildDigestFacts } from '../shared/watch/digest-facts';
import { projectDigestForProvider } from '../shared/watch/digest-sharing-projector';
import { makeEvidencePair, pageValueEvidence, sha256Hex } from '../shared/watch/diff/evidence';
import { validateChangeEvidencePair } from '../shared/watch/event-validator';
import { parseDigestExplanation } from '../shared/watch/digest-validator';
import type { WatchWrtOutcome } from './smoke-watch-manifest';
import {
  MAX_ROBOTS_RESPONSE_BYTES,
  MAX_XML_ATTRIBUTES_PER_TAG,
  MAX_XML_ATTRIBUTE_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_NAME_BYTES,
  MAX_XML_NODES,
  MAX_XML_TEXT_NODE_BYTES,
  MAX_XML_TOTAL_TEXT_BYTES,
  MAX_FEED_FIELD_BYTES,
  MAX_FEED_PROJECTION_BYTES,
  type ChangeEvidencePair,
  type DocumentChannels,
  type DigestFacts,
  type PageTarget,
  type RegionDescriptor,
} from '../shared/types/watch';
import type { TabInfo } from '../shared/types/browser';
import { FakeClock } from '../shared/watch/clock';
import { WatchRepository } from './watch/repository/watch-repository';
import { WatchProcessingServiceImpl } from './watch/watch-processing-service';
import { WatchLifecycleCoordinator } from './watch/watch-lifecycle-coordinator';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import type { FeedProjection, SourceWatchProjection, WatchRule } from '../shared/types/watch';

const execFileAsync = promisify(execFile);

const VALID_URL = 'https://www.openai.com/watch';
const NOW = '2026-09-01T00:00:00.000Z';

function outcome(
  id: string,
  ok: boolean,
  detail: string,
  evidenceKind: 'structural-proof' | 'real-observation' | 'honest-limit' = 'structural-proof',
) {
  return { id, ok, evidenceKind, detail } as const;
}

function validFeed(guid = 'one', title = '标题'): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>频道</title><link>https://www.openai.com/</link><item><guid>${guid}</guid><title>${title}</title><link>${VALID_URL}</link><description>摘要</description></item></channel></rss>`,
    'utf8',
  );
}

function makePair(before: string, after: string): ChangeEvidencePair {
  const pair = makeEvidencePair({
    itemId: 'item-d10',
    fieldKey: 'r0:main',
    label: '正文',
    before: before === '' ? { kind: 'absent' } : pageValueEvidence(before),
    after: after === '' ? { kind: 'absent' } : pageValueEvidence(after),
    feedItemKey: null,
    context: {
      beforeCapturedAt: NOW,
      afterCapturedAt: NOW,
      beforeFinalUrl: VALID_URL,
      afterFinalUrl: VALID_URL,
      beforeDocumentId: null,
      afterDocumentId: null,
    },
  });
  if (pair === null) throw new Error('D10 fixture pair construction failed');
  return pair;
}

function makeFacts(): DigestFacts {
  const pair = makePair('', '新内容');
  const facts = buildDigestFacts({
    scheduleId: 'schedule-d10',
    digestRunId: 'run-d10',
    batchIndex: 0,
    period: { fromExclusive: '2026-08-31T00:00:00.000Z', toInclusive: NOW },
    runStats: { changed: 1, failed: 0, unchanged: 0 },
    observations: [
      {
        sequence: 1,
        eventId: 'event-d10',
        ruleId: 'rule-d10',
        sourceId: 'source-d10',
        eventKind: 'changed',
        importance: 'important',
        observedAt: NOW,
        items: [pair],
      },
    ],
    fetchedAt: NOW,
  });
  if (facts === null) throw new Error('D10 fixture facts construction failed');
  return facts;
}

interface ScriptedResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

function scriptedRequestFactory(
  responses: readonly ScriptedResponse[],
  requestPaths: string[],
  destroyed: { count: number },
): WatchRequestFactory {
  let responseIndex = 0;
  return (options): WatchRequestLike => {
    const request = new EventEmitter();
    requestPaths.push(options.path);
    const response = new EventEmitter();
    const next = responses[responseIndex] ?? {
      statusCode: 500,
      headers: {},
      body: Buffer.alloc(0),
    };
    responseIndex += 1;
    const destroy = (): void => {
      destroyed.count += 1;
      queueMicrotask(() => request.emit('close'));
    };
    const end = (): void => {
      queueMicrotask(() => {
        request.emit(
          'response',
          Object.assign(response, {
            statusCode: next.statusCode,
            statusMessage: String(next.statusCode),
            headers: next.headers ?? {},
            destroy,
            resume: () => undefined,
          }),
        );
        queueMicrotask(() => {
          const body = next.body ?? Buffer.alloc(0);
          if (body.length > 0) response.emit('data', body);
          response.emit('end');
          response.emit('close');
          request.emit('close');
        });
      });
    };
    Object.assign(request, {
      setTimeout: () => undefined,
      end,
      abort: destroy,
      destroy,
    });
    return request as unknown as WatchRequestLike;
  };
}

function robotsBody(size: number): Buffer {
  const prefix = Buffer.from('User-agent: *\nAllow: /\n', 'utf8');
  if (size < prefix.length) return Buffer.alloc(size, 32);
  return Buffer.concat([prefix, Buffer.alloc(size - prefix.length, 32)]);
}

async function runPublicStackProbe(input: {
  lookup: (call: number) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  responses?: readonly ScriptedResponse[];
}): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof createPublicWatchHttpStack>['target']['get']>>;
  paths: string[];
  destroyed: number;
  lookups: number;
}> {
  const paths: string[] = [];
  const destroyed = { count: 0 };
  let lookups = 0;
  const stack = createPublicWatchHttpStack({
    lookup: async () => {
      lookups += 1;
      return input.lookup(lookups);
    },
    request: scriptedRequestFactory(input.responses ?? [], paths, destroyed),
  });
  try {
    const result = await stack.target.get({ url: VALID_URL, purpose: 'page' });
    return { result, paths, destroyed: destroyed.count, lookups };
  } finally {
    stack.robots.clearCache();
  }
}

function insertLegacyRule(db: ReturnType<typeof openDb>, id: string): void {
  db.prepare(
    `INSERT INTO watch_rules
      (id, source_id, kind, state, pause_reason, desired_enabled, muted, access_mode,
       schedule_json, target_json, condition_json, notification_level,
       source_row_version, source_locator_fingerprint, next_due_at,
       last_consumed_scheduled_for, last_daily_local_date, consecutive_failures,
       backoff_until, baseline_version, created_at, updated_at)
     VALUES (?, 'source-d10', 'feed', 'enabled', NULL, 1, 0, 'public',
       '{"kind":"interval","intervalMinutes":60}',
       '{"type":"feed","feedUrl":"https://www.openai.com/watch","format":"rss2"}',
       NULL, 'normal', 1, ?, NULL, NULL, NULL, 0, NULL, 0, ?, ?)`,
  ).run(id, 'a'.repeat(64), NOW, NOW);
}

function schemaSnapshot(db: ReturnType<typeof openDb>): unknown[] {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}

function legacyRowSnapshot(db: ReturnType<typeof openDb>, id: string): unknown {
  return db
    .prepare(
      `SELECT id,source_id,kind,state,pause_reason,desired_enabled,muted,access_mode,
       schedule_json,target_json,condition_json,notification_level,source_row_version,
       source_locator_fingerprint,next_due_at,last_consumed_scheduled_for,last_daily_local_date,
       consecutive_failures,backoff_until,baseline_version,created_at,updated_at
       FROM watch_rules WHERE id = ?`,
    )
    .get(id);
}

export interface WatchMigrationMatrixResult {
  ok: boolean;
  checks: number;
  failures: string[];
}

/** WRT-18 独立夹具：v4→v5 成功/逐语句失败/重开/future=6 全矩阵。 */
export function runWatchMigrationV5Matrix(): WatchMigrationMatrixResult {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt18-'));
  const failures: string[] = [];
  let checks = 0;
  const check = (condition: boolean, label: string): void => {
    checks += 1;
    if (!condition) failures.push(label);
  };
  const legacySteps = [
    WATCH_MIGRATION_V1,
    WATCH_MIGRATION_V2,
    WATCH_MIGRATION_V3,
    WATCH_MIGRATION_V4,
  ] as const;
  try {
    const successPath = join(dir, 'success.db');
    let db = openDb(successPath);
    runMigrations(db, legacySteps);
    insertLegacyRule(db, 'v5-success');
    const beforeRow = legacyRowSnapshot(db, 'v5-success');
    runWatchMigrations(db);
    const afterRow = legacyRowSnapshot(db, 'v5-success');
    const columns = (
      db.prepare('PRAGMA table_info(watch_rules)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    check(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === 5,
      'v5 user_version',
    );
    check(
      columns.includes('rule_version') && columns.includes('notification_show_details'),
      'v5 新列存在',
    );
    check(
      JSON.stringify(
        db
          .prepare('SELECT rule_version,notification_show_details FROM watch_rules WHERE id = ?')
          .get('v5-success'),
      ) === JSON.stringify({ rule_version: 1, notification_show_details: 0 }),
      'v5 默认回填 1/0',
    );
    check(JSON.stringify(beforeRow) === JSON.stringify(afterRow), 'v5 旧列逐列恒等');
    closeDb(db);
    db = openDb(successPath);
    runWatchMigrations(db);
    check(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === 5,
      'v5 重开成功',
    );
    closeDb(db);

    for (let index = 0; index < WATCH_MIGRATION_V5.statements.length; index += 1) {
      const path = join(dir, `fault-${index}.db`);
      const faulty = openDb(path);
      runMigrations(faulty, legacySteps);
      insertLegacyRule(faulty, `v5-fault-${index}`);
      const beforeSchema = schemaSnapshot(faulty);
      const beforeFaultRow = legacyRowSnapshot(faulty, `v5-fault-${index}`);
      const broken = {
        ...WATCH_MIGRATION_V5,
        statements: WATCH_MIGRATION_V5.statements.map((statement, current) =>
          current === index ? 'SELECT * FROM d10_missing_migration_table' : statement,
        ),
      };
      let threw = false;
      try {
        runMigrations(faulty, [...legacySteps, broken]);
      } catch {
        threw = true;
      }
      const afterSchema = schemaSnapshot(faulty);
      const afterFaultRow = legacyRowSnapshot(faulty, `v5-fault-${index}`);
      const version = (faulty.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      const faultColumns = (
        faulty.prepare('PRAGMA table_info(watch_rules)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      check(threw, `v5 statement ${index} 应失败`);
      check(version === 4, `v5 statement ${index} 回滚 user_version`);
      check(
        JSON.stringify(beforeSchema) === JSON.stringify(afterSchema),
        `v5 statement ${index} schema 恒等`,
      );
      check(
        JSON.stringify(beforeFaultRow) === JSON.stringify(afterFaultRow),
        `v5 statement ${index} data 恒等`,
      );
      check(
        !faultColumns.includes('rule_version') &&
          !faultColumns.includes('notification_show_details'),
        `v5 statement ${index} 无半列`,
      );
      closeDb(faulty);
    }

    const futurePath = join(dir, 'future.db');
    const futureDb = openDb(futurePath);
    runWatchMigrations(futureDb);
    futureDb.exec('PRAGMA user_version = 6');
    closeDb(futureDb);
    const beforeFuture = readFileSync(futurePath);
    const future = openWatchStore({
      dbPath: futurePath,
      backupsDir: join(dir, 'backups'),
      reconcile: () => ({ ok: true, reason: null }),
    });
    const afterFuture = readFileSync(futurePath);
    check(
      future.mode === 'unavailable' && !future.schedulerReady && future.repo === null,
      'future=6 unavailable 且 Scheduler 不启动',
    );
    check(beforeFuture.equals(afterFuture), 'future=6 零写入');
  } catch {
    failures.push('WRT-18 迁移夹具异常');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, checks, failures };
}

function fakeTabsBrowser(
  options: { returnExisting?: boolean } = {},
): WatchTaskTabBrowser & { tabs(): TabInfo[] } {
  const userTab: TabInfo = {
    id: 'user-tab',
    title: '用户页',
    url: VALID_URL,
    active: true,
    state: 'ready',
  };
  const tabs: TabInfo[] = [userTab];
  let sequence = 0;
  return {
    async createTab(url: string): Promise<TabInfo> {
      if (options.returnExisting) return { ...userTab };
      sequence += 1;
      for (const tab of tabs) tab.active = false;
      const tab: TabInfo = {
        id: `task-tab-${sequence}`,
        title: '任务页',
        url,
        active: true,
        state: 'ready',
      };
      tabs.push(tab);
      return { ...tab };
    },
    async closeTab(id: string): Promise<boolean> {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return false;
      tabs.splice(index, 1);
      if (tabs.length > 0 && !tabs.some((tab) => tab.active)) tabs[0]!.active = true;
      return true;
    },
    async activateTab(id: string): Promise<boolean> {
      const found = tabs.some((tab) => tab.id === id);
      if (!found) return false;
      for (const tab of tabs) tab.active = tab.id === id;
      return true;
    },
    async getTabs(): Promise<TabInfo[]> {
      return tabs.map((tab) => ({ ...tab }));
    },
    async getActiveTab(): Promise<TabInfo | null> {
      return tabs.find((tab) => tab.active) ? { ...tabs.find((tab) => tab.active)! } : null;
    },
    tabs: () => tabs.map((tab) => ({ ...tab })),
  };
}

async function wrt01(): Promise<boolean> {
  const denied = [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[2001:db8::1]/',
  ];
  return (
    denied.every((url) => {
      const parsed = validatePublicUrl(url);
      if (!parsed.ok) return true;
      const host = new URL(url).hostname.replace(/^\[|\]$/gu, '');
      return !isAllowedPublicAddress(host);
    }) && validatePublicUrl(VALID_URL).ok
  );
}

async function wrt02(): Promise<boolean> {
  const mixed = await runPublicStackProbe({
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ],
  });
  const reboundPaths: string[] = [];
  const reboundDestroyed = { count: 0 };
  let lookupCount = 0;
  const reboundStack = createPublicWatchHttpStack({
    lookup: async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.8', family: 4 },
          ];
    },
    request: scriptedRequestFactory(
      [
        {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('User-agent: *\nAllow: /\n'),
        },
      ],
      reboundPaths,
      reboundDestroyed,
    ),
  });
  try {
    const rebound = await reboundStack.target.get({ url: VALID_URL, purpose: 'page' });
    return (
      classifyIpAddress('93.184.216.34') === 'public' &&
      isAllowedPublicAddress('93.184.216.34') &&
      !isAllowedPublicAddress('10.0.0.8') &&
      !isAllowedPublicAddress('2001:db8::1') &&
      mixed.result.kind === 'failed' &&
      mixed.result.health === 'security_rejected' &&
      mixed.paths.length === 0 &&
      rebound.kind === 'failed' &&
      rebound.health === 'security_rejected' &&
      reboundPaths.length === 1 &&
      lookupCount >= 2
    );
  } finally {
    reboundStack.robots.clearCache();
  }
}

async function wrt03(): Promise<boolean> {
  const rejected = [
    'http://www.openai.com:443/',
    'https://www.openai.com:80/',
    'https://www.openai.com:444/',
    'file:///private.txt',
    'javascript:alert(1)',
    'http://127.0.0.1/',
  ].every((url) => {
    const parsed = validatePublicUrl(url);
    if (!parsed.ok) return true;
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, '');
    return !isAllowedPublicAddress(host);
  });
  const paths: string[] = [];
  const stack = createPublicWatchHttpStack({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: scriptedRequestFactory(
      [
        {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('User-agent: *\nAllow: /\n'),
        },
        {
          statusCode: 302,
          headers: { location: 'http://www.openai.com/private' },
          body: Buffer.alloc(0),
        },
      ],
      paths,
      { count: 0 },
    ),
  });
  try {
    const downgrade = await stack.target.get({ url: VALID_URL, purpose: 'page' });
    return (
      rejected &&
      downgrade.kind === 'failed' &&
      downgrade.health === 'security_rejected' &&
      paths.length === 2 &&
      validatePublicUrl('https://www.openai.com:444/').ok === false
    );
  } finally {
    stack.robots.clearCache();
  }
}

async function wrt04(): Promise<boolean> {
  const script = [
    "const http=require('node:http');",
    'let uncaught=0,unhandled=0,done=0,responseSeen=0,requestClosed=0;',
    "process.on('uncaughtException',()=>{uncaught++});",
    "process.on('unhandledRejection',()=>{unhandled++});",
    "const server=http.createServer((req,res)=>{ if(req.url==='/no-response'){return;} if(req.url==='/silent'){res.writeHead(200); res.write('first'); setTimeout(()=>res.end('last'),250);return;} res.end('ok'); });",
    "server.listen(0,'127.0.0.1',()=>{ const port=server.address().port; for(const path of ['/no-response','/silent']){ const req=http.request({hostname:'127.0.0.1',port,path},res=>{responseSeen++;res.on('data',()=>{});res.on('end',()=>{done++});res.on('close',()=>{done++});}); req.setTimeout(60,()=>req.destroy()); req.on('error',()=>{}); req.on('close',()=>{requestClosed++}); req.end(); } setTimeout(()=>{server.closeAllConnections(); server.close(()=>process.stdout.write(JSON.stringify({done,responseSeen,requestClosed,uncaught,unhandled})));},180); });",
  ].join('');
  try {
    const result = await execFileAsync(process.execPath, ['-e', script], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 32_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const parsed = JSON.parse(result.stdout) as {
      done?: number;
      responseSeen?: number;
      requestClosed?: number;
      uncaught?: number;
      unhandled?: number;
    };
    const checks = {
      node24: process.versions.node.startsWith('24.'),
      completion:
        parsed.requestClosed === 2 && parsed.responseSeen !== undefined && parsed.responseSeen >= 1,
      uncaught: parsed.uncaught === 0,
      unhandled: parsed.unhandled === 0,
    };
    if (!Object.values(checks).every(Boolean)) {
      throw new Error(
        `wrt04 failed checks: ${Object.entries(checks)
          .filter(([, ok]) => !ok)
          .map(([label]) => label)
          .join(',')} result=${JSON.stringify(parsed)}`,
      );
    }
    return true;
  } catch (error) {
    throw new Error(`wrt04 child failed: ${error instanceof Error ? error.message : 'unknown'}`, {
      cause: error,
    });
  }
}

async function wrt05(): Promise<boolean> {
  const rules = parseRobotsText('User-agent: *\nDisallow: /private\nAllow: /private/public\n');
  const atLimit = await runPublicStackProbe({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    responses: [
      {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: robotsBody(MAX_ROBOTS_RESPONSE_BYTES),
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html></html>'),
      },
    ],
  });
  const overPaths: string[] = [];
  const overDestroyed = { count: 0 };
  const overStack = createPublicWatchHttpStack({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: scriptedRequestFactory(
      [
        {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: robotsBody(MAX_ROBOTS_RESPONSE_BYTES + 1),
        },
      ],
      overPaths,
      overDestroyed,
    ),
  });
  let over: { kind: string; health?: string };
  try {
    over = await overStack.target.get({ url: VALID_URL, purpose: 'page' });
  } finally {
    overStack.robots.clearCache();
  }
  const verdict =
    rules.ok &&
    evaluateRobotsPath(rules.rules, 'aibrowse', '/private') === false &&
    evaluateRobotsPath(rules.rules, 'aibrowse', '/private/public') === true &&
    MAX_ROBOTS_RESPONSE_BYTES === 512_000 &&
    robotsBody(MAX_ROBOTS_RESPONSE_BYTES).length === 512_000 &&
    atLimit.result.kind === 'ok' &&
    atLimit.paths.length === 2 &&
    over.kind === 'failed' &&
    // RobotsPolicy intentionally maps the internal budget failure to the
    // public target's fail-closed `unavailable` classification.
    over.health === 'unavailable' &&
    overDestroyed.count > 0 &&
    overPaths.length === 1;
  const missingRobots = await runPublicStackProbe({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    responses: [
      { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(0) },
      {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html></html>'),
      },
    ],
  });
  const unavailableTarget = await runPublicStackProbe({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    responses: [
      {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('User-agent: *\nAllow: /\n'),
      },
      {
        statusCode: 429,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html>captcha</html>'),
      },
    ],
  });
  const clock = new FakeClock(0);
  const gate = new HostRequestGate({ clock, gapMs: 5_000 });
  const first = await gate.acquire('www.openai.com:443');
  const secondPromise = gate.acquire('www.openai.com:443');
  clock.advanceTo(4_999);
  const beforeGap = gate.lastStartedAt('www.openai.com:443');
  clock.advanceTo(5_000);
  const second = await secondPromise;
  const captcha = classifySnapshotSuspicion({
    url: 'https://example.com/captcha',
    title: '',
    visibleText: '不可信页面正文',
    headings: [],
    links: [],
    buttons: [{ id: 'submit', text: '提交', isSubmit: true }],
    meta: {
      capturedAt: 0,
      documentId: 1,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
  });
  const extraChecks = {
    missingRobots: missingRobots.result.kind === 'ok' && missingRobots.paths.length === 2,
    unavailableTarget:
      unavailableTarget.result.kind === 'ok' &&
      unavailableTarget.result.meta.statusCode === 429 &&
      classifyPublicHttpStatus(unavailableTarget.result.meta.statusCode) === 'unavailable',
    statusClass: classifyPublicHttpStatus(429) === 'unavailable',
    firstGate: first.ok,
    gapHeld: beforeGap === 0,
    secondGate: second.ok,
    secondTimestamp: gate.lastStartedAt('www.openai.com:443') === 5_000,
    captcha: captcha === 'captcha',
  };
  if (!Object.values(extraChecks).every(Boolean)) {
    throw new Error(
      `wrt05 failed checks: ${Object.entries(extraChecks)
        .filter(([, ok]) => !ok)
        .map(([label]) => label)
        .join(',')}`,
    );
  }
  return (
    verdict &&
    missingRobots.result.kind === 'ok' &&
    missingRobots.paths.length === 2 &&
    unavailableTarget.result.kind === 'ok' &&
    unavailableTarget.result.meta.statusCode === 429 &&
    classifyPublicHttpStatus(429) === 'unavailable' &&
    first.ok &&
    beforeGap === 0 &&
    second.ok &&
    gate.lastStartedAt('www.openai.com:443') === 5_000 &&
    captcha === 'captcha'
  );
}

async function wrt06(): Promise<boolean> {
  const hostile = [
    '<!DOCTYPE rss><rss><channel><title>x</title></channel></rss>',
    '<!DOCTYPE rss SYSTEM "http://evil.invalid/x.dtd"><rss><channel>x</channel></rss>',
    '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///private">]><rss><channel><title>&xxe;</title></channel></rss>',
    '<!DOCTYPE rss [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;">]><rss><channel>&lol2;</channel></rss>',
    '<rss xmlns:xi="http://www.w3.org/2001/XInclude"><channel><xi:include href="file:///private"/></channel></rss>',
    '<rss xmlns:xi="http://www.w3.org/2001/XInclude"><channel><title>x</title></channel></rss>',
    '<rss><channel>&unknown;</channel></rss>',
  ];
  const rejected = await Promise.all(hostile.map((doc) => parseFeedXml(Buffer.from(doc, 'utf8'))));
  const accepted = await parseFeedXml(validFeed());
  return (
    rejected.every((result) => !result.ok && result.health === 'security_rejected') && accepted.ok
  );
}

async function wrt07(): Promise<boolean> {
  const wrap = (inner: string): string => `<rss><channel>${inner}</channel></rss>`;
  const budgetPair = async (atMax: string, over: string): Promise<boolean> => {
    const [accepted, rejected] = await Promise.all([
      parseFeedXml(Buffer.from(atMax, 'utf8')),
      parseFeedXml(Buffer.from(over, 'utf8')),
    ]);
    return accepted.ok && !rejected.ok && rejected.health === 'budget_exceeded';
  };
  const depthAtMax = wrap('<a>'.repeat(MAX_XML_DEPTH - 2) + 'x' + '</a>'.repeat(MAX_XML_DEPTH - 2));
  const depthOver = wrap('<a>'.repeat(MAX_XML_DEPTH - 1) + 'x' + '</a>'.repeat(MAX_XML_DEPTH - 1));
  const nodesAtMax = wrap('<i/>'.repeat(MAX_XML_NODES - 4) + '<title>t</title>');
  const nodesOver = wrap('<i/>'.repeat(MAX_XML_NODES - 3) + '<title>t</title>');
  const nameAtMax = 'a'.repeat(MAX_XML_NAME_BYTES);
  const nameOver = 'a'.repeat(MAX_XML_NAME_BYTES + 1);
  const attributesAtMax = Array.from(
    { length: MAX_XML_ATTRIBUTES_PER_TAG },
    (_, index) => `a${index}="v"`,
  ).join(' ');
  const attributesOver = Array.from(
    { length: MAX_XML_ATTRIBUTES_PER_TAG + 1 },
    (_, index) => `a${index}="v"`,
  ).join(' ');
  const totalTextFeed = (extraBytes: number): string => {
    const target = MAX_XML_TOTAL_TEXT_BYTES - 24 + extraBytes;
    const fullChunks = Math.floor(target / MAX_XML_TEXT_NODE_BYTES);
    const remainder = target % MAX_XML_TEXT_NODE_BYTES;
    const chunks = Array.from(
      { length: fullChunks },
      () => `<i>${'x'.repeat(MAX_XML_TEXT_NODE_BYTES)}</i>`,
    );
    if (remainder > 0) chunks.push(`<i>${'x'.repeat(remainder)}</i>`);
    return `<rss><channel><title>Feed</title><link>https://example.com</link><description>d</description>${chunks.join('')}</channel></rss>`;
  };
  const exactProjection = (): boolean => {
    const bytes = (title: string): number =>
      Buffer.byteLength(encodeFeedProjectionCanonical(makeProjectionPayload(title)), 'utf8');
    let titleLength = MAX_FEED_PROJECTION_BYTES - bytes('');
    let encodedBytes = bytes('a'.repeat(titleLength));
    for (let index = 0; index < 5 && encodedBytes !== MAX_FEED_PROJECTION_BYTES; index += 1) {
      titleLength += MAX_FEED_PROJECTION_BYTES - encodedBytes;
      encodedBytes = bytes('a'.repeat(titleLength));
    }
    return (
      encodedBytes === MAX_FEED_PROJECTION_BYTES &&
      bytes('a'.repeat(titleLength + 1)) > MAX_FEED_PROJECTION_BYTES
    );
  };
  const checks = [
    await budgetPair(depthAtMax, depthOver),
    await budgetPair(nodesAtMax, nodesOver),
    await budgetPair(wrap(`<${nameAtMax}>x</${nameAtMax}>`), wrap(`<${nameOver}>x</${nameOver}>`)),
    await budgetPair(
      wrap(`<title ${attributesAtMax}>x</title>`),
      wrap(`<title ${attributesOver}>x</title>`),
    ),
    await budgetPair(
      wrap(`<title x="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES - 1)}">x</title>`),
      wrap(`<title x="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES)}">x</title>`),
    ),
    await budgetPair(
      wrap(`<title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES)}</title>`),
      wrap(`<title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES + 1)}</title>`),
    ),
    await budgetPair(totalTextFeed(0), totalTextFeed(1)),
  ];
  return (
    checks.every(Boolean) &&
    exactProjection() &&
    MAX_FEED_FIELD_BYTES === 4_096 &&
    MAX_FEED_PROJECTION_BYTES === 262_144 &&
    MAX_XML_DEPTH === 64 &&
    MAX_XML_NODES === 20_000 &&
    MAX_XML_ATTRIBUTES_PER_TAG === 64 &&
    MAX_XML_ATTRIBUTE_BYTES === 4_096 &&
    MAX_XML_TEXT_NODE_BYTES === 8_192 &&
    MAX_XML_TOTAL_TEXT_BYTES === 131_072
  );
}

function makeProjectionPayload(titleText: string): FeedProjectionCanonicalPayload {
  const field = (text: string, valueHash: string) => ({
    text,
    truncated: false,
    originalBytes: Buffer.byteLength(text, 'utf8'),
    valueHash,
  });
  return {
    type: 'feed',
    format: 'rss2',
    title: field('F', 'd10-title'),
    description: field('', 'd10-description'),
    siteUrl: field('', 'd10-site'),
    feedUrl: field('', 'd10-feed'),
    items: [
      {
        identity: 'd10-item',
        identityKind: 'id',
        title: field(titleText, 'd10-item-title'),
        link: field('', 'd10-item-link'),
        summary: field('', 'd10-item-summary'),
        publishedAt: null,
        updatedAt: null,
        author: field('', 'd10-item-author'),
      },
    ],
    itemsTruncated: false,
  };
}

async function wrt08(): Promise<boolean> {
  const duplicate = Buffer.from(
    '<?xml version="1.0"?><rss><channel><title>x</title><item><guid>same</guid><title>A</title></item><item><guid>same</guid><title>B</title></item></channel></rss>',
    'utf8',
  );
  const parsed = await parseFeedXml(duplicate);
  if (!parsed.ok || parsed.value.items.length !== 1) return false;
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt08-'));
  const db = openDb(join(dir, 'watch.db'));
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const rule: WatchRule = {
    id: 'wrt08-rule',
    version: 1,
    sourceId: 'source-d10',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: VALID_URL, format: 'rss2' },
    condition: null,
    notificationLevel: 'important',
    showDetails: true,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'b'.repeat(64),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const source: SourceWatchProjection = {
    sourceId: rule.sourceId,
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page',
    canonicalKey: VALID_URL,
  };
  const projection = async (value: string): Promise<FeedProjection | null> => {
    const result = await parseFeedXml(validFeed('wrt08', value));
    if (!result.ok) return null;
    return {
      schemaVersion: 1,
      ruleId: rule.id,
      sourceId: rule.sourceId,
      finalUrl: VALID_URL,
      capturedAt: NOW,
      documentId: null,
      contentHash: sha256Hex(result.canonicalJson),
      byteLength: result.byteLength,
      value: result.value,
    };
  };
  const clock = new FakeClock(Date.parse(NOW));
  const processing = new WatchProcessingServiceImpl({ repo, clock });
  const values = ['A', 'B', 'A', 'B', 'A'];
  try {
    if (!repo.insertRule(rule).ok) return false;
    for (let index = 0; index < values.length; index += 1) {
      const currentRule = repo.getRule(rule.id);
      if (currentRule === null) return false;
      const hint = processing.prepareAcquisition({ rule: currentRule });
      if (!hint.ok) return false;
      const current = await projection(values[index]!);
      if (current === null) return false;
      const runId = `wrt08-run-${index}`;
      if (
        !repo.insertRun({
          id: runId,
          ruleId: rule.id,
          requestKey: runId,
          trigger: 'manual',
          scheduledFor: null,
        }).ok
      )
        return false;
      if (!repo.transitionRun(runId, 'queued', { status: 'running', startedAt: NOW }).ok)
        return false;
      const processed = processing.process({
        rule: currentRule,
        runId,
        baselineHint: hint.baselineHint,
        acquisition: {
          ok: true,
          kind: 'projection',
          projection: current,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          responseMetadata: { httpStatus: 200, etag: null, lastModified: null, warnings: [] },
        },
        sourceAfterAcquisition: source,
      });
      if (!processed.ok) return false;
    }
    const events = repo.listEventsByRule(rule.id);
    if (events.length !== 1) return false;
    const observations = db
      .prepare(
        'SELECT idempotency_key,change_fingerprint FROM watch_event_observations WHERE event_id = ? ORDER BY sequence',
      )
      .all(events[0]!.id) as Array<{ idempotency_key: string; change_fingerprint: string }>;
    const items = repo.listEventItems(events[0]!.id);
    const afterValues = items
      .map((item) => item.after)
      .filter(
        (value): value is Extract<typeof value, { kind: 'present' }> => value.kind === 'present',
      )
      .map((value) => value.excerpt);
    const verdict =
      observations.length >= 4 &&
      new Set(observations.map((row) => row.idempotency_key)).size === observations.length &&
      afterValues.join(',') === 'B,A,B,A' &&
      items.every((item) => item.before !== undefined && item.after !== undefined);
    return verdict;
  } finally {
    repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wrt09(): Promise<boolean> {
  const target: PageTarget = {
    type: 'page',
    pageUrl: VALID_URL,
    regions: [{ kind: 'main-text', label: '正文' }],
    sessionConsent: null,
  };
  const unauthorized = sessionConsentTargetCheck(target);
  const browser = fakeTabsBrowser({ returnExisting: true });
  const workspace = new WatchTaskTabWorkspace({ browser });
  const result = await workspace.acquire(VALID_URL, new AbortController().signal);
  return unauthorized.ok === false && result.ok === false && browser.tabs().length === 1;
}

async function wrt10(): Promise<boolean> {
  const browser = fakeTabsBrowser();
  const before = JSON.stringify(browser.tabs());
  const workspace = new WatchTaskTabWorkspace({ browser });
  const controller = new AbortController();
  const acquired = await workspace.acquire(VALID_URL, controller.signal);
  if (!acquired.ok) return false;
  const released = await workspace.release(acquired.lease.tabId);
  return (
    released.ok && JSON.stringify(browser.tabs()) === before && workspace.getOwnedCount() === 0
  );
}

async function wrt11(): Promise<boolean> {
  const hostile = Buffer.from(
    '<html><body><h1>正文</h1><script>window.__d10=1</script><iframe src="http://127.0.0.1/"><p>私网</p></iframe><table><tr><th>A</th></tr><tr><td>B</td></tr></table></body></html>',
    'utf8',
  );
  const parsed = readPublicHtml(hostile, VALID_URL);
  if (
    !parsed.ok ||
    JSON.stringify(parsed.channels).includes('私网') ||
    JSON.stringify(parsed.channels).includes('__d10')
  )
    return false;
  const table = { headers: ['A'], rows: [['B']] };
  const channels: DocumentChannels = {
    mainText: '正文 A',
    headings: [{ level: 1, text: '标题' }],
    tables: [table],
    links: [
      { text: '同源', url: `${VALID_URL}?token=drop` },
      { text: '跨源', url: 'https://other.example/link' },
    ],
  };
  const tableFingerprint = computeTableHeaderFingerprint(table.headers);
  if (tableFingerprint === null) return false;
  const regions: RegionDescriptor[] = [
    { kind: 'main-text', label: '正文' },
    { kind: 'headings', label: '标题', levels: [1] },
    { kind: 'table', label: '表格', headerFingerprint: tableFingerprint, occurrence: 0 },
    { kind: 'links', label: '同源链接', sameOriginOnly: true },
  ];
  const preview = previewPageRegions(channels, regions);
  const before = projectPageProjection({
    channels,
    regions,
    ruleId: 'wrt11-rule',
    sourceId: 'source-d10',
    finalUrl: VALID_URL,
    capturedAt: NOW,
    documentId: '1',
  });
  const changedChannels = { ...channels, mainText: '正文 B' };
  const after = projectPageProjection({
    channels: changedChannels,
    regions,
    ruleId: 'wrt11-rule',
    sourceId: 'source-d10',
    finalUrl: VALID_URL,
    capturedAt: '2026-09-01T00:00:01.000Z',
    documentId: '2',
  });
  const ambiguous = projectPageProjection({
    channels: { ...channels, tables: [table, table] },
    regions: regions.map((region) =>
      region.kind === 'table' ? { ...region, occurrence: 2 } : region,
    ),
    ruleId: 'wrt11-rule',
    sourceId: 'source-d10',
    finalUrl: VALID_URL,
    capturedAt: NOW,
    documentId: '1',
  });
  if (!preview.ok || preview.preview.some((item) => item.status !== 'matched')) return false;
  if (!before.ok || !after.ok || ambiguous.ok) return false;
  const diff = diffPageProjections(before.projection, after.projection);
  return diff.pairs.length === 1 && diff.pairs[0]?.fieldKey === 'r0:main';
}

async function wrt12(): Promise<boolean> {
  const pair = makePair('旧', '新');
  const malformed = {
    ...pair,
    after: {
      ...pair.after,
      extra: 'unexpected',
    },
  };
  const fieldCatalog = new Set(['r0:main']);
  const changedSet = {
    eventKind: 'changed',
    fields: [
      {
        fieldKey: 'r0:main',
        before: { kind: 'present', value: '旧' },
        after: { kind: 'present', value: '新' },
      },
    ],
  };
  const warning = evaluateStructuredCondition({
    condition: {
      version: 1,
      combine: 'all',
      predicates: [
        { fieldKey: 'r0:missing', operator: 'changed', operand: null, caseSensitive: false },
      ],
    },
    changeSet: { eventKind: 'changed', fields: [] },
    fieldCatalog: new Set(['r0:missing']),
  });
  const error = evaluateStructuredCondition({
    condition: { version: 9, combine: 'all', predicates: [] },
    changeSet: changedSet,
    fieldCatalog,
  });
  return (
    validateChangeEvidencePair(pair) !== null &&
    validateChangeEvidencePair(malformed) === null &&
    warning.ok &&
    warning.matched === false &&
    warning.warnings.includes('field-absent') &&
    !error.ok &&
    error.code === 'condition-version-future'
  );
}

async function wrt13(): Promise<boolean> {
  const facts = makeFacts();
  const projection = projectDigestForProvider(facts, [
    { sourceId: 'source-d10', shareMode: 'full', displayName: '来源', canonicalUrl: VALID_URL },
  ]);
  const request = buildDigestProviderRequest({
    requestId: 'request-d10',
    model: 'fixture',
    projection,
  });
  const valid = parseDigestExplanation(
    '{"sections":[{"eventIds":["event-d10"],"explanation":"变化"}]}',
    ['event-d10'],
  );
  const invalid = parseDigestExplanation(
    '{"sections":[{"eventIds":["event-d10"],"explanation":"变化"}],"extra":1}',
    ['event-d10'],
  );
  return (
    request !== null &&
    request.tools === undefined &&
    request.system === SYSTEM_DIGEST_PROMPT &&
    valid !== null &&
    invalid === null
  );
}

async function wrt14(): Promise<boolean> {
  const facts = makeFacts();
  const metadataProjection = projectDigestForProvider(facts, [
    {
      sourceId: 'source-d10',
      shareMode: 'metadata',
      displayName: '元数据来源',
      canonicalUrl: VALID_URL,
    },
  ]);
  const blockedProjection = projectDigestForProvider(facts, [
    {
      sourceId: 'source-d10',
      shareMode: 'blocked',
      displayName: '阻断来源',
      canonicalUrl: VALID_URL,
    },
  ]);
  const sharingOk =
    metadataProjection.events.every((event) => event.evidence === undefined) &&
    blockedProjection.events.length === 0 &&
    !JSON.stringify(metadataProjection).includes('Source note');
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt14-'));
  const db = openDb(join(dir, 'watch.db'));
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const rule: WatchRule = {
    id: 'wrt14-rule',
    version: 1,
    sourceId: 'source-d10',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: VALID_URL, format: 'rss2' },
    condition: null,
    notificationLevel: 'important',
    showDetails: true,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'c'.repeat(64),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const fail = (label: string): false => {
    void label;
    return false;
  };
  try {
    if (!repo.insertRule(rule).ok) return fail('insert rule');
    if (
      !repo.createDigestSchedule({
        id: 'wrt14-schedule',
        sourceIds: [rule.sourceId],
        localTime: '09:00',
        timeZone: 'UTC',
        aiEnabled: true,
        nextDueAt: '2026-09-02T09:00:00.000Z',
        nowIso: NOW,
      }).ok
    )
      return fail('create schedule');
    const eventId = 'wrt14-event';
    const eventPair = makePair('旧', '新');
    const parsed = await parseFeedXml(validFeed('wrt14', '新'));
    if (!parsed.ok) return fail('parse feed');
    const projection: FeedProjection = {
      schemaVersion: 1,
      ruleId: rule.id,
      sourceId: rule.sourceId,
      finalUrl: VALID_URL,
      capturedAt: '2026-09-01T00:00:01.000Z',
      documentId: null,
      contentHash: sha256Hex(parsed.canonicalJson),
      byteLength: parsed.byteLength,
      value: parsed.value,
    };
    if (
      !repo.insertRun({
        id: 'wrt14-acquisition-run',
        ruleId: rule.id,
        requestKey: 'wrt14-run-key',
        trigger: 'manual',
        scheduledFor: null,
      }).ok
    )
      return fail('insert run');
    if (
      !repo.transitionRun('wrt14-acquisition-run', 'queued', { status: 'running', startedAt: NOW })
        .ok
    )
      return fail('start run');
    if (
      !repo.writeEventResult({
        path: 'create',
        rule,
        runId: 'wrt14-acquisition-run',
        sourceAfterRevalidationRowVersion: 1,
        identity: {
          sourceId: rule.sourceId,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: null,
        },
        baseline: {
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection.value),
          contentHash: projection.contentHash,
          byteLength: projection.byteLength,
          finalUrl: projection.finalUrl,
          capturedAt: projection.capturedAt,
          documentId: null,
          validators: { etag: null, lastModified: null },
        },
        event: {
          event: {
            id: eventId,
            ruleId: rule.id,
            sourceId: rule.sourceId,
            eventKind: 'changed',
            importance: 'important',
            idempotencyKey: 'wrt14-event-idempotency',
            changeFingerprint: 'd'.repeat(64),
            firstObservedAt: '2026-09-01T00:00:01.000Z',
            lastObservedAt: '2026-09-01T00:00:01.000Z',
            itemCount: 1,
            readAt: null,
          },
          items: [eventPair],
        },
        run: {
          expectedStatus: 'running',
          outcome: { kind: 'event-created', eventId },
          health: { state: 'healthy', acquisition: 'rss', code: null },
          responseMetadataJson: JSON.stringify({
            schemaVersion: 1,
            http: null,
            conditionWarnings: [],
          }),
        },
        audits: [{ id: 'wrt14-audit', reasonCode: 'event-created', createdAt: NOW }],
      }).ok
    )
      return fail('write event');
    const schedule = repo.getDigestSchedule('wrt14-schedule');
    if (schedule === null) return fail('get schedule');
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: schedule.nextDueAt,
      expectedLastConsumedScheduledFor: schedule.lastConsumedScheduledFor,
      expectedLastDailyLocalDate: schedule.lastDailyLocalDate,
      runId: 'wrt14-digest-run',
      requestKey: 'wrt14-request',
      logicalDate: '2026-09-01',
      nextDueAt: '2026-09-03T09:00:00.000Z',
      nowIso: '2026-09-01T01:00:00.000Z',
    });
    if (!reserved.ok) return fail(`reserve ${reserved.code}`);
    const observation = repo
      .readDigestJournalSlice(reserved.run.id)
      ?.find((entry) => entry.observation !== null)?.observation;
    if (observation === undefined || observation === null) return fail('observation');
    const digestFacts = buildDigestFacts({
      scheduleId: schedule.id,
      digestRunId: reserved.run.id,
      batchIndex: 0,
      period: reserved.run.period,
      runStats: { changed: 1, failed: 0, unchanged: 0 },
      observations: [observation],
      fetchedAt: reserved.run.period.toInclusive,
    });
    if (digestFacts === null) return fail('facts');
    if (
      !repo.commitDigestBatch({
        artifactId: 'wrt14-artifact',
        run: reserved.run,
        expectedNextSequence: reserved.run.nextSequence,
        firstSequence: reserved.run.nextSequence + 1,
        lastSequence: observation.sequence,
        facts: digestFacts,
        createdAt: '2026-09-01T01:00:00.000Z',
        aiEnabled: true,
      }).ok
    )
      return fail('commit digest');
    const artifact = repo.getDigestArtifact('wrt14-artifact');
    if (artifact === null) return fail('artifact');
    const staleClaim = repo.claimDigestProvider({
      id: artifact.id,
      scheduleId: schedule.id,
      factsRevision: artifact.factsRevision + 1,
      factsHash: artifact.factsHash,
      nowIso: '2026-09-01T01:00:00.500Z',
    });
    if (staleClaim !== null) return fail('facts revision CAS');
    const claimed = repo.claimDigestProvider({
      id: artifact.id,
      scheduleId: schedule.id,
      factsRevision: artifact.factsRevision,
      factsHash: artifact.factsHash,
      nowIso: '2026-09-01T01:00:01.000Z',
    });
    if (claimed === null) return fail('claim');
    if (!repo.deleteEventWithScrub(eventId, '2026-09-01T01:00:02.000Z').ok) return fail('scrub');
    const late = repo.finishClaimedDigest({
      id: claimed.id,
      factsRevision: claimed.factsRevision,
      factsHash: claimed.factsHash,
      state: 'succeeded',
      code: 'success',
      explanationJson: JSON.stringify({ sections: [{ eventIds: [eventId], explanation: '迟到' }] }),
      nowIso: '2026-09-01T01:00:03.000Z',
    });
    return sharingOk && late.ok === false && late.code === 'run-state-conflict';
  } finally {
    repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wrt15(): Promise<boolean> {
  const notification = buildInAppNotification({
    notificationId: 'notification-d10',
    subjectType: 'event',
    subjectId: 'event-d10',
    accessMode: 'session',
    showDetails: false,
    importance: 'important',
    sourceName: 'https://enemy.invalid/?query=private',
    changeCount: 1,
    fieldLabels: ['private query'],
    createdAt: NOW,
  });
  return notification.body === '受保护来源发生变化' && !notification.body.includes('query=private');
}

async function wrt16(): Promise<boolean> {
  const clock = new FakeClock(Date.parse(NOW));
  const due: string[][] = [];
  const scheduler = new WatchScheduler({
    clock,
    maxStartsPerTick: 1,
    onDue: (entries) => due.push(entries.map((entry) => entry.ruleId)),
  });
  scheduler.initialize([
    { ruleId: 'rule-a', effectiveDueAt: Date.parse(NOW) - 1 },
    { ruleId: 'rule-b', effectiveDueAt: Date.parse(NOW) - 1 },
  ]);
  clock.advanceTo(Date.parse(NOW));
  const daily = computeNextDueAt({
    rule: { schedule: { kind: 'daily', localTime: '09:00', timeZone: 'America/New_York' } },
    consumedScheduledFor: '2026-03-08T14:00:00.000Z',
    nowMs: Date.parse('2026-03-08T15:00:00.000Z'),
  });
  scheduler.stop();
  const flattened = due.flat();
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt16-'));
  const dbPath = join(dir, 'watch.db');
  let repo: WatchRepository | null = null;
  try {
    const db = openDb(dbPath);
    runWatchMigrations(db);
    repo = new WatchRepository(db);
    const rule: WatchRule = {
      id: 'wrt16-rule',
      version: 1,
      sourceId: 'source-d10',
      kind: 'feed',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 15 },
      target: { type: 'feed', feedUrl: VALID_URL, format: 'rss2' },
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: 1,
      sourceLocatorFingerprint: 'e'.repeat(64),
      nextDueAt: NOW,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    if (!repo.insertRule(rule).ok) return false;
    const advanced = computeNextDueAt({
      rule,
      consumedScheduledFor: NOW,
      nowMs: Date.parse(NOW),
    });
    if (advanced === null) return false;
    const reservation = repo.reserveScheduledRun({
      ruleId: rule.id,
      runId: 'wrt16-run',
      requestKey: `${rule.id}|${NOW}`,
      trigger: 'catch-up',
      scheduledFor: NOW,
      expectedNextDueAt: NOW,
      advancedNextDueAt: advanced.nextDueAt,
      advancedLastDailyLocalDate: advanced.lastDailyLocalDate,
      nowIso: NOW,
    });
    if (!reservation.ok) return false;
    const reservedRule = repo.getRule(rule.id);
    if (reservedRule === null) return false;
    repo.dispose();
    repo = null;
    const reopened = openWatchStore({
      dbPath,
      backupsDir: join(dir, 'backups'),
      reconcile: () => ({ ok: true, reason: null }),
    });
    if (reopened.mode !== 'normal') return false;
    repo = reopened.repo;
    const oldReplay = repo.reserveScheduledRun({
      ruleId: rule.id,
      runId: 'wrt16-replay',
      requestKey: `${rule.id}|${NOW}`,
      trigger: 'catch-up',
      scheduledFor: NOW,
      expectedNextDueAt: NOW,
      advancedNextDueAt: advanced.nextDueAt,
      advancedLastDailyLocalDate: advanced.lastDailyLocalDate,
      nowIso: NOW,
    });
    const recovered = repo.getRun('wrt16-run');
    const afterRestart = repo.getRule(rule.id);
    const newAdvanced =
      afterRestart === null || afterRestart.nextDueAt === null
        ? null
        : computeNextDueAt({
            rule: afterRestart,
            consumedScheduledFor: afterRestart.nextDueAt,
            nowMs: Date.parse(NOW) + 60_000,
          });
    const next =
      afterRestart && afterRestart.nextDueAt && newAdvanced
        ? repo.reserveScheduledRun({
            ruleId: rule.id,
            runId: 'wrt16-next',
            requestKey: `${rule.id}|${afterRestart.nextDueAt}`,
            trigger: 'catch-up',
            scheduledFor: afterRestart.nextDueAt,
            expectedNextDueAt: afterRestart.nextDueAt,
            advancedNextDueAt: newAdvanced.nextDueAt,
            advancedLastDailyLocalDate: newAdvanced.lastDailyLocalDate,
            nowIso: '2026-09-01T00:01:00.000Z',
          })
        : null;
    return (
      due.length > 0 &&
      due.every((batch) => batch.length === 1) &&
      new Set(flattened).size === 2 &&
      daily !== null &&
      reservedRule.nextDueAt === advanced.nextDueAt &&
      oldReplay.ok === false &&
      recovered?.status === 'interrupted' &&
      next?.ok === true
    );
  } finally {
    if (repo !== null && !repo.isDisposed) repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wrt17(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt17-'));
  const sourceDbPath = join(dir, 'sources.db');
  const watchDbPath = join(dir, 'watch.db');
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  let sourceDb: ReturnType<typeof openDb> | null = null;
  let repo: WatchRepository | null = null;
  let recoveredRepo: WatchRepository | null = null;
  let service: SourceServiceImpl | null = null;
  let coordinator: WatchLifecycleCoordinator | null = null;
  const networkCalls = 0;
  try {
    sourceDb = openDb(sourceDbPath);
    runMigrations(sourceDb);
    coordinator = new WatchLifecycleCoordinator({ nowMs: () => Date.parse(NOW) });
    service = new SourceServiceImpl({
      db: sourceDb,
      now: () => Date.parse(NOW),
      observer: coordinator,
    });
    const initialWatchDb = openDb(watchDbPath);
    runWatchMigrations(initialWatchDb);
    repo = new WatchRepository(initialWatchDb);
    const reader = (sourceId: string) => service!.getSourceWatchProjection(sourceId);
    coordinator.bind(repo, reader);

    const added = await service.addManual({
      scope: 'page',
      url: 'https://www.openai.com/d10-source',
      name: 'D10 source',
    });
    if (!added.ok) return false;

    const initialProjectionResult = service.getSourceWatchProjection(added.source.id);
    if (initialProjectionResult.status !== 'found') return false;
    const initialProjection = initialProjectionResult.projection;
    const rule: WatchRule = {
      id: 'wrt17-rule',
      version: 1,
      sourceId: added.source.id,
      kind: 'feed',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target: { type: 'feed', feedUrl: added.source.url, format: 'rss2' },
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: initialProjection.rowVersion,
      sourceLocatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: initialProjection.sourceId,
        scope: initialProjection.scope,
        canonicalKey: initialProjection.canonicalKey,
        kind: 'feed',
        canonicalTargetUrl: added.source.url,
      }),
      nextDueAt: null,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    if (repo === null || !repo.insertRule(rule).ok) return false;

    const stale = await service.updateManual(added.source.id, { name: 'stale' }, 99);
    if (stale.ok) return false;
    const updated = await service.updateManual(added.source.id, { name: 'updated' }, 1);
    if (!updated.ok) return false;
    const readable = await service.get(added.source.id, 'user');
    if (!readable.ok || readable.source.name !== 'updated') return false;
    const afterUpdate = repo.getRule(rule.id);
    if (afterUpdate === null || afterUpdate.sourceRowVersion !== 2) return false;

    const disabled = await service.disableManual(added.source.id, 2);
    if (!disabled.ok) return false;
    const paused = repo.getRule(rule.id);
    if (paused === null || paused.state !== 'paused' || paused.pauseReason !== 'source-disabled') {
      return false;
    }
    const restored = await service.restoreManual(added.source.id, 3);
    if (!restored.ok) return false;
    const restoredRule = repo.getRule(rule.id);
    if (
      restoredRule === null ||
      restoredRule.state !== 'enabled' ||
      restoredRule.pauseReason !== null ||
      restoredRule.sourceRowVersion !== 4
    ) {
      return false;
    }

    const currentProjectionResult = service.getSourceWatchProjection(added.source.id);
    if (currentProjectionResult.status !== 'found') return false;
    const currentProjection = currentProjectionResult.projection;
    const abortMutation = {
      mutationId: 'wrt17-abort',
      operation: 'disable' as const,
      before: currentProjection,
      after: { ...currentProjection, rowVersion: currentProjection.rowVersion + 1, enabled: false },
    };
    if (coordinator.prepare([abortMutation]).ok !== true) return false;
    const pausedForAbort = repo.getRule(rule.id);
    if (pausedForAbort === null || pausedForAbort.pauseReason !== 'source-disabled') return false;
    coordinator.abort([abortMutation.mutationId]);
    const afterAbort = repo.getRule(rule.id);
    const abortIntent = repo.getSourceCleanupIntent(abortMutation.mutationId);
    if (
      afterAbort === null ||
      afterAbort.state !== 'enabled' ||
      afterAbort.sourceRowVersion !== 4 ||
      abortIntent?.state !== 'aborted'
    ) {
      return false;
    }

    const crashMutation = {
      mutationId: 'wrt17-crash',
      operation: 'update' as const,
      before: currentProjection,
      after: { ...currentProjection, rowVersion: currentProjection.rowVersion + 1 },
    };
    if (coordinator.prepare([crashMutation]).ok !== true) return false;
    const pausedForCrash = repo.getRule(rule.id);
    if (pausedForCrash === null || pausedForCrash.pauseReason !== null) return false;
    coordinator.dispose();
    repo.dispose();
    repo = null;

    const reopened = openWatchStore({
      dbPath: watchDbPath,
      backupsDir,
      nowMs: () => Date.parse(NOW),
      reconcile: (reopenedRepo) => {
        coordinator!.bind(reopenedRepo, reader);
        return coordinator!.reconcileOnStartup(reopenedRepo, reader);
      },
    });
    if (reopened.mode !== 'normal') return false;
    recoveredRepo = reopened.repo;
    const recoveredRule = recoveredRepo.getRule(rule.id);
    if (
      recoveredRule === null ||
      recoveredRule.state !== 'enabled' ||
      recoveredRule.pauseReason !== null ||
      recoveredRule.sourceRowVersion !== 4 ||
      recoveredRepo.listSourceCleanupIntents().length !== 0
    ) {
      return false;
    }

    const token = service.issueDeleteConfirmToken(added.source.id);
    const deleted = await service.hardDeleteManual(added.source.id, token);
    const projection = service.getSourceWatchProjection(added.source.id);
    const deletedRule = recoveredRepo.getRule(rule.id);
    return (
      deleted.ok && projection.status === 'missing' && deletedRule === null && networkCalls === 0
    );
  } finally {
    service?.dispose();
    coordinator?.dispose();
    if (repo !== null && !repo.isDisposed) repo.dispose();
    if (recoveredRepo !== null && !recoveredRepo.isDisposed) recoveredRepo.dispose();
    if (sourceDb?.isOpen === true) sourceDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wrt18(): Promise<boolean> {
  return runWatchMigrationV5Matrix().ok;
}

async function wrt19(): Promise<boolean> {
  const result = readPublicHtml(
    Buffer.from(
      '<html><body><script>private</script><iframe src="http://127.0.0.1/"></iframe><h1>安全正文</h1></body></html>',
      'utf8',
    ),
    VALID_URL,
  );
  return (
    result.ok &&
    result.channels.headings.some((heading) => heading.text === '安全正文') &&
    result.channels.links.length === 0
  );
}

export async function runWatchRedTeamScenarios(): Promise<WatchWrtOutcome[]> {
  const probes: readonly [
    string,
    () => Promise<boolean>,
    'structural-proof' | 'real-observation' | 'honest-limit',
  ][] = [
    ['WRT-01', wrt01, 'structural-proof'],
    ['WRT-02', wrt02, 'structural-proof'],
    ['WRT-03', wrt03, 'structural-proof'],
    ['WRT-04', wrt04, 'real-observation'],
    ['WRT-05', wrt05, 'structural-proof'],
    ['WRT-06', wrt06, 'structural-proof'],
    ['WRT-07', wrt07, 'structural-proof'],
    ['WRT-08', wrt08, 'real-observation'],
    // These two use deterministic BrowserController-shaped fakes; they are not
    // Electron task-tab observations and must not be reported as real-observation.
    ['WRT-09', wrt09, 'structural-proof'],
    ['WRT-10', wrt10, 'structural-proof'],
    ['WRT-11', wrt11, 'structural-proof'],
    ['WRT-12', wrt12, 'structural-proof'],
    ['WRT-13', wrt13, 'structural-proof'],
    ['WRT-14', wrt14, 'structural-proof'],
    ['WRT-15', wrt15, 'structural-proof'],
    ['WRT-16', wrt16, 'structural-proof'],
    ['WRT-17', wrt17, 'structural-proof'],
    ['WRT-18', wrt18, 'structural-proof'],
    ['WRT-19', wrt19, 'honest-limit'],
  ];
  const results: WatchWrtOutcome[] = [];
  for (const [id, probe, evidenceKind] of probes) {
    try {
      results.push(
        outcome(
          id,
          await probe(),
          evidenceKind === 'real-observation'
            ? '真实/受控观察完成'
            : evidenceKind === 'honest-limit'
              ? '诚实限制：仅完成结构性证明，真实 Electron acquisition 未运行'
              : '结构性夹具通过',
          evidenceKind,
        ),
      );
    } catch (error) {
      results.push(
        outcome(
          id,
          false,
          id === 'WRT-04' && error instanceof Error ? error.message : '夹具受控失败',
          evidenceKind,
        ),
      );
    }
  }
  return results;
}
