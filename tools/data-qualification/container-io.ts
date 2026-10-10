// Run this offline qualification entry with Node 24 and --experimental-strip-types.
import { createHash } from 'node:crypto';
import { lstat, open, readFile, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const GIB = 1024 ** 3;
export const CONTAINER_BYTES = 5 * GIB;
export const SAFETY_BYTES = GIB;
export const REQUIRED_FREE_BYTES = CONTAINER_BYTES + SAFETY_BYTES;
export const CHUNK_BYTES = 8 * 1024 ** 2;
export const TIME_BUDGET_MS = 300_000;
const RUN_ID = /^[0-9a-f]{32}$/u;

export interface IoPlan {
  fileBytes: number;
  chunkBytes: number;
  timeBudgetMs: number;
}

export interface MemoryPoint {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface IoMeasurement {
  expectedBytes: number;
  writtenBytes: number;
  readBytes: number;
  writeSha256: string;
  readSha256: string;
  byteCountMatches: boolean;
  hashMatches: boolean;
  latenciesMs: {
    write: number;
    fsync: number;
    closeAfterWrite: number;
    readAndHash: number;
    closeAfterRead: number;
    totalIo: number;
  };
  memory: {
    before: MemoryPoint;
    peak: MemoryPoint;
    after: MemoryPoint;
  };
}

export interface ObservationCost {
  samples: number;
  elapsedMs: number;
  averageMicroseconds: number;
  rssBefore: number;
  rssAfter: number;
}

const memoryPoint = (): MemoryPoint => ({ ...process.memoryUsage() });

const maxMemory = (left: MemoryPoint, right: MemoryPoint): MemoryPoint => ({
  rss: Math.max(left.rss, right.rss),
  heapTotal: Math.max(left.heapTotal, right.heapTotal),
  heapUsed: Math.max(left.heapUsed, right.heapUsed),
  external: Math.max(left.external, right.external),
  arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
});

export function measureObservationCost(samples = 1_000): ObservationCost {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100_000)
    throw new Error('内存观测样本数越界');
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (let index = 0; index < samples; index++) process.memoryUsage();
  const elapsedMs = performance.now() - started;
  return {
    samples,
    elapsedMs,
    averageMicroseconds: (elapsedMs * 1_000) / samples,
    rssBefore,
    rssAfter: process.memoryUsage().rss,
  };
}

export function validateRunId(value: string): string {
  if (!RUN_ID.test(value)) throw new Error('runId 必须是固定格式的小写 GUID');
  return value;
}

export function fixedPlan(): IoPlan {
  return {
    fileBytes: CONTAINER_BYTES,
    chunkBytes: CHUNK_BYTES,
    timeBudgetMs: TIME_BUDGET_MS,
  };
}

export async function assertNoReparsePoints(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error(`资格路径含重解析点：${basename(path)}`);
  }
}

function deterministicChunk(bytes: number): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < result.length; index++) result[index] = (index * 131 + 17) & 0xff;
  return result;
}

