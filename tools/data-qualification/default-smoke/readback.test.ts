import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareDefaultApp } from './scope.ts';
import { DEFAULT_SMOKE_MARKER, NORMAL_EXIT_MARKER } from './evidence.ts';
import { measureArtifacts, runDefaultSmokeReadback } from './readback.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'default-smoke-'));
  const repository = join(root, 'repository');
  const profile = join(root, 'profile');
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian'])
    mkdirSync(join(repository, 'out', part), { recursive: true });
  mkdirSync(join(profile, 'lifecycle-guardian'), { recursive: true });
  mkdirSync(join(repository, 'src/main/browser'), { recursive: true });
  writeFileSync(join(repository, 'src/main/browser/tab-manager.ts'), 'fixed security source');
  writeFileSync(join(repository, 'package.json'), '{"name":"aibrowse","version":"0.1.0"}');
  writeFileSync(join(repository, 'out/main/index.js'), 'fixed main');
  writeFileSync(join(repository, 'out/preload/index.js'), 'fixed preload');
  writeFileSync(join(repository, 'out/renderer/index.html'), 'fixed renderer');
  writeFileSync(join(repository, 'out/lifecycle-guardian/guardian.exe'), 'fixed guardian');
  writeFileSync(
    join(profile, 'lifecycle-guardian/writers.json'),
    JSON.stringify({
      version: 1,
      root: 'a'.repeat(64),
      session: randomUUID().replaceAll('-', ''),
      main: null,
      utility: null,
    }),
  );
  const appRoot = join(root, 'app');
  const buildReceipt = join(root, 'build.json');
  prepareDefaultApp({ repository, appRoot, receipt: buildReceipt, electron: 'unused' });
  writeFileSync(
    join(appRoot, 'log/aibrowse-2026-10-04.log'),
    `${DEFAULT_SMOKE_MARKER}\n${NORMAL_EXIT_MARKER}`,
  );
  return {
    root,
    repository,
    profile,
    appRoot,
    buildReceipt,
    output: join(root, 'readback.json'),
    exitCode: 0,
    jobZero: true,
  };
}

it('读回私有日志、当前制品和退休账本后才通过', () => {
  const request = fixture();
  runDefaultSmokeReadback(request);
  expect(JSON.parse(readFileSync(request.output, 'utf8'))).toMatchObject({
    passed: true,
    ledgerRetired: true,
  });
});

it('启动绑定后的制品变化与未退休main分别可甄别', () => {
  const changed = fixture();
  writeFileSync(join(changed.repository, 'out/main/index.js'), 'changed main');
  expect(() => runDefaultSmokeReadback(changed)).toThrow('运行制品与启动绑定不符');

  const open = fixture();
  const ledgerPath = join(open.profile, 'lifecycle-guardian/writers.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
  ledger.main = { pid: 42 };
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  runDefaultSmokeReadback(open);
  expect(JSON.parse(readFileSync(open.output, 'utf8'))).toMatchObject({ passed: false });
});

it('全部采样原件累计超过256MiB时拒绝且无需读取大文件正文', () => {
  const root = mkdtempSync(join(tmpdir(), 'default-smoke-budget-'));
  const file = join(root, 'sparse.bin');
  writeFileSync(file, '');
  truncateSync(file, 256 * 1024 * 1024 + 1);
  expect(() => measureArtifacts(root)).toThrow('超过字节预算');
});

it('日志读回产物保留原字节hash', () => {
  const request = fixture();
  runDefaultSmokeReadback(request);
  const bytes = readFileSync(request.output.replace(/\.json$/, '.main-log.txt'));
  const result = JSON.parse(readFileSync(request.output, 'utf8')) as { logSha256: string };
  expect(result.logSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
});

it('安全扫描的私有源码或原候选改变均拒绝', () => {
  for (const source of ['repository', 'appRoot'] as const) {
    const request = fixture();
    writeFileSync(join(request[source], 'src/main/browser/tab-manager.ts'), 'changed source');
    expect(() => runDefaultSmokeReadback(request)).toThrow('源码快照改变');
  }
});
