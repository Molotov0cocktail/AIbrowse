import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  lstat,
  link,
  symlink,
  rename,
  readdir,
  statfs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDatasetScope,
  inspectDatasetWork,
  readDatasetScope,
  DATASET_MEMBERS,
  type DatasetContext,
} from './dataset-layout';
import { DatasetSwitch } from './dataset-switch';
import { TransferBudget } from './transfer-budget';

const context: DatasetContext = { check: () => {}, requireRollbackSpace: () => {} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-dataset-switch-'));
  for (const name of ['sources', 'research', 'watch', 'conversations'])
    await mkdir(join(root, name));
  for (const domain of ['sources', 'research', 'watch']) {
    await writeFile(join(root, domain, `${domain}.db`), `old-${domain}`);
    await writeFile(join(root, domain, `${domain}.db-wal`), `wal-${domain}`);
    await writeFile(join(root, domain, `${domain}.db-shm`), `shm-${domain}`);
    await writeFile(join(root, domain, `${domain}.db-journal`), `journal-${domain}`);
    await mkdir(join(root, domain, 'backups'));
    await writeFile(join(root, domain, 'backups', 'keep'), '保留备份');
  }
  await writeFile(join(root, 'conversations', 'index.json'), 'old-index');
  await writeFile(join(root, 'credentials.json'), '不触及');
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
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
    root,
    scope,
    expected: await inspectDatasetWork(scope, context),
    engine: new DatasetSwitch(scope, context),
  };
}

describe('固定数据代切换', () => {
  it('登记handoff不动活库，startup保存完整旧WAL/SHM/journal后发布同一新代', async () => {
    const { root, scope, expected, engine } = await fixture();
    expect((await engine.registerHandoff(expected, new TransferBudget().suspend())).state).toBe(
      'handoff',
    );
    expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
    expect((await engine.resumeAtStartup()).state).toBe('new-awaiting-health');
    expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('new-sources');
    for (const [id, text] of [
      ['sources', 'old-sources'],
      ['sources-wal', 'wal-sources'],
      ['sources-shm', 'shm-sources'],
      ['sources-journal', 'journal-sources'],
    ])
      expect(await readFile(join(scope.operationRoot, 'rollback', id!), 'utf8')).toBe(text);
    expect(await readFile(join(root, 'sources', 'backups', 'keep'), 'utf8')).toBe('保留备份');
    expect(await readFile(join(root, 'credentials.json'), 'utf8')).toBe('不触及');
    expect((await engine.commitHealthy()).state).toBe('committed');
  });
  it('篡改新件即拒绝，不靠handoff声明授予成功', async () => {
    const { root, scope, expected, engine } = await fixture();
    await engine.registerHandoff(expected, new TransferBudget().suspend());
    await writeFile(join(scope.operationRoot, 'work', 'sources.db'), 'tampered');
    expect((await engine.resumeAtStartup()).state).toBe('recovery-required');
    expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
  });
  it('健康失败回退完整旧代且保留失败新件', async () => {
    const { root, scope, expected, engine } = await fixture();
    await engine.registerHandoff(expected, new TransferBudget().suspend());
    await engine.resumeAtStartup();
    expect((await engine.rollbackAfterFailure()).state).toBe('old-restored');
    expect(await readFile(join(root, 'sources', 'sources.db-wal'), 'utf8')).toBe('wal-sources');
    expect(await readFile(join(scope.operationRoot, 'work', 'sources.db'), 'utf8')).toBe(
      'new-sources',
    );
    expect(await readFile(join(root, 'conversations', 'index.json'), 'utf8')).toBe('old-index');
  });
  it('未知额外键清单或重复JSON键安全拒绝', async () => {
    const { scope, engine } = await fixture();
    await writeFile(join(scope.operationRoot, 'journal.json'), '{"version":1,"version":1}');
    expect((await engine.resumeAtStartup()).state).toBe('recovery-required');
  });
  it('新成员摘要必须闭合，不能把伪路径当逻辑ID', async () => {
    const { engine, expected } = await fixture();
    const forged = {
      ...expected,
      path: '../credentials.json',
      sources: { bytes: 1, sha256: createHash('sha256').update('x').digest('hex') },
    };
    expect((await engine.registerHandoff(forged, new TransferBudget().suspend())).state).toBe(
      'recovery-required',
    );
  });
});

it('旧数据按实际分配单元准入，空间失败前不创建回退副本或改动旧数据', async () => {
  const { root, scope, expected } = await fixture();
  await mkdir(join(root, 'conversations', 'nested'));
  await writeFile(join(root, 'conversations', 'nested', 'extra'), Buffer.alloc(8193));
  const cluster = Number((await statfs(root)).bsize);
  let requested = 0;
  const guarded = {
    ...context,
    requireRollbackSpace: (bytes: number) => {
      requested = bytes;
      throw new Error('空间不足');
    },
  };
  const engine = new DatasetSwitch(scope, guarded);
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect(requested).toBe(0);
  expect((await engine.resumeAtStartup()).state).toBe('old-unchanged');
  // Thirteen small files, one larger file and two directory allocation units.
  expect(requested).toBe(15 * cluster + Math.ceil(8193 / cluster) * cluster);
  expect(await readdir(join(scope.operationRoot, 'rollback'))).toEqual([]);
  expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
});

it('失败后撤销同实例的健康提交资格', async () => {
  const { root, expected, engine } = await fixture();
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  const path = join(root, 'sources', 'sources.db');
  await writeFile(path, 'unknown');
  expect((await engine.commitHealthy()).state).toBe('recovery-required');
  await writeFile(path, 'new-sources');
  expect((await engine.commitHealthy()).state).toBe('recovery-required');
});

