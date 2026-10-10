import { ChildProcess, type spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { installCrossSpawnHook, prepareCrossApp, snapshotOut } from './cross-smoke-scope';
import { readPrivateLogs } from './cross-smoke-readback';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cross-scope-'));
  const repository = join(root, 'repository');
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian'])
    mkdirSync(join(repository, 'out', part), { recursive: true });
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify({ name: 'aibrowse', version: '1.0.0' }),
  );
  writeFileSync(join(repository, 'out/main/index.js'), 'old main');
  writeFileSync(join(repository, 'out/lifecycle-guardian/guardian.exe'), 'old helper');
  return {
    repository,
    appRoot: join(root, 'app'),
    receipt: join(root, 'receipt.json'),
    electron: join(root, 'electron.exe'),
  };
}
it('dev仅在本次CLI构建之后的原spawn边界绑定，并保留原ChildProcess', () => {
  const request = fixture();
  const child = new ChildProcess();
  const original = vi.fn(() => child) as unknown as typeof spawn;
  const hooked = installCrossSpawnHook(request, original);
  writeFileSync(join(request.repository, 'out/main/index.js'), 'new built main');
  writeFileSync(
    join(request.repository, 'out/lifecycle-guardian/guardian.exe'),
    'new built helper',
  );
  expect(hooked(request.electron, ['.'], { stdio: 'inherit' })).toBe(child);
  const receipt = JSON.parse(readFileSync(request.receipt, 'utf8')) as {
    files: ReturnType<typeof snapshotOut>;
  };
  expect(receipt.files).toEqual(snapshotOut(request.repository));
  expect(readFileSync(join(request.appRoot, 'out/lifecycle-guardian/guardian.exe'), 'utf8')).toBe(
    'new built helper',
  );
  expect(original).toHaveBeenCalledExactlyOnceWith(request.electron, [request.appRoot], {
    stdio: 'inherit',
  });
  expect(() => hooked(request.electron, ['.'], { stdio: 'inherit' })).toThrow();
});
it.each([['.', '--inspect'], ['other']])('开发Electron未知参数不授启动：%j', (...args) => {
  const request = fixture();
  const original = vi.fn(() => new ChildProcess()) as unknown as typeof spawn;
  const hooked = installCrossSpawnHook(request, original);
  expect(() => hooked(request.electron, args, { stdio: 'inherit' })).toThrow();
  expect(original).not.toHaveBeenCalled();
});
it('未知Electron路径或spawn options均拒绝；构建子进程照原参数传递', () => {
  const request = fixture();
  const original = vi.fn(() => new ChildProcess()) as unknown as typeof spawn;
  const hooked = installCrossSpawnHook(request, original);
  expect(() =>
    hooked(join(request.repository, 'electron.exe'), ['.'], { stdio: 'inherit' }),
  ).toThrow();
  expect(() => hooked(request.electron, ['.'], { stdio: 'pipe' })).toThrow();
  hooked('esbuild', ['--service'], { stdio: 'pipe' });
  expect(original).toHaveBeenCalledExactlyOnceWith('esbuild', ['--service'], { stdio: 'pipe' });
});
it('私有日志覆盖轮转与跨日，仓库共享marker不归属该进程', () => {
  const request = fixture();
  const receipt = prepareCrossApp(request);
  mkdirSync(join(request.repository, 'log'));
  writeFileSync(join(request.repository, 'log/aibrowse-2026-10-04.log'), 'unowned success');
  expect(readPrivateLogs(request.appRoot, receipt.log).bytes.length).toBe(0);
  for (const [name, text] of [
    ['aibrowse-2026-10-04.log', 'first'],
    ['aibrowse-2026-10-04.1.log', 'rotated'],
    ['aibrowse-2026-10-05.log', 'next day'],
  ])
    writeFileSync(join(request.appRoot, 'log', name!), text!);
  const logs = readPrivateLogs(request.appRoot, receipt.log);
  expect(logs.members).toHaveLength(3);
  expect(logs.bytes.toString()).not.toContain('unowned');
  expect(logs.bytes.toString()).toContain('rotated');
  renameSync(join(request.appRoot, 'log'), join(request.appRoot, 'old-log'));
  mkdirSync(join(request.appRoot, 'log'));
  expect(() => readPrivateLogs(request.appRoot, receipt.log)).toThrow();
});
it('有界私有日志拒绝未知成员与超额内容', () => {
  const request = fixture();
  const receipt = prepareCrossApp(request);
  writeFileSync(
    join(request.appRoot, 'log/aibrowse-2026-10-04.log'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  expect(() => readPrivateLogs(request.appRoot, receipt.log)).toThrow();
});
it('各cross入口的本地调用图不达默认SRT源码扫描', () => {
  const source = ts.createSourceFile(
    'smoke.ts',
    readFileSync('src/main/smoke.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const node of source.statements)
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  const seen = new Set<string>();
  const inspect = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const declaration = functions.get(name);
    if (!declaration) return;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        expect(node.expression.getText(source)).not.toBe('app.getAppPath');
        if (ts.isIdentifier(node.expression)) inspect(node.expression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(declaration);
  };
  for (const name of [
    'runSessionSmokeScenario',
    'runSourcesSmokeScenario',
    'runSourcesUiSmokeScenario',
    'runResearchSmokeGate',
  ]) {
    expect(functions.has(name)).toBe(true);
    inspect(name);
  }
  expect(readFileSync('src/main/smoke-watch-store.ts', 'utf8')).not.toContain('getAppPath');
  expect(seen.has('runSourcesRecoverySmoke')).toBe(false);
});
