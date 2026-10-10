import { mkdtemp, mkdir, writeFile, readFile, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DatasetStartup } from './dataset-startup';
import { createDatasetScope, inspectDatasetWork } from './dataset-layout';
import { DatasetSwitch } from './dataset-switch';
import { registerActiveDataset, readActiveDataset } from './dataset-active';
import { DatasetReplacement, ensureRecoveryGate, readRecoveryGate } from './dataset-replacement';
import { TransferBudget } from './transfer-budget';

afterEach(() => vi.restoreAllMocks());
const context = { check() {}, requireRollbackSpace() {}, assertNoWriters() {} };
const domains = ['sources', 'research', 'watch'] as const;
async function fixture(replacement = true) {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-startup-gate-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: 'a'.repeat(32),
      generation: 'b'.repeat(32),
      purpose: 'restore',
    },
    context,
  );
  for (const domain of domains) {
    await mkdir(join(root, domain));
    for (const [path, value] of [
      [join(root, domain, `${domain}.db`), 'old'],
      [join(scope.operationRoot, 'work', `${domain}.db`), 'new'],
    ]) {
      const db = new DatabaseSync(path!);
      db.exec('CREATE TABLE marker(value TEXT)');
      db.prepare('INSERT INTO marker VALUES (?)').run(value!);
      db.close();
    }
  }
  await mkdir(join(root, 'conversations'));
  await writeFile(join(root, 'conversations', 'index.json'), 'old');
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'index.json'), 'new');
  const replacementEngine = new DatasetReplacement(scope, context);
  if (replacement) {
    await writeFile(join(root, 'data-transfer', 'active.json'), 'opaque-old');
    await replacementEngine.prepare();
    await replacementEngine.archivePrevious();
  } else await ensureRecoveryGate(root, context);
  await registerActiveDataset(scope);
  const engine = new DatasetSwitch(scope, context);
  await engine.registerHandoff(
    await inspectDatasetWork(scope, context),
    new TransferBudget().suspend(),
  );
  return { root, scope, engine, replacementEngine };
}
const boot = () => new DatasetStartup({ assertNoWriters() {} });

