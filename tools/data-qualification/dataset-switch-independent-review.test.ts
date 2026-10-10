import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { expect, it, vi } from 'vitest';
import {
  createDatasetScope,
  inspectDatasetWork,
  readDatasetScope,
  type DatasetContext,
} from '../../src/main/storage/dataset-layout';
import { DatasetSwitch } from '../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../src/main/storage/transfer-budget';

const root = join(process.cwd(), 'log/stage7-e2/independent-dataset-review-001');
const context: DatasetContext = { check: () => {}, requireRollbackSpace: () => {} };
async function fixture() {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'fixture-'));
  for (const domain of ['sources', 'research', 'watch']) {
    await mkdir(join(directory, domain));
    await writeFile(join(directory, domain, `${domain}.db`), `old-${domain}`);
  }
  await mkdir(join(directory, 'conversations'));
  await writeFile(join(directory, 'conversations', 'index.json'), 'old-index');
  const scope = await createDatasetScope(
    {
      userDataRoot: directory,
      operationId: 'a'.repeat(32),
      generation: 'b'.repeat(32),
      purpose: 'restore',
    },
    context,
  );
  for (const domain of ['sources', 'research', 'watch'])
    await writeFile(join(scope.operationRoot, 'work', `${domain}.db`), `new-${domain}`);
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'index.json'), 'new-index');
  return {
    directory,
    scope,
    expected: await inspectDatasetWork(scope, context),
    engine: new DatasetSwitch(scope, context),
  };
}

it('合法分数单调时钟handoff不能因相加舍入差异被数据集登记拒绝', async () => {
  const f = await fixture();
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  for (let i = 0; i < 2; i++) {
    now += 17 / 997;
    budget.check();
  }
  const state = budget.suspend();
  const total = Object.values(state.phaseRemainingMs).reduce((sum, value) => sum + value, 0);
  expect(state.totalRemainingMs - total).toBeGreaterThan(0);
  expect(state.totalRemainingMs - total).toBeLessThan(0.000001);
  expect(() => new TransferBudget(() => 0, state)).not.toThrow();
  expect((await f.engine.registerHandoff(f.expected, state)).state).toBe('handoff');
  expect(await readFile(join(f.directory, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
});

it('新冷实例不能再次领取已持久领取的健康尝试，仍可显式回退完整旧代', async () => {
  const f = await fixture();
  expect((await f.engine.registerHandoff(f.expected, new TransferBudget().suspend())).state).toBe(
    'handoff',
  );
  expect((await f.engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  const scope = await readDatasetScope({
    userDataRoot: f.directory,
    operationId: f.scope.operationId,
  });
  const next = new DatasetSwitch(scope, context);
  expect((await next.resumeAtStartup()).code).toBe('attempt-exhausted');
  expect((await next.commitHealthy()).state).toBe('recovery-required');
  expect((await next.rollbackAfterFailure()).state).toBe('old-restored');
  expect(await readFile(join(f.directory, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
  expect(await readFile(join(scope.operationRoot, 'work', 'sources.db'), 'utf8')).toBe(
    'new-sources',
  );
});

it('崩溃资格工具收到child error时不能在真实exit之前释放监督Promise', async () => {
  const source = await readFile('tools/data-qualification/switch-crash/run.ts', 'utf8');
  const start = source.indexOf('async function supervise(');
  const end = source.indexOf('async function textAt(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const compiled = await transform(source.slice(start, end), { loader: 'ts', target: 'node24' });
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => false),
    send: vi.fn(),
  });
  const scope = {
    output: root,
    worker: 'controlled-no-native-spawn',
    process: { execPath: 'unused' },
    spawn: () => child,
    isAbsolute,
    sep,
    Buffer,
    Promise,
    setTimeout,
    clearTimeout,
    LIMIT: { exitMs: 20, childMs: 100, frameBytes: 256, frames: 500 },
  };
  const supervise = runInNewContext(compiled.code + '\nsupervise;', scope) as (
    path: string,
    mode: string,
    boundary: number | null,
  ) => Promise<unknown>;
  let settled = false;
  const pending = supervise(join(root, 'synthetic-owned'), 'publish', null).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  child.emit('error', new Error('受控IPC故障，进程尚未退出'));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  try {
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  } finally {
    child.emit('exit', 1);
    await pending;
  }
});
