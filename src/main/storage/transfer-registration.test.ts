import { mkdtemp, writeFile, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatasetScope } from './dataset-layout';
import {
  assertRegisteredTransferInput,
  parseTransferRegistration,
  registerTransferWorker,
  resolveRegisteredTransfer,
} from './transfer-registration';

async function fixture(action: 'backup' | 'restore' = 'restore') {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-registration-'));
  const job = { operationId: randomUUID(), snapshotId: randomUUID(), action };
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: job.operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  const path = join(root, '用户选择.aibak');
  await writeFile(path, '容器候选');
  return { root, scope, job, path };
}
describe('主进程维护登记', () => {
  it('有界登记绑定scope、原生选定文件身份和同一job，无配置或凭据', async () => {
    const { scope, job, path } = await fixture();
    const registration = await registerTransferWorker(scope, job, '0.1.0', path);
    expect(await resolveRegisteredTransfer(registration)).toEqual(scope);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.input)).toBe(true);
    const text = JSON.stringify(registration);
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
    for (const extra of ['provider', 'sql', 'script', 'command', 'key'])
      expect(text).not.toContain('"' + extra + '"');
  });
  it('原件被同名替换或改写后拒绝，替代物保持', async () => {
    const { scope, job, path } = await fixture();
    const r = await registerTransferWorker(scope, job, '0.1.0', path);
    await rename(path, path + '.retained');
    await writeFile(path, '容器候选');
    await expect(assertRegisteredTransferInput(r.input!)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('容器候选');
  });
  it('拒绝scope/action混代、额外私有配置、重复键和超限参数', async () => {
    const { scope, job, path } = await fixture();
    await expect(
      registerTransferWorker(scope, { ...job, operationId: randomUUID() }, '0.1.0', path),
    ).rejects.toThrow();
    const r = await registerTransferWorker(scope, job, '0.1.0', path);
    for (const value of [
      JSON.stringify({ ...r, sql: 'SELECT 1' }),
      JSON.stringify({ ...r, input: null }),
      JSON.stringify({ ...r, userDataRoot: '..' }),
      '{"version":1,"version":1}',
      ' '.repeat(4097),
    ])
      expect(() => parseTransferRegistration(value)).toThrow();
  });
  it('backup不接受外部输入，无法用env或renderer参数选择其输出成员', async () => {
    const { scope, job, path } = await fixture('backup');
    await expect(registerTransferWorker(scope, job, '0.1.0', path)).rejects.toThrow();
    const r = await registerTransferWorker(scope, job, '0.1.0');
    expect(r.input).toBeNull();
    await expect(resolveRegisteredTransfer({ ...r, generation: '0'.repeat(32) })).rejects.toThrow();
  });
});
