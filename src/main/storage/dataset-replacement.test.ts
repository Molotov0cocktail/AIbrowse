import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  lstat,
  link,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDatasetScope, readDatasetScope, type DatasetContext } from './dataset-layout';
import { registerActiveDataset, readActiveDataset } from './dataset-active';
import {
  DatasetReplacement,
  ensureRecoveryGate,
  readRecoveryGate,
  type DatasetReplacementContext,
} from './dataset-replacement';

const context: DatasetReplacementContext = {
  check() {},
  requireRollbackSpace() {},
  assertNoWriters() {},
};
const old = Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.alloc(5000, 42)]);
const temporary = Buffer.from('{"unknown":"../outside",');
async function fixture(boundary?: DatasetContext['boundary']) {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: 'a'.repeat(32),
      generation: 'b'.repeat(32),
      purpose: 'restore',
    },
    context,
  );
  const active = join(root, 'data-transfer', 'active.json');
  await writeFile(active, old);
  await writeFile(active + '.tmp', temporary);
  const engine = new DatasetReplacement(scope, { ...context, boundary });
  return {
    root,
    scope,
    active,
    engine,
    gate: join(root, 'data-transfer', 'recovery-gate'),
    evidence: join(scope.operationRoot, 'evidence'),
  };
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false;
    throw e;
  }
}

