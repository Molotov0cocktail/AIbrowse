import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateTransferSchema,
  normalizeTransferSchema,
} from '../../../src/main/storage/transfer-schema';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json';
import {
  openPrivateStagingDatabase,
  type StagingDatabaseDomain,
  type StagingSqliteSettings,
} from '../../../src/main/storage/staging-sqlite';
import {
  validateSourceTransfer,
  normalizeAndVerifySourceIndex,
} from '../../../src/main/sources/repository/source-transfer-validation';
import { validateResearchTransfer } from '../../../src/main/research/repository/research-transfer-validation';
import { validateWatchTransferDatabase } from '../../../src/main/watch/repository/watch-transfer-validation';
import { projectIndex, projectSession, sessionChunks, LIMITS } from '../projection/projection';
import { fixtureId } from '../fixtures';
import { BUDGET, FIXTURE, STAGES, assertFact, type Stage } from './contract';
import type { ScanResult } from './protocol';
import { diskCensus } from './disk';

const DOMAINS = ['sources', 'research', 'watch'] as const;
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) hash.update(chunk);
  return hash.digest('hex');
}

export interface ProjectedOutputEvidence {
  expectedBytes: number;
  actualBytes: number;
  sha256: string;
}
export async function writeProjectedChunks(
  file: string,
  chunks: Iterable<Buffer>,
  expectedBytes: number,
  sample: () => void = () => {},
): Promise<ProjectedOutputEvidence> {
  assertFact(
    Number.isSafeInteger(expectedBytes) &&
      expectedBytes >= 0 &&
      expectedBytes <= LIMITS.sessionBytes,
    '输出长度无效',
  );
  const expectedHash = createHash('sha256');
  let emittedBytes = 0;
  const fd = openSync(file, 'wx');
  try {
    for (const chunk of chunks) {
      emittedBytes += chunk.length;
      assertFact(emittedBytes <= expectedBytes, '投影输出超过声明长度');
      expectedHash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset);
        assertFact(
          Number.isSafeInteger(written) && written > 0 && written <= chunk.length - offset,
          '投影输出写入未推进',
        );
        offset += written;
        sample();
      }
    }
  } finally {
    closeSync(fd);
  }
  assertFact(emittedBytes === expectedBytes, '投影输出缺少声明字节');
  assertFact(statSync(file).size === expectedBytes, '投影输出实际长度不符');
  const actualHash = createHash('sha256');
  let actualBytes = 0;
  // The read stream must reach EOF; each chunk stays bounded and the bytes on
  // disk, rather than successful write return values, supply the evidence.
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
    assertFact(Buffer.isBuffer(chunk), '投影输出读取类型无效');
    actualBytes += chunk.length;
    assertFact(actualBytes <= expectedBytes, '投影输出存在尾随字节');
    actualHash.update(chunk);
    sample();
  }
  const sha256 = actualHash.digest('hex');
  assertFact(
    actualBytes === expectedBytes && sha256 === expectedHash.digest('hex'),
    '投影输出完整性验证失败',
  );
  return { expectedBytes, actualBytes, sha256 };
}

