// Offline qualification entry. Never opens an existing database or user profile.
import {
  mkdirSync,
  statSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import {
  MIGRATION_MODULES,
  git,
  readHistoricalSteps,
  applySteps,
  sha256,
  type Domain,
} from './history.ts';
import {
  appendSources,
  populateResearch,
  populateWatch,
  conversationMessage,
  jsonShape,
} from './fixtures.ts';

const FILE_BUDGET = 1024 ** 3;
const TIME_BUDGET_MS = 240_000;
const SAMPLE_LIMIT = 5000;

function tableSnapshot(db: DatabaseSync): Record<string, Record<string, unknown>[]> {
  const result: Record<string, Record<string, unknown>[]> = {};
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sources_fts%' ORDER BY name",
    )
    .all();
  for (const row of tables) {
    const name = row.name;
    if (typeof name !== 'string' || !/^[a-z_]+$/.test(name))
      throw new Error('历史受信表名不符合工具约束');
    result[name] = db.prepare(`SELECT * FROM ${name}`).all();
  }
  return result;
}

function verifyOldRows(
  before: ReturnType<typeof tableSnapshot>,
  after: ReturnType<typeof tableSnapshot>,
): number {
  let rows = 0;
  for (const [name, values] of Object.entries(before)) {
    if (values.length === 0) continue;
    const columns = Object.keys(values[0]!);
    const current = after[name];
    if (current === undefined) throw new Error('升级后缺少原非空表');
    const normalize = (items: Record<string, unknown>[]) =>
      items.map((item) => JSON.stringify(columns.map((column) => item[column]))).sort();
    if (JSON.stringify(normalize(values)) !== JSON.stringify(normalize(current)))
      throw new Error('升级后原字段或行发生意外变化');
    rows += values.length;
  }
  return rows;
}

function databaseFacts(db: DatabaseSync) {
  const start = performance.now();
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (
    integrity.length !== 1 ||
    integrity[0]?.integrity_check !== 'ok' ||
    foreignKeys.length !== 0
  ) {
    throw new Error('合成库完整性或外键失败');
  }
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  return {
    integrity,
    foreignKeys,
    schemaHash: sha256(JSON.stringify(schema)),
    schemaObjects: schema.length,
    pageCount: db.prepare('PRAGMA page_count').get(),
    pageSize: db.prepare('PRAGMA page_size').get(),
    freePages: db.prepare('PRAGMA freelist_count').get(),
    verificationMs: performance.now() - start,
  };
}

async function nativeBlockingProbe() {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), '--blocked-worker'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
    },
  );
  const started = performance.now();
  let ready = false;
  let outputBytes = 0;
  let maxHeartbeatGapMs = 0;
  let last = performance.now();
  let killedAt = 0;
  let killSent = false;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last);
    last = now;
  }, 10);
  const timeout = setTimeout(() => {
    killedAt = performance.now();
    killSent = child.kill();
  }, 2000);
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (chunk.toString().includes('native-start')) ready = true;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (accept, reject) => {
        confirmationTimer = setTimeout(() => {
          child.unref();
          child.stdout.destroy();
          child.stderr.destroy();
          reject(new Error(`校验子进程退出未确认，保留现场，PID=${child.pid}`));
        }, 7000);
        child.once('error', reject);
        child.once('exit', (code, signal) => accept({ code, signal }));
      },
    );
    return {
      scope: '仅独立Node同步SQLite与父Node心跳；不覆盖Electron utilityProcess或主UI',
      ready,
      killSent,
      outputBytes,
      ...exit,
      elapsedMs: performance.now() - started,
      terminationConfirmationMs: killedAt === 0 ? null : performance.now() - killedAt,
      maxHeartbeatGapMs,
    };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    clearTimeout(confirmationTimer);
  }
}