it('已停止标志不泄漏到后续独立失败的结果', async () => {
  const { scope, expected } = await fixture();
  const engine = new DatasetSwitch(scope, {
    ...context,
    check: (phase) => {
      if (phase === 'backup') throw new Error('取消');
    },
  });
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('old-unchanged');
  expect((await engine.commitHealthy()).state).toBe('recovery-required');
});

it('非法总预算不能通过向下钳制被接受', async () => {
  const { expected, engine } = await fixture();
  const budget = new TransferBudget().suspend();
  for (const key of Object.keys(budget.phaseRemainingMs) as Array<
    keyof typeof budget.phaseRemainingMs
  >)
    budget.phaseRemainingMs[key] = 0;
  expect((await engine.registerHandoff(expected, budget)).state).toBe('recovery-required');
});

it('scope创建冲突不把操作根路径包含在错误中', async () => {
  const { scope } = await fixture();
  await expect(createDatasetScope(scope, context)).rejects.toThrow(
    /^数据切换校验失败，原件和现场已保留$/u,
  );
});

it.each(DATASET_MEMBERS.map(([id], index) => [id, index] as const))(
  '安放期间%s原件rename后故障可恢复完整旧代',
  async (_id, index) => {
    const { root, scope, expected } = await fixture();
    let fired = false;
    const engine = new DatasetSwitch(scope, {
      ...context,
      check: () => {},
      boundary: (point) => {
        if (!fired && point === `retired:${index}`) {
          fired = true;
          throw new Error('注入故障');
        }
      },
    });
    await engine.registerHandoff(expected, new TransferBudget().suspend());
    expect((await engine.resumeAtStartup()).state).toBe('old-restored');
    expect(fired).toBe(true);
    for (const domain of ['sources', 'research', 'watch']) {
      expect(await readFile(join(root, domain, `${domain}.db`), 'utf8')).toBe(`old-${domain}`);
      expect(await readFile(join(root, domain, `${domain}.db-wal`), 'utf8')).toBe(`wal-${domain}`);
      expect(await readFile(join(root, domain, `${domain}.db-shm`), 'utf8')).toBe(`shm-${domain}`);
      expect(await readFile(join(root, domain, `${domain}.db-journal`), 'utf8')).toBe(
        `journal-${domain}`,
      );
    }
  },
);

it('切换前取消返回旧数据未改，不把预算失败当保存成功', async () => {
  const { root, scope, expected } = await fixture();
  const engine = new DatasetSwitch(scope, {
    ...context,
    check: (phase, bytes) => {
      if (phase === 'backup' && bytes > 0) throw new Error('取消');
    },
  });
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('old-unchanged');
  expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
});

it('领取过健康额度的新进程不能重新获得健康尝试', async () => {
  const { scope, expected, engine } = await fixture();
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  const reopened = await readDatasetScope({
    userDataRoot: scope.userDataRoot,
    operationId: scope.operationId,
  });
  const next = new DatasetSwitch(reopened, context);
  expect((await next.resumeAtStartup()).code).toBe('attempt-exhausted');
  expect((await next.commitHealthy()).state).toBe('recovery-required');
  expect((await next.rollbackAfterFailure()).state).toBe('old-restored');
});

it('journal保留main移交的预算，不恢复已消耗的额度', async () => {
  const { scope, expected, engine } = await fixture();
  let clock = 0;
  const budget = new TransferBudget(() => clock);
  budget.enter('sqlite');
  clock = 80_000;
  const suspended = budget.suspend();
  await engine.registerHandoff(expected, suspended);
  expect((await engine.readBudgetState())?.phaseRemainingMs.sqlite).toBe(10_000);
  await engine.resumeAtStartup();
  const remaining = await engine.readBudgetState();
  expect(remaining?.phaseRemainingMs.rollbackCopy).toBe(0);
  expect(remaining?.phaseRemainingMs.publish).toBe(30_000);
  expect(remaining?.phaseRemainingMs.boot).toBe(0);
  expect((await lstat(join(scope.operationRoot, 'journal.json'))).size).toBeLessThanOrEqual(4096);
});

it.each(['半写', '非法UTF8', '超长'] as const)('%s清单原件保留，不发布新数据', async (kind) => {
  const { root, scope, expected, engine } = await fixture();
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  const damaged =
    kind === '半写'
      ? Buffer.from('{"version":')
      : kind === '非法UTF8'
        ? Buffer.from([0xc3, 0x28])
        : Buffer.alloc(4097, 32);
  const path = join(scope.operationRoot, 'journal.json.tmp');
  await writeFile(path, damaged);
  expect((await engine.resumeAtStartup()).state).toBe('recovery-required');
  expect(await readFile(path)).toEqual(damaged);
  expect(await readFile(join(root, 'sources', 'sources.db'), 'utf8')).toBe('old-sources');
});

it('多硬链接旧库被拒绝且不会破坏另一个名字', async () => {
  const { root, expected, engine } = await fixture();
  await link(join(root, 'sources', 'sources.db'), join(root, 'keep.db'));
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('recovery-required');
  expect(await readFile(join(root, 'keep.db'), 'utf8')).toBe('old-sources');
});

it('会话junction越界被拒绝，外部目录保留', async () => {
  const { root, expected, engine } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'aibrowse-dataset-external-'));
  await writeFile(join(outside, 'keep'), '不触及');
  await rename(join(root, 'conversations'), join(root, 'original-conversations'));
  await symlink(outside, join(root, 'conversations'), 'junction');
  await engine.registerHandoff(expected, new TransferBudget().suspend());
  expect((await engine.resumeAtStartup()).state).toBe('recovery-required');
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('不触及');
});
