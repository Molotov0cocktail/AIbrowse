import { mkdtemp, readFile, writeFile, lstat, rename, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatasetScope } from './dataset-layout';
import { clearActiveDataset, readActiveDataset, registerActiveDataset } from './dataset-active';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-active-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: 'a'.repeat(32),
      generation: 'b'.repeat(32),
      purpose: 'restore',
    },
    { check() {}, requireRollbackSpace() {} },
  );
  return { root, scope, path: join(root, 'data-transfer', 'active.json') };
}
describe('唯一维护操作指针', () => {
  it('持久登记后冷读取相同世代，精确清除后仍保留整个操作现场', async () => {
    const { root, scope, path } = await fixture();
    expect(await readActiveDataset(root)).toBeNull();
    await registerActiveDataset(scope);
    expect(await readActiveDataset(root)).toEqual(scope);
    await clearActiveDataset(scope);
    expect(await readActiveDataset(root)).toBeNull();
    expect((await lstat(scope.operationRoot)).isDirectory()).toBe(true);
    await expect(lstat(path)).rejects.toHaveProperty('code', 'ENOENT');
  });
  it('已有指针或中断tmp拒绝覆盖，原件逐字保留', async () => {
    const { root, scope, path } = await fixture();
    await writeFile(path + '.tmp', '中断');
    await expect(registerActiveDataset(scope)).rejects.toThrow();
    await expect(readActiveDataset(root)).rejects.toThrow();
    expect(await readFile(path + '.tmp', 'utf8')).toBe('中断');
  });
  it('未知键、重复键和超限文件不能转为没有待恢复操作', async () => {
    const { root, path } = await fixture();
    for (const text of ['{}', '{"version":1,"version":1}', ' '.repeat(4097)]) {
      await writeFile(path, text);
      await expect(readActiveDataset(root)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(text);
    }
  });
  it('另一世代不能认领或清除当前指针', async () => {
    const { scope, path } = await fixture();
    await registerActiveDataset(scope);
    const before = await readFile(path);
    await expect(clearActiveDataset({ ...scope, generation: 'c'.repeat(32) })).rejects.toThrow();
    await expect(registerActiveDataset(scope)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  });
  it('owner替代或指针多硬链接拒绝，保留替代对象', async () => {
    const { root, scope, path } = await fixture();
    await registerActiveDataset(scope);
    await link(path, path + '.linked');
    await expect(readActiveDataset(root)).rejects.toThrow();
    await expect(clearActiveDataset(scope)).rejects.toThrow();
    expect((await lstat(path)).nlink).toBe(2);
    await rename(scope.operationRoot, scope.operationRoot + '-retained');
    await expect(readActiveDataset(root)).rejects.toThrow();
  });
});