async function run() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`;
  const output = join(root, 'log', 'stage7-e2', runId);
  mkdirSync(output, { recursive: true });
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const entries: unknown[] = [];
  const plan = {
    purpose: 'Git历史schema与合成容量包络资格；不是E2实现或PASS',
    baseline,
    toolHashes: Object.fromEntries(
      ['run.ts', 'fixtures.ts', 'history.ts', 'qualification.test.ts'].map((name) => [
        name,
        sha256(readFileSync(join(root, 'tools', 'data-qualification', name))),
      ]),
    ),
    node: process.version,
    sqlite: process.versions.sqlite,
    fileBudgetBytes: FILE_BUDGET,
    elapsedBudgetMs: TIME_BUDGET_MS,
    sourceRows: [100, 1000, SAMPLE_LIMIT],
    researchTasks: 30,
    watchPausedRules: 200,
    oracle: '完整性/外键；单元测试复核合成字段；样本不能证明无上限域最大值',
    limitations: [
      '旧Sources总行数与Conversation助手正文无有限硬上限',
      '数据库文件包含页/索引/空闲页，逻辑预算不等于物理长度',
      '旧schema为受控非空样本；不是全部历史合法数据或全量迁移资格',
      'Watch仅规则上限样本，不是100MiB事件/Digest饱和态',
      '不运行Electron、不读取用户数据或Key、不测实际业务drain',
    ],
  };
  writeFileSync(join(output, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
  function totalBytes(): number {
    return readdirSync(output).reduce((sum, name) => sum + statSync(join(output, name)).size, 0);
  }
  function checkpoint() {
    const cpu = process.cpuUsage(cpuStart);
    if (
      performance.now() - started > TIME_BUDGET_MS ||
      (cpu.user + cpu.system) / 1000 > TIME_BUDGET_MS ||
      totalBytes() > FILE_BUDGET
    ) {
      throw new Error('达到预登记时间或文件预算，保留原件并停止');
    }
  }
  try {
    for (const domain of Object.keys(MIGRATION_MODULES) as Domain[]) {
      const descriptor = MIGRATION_MODULES[domain];
      const refs = git(root, ['log', '--format=%H', baseline, '--', descriptor.path])
        .split('\n')
        .filter(Boolean);
      const seen = new Set<string>();
      const current = readHistoricalSteps(root, baseline, domain);
      for (const ref of refs) {
        checkpoint();
        const history = readHistoricalSteps(root, ref, domain);
        if (seen.has(history.statementsHash)) continue;
        seen.add(history.statementsHash);
        const filename = `${domain}-history-${ref.slice(0, 12)}.db`;
        const path = join(output, filename);
        const db = new DatabaseSync(path);
        let before: ReturnType<typeof tableSnapshot>;
        try {
          db.exec('PRAGMA foreign_keys = ON');
          applySteps(db, history.steps);
          if (history.steps.length > 0) {
            if (domain === 'sources') appendSources(db, 0, 3);
            else if (domain === 'research') populateResearch(db);
            else populateWatch(db);
          }
          entries.push({
            kind: '历史schema与合成数据',
            domain,
            ref,
            ...history,
            filename,
            ...databaseFacts(db),
            bytes: statSync(path).size,
          });
          before = tableSnapshot(db);
        } finally {
          db.close();
        }
        const upgradedPath = join(output, `${domain}-upgraded-${ref.slice(0, 12)}.db`);
        copyFileSync(path, upgradedPath);
        const upgraded = new DatabaseSync(upgradedPath);
        try {
          upgraded.exec('PRAGMA foreign_keys = ON');
          const startedUpgrade = performance.now();
          applySteps(upgraded, current.steps.slice(history.steps.length));
          entries.push({
            kind: '历史合成库升级副本',
            domain,
            ref,
            bytes: statSync(upgradedPath).size,
            ...databaseFacts(upgraded),
            preservedRows: verifyOldRows(before, tableSnapshot(upgraded)),
            elapsedMs: performance.now() - startedUpgrade,
          });
        } finally {
          upgraded.close();
        }
      }
      const dbPath = join(output, `${domain}-sample.db`);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA foreign_keys = ON');
        applySteps(db, readHistoricalSteps(root, baseline, domain).steps);
        const start = performance.now();
        if (domain === 'sources') {
          let previous = 0;
          for (const count of [100, 1000, SAMPLE_LIMIT]) {
            checkpoint();
            appendSources(db, previous, count);
            entries.push({
              kind: 'Source最大字段与20标签样本',
              count,
              bytes: statSync(dbPath).size,
              ...databaseFacts(db),
              elapsedMs: performance.now() - start,
            });
            previous = count;
          }
        } else {
          if (domain === 'research') populateResearch(db);
          else populateWatch(db);
          entries.push({
            kind: '当前schema合成样本',
            domain,
            bytes: statSync(dbPath).size,
            ...databaseFacts(db),
            elapsedMs: performance.now() - start,
          });
        }
      } finally {
        db.close();
      }
    }
    for (const [encoding, unit] of [
      ['ascii', 'x'],
      ['cjk', '界'],
      ['escape', '\u0000'],
      ['surrogate', '\ud800'],
    ] as const) {
      checkpoint();
      const messages = Array.from({ length: 200 }, () => conversationMessage(unit.repeat(16_000)));
      const value = { version: 2, messages };
      const serialized = JSON.stringify(value, null, 2);
      const start = performance.now();
      JSON.parse(serialized);
      const parseMs = performance.now() - start;
      const bytes = Buffer.byteLength(serialized);
      writeFileSync(join(output, `conversation-${encoding}.json`), serialized, { flag: 'wx' });
      entries.push({
        kind: 'Conversation编码样本',
        encoding,
        charactersPerMessage: 16_000,
        messageBytes: Buffer.byteLength(JSON.stringify(messages[0])),
        sessionBytes: bytes,
        fiftySessionsBytes: bytes * 50,
        parseMs,
        ...jsonShape(value),
      });
    }
    entries.push({ kind: '同步SQLite可终止路径预检', ...(await nativeBlockingProbe()) });
    checkpoint();
    writeFileSync(
      join(output, 'report.json'),
      JSON.stringify(
        {
          ...plan,
          entries,
          totalFixtureBytes: totalBytes(),
          elapsedMs: performance.now() - started,
          cpu: process.cpuUsage(cpuStart),
          result: '测量完成；预算待冻结；不构成E2 PASS',
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        report: relative(root, join(output, 'report.json')),
        entries: entries.length,
        totalBytes: totalBytes(),
      }),
    );
  } catch (error) {
    writeFileSync(
      join(output, 'failure.json'),
      JSON.stringify(
        { ...plan, entries, error: String(error), totalFixtureBytes: totalBytes() },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    throw error;
  }
}
if (process.argv[2] === '--blocked-worker') {
  const db = new DatabaseSync(':memory:');
  process.stdout.write('native-start\n');
  db.prepare(
    'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000000) SELECT sum(x) FROM n',
  ).get();
} else if (process.argv.length === 2) {
  await run();
} else {
  throw new Error('不支持外部路径或附加参数');
}
