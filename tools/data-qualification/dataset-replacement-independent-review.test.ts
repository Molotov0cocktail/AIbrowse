import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import { DatasetReplacement } from '../../src/main/storage/dataset-replacement';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
afterEach(() => vi.restoreAllMocks());
const context = { check() {}, requireRollbackSpace() {}, assertNoWriters() {} };

it('归档最后目标存在性检查期间替换源，不能把未知替代物移动到证据目录', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'replacement-independent-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: randomUUID().replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: 'restore',
    },
    context,
  );
  const source = join(root, 'data-transfer', 'active.json');
  const target = join(scope.operationRoot, 'evidence', 'active.json');
  await fs.writeFile(source, 'old registered bytes');
  let armed = false,
    replaced = false;
  const engine = new DatasetReplacement(scope, {
    ...context,
    boundary(point) {
      if (point === 'before-replacement-archived:0') armed = true;
    },
  });
  await engine.prepare();
  const originalStat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (armed && !replaced && String(args[0]) === target) {
      await fs.rename(source, source + '.retained');
      await fs.writeFile(source, 'unknown replacement', { flag: 'wx' });
      replaced = true;
    }
    return originalStat(...args);
  });
  await expect(engine.archivePrevious()).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await fs.readFile(source, 'utf8')).toBe('unknown replacement');
  expect(await fs.readFile(source + '.retained', 'utf8')).toBe('old registered bytes');
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('replacement记录发布前最后目标检查期间替换tmp，不能把未知替代物发布为正式记录', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'replacement-record-independent-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: randomUUID().replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: 'restore',
    },
    context,
  );
  const final = join(scope.operationRoot, 'replacement.json');
  const temp = final + '.tmp';
  let armed = false,
    replaced = false;
  const engine = new DatasetReplacement(scope, {
    ...context,
    boundary(point) {
      if (point === 'replacement-temp-flushed') armed = true;
    },
  });
  const originalStat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (armed && !replaced && String(args[0]) === final) {
      await fs.rename(temp, temp + '.retained');
      await fs.writeFile(temp, 'unknown replacement', { flag: 'wx' });
      replaced = true;
    }
    return originalStat(...args);
  });
  await expect(engine.prepare()).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await fs.readFile(temp, 'utf8')).toBe('unknown replacement');
  await expect(fs.lstat(final)).rejects.toMatchObject({ code: 'ENOENT' });
});