it.each(['missing', 'bad'] as const)(
  'gate存在且active为%s时拒绝普通启动并保留原件',
  async (active) => {
    const root = await mkdtemp(join(tmpdir(), 'aibrowse-empty-gate-'));
    await ensureRecoveryGate(root, context);
    if (active === 'bad') await writeFile(join(root, 'data-transfer', 'active.json'), 'invalid');
    expect(await boot().prepare(root)).toBe('recovery-required');
    expect(await readRecoveryGate(root, context)).not.toBeNull();
  },
);
it('gate存在的普通handoff没有replacement证明不得发布新库', async () => {
  const f = await fixture(false);
  expect(await boot().prepare(f.root)).toBe('recovery-required');
  expect(await readFile(join(f.root, 'conversations', 'index.json'), 'utf8')).toBe('old');
  expect(await readActiveDataset(f.root)).not.toBeNull();
});
it('replacement归档变化必须在切换前拒绝，不能先发布再健康检查', async () => {
  const f = await fixture();
  await writeFile(join(f.scope.operationRoot, 'evidence', 'active.json'), 'changed');
  expect(await boot().prepare(f.root)).toBe('recovery-required');
  expect(await readFile(join(f.root, 'conversations', 'index.json'), 'utf8')).toBe('old');
});
it('救援的old-restored只回到救援前现场，仍保留gate及active', async () => {
  const f = await fixture();
  expect((await f.engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  expect((await f.engine.rollbackAfterFailure()).state).toBe('old-restored');
  expect(await boot().prepare(f.root)).toBe('recovery-required');
  expect(await readRecoveryGate(f.root, context)).not.toBeNull();
  expect(await readActiveDataset(f.root)).not.toBeNull();
});
it('完整健康提交后先归档gate再清active，才开启三个健康句柄写入', async () => {
  const f = await fixture();
  const proof = vi.fn();
  const startup = new DatasetStartup({ assertNoWriters: proof });
  expect(await startup.prepare(f.root)).toBe('checking');
  const handles = domains.map((domain) => startup.open(domain));
  try {
    expect(await startup.complete(true)).toBe(true);
    expect(await readRecoveryGate(f.root, context)).toBeNull();
    expect(await lstat(join(f.scope.operationRoot, 'evidence', 'recovery-gate'))).toBeDefined();
    expect(await readActiveDataset(f.root)).toBeNull();
    expect(proof).toHaveBeenCalledWith('before-stores');
    expect(proof).toHaveBeenCalledWith('read-only-health');
    handles[0]!.exec("INSERT INTO marker VALUES ('allowed')");
  } finally {
    for (const handle of handles) handle.close();
  }
});
it('gate退休失败不清active不开放健康句柄写权限', async () => {
  const f = await fixture();
  const startup = boot();
  expect(await startup.prepare(f.root)).toBe('checking');
  const handles = domains.map((domain) => startup.open(domain));
  vi.spyOn(DatasetReplacement.prototype, 'retireGateAfterCommit').mockRejectedValueOnce(
    new Error('失败'),
  );
  try {
    expect(await startup.complete(true)).toBe(false);
    expect(await readActiveDataset(f.root)).not.toBeNull();
    expect(await readRecoveryGate(f.root, context)).not.toBeNull();
    expect(() => handles[0]!.exec("INSERT INTO marker VALUES ('illegal')")).toThrow();
  } finally {
    for (const handle of handles) handle.close();
  }
});
it.each([false, true])('committed重启幂等完成gate退休（此前已退役=%s）', async (retired) => {
  const f = await fixture();
  expect((await f.engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  expect((await f.engine.commitHealthy()).state).toBe('committed');
  if (retired) await f.replacementEngine.retireGateAfterCommit(() => {});
  expect(await boot().prepare(f.root)).toBe('normal');
  expect(await readRecoveryGate(f.root, context)).toBeNull();
  expect(await readActiveDataset(f.root)).toBeNull();
});
it('无writer主进程证明失效时连普通启动也不得放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-writer-proof-'));
  const startup = new DatasetStartup({
    assertNoWriters() {
      throw new Error('旧writer未退出');
    },
  });
  expect(await startup.prepare(root)).toBe('recovery-required');
});

it('健康失败关闭该代句柄并回退，gate与active继续阻止救援前现场开放', async () => {
  const f = await fixture();
  const startup = boot();
  expect(await startup.prepare(f.root)).toBe('checking');
  const handle = startup.open('sources');
  expect(startup.hasOpenHealthHandles()).toBe(true);
  expect(await startup.fail()).toBe('recovery-required');
  expect(startup.hasOpenHealthHandles()).toBe(false);
  expect(handle.isOpen).toBe(false);
  expect(await readFile(join(f.root, 'conversations', 'index.json'), 'utf8')).toBe('old');
  expect(await readRecoveryGate(f.root, context)).not.toBeNull();
  expect(await readActiveDataset(f.root)).not.toBeNull();
});
it('主进程健康期无writer证明撤销后，不提交、不退役gate，fail仍受控关闭句柄', async () => {
  const f = await fixture();
  let permitted = true;
  const startup = new DatasetStartup({
    assertNoWriters() {
      if (!permitted) throw new Error('writer状态不明');
    },
  });
  expect(await startup.prepare(f.root)).toBe('checking');
  const handles = domains.map((domain) => startup.open(domain));
  permitted = false;
  expect(await startup.complete(true)).toBe(false);
  expect(await startup.fail()).toBe('recovery-required');
  expect(handles.every((handle) => !handle.isOpen)).toBe(true);
  expect(await readRecoveryGate(f.root, context)).not.toBeNull();
  expect(await readActiveDataset(f.root)).not.toBeNull();
});
it('未提交却已缺失gate不能启动切换，即使gate原件在evidence也不授许可', async () => {
  const f = await fixture();
  await rename(
    join(f.root, 'data-transfer', 'recovery-gate'),
    join(f.scope.operationRoot, 'evidence', 'recovery-gate'),
  );
  expect(await boot().prepare(f.root)).toBe('recovery-required');
  expect(await readFile(join(f.root, 'conversations', 'index.json'), 'utf8')).toBe('old');
  expect(await readActiveDataset(f.root)).not.toBeNull();
});
it('已提交且gate已退役也须校验归档，不能只因gate缺失就清active', async () => {
  const f = await fixture();
  expect((await f.engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  expect((await f.engine.commitHealthy()).state).toBe('committed');
  await f.replacementEngine.retireGateAfterCommit(() => {});
  await writeFile(
    join(f.scope.operationRoot, 'evidence', 'active.json'),
    'replacement-of-evidence',
  );
  expect(await boot().prepare(f.root)).toBe('recovery-required');
  expect(await readActiveDataset(f.root)).not.toBeNull();
});

it('健康句柄关闭失败仍保留所有权，只有真实关闭成功才报告无句柄', async () => {
  const f = await fixture();
  const startup = boot();
  expect(await startup.prepare(f.root)).toBe('checking');
  const handle = startup.open('sources');
  const close = vi.spyOn(handle, 'close').mockImplementation(() => {
    throw new Error('关闭失败');
  });
  expect(await startup.fail()).toBe('recovery-required');
  expect(startup.hasOpenHealthHandles()).toBe(true);
  expect(handle.isOpen).toBe(true);
  close.mockRestore();
  expect(await startup.fail()).toBe('recovery-required');
  expect(startup.hasOpenHealthHandles()).toBe(false);
  expect(handle.isOpen).toBe(false);
});