describe('恢复意图有界接替', () => {
  it.each([
    'replacement-gate-created',
    'replacement-gate-flushed',
    'replacement-temp-created',
    'replacement-temp-written',
    'replacement-temp-flushed',
    'replacement-record-published',
    'before-replacement-archived:0',
    'replacement-archived:0',
    'before-replacement-archived:1',
    'replacement-archived:1',
  ])('中断%s后重开只接受完整凭据且旧指针恰好保留一份', async (point) => {
    let interrupted = false;
    const f = await fixture((value) => {
      if (value === point) {
        interrupted = true;
        throw new Error('模拟进程中断');
      }
    });
    await expect(
      (async () => {
        await f.engine.prepare();
        await f.engine.archivePrevious();
      })(),
    ).rejects.toThrow();
    expect(interrupted).toBe(true);
    expect(await exists(f.gate)).toBe(true);
    for (const [name, bytes] of [
      ['active.json', old],
      ['active.json.tmp', temporary],
    ] as const) {
      const source = join(f.root, 'data-transfer', name);
      const archived = join(f.evidence, name);
      expect(Number(await exists(source)) + Number(await exists(archived))).toBe(1);
      expect(await readFile((await exists(source)) ? source : archived)).toEqual(bytes);
    }
    const cold = new DatasetReplacement(await readDatasetScope(f.scope), context);
    if (await exists(join(f.scope.operationRoot, 'replacement.json'))) {
      await cold.archivePrevious();
      await registerActiveDataset(f.scope);
      await cold.verifyActive();
    } else {
      await expect(cold.archivePrevious()).rejects.toThrow();
      expect(await readFile(f.active)).toEqual(old);
      expect(await readFile(f.active + '.tmp')).toEqual(temporary);
    }
  });
  it.each(['before-replacement-gate-retired', 'replacement-gate-retired'])(
    '已提交后%s中断可验证重开，gate字节仍恰好保留一份',
    async (point) => {
      const f = await fixture();
      await f.engine.prepare();
      await f.engine.archivePrevious();
      await registerActiveDataset(f.scope);
      await writeFile(
        join(f.scope.operationRoot, 'journal.json'),
        JSON.stringify({
          version: 1,
          operationId: f.scope.operationId,
          generation: f.scope.generation,
          phase: 'committed',
        }),
      );
      const bytes = await readFile(f.gate);
      let interrupted = false;
      const engine = new DatasetReplacement(f.scope, {
        ...context,
        boundary(value) {
          if (value === point) {
            interrupted = true;
            throw new Error('模拟进程中断');
          }
        },
      });
      await expect(engine.retireGateAfterCommit(() => {})).rejects.toThrow();
      expect(interrupted).toBe(true);
      const archived = join(f.evidence, 'recovery-gate');
      expect(Number(await exists(f.gate)) + Number(await exists(archived))).toBe(1);
      expect(await readFile((await exists(f.gate)) ? f.gate : archived)).toEqual(bytes);
      await new DatasetReplacement(await readDatasetScope(f.scope), context).retireGateAfterCommit(
        () => {},
      );
      expect(await exists(f.gate)).toBe(false);
      expect(await readFile(archived)).toEqual(bytes);
    },
  );
  it('归档边界取消及commit证明撤销均不执行下一次rename', async () => {
    const f = await fixture();
    await f.engine.prepare();
    let allowed = true;
    const guarded = new DatasetReplacement(f.scope, {
      ...context,
      assertNoWriters() {
        if (!allowed) throw new Error('资格已撤销');
      },
      boundary(point) {
        if (point === 'before-replacement-archived:0') allowed = false;
      },
    });
    await expect(guarded.archivePrevious()).rejects.toThrow();
    expect(await readFile(f.active)).toEqual(old);
    await f.engine.archivePrevious();
    await registerActiveDataset(f.scope);
    await writeFile(
      join(f.scope.operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: f.scope.operationId,
        generation: f.scope.generation,
        phase: 'committed',
      }),
    );
    let committed = true;
    const retiring = new DatasetReplacement(f.scope, {
      ...context,
      boundary(point) {
        if (point === 'before-replacement-gate-retired') committed = false;
      },
    });
    await expect(
      retiring.retireGateAfterCommit(() => {
        if (!committed) throw new Error('健康证明已撤销');
      }),
    ).rejects.toThrow();
    expect(await exists(f.gate)).toBe(true);
    expect(await exists(join(f.evidence, 'recovery-gate'))).toBe(false);
  });
  it('gate只阻断启动；未知旧active/tmp按字节保全并绑定新active', async () => {
    const f = await fixture();
    expect(await readRecoveryGate(f.root, context)).toBeNull();
    await f.engine.prepare();
    expect(await readFile(f.active)).toEqual(old);
    expect(await readRecoveryGate(f.root, context)).not.toBeNull();
    await f.engine.archivePrevious();
    await f.engine.archivePrevious();
    expect(await readFile(join(f.evidence, 'active.json'))).toEqual(old);
    expect(await readFile(join(f.evidence, 'active.json.tmp'))).toEqual(temporary);
    await registerActiveDataset(f.scope);
    await new DatasetReplacement(await readDatasetScope(f.scope), context).verifyActive();
    expect((await readActiveDataset(f.root))?.operationId).toBe(f.scope.operationId);
    expect(
      (await readFile(join(f.scope.operationRoot, 'replacement.json'))).length,
    ).toBeLessThanOrEqual(4096);
  });
  it('缺失旧指针显式记录；新active必须绑定同一个恢复scope', async () => {
    const f = await fixture();
    await rename(f.active, join(f.root, 'saved-original'));
    await rename(f.active + '.tmp', join(f.root, 'saved-temporary'));
    await f.engine.prepare();
    await f.engine.archivePrevious();
    const record = JSON.parse(
      await readFile(join(f.scope.operationRoot, 'replacement.json'), 'utf8'),
    ) as { previous: unknown };
    expect(record.previous).toEqual([null, null]);
    const other = await createDatasetScope(
      {
        userDataRoot: f.root,
        operationId: 'c'.repeat(32),
        generation: 'd'.repeat(32),
        purpose: 'restore',
      },
      context,
    );
    await registerActiveDataset(other);
    await expect(f.engine.verifyActive()).rejects.toThrow();
    expect(await exists(f.gate)).toBe(true);
  });
  it('旧7身份owner仍可读但不能被接替器隐式迁移', async () => {
    const f = await fixture();
    const ownerPath = join(f.scope.operationRoot, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      version: number;
      identities: unknown[];
    };
    expect(owner.version).toBe(2);
    expect(owner.identities).toHaveLength(8);
    owner.version = 1;
    owner.identities.pop();
    const bytes = JSON.stringify(owner);
    await writeFile(ownerPath, bytes);
    const legacy = await readDatasetScope(f.scope);
    expect(legacy.identities).toHaveLength(7);
    await expect(new DatasetReplacement(legacy, context).prepare()).rejects.toThrow();
    expect(await readFile(ownerPath, 'utf8')).toBe(bytes);
  });
  it('writer/取消阻止归档，未准备的scope及错代均无权接替', async () => {
    const f = await fixture();
    await expect(f.engine.archivePrevious()).rejects.toThrow();
    await expect(
      new DatasetReplacement(f.scope, {
        ...context,
        assertNoWriters() {
          throw new Error('仍有writer');
        },
      }).prepare(),
    ).rejects.toThrow();
    await expect(
      new DatasetReplacement({ ...f.scope, generation: 'c'.repeat(32) }, context).prepare(),
    ).rejects.toThrow();
    expect(await readFile(f.active)).toEqual(old);
  });
  it('两个位置同时存在、原件变化与未知目标均失败且零覆盖', async () => {
    for (const kind of ['both', 'changed', 'target'] as const) {
      const f = await fixture();
      await f.engine.prepare();
      if (kind === 'changed') await writeFile(f.active, '被改变');
      else
        await writeFile(
          join(f.evidence, 'active.json'),
          kind === 'both' ? old : Buffer.from('未知证据'),
        );
      await expect(f.engine.archivePrevious()).rejects.toThrow();
      expect(await readFile(f.active)).toEqual(kind === 'changed' ? Buffer.from('被改变') : old);
    }
  });
  it('损坏/重复键/伪路径replacement不赋予移动权限', async () => {
    for (const body of ['{', '{"version":1,"version":1}', '{"path":"../outside"}']) {
      const f = await fixture();
      await ensureRecoveryGate(f.root, context);
      await writeFile(join(f.scope.operationRoot, 'replacement.json'), body);
      await expect(f.engine.archivePrevious()).rejects.toThrow();
      expect(await readFile(f.active)).toEqual(old);
    }
  });
  it('替换gate/evidence身份、硬链接和目录冒充pointer均拒绝', async () => {
    for (const kind of ['gate', 'evidence', 'hardlink', 'directory'] as const) {
      const f = await fixture();
      await f.engine.prepare();
      if (kind === 'gate') {
        await rename(f.gate, f.gate + '.saved');
        await writeFile(f.gate, 'new');
      }
      if (kind === 'evidence') {
        await rename(f.evidence, f.evidence + '.saved');
        await mkdir(f.evidence);
      }
      if (kind === 'hardlink') await link(f.active, join(f.root, 'linked'));
      if (kind === 'directory') {
        await rename(f.active, f.active + '.saved');
        await mkdir(f.active);
      }
      await expect(f.engine.archivePrevious()).rejects.toThrow();
    }
  });
  it('目录链接不被作为数据根或evidence接纳', async () => {
    const f = await fixture();
    await f.engine.prepare();
    await rename(f.evidence, f.evidence + '.saved');
    await symlink(
      f.evidence + '.saved',
      f.evidence,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(f.engine.archivePrevious()).rejects.toThrow();
  });
  it('只有完整commit proof可退役gate；gate原件仍存evidence', async () => {
    const f = await fixture();
    await f.engine.prepare();
    await f.engine.archivePrevious();
    await registerActiveDataset(f.scope);
    await expect(
      f.engine.retireGateAfterCommit(() => {
        throw new Error('健康未完成');
      }),
    ).rejects.toThrow();
    await writeFile(
      join(f.scope.operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: f.scope.operationId,
        generation: f.scope.generation,
        phase: 'rolled-back',
      }),
    );
    await expect(f.engine.retireGateAfterCommit(() => {})).rejects.toThrow();
    expect(await exists(f.gate)).toBe(true);
    await writeFile(
      join(f.scope.operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: f.scope.operationId,
        generation: f.scope.generation,
        phase: 'committed',
      }),
    );
    const gate = await readFile(f.gate);
    await f.engine.retireGateAfterCommit(() => {});
    await f.engine.retireGateAfterCommit(() => {});
    expect(await exists(f.gate)).toBe(false);
    expect(await readFile(join(f.evidence, 'recovery-gate'))).toEqual(gate);
  });
  it('再次显式恢复使用新scope，前次归档与未知新active均保留', async () => {
    const f = await fixture();
    await f.engine.prepare();
    await f.engine.archivePrevious();
    await registerActiveDataset(f.scope);
    const active = await readFile(f.active);
    const next = await createDatasetScope(
      {
        userDataRoot: f.root,
        operationId: 'c'.repeat(32),
        generation: 'd'.repeat(32),
        purpose: 'restore',
      },
      context,
    );
    const engine = new DatasetReplacement(next, context);
    await engine.prepare();
    await engine.archivePrevious();
    await registerActiveDataset(next);
    await engine.verifyActive();
    expect(await readFile(join(next.operationRoot, 'evidence', 'active.json'))).toEqual(active);
    expect(await readFile(join(f.evidence, 'active.json'))).toEqual(old);
  });
});