// Only the builder-owned synthetic profile can be supplied by the fixed worker.
// This is measurement assembly; it is not an untrusted container decoder.
export async function scanFixedDataset(
  root: string,
  progress: (stage: Stage, elapsedMs: number) => void,
): Promise<ScanResult> {
  const started = performance.now();
  const profile = join(root, 'runtime', 'profile');
  const staging = join(root, 'runtime', 'staging');
  mkdirSync(staging);
  const originals = new Map<string, string>();
  const sqliteSettings: Array<{
    member: string;
    purpose: 'integrity' | 'semantics' | 'migration';
    settings: StagingSqliteSettings;
  }> = [];
  const withStaging = async (
    member: string,
    domain: StagingDatabaseDomain,
    purpose: 'integrity' | 'semantics' | 'migration',
    work: (db: DatabaseSync) => void | Promise<void>,
  ): Promise<void> => {
    const opened = openPrivateStagingDatabase(join(staging, member), domain);
    sqliteSettings.push({ member, purpose, settings: opened.settings });
    try {
      writeFileSync(
        join(root, 'runtime', 'utility-sqlite-settings.json'),
        JSON.stringify(sqliteSettings, null, 2),
      );
      await work(opened.db);
    } finally {
      opened.db.close();
    }
  };
  const stageMs: number[] = [];
  let rssPeakBytes = process.memoryUsage().rss;
  let migrationCases = 0;
  const disk: object[] = [];
  const conversationOutputs: Array<ProjectedOutputEvidence & { member: string }> = [];
  const sample = () => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
    assertFact(performance.now() - started <= BUDGET.utilityMs, 'utility 固定时限已耗尽');
  };
  const stage = async (name: Stage, work: () => void | Promise<void>) => {
    assertFact(name === STAGES[stageMs.length], '扫描阶段改变');
    const begin = performance.now();
    await work();
    sample();
    disk.push({ stage: name, at: performance.now(), ...diskCensus(root) });
    stageMs.push(performance.now() - begin);
    progress(name, performance.now() - started);
  };
  await stage('physical-integrity', async () => {
    for (const domain of DOMAINS) {
      const file = join(profile, domain, `${domain}.db`);
      for (const suffix of ['', '-wal'])
        if (existsSync(file + suffix)) originals.set(file + suffix, await hashFile(file + suffix));
      const source = new DatabaseSync(file, { readOnly: true, allowExtension: false });
      try {
        const target = join(staging, `${domain}.db`);
        assertFact(!existsSync(target), 'snapshot 目标必须全新');
        await backup(source, target, { rate: 100 });
      } finally {
        source.close();
      }
      await withStaging(`${domain}.db`, domain, 'integrity', (db) => {
        assertFact(
          db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok',
          'SQLite integrity 失败',
        );
        assertFact(
          db.prepare('PRAGMA foreign_key_check').get() === undefined,
          'SQLite 外键检查失败',
        );
      });
    }
  });
  await withStaging('sources.db', 'sources', 'semantics', async (sources) => {
    await stage('sources-schema', () => {
      assertFact(normalizeTransferSchema(sources, 'sources').ok, 'Sources schema 失败');
    });
    await stage('sources-business', () => {
      const result = validateSourceTransfer(sources);
      assertFact(result.ok && result.counts.sources === FIXTURE.sources, 'Sources 语义或数量失败');
    });
    await stage('sources-index', () => {
      assertFact(normalizeAndVerifySourceIndex(sources).ok, 'Sources FTS 重建失败');
    });
  });
  await stage('research', () =>
    withStaging('research.db', 'research', 'semantics', (db) => {
      assertFact(normalizeTransferSchema(db, 'research').ok, 'Research schema 失败');
      const result = validateResearchTransfer(db);
      assertFact(
        result.ok && result.counts.tasks === FIXTURE.researchTasks,
        'Research 语义或数量失败',
      );
    }),
  );
  await stage('watch', () =>
    withStaging('watch.db', 'watch', 'semantics', (db) => {
      assertFact(normalizeTransferSchema(db, 'watch').ok, 'Watch schema 失败');
      const result = validateWatchTransferDatabase(db);
      assertFact(
        result.ok &&
          result.counts.watch_rules === FIXTURE.watchRules &&
          result.counts.watch_events === FIXTURE.watchEvents &&
          result.counts.watch_event_items === FIXTURE.watchEvidencePairs &&
          result.counts.watch_digests === FIXTURE.watchDigests,
        'Watch 语义或数量失败',
      );
    }),
  );
  await stage('historical-migrations', async () => {
    const history = join(root, 'fixtures', 'history');
    for (const domain of DOMAINS) {
      for (const variant of domain === 'watch' ? ['current', 'historical'] : ['current']) {
        for (
          let version = variant === 'historical' ? 3 : 0;
          version <= (domain === 'watch' ? 5 : 1);
          version++
        ) {
          const name = `${domain}-${variant}-${version}.db`;
          const file = join(staging, name);
          await copyFile(join(history, name), file);
          await withStaging(name, domain, 'migration', (db) => {
            assertFact(normalizeTransferSchema(db, domain).ok, '历史 schema 迁移失败');
            assertFact(validateTransferSchema(db, domain).ok, '迁移后 schema 失败');
            const result =
              domain === 'sources'
                ? validateSourceTransfer(db)
                : domain === 'research'
                  ? validateResearchTransfer(db)
                  : validateWatchTransferDatabase(db);
            assertFact(result.ok, '历史迁移后语义失败');
            migrationCases++;
          });
        }
      }
    }
    assertFact(migrationCases === FIXTURE.migrationCases, '历史前缀数量改变');
  });
  await stage('conversations', async () => {
    const input = join(profile, 'conversations');
    assertFact(
      readdirSync(input).length === FIXTURE.conversationSessions + 1,
      'Conversation 文件集合改变',
    );
    const output = join(staging, 'conversations');
    mkdirSync(output);
    const indexFile = join(input, 'index.json');
    originals.set(indexFile, await hashFile(indexFile));
    const projectedIndex = projectIndex(
      parseBoundedJson(readFileSync(indexFile, 'utf8'), {
        bytes: LIMITS.indexBytes,
        depth: 16,
        nodes: 262144,
      }),
    );
    const indexEvidence = await writeProjectedChunks(
      join(output, 'index.json'),
      [Buffer.from(JSON.stringify(projectedIndex.value))],
      projectedIndex.compactBytes,
      sample,
    );
    conversationOutputs.push({ member: 'index', ...indexEvidence });
    for (let i = 0; i < FIXTURE.conversationSessions; i++) {
      const name = `${fixtureId(i)}.json`;
      const file = join(input, name);
      originals.set(file, await hashFile(file));
      assertFact(statSync(file).size <= LIMITS.sessionBytes, 'Conversation 原件过大');
      const parsed = parseBoundedJson(readFileSync(file, 'utf8'), {
        bytes: LIMITS.sessionBytes,
        depth: 16,
        nodes: 262144,
      });
      const projected = projectSession(parsed, sample);
      const chunks = sessionChunks(projected.value);
      // The writer holds at most one allowed message chunk, not another full session string.
      const evidence = await writeProjectedChunks(
        join(output, name),
        chunks,
        projected.compactBytes,
        sample,
      );
      conversationOutputs.push({ member: fixtureId(i), ...evidence });
      if (i === 0)
        assertFact(
          projected.compactBytes === FIXTURE.denseSessionBytes &&
            evidence.actualBytes === FIXTURE.denseSessionBytes,
          '最大合法 Conversation 被裁切',
        );
      sample();
    }
    for (const [file, hash] of originals)
      assertFact((await hashFile(file)) === hash, '扫描改变了同代输入');
  });
  writeFileSync(
    join(root, 'runtime', 'utility-metrics.json'),
    JSON.stringify(
      {
        stageMs,
        rssPeakBytes,
        sqliteSettings,
        conversationOutputs,
        disk,
        diskSampling: '阶段末目录普查；不声称捕捉所有瞬时 SQLite 临时页',
      },
      null,
      2,
    ),
  );
  return {
    counts: [5000, 30, 200, 2800, 8400, 1030, 50],
    stageMs: stageMs as ScanResult['stageMs'],
    rssPeakBytes,
    migrationCases: 13,
    versions: [1, 1, 5],
    sourceIndexRebuilt: true,
    inputsUnchanged: true,
  };
}
