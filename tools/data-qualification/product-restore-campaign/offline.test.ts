import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { offline } from './offline';
import { exactSources, record } from './binding';
import { hash, read, save } from './files';
import { verifySmallFixture } from '../product-restore-fixtures/oracle';
import { projectBinding } from './project-binding';
import { compileBundle } from './compile';
import { Processes } from './process';

async function fixture() {
  const parent = resolve('log/stage7-e2/restore-campaign-implementation-001');
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(join(parent, 'offline-'));
  const appData = join(evidence, 'appData'),
    journal = join(evidence, 'journal');
  const root = join(appData, 'aibrowse'),
    fileId128 = 'a'.repeat(32),
    volumeSerial64 = 'b'.repeat(16);
  await mkdir(root, { recursive: true });
  await mkdir(join(journal, 'runner-output/restore-campaign'), { recursive: true });
  const runId = randomUUID().replaceAll('-', '');
  await save(join(root, '.aibrowse-e1-synthetic-owner.json'), {
    version: 1,
    runId,
    fileId128,
    volumeSerial64,
  });
  await save(join(journal, 'manifest.json'), {
    Version: 2,
    RunId: runId,
    DeclaredProfile: root,
    ResolvedProfile: root,
    RootIdentity: {
      FileId128: fileId128,
      VolumeSerial64: volumeSerial64,
      Sddl: '纯工具夹具，不授原生根身份',
    },
  });
  return { root, appData, journal, evidence };
}
it('编译后offline工具实际进程验证A/B装配及H生产备份，无产品进程', async () => {
  const r = await fixture(),
    p = await fixture();
  const bundle = join(r.evidence, 'offline.cjs');
  const bound: string[] = [];
  const compiled = await compileBundle(
    resolve('tools/data-qualification/product-restore-campaign/offline-entry.ts'),
    bundle,
    async (path) => {
      bound.push(path);
    },
  );
  await save(join(r.evidence, 'compiled-inputs.json'), {
    bound,
    inputs: compiled.inputs,
    rendered: compiled.rendered,
  });
  const deadline = performance.now() + 30_000;
  const processes = new Processes(() => deadline);
  try {
    await processes.external(
      process.execPath,
      [bundle, 'prepare', 'R', r.appData, r.journal],
      deadline,
    );
    expect(verifySmallFixture(r.root, 'A', 'source').bytes).toBe(942553);
    await mkdir(join(r.root, 'lifecycle-guardian'));
    await save(join(r.root, 'lifecycle-guardian/writers.json'), {
      version: 1,
      root: 'c'.repeat(64),
      session: 'd'.repeat(32),
      main: null,
      utility: null,
    });
    await processes.external(
      process.execPath,
      [bundle, 'install-b', 'R', r.appData, r.journal],
      deadline,
    );
    expect(verifySmallFixture(r.root, 'B', 'source').bytes).toBe(942553);
    expect(
      verifySmallFixture(join(r.root, 'restore-campaign-preserved-A'), 'A', 'source').bytes,
    ).toBe(942553);
    await processes.external(
      process.execPath,
      [bundle, 'prepare', 'P', p.appData, p.journal],
      deadline,
    );
    const evidence = join(p.journal, 'runner-output/restore-campaign');
    expect(verifySmallFixture(join(evidence, 'fixtures/H'), 'H', 'source').bytes).toBe(942553);
    expect(
      JSON.parse((await readFile(join(evidence, 'synthetic-H-wire.json'))).toString()).origin,
    ).toBe('受控合成生产管线备份');
    expect((await readFile(join(p.root, 'conversations/index.json'))).toString()).toBe(
      '{"version":1,"sessions":',
    );
    expect(processes.owned.size).toBe(0);
    expect(processes.diagnostics).toHaveLength(3);
    expect(
      processes.diagnostics.every(
        (child) => child.exitSeen && child.exitCode === 0 && child.closeCode === 0 && !child.failed,
      ),
    ).toBe(true);
  } finally {
    processes.stop();
    await Promise.all([...processes.owned].map((child) => child.closed));
    await save(join(r.evidence, 'compiled-children.json'), processes.diagnostics);
  }
}, 40_000);
it('A装配→拒绝忙writer→退休后保留A且安装B，全部原件保持', async () => {
  const f = await fixture();
  await offline('prepare', 'R', f.appData, f.journal);
  expect(verifySmallFixture(f.root, 'A', 'source').bytes).toBe(942553);
  await mkdir(join(f.root, 'lifecycle-guardian'));
  const ledger = {
    version: 1,
    root: 'c'.repeat(64),
    session: 'd'.repeat(32),
    main: { pid: 1, created: '133000000000000001', image: 'e'.repeat(64) },
    utility: null,
  };
  const path = join(f.root, 'lifecycle-guardian/writers.json');
  await save(path, ledger);
  await expect(offline('install-b', 'R', f.appData, f.journal)).rejects.toThrow();
  expect(verifySmallFixture(f.root, 'A', 'source').bytes).toBe(942553);
  await writeFile(path, JSON.stringify({ ...ledger, main: null }));
  await offline('install-b', 'R', f.appData, f.journal);
  expect(verifySmallFixture(f.root, 'B', 'source').bytes).toBe(942553);
  expect(
    verifySmallFixture(join(f.root, 'restore-campaign-preserved-A'), 'A', 'source').bytes,
  ).toBe(942553);
  await expect(offline('install-b', 'R', f.appData, f.journal)).rejects.toThrow();
});
it('P构造保留坏index、有效三库以及明确合成H备份，重复准备拒绝覆盖', async () => {
  const f = await fixture();
  await offline('prepare', 'P', f.appData, f.journal);
  const index = await readFile(join(f.root, 'conversations/index.json'));
  expect(index.toString()).toBe('{"version":1,"sessions":');
  const evidence = join(f.journal, 'runner-output/restore-campaign');
  const wire = JSON.parse((await readFile(join(evidence, 'synthetic-H-wire.json'))).toString()) as {
    origin: string;
    members: unknown[];
  };
  expect(wire.origin).toBe('受控合成生产管线备份');
  expect(wire.members).toHaveLength(4);
  expect(verifySmallFixture(join(evidence, 'fixtures/H'), 'H', 'source').bytes).toBe(942553);
  await expect(offline('prepare', 'P', f.appData, f.journal)).rejects.toThrow();
  expect(hash(await read(join(f.root, 'conversations/index.json')))).toBe(hash(index));
  await mkdir(join(f.root, 'data-transfer'));
  await writeFile(join(f.root, 'data-transfer/recovery-gate'), 'AIbrowse recovery barrier\n');
  await offline('recovery-entry', 'P', f.appData, f.journal);
  expect((await lstat(join(evidence, 'recovery-entry.json'))).isFile()).toBe(true);
  expect(await readdir(join(f.root, 'conversations'))).toHaveLength(2);
});
it('固定闭包不能删除bundle输入与source两处来隐藏来源，也拒绝空map和路径越界', () => {
  const sources = { 'a.ts': 'a'.repeat(64), 'b.ts': 'b'.repeat(64) };
  expect(() => exactSources(sources, ['a.ts', 'b.ts'])).not.toThrow();
  expect(() => exactSources({ 'a.ts': sources['a.ts'] }, ['a.ts', 'b.ts'])).toThrow();
  expect(() =>
    exactSources({ ...sources, 'extra.ts': 'c'.repeat(64) }, ['a.ts', 'b.ts']),
  ).toThrow();
  for (const value of [
    {},
    { '../a.ts': 'a'.repeat(64) },
    { '/a.ts': 'a'.repeat(64) },
    { 'a.ts': 'bad' },
  ])
    expect(() => record(value)).toThrow();
});
it('已知静态报告只能去掉精确四行warning，拒绝多插一行或字段变化', () => {
  const prefix =
    `(node:123) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of ${pathToFileURL(resolve('tools/release/verify-static-binding.ts')).href} is not specified and it doesn't parse as CommonJS.\n` +
    'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n' +
    `To eliminate this warning, add "type": "module" to ${toNamespacedPath(resolve('package.json'))}.\n` +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  const body = JSON.stringify(
    {
      ok: true,
      executableSha256: '',
      asarSha256: '',
      asarHeaderSha256: '',
      guardianSha256: '',
      fuses: {},
      artifacts: [],
      modules: [],
      sourceGraphSha256: '',
      references: [],
      productExecuted: false,
    },
    null,
    2,
  );
  const bytes = Buffer.from(prefix + body);
  expect(projectBinding(bytes).ok).toBe(true);
  for (const text of [
    bytes.toString().replace('Reparsing as ES module', 'unrecognized'),
    'arbitrary prefix\n' + bytes.toString(),
    bytes.toString().replace('"ok": true', '"ok": true,"extra":1'),
  ])
    expect(() => projectBinding(Buffer.from(text))).toThrow();
});
