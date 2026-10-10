import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { mkdir, readdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker, verifyWorkerBuild, type WorkerBuild } from './build';
import {
  QUALIFICATION_LIMITS,
  REPLACEMENT_CHECKPOINTS,
  assertExactCheckpointSequence,
  type ReplacementCheckpoint,
} from './contracts';
import { inspectFixture } from './fixture';
import { superviseWorker, type ChildObservation } from './supervisor';
import {
  bindDirectory,
  readBoundedRegularFile,
  verifyDirectory,
  type DirectoryBinding,
} from './binding';

if (process.argv.slice(2).length !== 0) throw new Error('replacement crash runner不接受参数');

interface CaseRecord {
  readonly scene: number;
  readonly point: ReplacementCheckpoint;
  readonly killed: Pick<ChildObservation, 'exitCode' | 'signal' | 'frames' | 'outputBytes'>;
  readonly reopened: ChildObservation['state'];
  readonly completeOldCopies: number;
  readonly completeNewCopies: number;
}

interface Report {
  readonly version: 1;
  readonly limits: typeof QUALIFICATION_LIMITS;
  readonly startedAt: string;
  readonly output: string;
  status: 'running' | 'PASS' | 'FAIL';
  build?: WorkerBuild;
  runnerBuild?: WorkerBuild;
  control?: object;
  cases: CaseRecord[];
  failure?: string;
  elapsedMs?: number;
  allocatedBytes?: number;
  ownershipRetained?: boolean;
}

const started = performance.now();
const deadline = started + QUALIFICATION_LIMITS.wallMs;
const runnerPath = fileURLToPath(import.meta.url);
const runnerBuild = JSON.parse(
  (
    await readBoundedRegularFile(join(dirname(runnerPath), 'build-binding.json'), 1024 ** 2)
  ).bytes.toString('utf8'),
) as WorkerBuild;
if (runnerBuild.artifact.path !== runnerPath) throw new Error('runner制品不是冻结构建路径');
await verifyWorkerBuild(runnerBuild);
const output = resolve('log', 'stage7-e2', `replacement-crash-${randomUUID().replaceAll('-', '')}`);
await mkdir(output);
const outputBinding = await bindDirectory(output);
const report: Report = {
  version: 1,
  limits: QUALIFICATION_LIMITS,
  startedAt: new Date().toISOString(),
  output,
  status: 'running',
  cases: [],
  runnerBuild,
};
const reportPath = join(output, 'report.json');
const caseBindings = new Map<string, DirectoryBinding>();
const CASE_WRITE_RESERVE_BYTES = 4 * 1024 ** 2;
const CASE_REOPEN_RESERVE_BYTES = 1024 ** 2;

async function persist(): Promise<void> {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

async function allocatedBytes(path: string, cluster: number): Promise<number> {
  const entry = await lstat(path, { bigint: true });
  if (entry.isSymbolicLink()) throw new Error('资格根包含重解析点');
  if (entry.isFile()) {
    if (entry.nlink !== 1n) throw new Error('资格根包含硬链接');
    return Math.ceil(Number(entry.size) / cluster) * cluster;
  }
  if (!entry.isDirectory()) throw new Error('资格根包含非普通对象');
  let total = cluster;
  for (const name of await readdir(path)) total += await allocatedBytes(join(path, name), cluster);
  return total;
}

async function admission(
  build: WorkerBuild,
  cluster: number,
  scopeBinding: DirectoryBinding,
): Promise<void> {
  if (performance.now() >= deadline) throw new Error('600秒总期限耗尽');
  await verifyDirectory(scopeBinding);
  await verifyWorkerBuild(runnerBuild);
  await verifyWorkerBuild(build);
  const bytes =
    (await allocatedBytes(output, cluster)) + (await allocatedBytes(dirname(runnerPath), cluster));
  report.allocatedBytes = bytes;
  if (bytes > QUALIFICATION_LIMITS.allocatedBytes) throw new Error('64MiB实际分配预算耗尽');
}

async function runChild(
  build: WorkerBuild,
  cluster: number,
  root: string,
  mode: 'write' | 'reopen',
  killAt: ReplacementCheckpoint | null,
): Promise<ChildObservation> {
  await admission(build, cluster, outputBinding);
  const currentAllocation = report.allocatedBytes ?? 0;
  const reserve = mode === 'write' ? CASE_WRITE_RESERVE_BYTES : CASE_REOPEN_RESERVE_BYTES;
  if (currentAllocation + reserve > QUALIFICATION_LIMITS.allocatedBytes)
    throw new Error('child启动前实际分配保留量不足');
  if (mode === 'write') {
    let absent = false;
    try {
      await lstat(root);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        absent = true;
      } else throw error;
    }
    if (!absent) throw new Error('writer case根必须fresh');
    if (caseBindings.has(root)) throw new Error('case根被重复用于writer');
  } else {
    const binding = caseBindings.get(root);
    if (!binding) throw new Error('reopen缺少已拥有case根');
    await verifyDirectory(binding);
  }
  const result = await superviseWorker(output, build.artifact.path, root, mode, killAt, deadline);
  if (mode === 'write') caseBindings.set(root, await bindDirectory(root));
  else await verifyDirectory(caseBindings.get(root)!);
  await admission(build, cluster, outputBinding);
  return result;
}