export async function writeAndVerifySyntheticFile(
  filename: string,
  plan: IoPlan,
): Promise<IoMeasurement> {
  if (
    !Number.isSafeInteger(plan.fileBytes) ||
    plan.fileBytes < 1 ||
    !Number.isSafeInteger(plan.chunkBytes) ||
    plan.chunkBytes < 1 ||
    plan.chunkBytes > 64 * 1024 ** 2 ||
    !Number.isSafeInteger(plan.timeBudgetMs) ||
    plan.timeBudgetMs < 1
  )
    throw new Error('I/O 测量计划越界');

  const started = performance.now();
  const deadline = () => {
    if (performance.now() - started > plan.timeBudgetMs)
      throw new Error('I/O 测量超过预设期限，停止且保留原件');
  };
  const before = memoryPoint();
  let peak = before;
  const sample = () => {
    peak = maxMemory(peak, memoryPoint());
    deadline();
  };
  const chunk = deterministicChunk(plan.chunkBytes);
  const writeHash = createHash('sha256');
  let writtenBytes = 0;
  let writeMs: number;
  let fsyncMs: number;
  let closeAfterWriteMs: number;
  const writer = await open(filename, 'wx');
  try {
    const phase = performance.now();
    while (writtenBytes < plan.fileBytes) {
      const bytes = Math.min(chunk.length, plan.fileBytes - writtenBytes);
      const value = bytes === chunk.length ? chunk : chunk.subarray(0, bytes);
      let offset = 0;
      while (offset < value.length) {
        const result = await writer.write(value, offset, value.length - offset, null);
        if (result.bytesWritten < 1) throw new Error('合成文件流写未前进');
        writeHash.update(value.subarray(offset, offset + result.bytesWritten));
        offset += result.bytesWritten;
        writtenBytes += result.bytesWritten;
      }
      sample();
    }
    writeMs = performance.now() - phase;
    const syncStarted = performance.now();
    await writer.sync();
    fsyncMs = performance.now() - syncStarted;
    sample();
  } finally {
    const closeStarted = performance.now();
    await writer.close();
    closeAfterWriteMs = performance.now() - closeStarted;
  }

  const readHash = createHash('sha256');
  let readBytes = 0;
  let readAndHashMs: number;
  let closeAfterReadMs: number;
  const reader = await open(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(plan.chunkBytes);
    const phase = performance.now();
    while (true) {
      const result = await reader.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      readHash.update(buffer.subarray(0, result.bytesRead));
      readBytes += result.bytesRead;
      sample();
    }
    readAndHashMs = performance.now() - phase;
  } finally {
    const closeStarted = performance.now();
    await reader.close();
    closeAfterReadMs = performance.now() - closeStarted;
  }

  const diskBytes = (await stat(filename)).size;
  const writeSha256 = writeHash.digest('hex');
  const readSha256 = readHash.digest('hex');
  const byteCountMatches =
    writtenBytes === plan.fileBytes && readBytes === plan.fileBytes && diskBytes === plan.fileBytes;
  const hashMatches = writeSha256 === readSha256;
  if (!byteCountMatches || !hashMatches) throw new Error('合成文件实际字节数或回读哈希不匹配');
  sample();
  return {
    expectedBytes: plan.fileBytes,
    writtenBytes,
    readBytes,
    writeSha256,
    readSha256,
    byteCountMatches,
    hashMatches,
    latenciesMs: {
      write: writeMs,
      fsync: fsyncMs,
      closeAfterWrite: closeAfterWriteMs,
      readAndHash: readAndHashMs,
      closeAfterRead: closeAfterReadMs,
      totalIo: performance.now() - started,
    },
    memory: { before, peak, after: memoryPoint() },
  };
}

async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'w' });
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runFormal(runId: string): Promise<void> {
  validateRunId(runId);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logRoot = join(repository, 'log');
  const stageRoot = join(logRoot, 'stage7-e2');
  const runRoot = join(stageRoot, `container-io-${runId}`);
  await assertNoReparsePoints([repository, logRoot, stageRoot, runRoot]);
  const reportPath = join(runRoot, 'report.json');
  const dataPath = join(runRoot, 'container-5gib.bin');
  const plan = fixedPlan();
  const started = performance.now();
  const volume = await statfs(runRoot, { bigint: true });
  const availableBytes = volume.bavail * volume.bsize;
  const sourcePaths = [
    join(repository, 'tools', 'data-qualification', 'container-io.ts'),
    join(repository, 'tools', 'data-qualification', 'run-container-io.ps1'),
    join(repository, 'tools', 'release-profile', 'JobProcess.cs'),
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path.slice(repository.length + 1).replaceAll('\\', '/'),
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  const report: Record<string, unknown> = {
    revision: 'container-io-v1',
    purpose: '5 GiB候选容器原始流式I/O资格；不是E2 PASS或历史合法最大值证明',
    sourceHashes,
    candidateBasis: {
      sourcesMiB: 512,
      researchMiB: 64,
      watchMiB: 512,
      conversations: { count: 50, eachMiB: 64 },
      remainingIndexAndContainerAllowanceMiB: 832,
      candidateTotalBytes: CONTAINER_BYTES,
      status: '候选，尚未冻结',
    },
    plan,
    disk: {
      requiredFreeBytes: REQUIRED_FREE_BYTES,
      candidateFileBytes: CONTAINER_BYTES,
      safetyBytes: SAFETY_BYTES,
      availableBytes: availableBytes.toString(),
    },
    cacheClaim: '未控制或清空操作系统缓存；结果不称冷缓存',
    limitations: [
      '不实现或解析备份容器',
      '不证明历史合法数据存在有限最大值',
      '仅测量当前机器、当前卷上的顺序流写、fsync和流读哈希',
    ],
    observationCost: measureObservationCost(),
    status: 'running',
  };
  await writeJsonDurable(reportPath, report);
  try {
    if (availableBytes < BigInt(REQUIRED_FREE_BYTES))
      throw new Error('可用磁盘不足5 GiB单文件与1 GiB安全余量');
    report.measurement = await writeAndVerifySyntheticFile(dataPath, plan);
    report.status = 'measurement-complete-awaiting-launcher-verification';
  } catch (error) {
    report.status = 'failed-originals-preserved';
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    report.elapsedMs = performance.now() - started;
    await writeJsonDurable(reportPath, report);
  }
}

async function main(): Promise<void> {
  const [action, runId, ...extra] = process.argv.slice(2);
  if (action !== 'run' || runId === undefined || extra.length !== 0)
    throw new Error('只接受固定入口：run <runId>');
  await runFormal(runId);
}

const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
