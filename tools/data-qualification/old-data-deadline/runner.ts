import { lstat, open, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  bindDirectory,
  bindRegularFile,
  verifyBinding,
  verifyDirectory,
} from '../replacement-crash/binding';
import type { BuildProof } from './build';
import {
  EXPECTED_INITIAL,
  EXPECTED_REOPEN,
  FIXED_JOB_SHA256,
  LIMITS,
  NODE_SHA256,
  NODE_VERSION,
  RUN_CLAIM_NAME,
  SCENES,
  need,
  requireScopeId,
  sceneDirectoryName,
  type ExpectedSceneResult,
  type Scene,
} from './contract';
import { inspectCommittedFixture, inspectInterruptedFixture, type SceneResult } from './fixture';
import { runWorker, type ChildObservation, type RuntimeProof } from './supervisor';

interface RunRecord {
  version: 1;
  status: 'running' | 'PASS' | 'FAIL';
  baseline: string;
  limits: typeof LIMITS;
  buildProofSha256: string;
  cases: Array<{
    scene: Scene;
    initial: SceneResult;
    initialExitClose: true;
    initialOutputBytes: number;
    reopen?: SceneResult;
    reopenExitClose?: true;
    reopenOutputBytes?: number;
    allocatedBytes: number;
  }>;
  elapsedMs?: number;
  allocatedBytes?: number;
  failure?: string;
  claims: {
    fileProtocolOldDeadline: boolean;
    sqliteBusiness: false;
    enospc: false;
    recoveryRP: false;
    e2Complete: false;
  };
}

async function readJson(path: string, maximumBytes: number): Promise<unknown> {
  const before = await lstat(path, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  need(before.size > 1n && before.size <= BigInt(maximumBytes));
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  need(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs,
  );
  return JSON.parse(bytes.toString('utf8'));
}
async function allocated(path: string, unit: number): Promise<number> {
  const value = await lstat(path, { bigint: true });
  need(!value.isSymbolicLink());
  if (value.isFile()) {
    need(value.nlink === 1n);
    return Math.ceil(Number(value.size) / unit) * unit;
  }
  need(value.isDirectory());
  let bytes = unit;
  for (const entry of await readdir(path)) bytes += await allocated(join(path, entry), unit);
  return bytes;
}
function expectedResult(actual: SceneResult, expected: ExpectedSceneResult): void {
  for (const [key, value] of Object.entries(expected))
    need((actual as unknown as Record<string, unknown>)[key] === value, '场景终态不符');
  need(actual.rollbackCopyRemaining === 0 && actual.rollbackCopyBudget === 0);
}
function runtimeMatches(runtime: RuntimeProof, proof: BuildProof): void {
  need(
    resolve(runtime.nodePath) === resolve(proof.node.path) &&
      runtime.nodeVersion === proof.nodeVersion &&
      resolve(runtime.workerPath) === resolve(proof.worker.path) &&
      runtime.workerSha256 === proof.worker.sha256,
  );
}
function validateObservation(
  observation: ChildObservation,
  proof: BuildProof,
  scene: Scene,
  action: 'initial' | 'reopen',
): SceneResult {
  runtimeMatches(observation.terminal.runtime, proof);
  const result = observation.terminal.result;
  need(result.scene === scene && result.action === action);
  need(observation.exitObserved && observation.closeObserved && observation.exitCode === 0);
  need(
    action === 'initial' && scene !== 'normal'
      ? observation.selected.length === 1 && observation.selected[0]?.phase === scene
      : observation.selected.length === 0,
  );
  return result;
}
async function writeRecord(path: string, record: RunRecord, first = false): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record, null, 2));
  need(bytes.length <= LIMITS.reportBytes);
  if (first) {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else await writeFile(path, bytes);
}