await persist();
try {
  const buildRoot = join(output, 'build');
  const build = await buildWorker(process.cwd(), buildRoot);
  report.build = build;
  await persist();
  const fs = await statfs(output);
  const cluster = Number(fs.bsize);
  if (!Number.isSafeInteger(cluster) || cluster < 1) throw new Error('文件系统分配单元非法');

  const controlRoot = join(output, 'control');
  const control = await runChild(build, cluster, controlRoot, 'write', null);
  assertExactCheckpointSequence(control.points);
  if (control.state !== 'normal') throw new Error('正常控制未完成完整新代');
  const controlReopen = await runChild(build, cluster, controlRoot, 'reopen', null);
  if (controlReopen.state !== 'normal') throw new Error('正常控制新进程重开未保持完整新代');
  const controlOracle = await inspectFixture(controlRoot, 'normal');
  report.control = { observation: control, reopen: controlReopen, oracle: controlOracle };
  await persist();

  for (const [index, point] of REPLACEMENT_CHECKPOINTS.entries()) {
    const root = join(output, `case-${String(index).padStart(2, '0')}`);
    const killed = await runChild(build, cluster, root, 'write', point);
    if (!killed.killed || killed.points.at(-1) !== point) throw new Error('终止点与冻结边界不一致');
    const reopened = await runChild(build, cluster, root, 'reopen', null);
    const expected = index < 14 ? 'recovery-required' : 'normal';
    if (reopened.state !== expected) throw new Error(`${point}重开状态不是${expected}`);
    const oracle = await inspectFixture(root, expected);
    report.cases.push({
      scene: index + 2,
      point,
      killed: {
        exitCode: killed.exitCode,
        signal: killed.signal,
        frames: killed.frames,
        outputBytes: killed.outputBytes,
      },
      reopened: reopened.state,
      completeOldCopies: oracle.completeOldCopies,
      completeNewCopies: oracle.completeNewCopies,
    });
    await persist();
  }
  if (report.cases.length !== QUALIFICATION_LIMITS.checkpoints)
    throw new Error('实际中断case数不等于18');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = error instanceof Error ? error.message : '未知资格失败';
  report.ownershipRetained = /退出未确认|输出关闭未确认/u.test(report.failure);
  process.exitCode = 1;
} finally {
  report.elapsedMs = performance.now() - started;
  try {
    const fs = await statfs(output);
    report.allocatedBytes =
      (await allocatedBytes(output, Number(fs.bsize))) +
      (await allocatedBytes(dirname(runnerPath), Number(fs.bsize)));
    if (
      report.elapsedMs > QUALIFICATION_LIMITS.wallMs ||
      report.allocatedBytes > QUALIFICATION_LIMITS.allocatedBytes
    ) {
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  } catch (error) {
    report.status = 'FAIL';
    report.failure ??= error instanceof Error ? error.message : '收口计量失败';
    process.exitCode = 1;
  }
  await persist();
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      scenes: 1 + report.cases.length,
      elapsedMs: report.elapsedMs,
      allocatedBytes: report.allocatedBytes,
      output,
    }) + '\n',
  );
}
