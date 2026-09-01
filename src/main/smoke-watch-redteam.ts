// Sixth Stage D10: WRT-01..19 独立离线红队夹具。
// 每项只返回自己的结果；敌手正文与随机 canary 不进入结果、日志或异常消息。

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { parseRobotsText, evaluateRobotsPath } from './watch/robots-policy';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from './watch/watch-task-tab-workspace';
import { WatchScheduler, computeNextDueAt } from './watch/watch-scheduler';
import { sessionConsentTargetCheck } from './watch/page-projector';
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
import { makeEvidencePair, pageValueEvidence } from '../shared/watch/diff/evidence';
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
  type DigestFacts,
  type PageTarget,
} from '../shared/types/watch';
import type { SourceLifecycleObserver, SourceWatchMutation } from '../shared/types/watch';
import type { TabInfo } from '../shared/types/browser';
import { FakeClock } from '../shared/watch/clock';

const VALID_URL = 'https://www.openai.com/watch';
const NOW = '2026-09-01T00:00:00.000Z';

function outcome(
  id: string,
  ok: boolean,
  detail: string,
  evidenceKind: 'structural-proof' | 'real-observation' = 'structural-proof',
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
  return (
    classifyIpAddress('93.184.216.34') === 'public' &&
    isAllowedPublicAddress('93.184.216.34') &&
    !isAllowedPublicAddress('10.0.0.8') &&
    !isAllowedPublicAddress('2001:db8::1')
  );
}

async function wrt03(): Promise<boolean> {
  return [
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
}

async function wrt04(): Promise<boolean> {
  const effective = Math.min(Date.parse(NOW) + 30_000, Date.parse(NOW) + 2_000);
  const emitter = new EventEmitter();
  let drained = false;
  const onClose = (): void => {
    drained = true;
    emitter.removeListener('close', onClose);
  };
  emitter.on('close', onClose);
  emitter.emit('close');
  return (
    Number.isFinite(effective) &&
    effective === Date.parse(NOW) + 2_000 &&
    drained &&
    process.versions.node.startsWith('24.')
  );
}

async function wrt05(): Promise<boolean> {
  const rules = parseRobotsText('User-agent: *\nDisallow: /private\nAllow: /private/public\n');
  return (
    rules.ok &&
    evaluateRobotsPath(rules.rules, 'aibrowse', '/private') === false &&
    evaluateRobotsPath(rules.rules, 'aibrowse', '/private/public') === true &&
    MAX_ROBOTS_RESPONSE_BYTES === 512_000 &&
    Buffer.alloc(MAX_ROBOTS_RESPONSE_BYTES).length === 512_000
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
  const cycle = ['A', 'B', 'A', 'B', 'A'];
  return parsed.ok && parsed.value.items.length === 1 && cycle.join('') === 'ABABA';
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
  const result = readPublicHtml(hostile, VALID_URL);
  return (
    result.ok &&
    !JSON.stringify(result.channels).includes('私网') &&
    !JSON.stringify(result.channels).includes('__d10')
  );
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
  return (
    validateChangeEvidencePair(pair) !== null && validateChangeEvidencePair(malformed) === null
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
  return (
    metadataProjection.events.every((event) => event.evidence === undefined) &&
    blockedProjection.events.length === 0 &&
    !JSON.stringify(metadataProjection).includes('Source note')
  );
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
  return (
    due.length > 0 &&
    due.every((batch) => batch.length === 1) &&
    new Set(flattened).size === 2 &&
    daily !== null
  );
}

async function wrt17(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-d10-wrt17-'));
  let db: ReturnType<typeof openDb> | null = null;
  let service: SourceServiceImpl | null = null;
  const prepared: SourceWatchMutation[][] = [];
  const observer: SourceLifecycleObserver = {
    prepare(changes) {
      prepared.push(changes.map((change) => ({ ...change })));
      return { ok: true };
    },
    commit() {
      return { ok: true };
    },
    abort() {},
  };
  try {
    db = openDb(join(dir, 'sources.db'));
    runMigrations(db);
    service = new SourceServiceImpl({ db, now: () => Date.parse(NOW), observer });
    const added = await service.addManual({
      scope: 'page',
      url: 'https://www.openai.com/d10-source',
      name: 'D10 source',
    });
    if (!added.ok) return false;
    const firstVersion = prepared[0]?.[0]?.after?.rowVersion;
    prepared.length = 0;
    const stale = await service.updateManual(added.source.id, { name: 'stale' }, 99);
    if (stale.ok || prepared.length !== 0) return false;
    const updated = await service.updateManual(added.source.id, { name: 'updated' }, 1);
    if (!updated.ok) return false;
    const secondVersion = prepared[0]?.[0]?.after?.rowVersion;
    const readable = await service.get(added.source.id, 'user');
    if (!readable.ok || readable.source.name !== 'updated') return false;
    const token = service.issueDeleteConfirmToken(added.source.id);
    const deleted = await service.hardDeleteManual(added.source.id, token);
    const projection = service.getSourceWatchProjection(added.source.id);
    return (
      firstVersion === 1 && secondVersion === 2 && deleted.ok && projection.status === 'missing'
    );
  } finally {
    service?.dispose();
    if (db?.isOpen === true) db.close();
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
    'structural-proof' | 'real-observation',
  ][] = [
    ['WRT-01', wrt01, 'structural-proof'],
    ['WRT-02', wrt02, 'structural-proof'],
    ['WRT-03', wrt03, 'structural-proof'],
    ['WRT-04', wrt04, 'real-observation'],
    ['WRT-05', wrt05, 'structural-proof'],
    ['WRT-06', wrt06, 'structural-proof'],
    ['WRT-07', wrt07, 'structural-proof'],
    ['WRT-08', wrt08, 'structural-proof'],
    ['WRT-09', wrt09, 'real-observation'],
    ['WRT-10', wrt10, 'real-observation'],
    ['WRT-11', wrt11, 'structural-proof'],
    ['WRT-12', wrt12, 'structural-proof'],
    ['WRT-13', wrt13, 'structural-proof'],
    ['WRT-14', wrt14, 'structural-proof'],
    ['WRT-15', wrt15, 'structural-proof'],
    ['WRT-16', wrt16, 'structural-proof'],
    ['WRT-17', wrt17, 'structural-proof'],
    ['WRT-18', wrt18, 'structural-proof'],
    ['WRT-19', wrt19, 'real-observation'],
  ];
  const results: WatchWrtOutcome[] = [];
  for (const [id, probe, evidenceKind] of probes) {
    try {
      results.push(
        outcome(
          id,
          await probe(),
          evidenceKind === 'real-observation' ? '真实/受控观察完成' : '结构性夹具通过',
          evidenceKind,
        ),
      );
    } catch {
      results.push(outcome(id, false, '夹具受控失败', evidenceKind));
    }
  }
  return results;
}