async function main(): Promise<void> {
  const [scopeId, ...rest] = process.argv.slice(2);
  requireScopeId(scopeId);
  need(
    rest.length === 0 &&
      process.platform === 'win32' &&
      process.arch === 'x64' &&
      process.version === NODE_VERSION,
  );
  const repository = resolve(__dirname, '../../..');
  const campaign = join(repository, 'log', 'stage7-e2', scopeId);
  need(resolve(__dirname) === resolve(campaign));
  need(resolve(process.cwd()) === resolve(campaign));
  const proofPath = join(campaign, 'build-proof.json');
  const claim = (await readJson(join(campaign, RUN_CLAIM_NAME), 4096)) as Record<string, unknown>;
  need(
    Object.keys(claim).sort().join('|') === 'consumed|scopeId|version' &&
      claim.version === 1 &&
      claim.scopeId === scopeId &&
      claim.consumed === true,
    '运行scope一次性标记无效',
  );
  const proof = (await readJson(proofPath, 256 * 1024)) as BuildProof;
  need(
    proof.version === 1 &&
      proof.kind === 'old-data-deadline-build' &&
      proof.scopeId === scopeId &&
      proof.nodeVersion === NODE_VERSION &&
      proof.node.sha256 === NODE_SHA256 &&
      proof.fixedJobSha256 === FIXED_JOB_SHA256 &&
      proof.productE2Pass === false,
  );
  await verifyDirectory(proof.repository);
  await verifyDirectory(proof.output);
  await verifyBinding(proof.runner, 8 * 1024 ** 2);
  await verifyBinding(proof.worker, 8 * 1024 ** 2);
  await verifyBinding(proof.runtimeProof, 4096);
  await verifyBinding(proof.node, 256 * 1024 ** 2);
  for (const source of proof.sources) await verifyBinding(source, 8 * 1024 ** 2);
  need((await bindDirectory(repository)).dev === proof.repository.dev);
  need((await bindRegularFile(process.execPath, 256 * 1024 ** 2)).sha256 === NODE_SHA256);
  const buildProofSha256 = (await bindRegularFile(proofPath, 256 * 1024)).sha256;
  const reportPath = join(campaign, 'report.json');
  const record: RunRecord = {
    version: 1,
    status: 'running',
    baseline: proof.baseline,
    limits: LIMITS,
    buildProofSha256,
    cases: [],
    claims: {
      fileProtocolOldDeadline: false,
      sqliteBusiness: false,
      enospc: false,
      recoveryRP: false,
      e2Complete: false,
    },
  };
  await writeRecord(reportPath, record, true);
  const started = performance.now();
  const fs = await statfs(campaign);
  const unit = Number(fs.bsize);
  need(Number.isSafeInteger(unit) && unit > 0 && unit <= 1024 * 1024);
  try {
    for (const scene of SCENES) {
      need(performance.now() - started < LIMITS.campaignWorkMs);
      const root = join(campaign, sceneDirectoryName(scene));
      const initialObservation = await runWorker(proof.worker.path, scopeId, scene, 'initial');
      const initial = validateObservation(initialObservation, proof, scene, 'initial');
      expectedResult(initial, EXPECTED_INITIAL[scene]);
      if (scene === 'normal') await inspectCommittedFixture(root);
      else {
        need(initial.selected === 1 && initial.waitedMs >= LIMITS.realDelayMs);
        await inspectInterruptedFixture(root, scene, false);
      }
      const item: RunRecord['cases'][number] = {
        scene,
        initial,
        initialExitClose: true,
        initialOutputBytes: initialObservation.outputBytes,
        allocatedBytes: 0,
      };
      if (scene !== 'normal') {
        const reopenedObservation = await runWorker(proof.worker.path, scopeId, scene, 'reopen');
        const reopened = validateObservation(reopenedObservation, proof, scene, 'reopen');
        expectedResult(reopened, EXPECTED_REOPEN[scene]);
        await inspectInterruptedFixture(root, scene, true);
        item.reopen = reopened;
        item.reopenExitClose = true;
        item.reopenOutputBytes = reopenedObservation.outputBytes;
      }
      item.allocatedBytes = await allocated(root, unit);
      need(item.allocatedBytes <= LIMITS.sceneAllocatedBytes);
      record.cases.push(item);
      record.allocatedBytes = await allocated(campaign, unit);
      need(record.allocatedBytes + 64 * 1024 <= LIMITS.campaignAllocatedBytes);
      await writeRecord(reportPath, record);
    }
    record.elapsedMs = performance.now() - started;
    need(record.elapsedMs < LIMITS.campaignWorkMs);
    record.allocatedBytes = await allocated(campaign, unit);
    need(record.allocatedBytes + 64 * 1024 <= LIMITS.campaignAllocatedBytes);
    record.claims.fileProtocolOldDeadline = true;
    record.status = 'PASS';
  } catch {
    record.status = 'FAIL';
    record.failure = '旧集合期限资格失败，原件、work及失败副本已保留';
    process.exitCode = 2;
  } finally {
    record.elapsedMs ??= performance.now() - started;
    record.allocatedBytes ??= await allocated(campaign, unit);
    if (
      record.elapsedMs >= LIMITS.campaignWorkMs ||
      record.allocatedBytes > LIMITS.campaignAllocatedBytes
    ) {
      record.status = 'FAIL';
      record.claims.fileProtocolOldDeadline = false;
      process.exitCode = 2;
    }
    await writeRecord(reportPath, record);
  }
}

void main().catch(() => {
  process.exitCode = 2;
});
