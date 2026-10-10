import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createDatasetScope, inspectDatasetWork } from './dataset-layout';
import { DatasetSwitch } from './dataset-switch';
import { registerActiveDataset, readActiveDataset } from './dataset-active';
import { TransferBudget } from './transfer-budget';
import { DatasetStartup } from './dataset-startup';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-startup-'));
  const context = { check() {}, requireRollbackSpace() {} };
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: 'a'.repeat(32),
      generation: 'b'.repeat(32),
      purpose: 'restore',
    },
    context,
  );
  for (const domain of ['sources', 'research', 'watch']) {
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
  await writeFile(join(root, 'conversations', 'index.json'), '旧索引');
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'index.json'), '新索引');
  await registerActiveDataset(scope);
  await new DatasetSwitch(scope, context).registerHandoff(
    await inspectDatasetWork(scope, context),
    new TransferBudget().suspend(),
  );
  return { root, scope };
}
describe('启动先恢复再开放Store', () => {
  it('无恢复操作不创建或打开任何数据库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aibrowse-no-startup-'));
    const boot = new DatasetStartup({ assertNoWriters() {} });
    expect(await boot.prepare(root)).toBe('normal');
    expect(() => boot.open('sources')).toThrow();
    await expect(boot.prepare(root)).rejects.toThrow();
  });
  it('同一健康世代3句柄拒写，全部健康和摘要提交后才解除保护', async () => {
    const { root } = await fixture();
    const boot = new DatasetStartup({ assertNoWriters() {} });
    expect(await boot.prepare(root)).toBe('checking');
    const handles = ['sources', 'research', 'watch'].map((domain) =>
      boot.open(domain as 'sources' | 'research' | 'watch'),
    );
    expect(await boot.complete(false)).toBe(false);
    expect(() => handles[0]!.prepare('INSERT INTO marker VALUES (?)').run('illegal')).toThrow();
    expect(await boot.complete(true)).toBe(true);
    expect(await readActiveDataset(root)).toBeNull();
    handles[0]!.prepare('INSERT INTO marker VALUES (?)').run('allowed');
    for (const h of handles) h.close();
    const again = new DatasetStartup({ assertNoWriters() {} });
    expect(await again.prepare(root)).toBe('normal');
  });
  it('服务健康失败关闭全部句柄并回退完整旧代，保持失败状态不自动再装配', async () => {
    const { root } = await fixture();
    const boot = new DatasetStartup({ assertNoWriters() {} });
    expect(await boot.prepare(root)).toBe('checking');
    const handle = boot.open('sources');
    expect(await boot.fail()).toBe('old-restored');
    expect(handle.isOpen).toBe(false);
    expect(boot.getState()).toBe('recovery-required');
    expect(await readFile(join(root, 'conversations', 'index.json'), 'utf8')).toBe('旧索引');
    expect(await readActiveDataset(root)).toBeNull();
  });
  it('健康提交期间退出封门后不解除数据库写保护', async () => {
    const { root } = await fixture();
    const boot = new DatasetStartup({ assertNoWriters() {} });
    expect(await boot.prepare(root)).toBe('checking');
    const handles = (['sources', 'research', 'watch'] as const).map((domain) => boot.open(domain));
    let checks = 0;
    expect(await boot.complete(() => ++checks === 1)).toBe(false);
    expect(boot.getState()).toBe('recovery-required');
    expect(() => handles[0]!.prepare('INSERT INTO marker VALUES (?)').run('illegal')).toThrow();
    await boot.fail();
    expect(handles.every((handle) => !handle.isOpen)).toBe(true);
  });
  it('未知active或中断tmp不可当作普通启动并写空库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aibrowse-bad-startup-'));
    await mkdir(join(root, 'data-transfer'));
    await writeFile(join(root, 'data-transfer', 'active.json.tmp'), '{');
    const boot = new DatasetStartup({ assertNoWriters() {} });
    expect(await boot.prepare(root)).toBe('recovery-required');
    expect(() => boot.open('sources')).toThrow();
    expect(await readFile(join(root, 'data-transfer', 'active.json.tmp'), 'utf8')).toBe('{');
  });
});
