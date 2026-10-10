import { execFileSync } from 'node:child_process';
import type childProcess from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { prepareCrossApp } from './cross-smoke-scope.ts';
import { DEFAULT_SMOKE_MARKER, NORMAL_EXIT_MARKER } from './default-smoke/evidence.ts';
import { runDefaultSmokeReadback } from './default-smoke/readback.ts';
import {
  installDefaultSpawnHook,
  prepareDefaultApp,
  snapshotSmokeSources,
} from './default-smoke/scope.ts';

function fixture() {
  const evidence = resolve('log/stage7-e2/resume-default-smoke-review-001');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'scope-'));
  const repository = join(root, 'repository');
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian'])
    mkdirSync(join(repository, 'out', part), { recursive: true });
  mkdirSync(join(repository, 'src/main/browser'), { recursive: true });
  writeFileSync(
    join(repository, 'src/main/browser/tab-manager.ts'),
    'export const auditedSource = true;',
  );
  writeFileSync(join(repository, 'package.json'), '{"name":"review-fixture","version":"1.0.0"}');
  writeFileSync(join(repository, 'out/main/index.js'), 'main');
  writeFileSync(join(repository, 'out/preload/index.js'), 'preload');
  writeFileSync(join(repository, 'out/renderer/index.html'), 'renderer');
  writeFileSync(join(repository, 'out/lifecycle-guardian/guardian.exe'), 'helper');
  return {
    root,
    repository,
    appRoot: join(root, 'private.app'),
    receipt: join(root, 'before-build.json'),
    electron: join(root, 'electron.exe'),
  };
}

function requestWithReadback() {
  const scope = fixture();
  prepareDefaultApp(scope);
  const profile = join(scope.root, 'profile');
  mkdirSync(join(profile, 'lifecycle-guardian'), { recursive: true });
  writeFileSync(
    join(profile, 'lifecycle-guardian/writers.json'),
    JSON.stringify({
      version: 1,
      root: 'a'.repeat(64),
      session: 'b'.repeat(32),
      main: null,
      utility: null,
    }),
  );
  writeFileSync(
    join(scope.appRoot, 'log/aibrowse-2026-10-10.log'),
    `${DEFAULT_SMOKE_MARKER}\n${NORMAL_EXIT_MARKER}`,
  );
  return {
    ...scope,
    profile,
    buildReceipt: scope.receipt,
    output: join(scope.root, 'readback.json'),
    exitCode: 0,
    jobZero: true,
  };
}

it('默认准备保持SRT-12实际appPath源码读取；旧cross缺失控制仍复现', () => {
  const old = fixture();
  prepareCrossApp(old);
  expect(() => readFileSync(join(old.appRoot, 'src/main/browser/tab-manager.ts'))).toThrow(
    /ENOENT/,
  );
  const current = fixture();
  prepareDefaultApp(current);
  const source = readFileSync('src/main/smoke.ts', 'utf8');
  expect(source).toContain("join(app.getAppPath(), 'src/main/browser/tab-manager.ts')");
  const app = { getAppPath: () => current.appRoot };
  expect(readFileSync(join(app.getAppPath(), 'src/main/browser/tab-manager.ts'), 'utf8')).toBe(
    'export const auditedSource = true;',
  );
  expect(snapshotSmokeSources(current.appRoot)).toEqual(snapshotSmokeSources(current.repository));
});

it.each(['repository', 'appRoot'] as const)('读回拒绝准备后 %s 源码变化', (location) => {
  const request = requestWithReadback();
  writeFileSync(join(request[location], 'src/main/browser/tab-manager.ts'), 'changed');
  expect(() => runDefaultSmokeReadback(request)).toThrow('源码快照改变');
});

it('dev真正spawn端口前已具备私有源码，原spawn身份保持且第二次启动拒绝', () => {
  const scope = fixture();
  const identity = {} as childProcess.ChildProcess;
  const original = vi.fn(() => {
    expect(snapshotSmokeSources(scope.appRoot)).toEqual(snapshotSmokeSources(scope.repository));
    expect(JSON.parse(readFileSync(`${scope.receipt}.sources.json`, 'utf8')).version).toBe(1);
    return identity;
  });
  const hook = installDefaultSpawnHook(scope, original as typeof childProcess.spawn);
  expect(hook(scope.electron, ['.'], { stdio: 'inherit' })).toBe(identity);
  expect(original).toHaveBeenCalledWith(scope.electron, [scope.appRoot], { stdio: 'inherit' });
  expect(() => hook(scope.electron, ['.'], { stdio: 'inherit' })).toThrow();
  expect(original).toHaveBeenCalledTimes(1);
});

it('源码允许深度16的成员，拒绝深度17并保留现场', () => {
  const scope = fixture();
  const directory = join(scope.repository, 'src', ...Array<string>(15).fill('d'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'allowed.ts'), 'bounded');
  expect(snapshotSmokeSources(scope.repository)).toHaveLength(2);
  mkdirSync(join(directory, 'extra'));
  writeFileSync(join(directory, 'extra', 'rejected.ts'), 'over-depth');
  expect(() => snapshotSmokeSources(scope.repository)).toThrow('超出预算');
  expect(readFileSync(join(directory, 'extra', 'rejected.ts'), 'utf8')).toBe('over-depth');
});

it('源码硬链接成员在复制前拒绝且保留两名称', () => {
  const scope = fixture();
  const original = join(scope.repository, 'src/main/browser/tab-manager.ts');
  const alias = join(scope.repository, 'src/main/browser/alias.ts');
  linkSync(original, alias);
  expect(() => prepareDefaultApp(scope)).toThrow('源码成员无效或超限');
  expect(readFileSync(alias, 'utf8')).toBe(readFileSync(original, 'utf8'));
});

it('默认source准备的真实Node入口只处理微型文件，native strip-types可运行', () => {
  const scope = fixture();
  const request = join(scope.root, 'scope-request.json');
  writeFileSync(request, JSON.stringify(scope));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  const output = execFileSync(
    process.execPath,
    [resolve('tools/data-qualification/default-smoke/scope.ts'), request],
    { encoding: 'utf8', env, windowsHide: true, timeout: 10000, maxBuffer: 131072, stdio: 'pipe' },
  );
  writeFileSync(join(scope.root, 'prepare-stdout.txt'), output);
  expect(snapshotSmokeSources(scope.appRoot)).toEqual(snapshotSmokeSources(scope.repository));
  expect(() =>
    execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('tools/data-qualification/default-smoke/scope.ts')).href,
        '--eval',
        '',
      ],
      { env, windowsHide: true, timeout: 10000, maxBuffer: 131072, stdio: 'pipe' },
    ),
  ).not.toThrow();
});

it('默认readback真实Node入口验证小型原件并生成成功回执', () => {
  const request = requestWithReadback();
  const path = join(request.root, 'readback-request.json');
  writeFileSync(path, JSON.stringify(request));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  const output = execFileSync(
    process.execPath,
    [resolve('tools/data-qualification/default-smoke/readback.ts'), path],
    { encoding: 'utf8', env, windowsHide: true, timeout: 10000, maxBuffer: 131072, stdio: 'pipe' },
  );
  writeFileSync(join(request.root, 'readback-stdout.txt'), output);
  expect(JSON.parse(readFileSync(request.output, 'utf8'))).toMatchObject({
    passed: true,
    ledgerRetired: true,
  });
});
