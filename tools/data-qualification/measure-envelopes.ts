// Bundle this offline entry with esbuild for Node. It never opens user data or Electron.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type { DbHandle } from '../../src/main/sources/db/sqlite-driver';
import { WATCH_MIGRATIONS } from '../../src/main/watch/db/watch-migrations';
import { RESEARCH_MIGRATIONS } from '../../src/main/research/db/research-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { MAX_WATCH_DB_BYTES } from '../../src/shared/types/watch';
import { parseMessagesFile } from '../../src/main/ai/conversation-store';
import {
  appendDenseDigest,
  appendDenseEvent,
  insertDenseResearch,
  prepareDigestParents,
  projectedConversationFixture,
  proposedFixedProtocolEnvelope,
} from './envelope-fixtures';
import { jsonShape, populateWatch } from './fixtures';

const root = resolve(process.cwd());
const base = join(root, 'log', 'stage7-e2');
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, 'envelope-'));
const started = performance.now();
const diskBudget = 512 * 1024 ** 2;
const timeBudgetMs = 120_000;
const entries: Record<string, unknown>[] = [];
const sourcePaths = [
  'tools/data-qualification/envelope-fixtures.ts',
  'tools/data-qualification/envelope.test.ts',
  'tools/data-qualification/measure-envelopes.ts',
  'tools/data-qualification/fixtures.ts',
  'src/main/ai/conversation-store.ts',
  'src/shared/types/conversation.ts',
  'src/shared/types/agent.ts',
  'src/main/research/repository/research-repository.ts',
  'src/main/research/result-validator.ts',
  'src/main/research/db/research-migrations.ts',
  'src/shared/types/research.ts',
  'src/main/watch/repository/watch-repository.ts',
  'src/main/watch/watch-row-validation.ts',
  'src/main/watch/db/watch-migrations.ts',
  'src/shared/watch/digest-facts.ts',
  'src/shared/types/watch.ts',
];
const report: Record<string, unknown> = {
  purpose: '补充物理容量与闭合字段包络资格，不是E2 PASS',
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  sourceHashes: Object.fromEntries(
    sourcePaths.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ]),
  ),
  node: process.version,
  sqlite: process.versions.sqlite,
  diskBudget,
  timeBudgetMs,
  oracle:
    '真实Research校验/Repository预算、Watch整库扫描/逻辑估算、SQLite完整性及外键；文件大小含空闲页',
  limitations: [
    '合成数据不证明历史最大值或所有行组合',
    '不执行Electron、utilityProcess、主UI或实际drain',
    'Watch无AI解释及通知outbox；样本不穷举稀疏小行、全部页大小和碎片分布',
    'Conversation样本数和文本长度是输入参数；历史助手内容、toolCalls及上下文部分字段没有有限上限',
    '固定manifest/result仅候选协议形状，尚未成为正式协议',
  ],
  entries,
  result: '进行中',
};
function save() {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
function guard() {
  const bytes = readdirSync(output).reduce(
    (sum, name) => sum + statSync(join(output, name)).size,
    0,
  );
  if (bytes > diskBudget || performance.now() - started > timeBudgetMs)
    throw new Error('本轮资格预算耗尽，保留现场并停止');
}
function open(name: string) {
  const filename = join(output, name);
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA foreign_keys = ON');
  const db: DbHandle = {
    path: filename,
    isOpen: true,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
  return { raw, db, filename };
}
function physical(raw: DatabaseSync, filename: string) {
  const start = performance.now();
  const integrity = raw.prepare('PRAGMA integrity_check').all();
  const foreignKeys = raw.prepare('PRAGMA foreign_key_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0)
    throw new Error('合成库完整性失败');
  return {
    bytes: statSync(filename).size,
    pageCount: raw.prepare('PRAGMA page_count').get(),
    pageSize: raw.prepare('PRAGMA page_size').get(),
    freePages: raw.prepare('PRAGMA freelist_count').get(),
    integrity,
    foreignKeys,
    verificationMs: performance.now() - start,
  };
}
save();
try {
  const research = open('research-dense.db');
  try {
    for (const step of RESEARCH_MIGRATIONS)
      for (const sql of step.statements) research.db.exec(sql);
    let taskBytes = 0;
    research.db.exec('BEGIN');
    for (let i = 0; i < 30; i++) {
      taskBytes = insertDenseResearch(research.db, i);
      guard();
    }
    research.db.exec('COMMIT');
    entries.push({
      kind: 'Research接近任务预算的合法表格',
      tasks: 30,
      taskBytes,
      logicalBytes: taskBytes * 30,
      ...physical(research.raw, research.filename),
    });
    research.raw.exec('DELETE FROM research_tasks');
    entries.push({
      kind: 'Research业务清空但物理页保留反例',
      tasks: 0,
      logicalBytes: 0,
      ...physical(research.raw, research.filename),
    });
    save();
  } finally {
    research.db.close();
  }
  const watch = open('watch-dense.db');
  try {
    for (const step of WATCH_MIGRATIONS) for (const sql of step.statements) watch.db.exec(sql);
    populateWatch(watch.raw);
    watch.db.exec('BEGIN');
    for (let i = 0; i < 2800; i++) {
      appendDenseEvent(watch.db, i);
      if (i % 100 === 0) guard();
    }
    prepareDigestParents(watch.db, 2800);
    watch.db.exec('COMMIT');
    const repo = new WatchRepository(watch.db);
    let logicalBytes = repo.estimateLogicalBytes();
    entries.push({
      kind: 'Watch事件饱和前样本',
      rules: 200,
      events: 2800,
      digests: 0,
      logicalBytes,
      ...physical(watch.raw, watch.filename),
    });
    let digests = 0;
    const target = MAX_WATCH_DB_BYTES * 0.99;
    while (logicalBytes < target && digests < 1400) {
      watch.db.exec('BEGIN');
      for (let j = 0; j < 10; j++) {
        appendDenseDigest(watch.db, digests++);
      }
      watch.db.exec('COMMIT');
      logicalBytes = repo.estimateLogicalBytes();
      guard();
    }
    if (logicalBytes > MAX_WATCH_DB_BYTES || logicalBytes < target)
      throw new Error('样本未落入预设99%至100%逻辑预算窗口');
    const scanStart = performance.now();
    const scan = repo.scanIntegrity();
    if (!scan.ok) throw new Error(`Watch合成库业务扫描失败：${scan.reason}`);
    entries.push({
      kind: 'Watch事件及Digest接近逻辑预算',
      rules: 200,
      events: 2800,
      items: 8400,
      digests,
      logicalBytes,
      logicalBudget: MAX_WATCH_DB_BYTES,
      businessScan: scan,
      businessScanMs: performance.now() - scanStart,
      ...physical(watch.raw, watch.filename),
    });
    save();
  } finally {
    watch.db.close();
  }
  for (const [encoding, unit] of [
    ['ascii', 'a'],
    ['cjk', '界'],
    ['escape', '\u0001'],
  ] as const) {
    const fixture = projectedConversationFixture(unit.repeat(16000), 64);
    const text = JSON.stringify(fixture, null, 2);
    const start = performance.now();
    const parsed = parseMessagesFile(text);
    if (parsed?.dropped !== 0 || parsed.messages.length !== 200)
      throw new Error('合成会话解析失败');
    entries.push({
      kind: 'Conversation已知字段文本重复与toolCalls样本',
      encoding,
      charactersPerText: 16000,
      callsPerMessage: 64,
      messages: 200,
      sessionBytes: Buffer.byteLength(text),
      parseMs: performance.now() - start,
      ...jsonShape(fixture),
    });
    guard();
  }
  const envelopes = proposedFixedProtocolEnvelope();
  for (const [kind, value] of Object.entries(envelopes))
    entries.push({
      kind: `候选固定协议${kind}`,
      bytes: Buffer.byteLength(JSON.stringify(value)),
      ...jsonShape(value),
    });
  report.result = '测量完成；预算冻结及真实进程资格未完成';
} catch (error) {
  report.result = '失败，原件保留';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.elapsedMs = performance.now() - started;
  save();
  process.stdout.write(`${output}\n${report.result}\n`);
}
