import { ChildProcess, type spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { installCrossSpawnHook, snapshotOut } from './cross-smoke-scope';

function installedFunction(file: string, name: string): string {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const matches = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.getText(source);
}

it('已安装electron-vite的真实startElectron函数匹配hook，保留原ChildProcess与close退出码', () => {
  const root = mkdtempSync(join(tmpdir(), 'cross-dev-independent-'));
  const repository = join(root, 'repository');
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian']) {
    mkdirSync(join(repository, 'out', part), { recursive: true });
    writeFileSync(join(repository, 'out', part, 'fixture.js'), `new ${part}`);
  }
  writeFileSync(join(repository, 'package.json'), '{"name":"aibrowse","version":"1.0.0"}');
  writeFileSync(join(repository, 'out/main/index.js'), 'new main');
  writeFileSync(join(repository, 'out/lifecycle-guardian/guardian.exe'), 'new guardian');
  const request = {
    repository,
    appRoot: join(root, 'app'),
    receipt: join(root, 'receipt.json'),
    electron: join(root, 'electron.exe'),
  };
  const child = new ChildProcess();
  const original = vi.fn(() => child) as unknown as typeof spawn;
  const exit = vi.fn();
  const entryCheck = vi.fn();
  const hooked = installCrossSpawnHook(request, original);
  // Evaluate only this installed function with inert ports; no process is launched.
  const startElectron = new Function(
    'ensureElectronEntryFile',
    'getElectronPath',
    'process',
    'spawn',
    `${installedFunction('node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js', 'startElectron')}; return startElectron;`,
  )(
    entryCheck,
    () => request.electron,
    { env: { NODE_ENV_ELECTRON_VITE: 'development' }, exit },
    hooked,
  ) as (root: string) => ChildProcess;

  expect(startElectron(repository)).toBe(child);
  expect(entryCheck).toHaveBeenCalledExactlyOnceWith(repository);
  expect(original).toHaveBeenCalledExactlyOnceWith(request.electron, [request.appRoot], {
    stdio: 'inherit',
  });
  const receipt = readFileSync(request.receipt, 'utf8');
  expect((JSON.parse(receipt) as { files: ReturnType<typeof snapshotOut> }).files).toEqual(
    snapshotOut(repository),
  );
  expect(child.listeners('close')).toEqual([exit]);
  child.emit('close', 91);
  expect(exit).toHaveBeenCalledExactlyOnceWith(91);
  expect(() => startElectron(repository)).toThrow('开发启动器额外启动或入口改变');
  expect(original).toHaveBeenCalledTimes(1);
  expect(readFileSync(request.receipt, 'utf8')).toBe(receipt);
});

it('已安装dev入口等待两个构建及renderer监听完成才调用原启动函数', async () => {
  const events: string[] = [];
  const env: Record<string, string> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), hasWarned: false };
  const color = (text: string) => text;
  const config = {
    main: { name: 'main' },
    preload: { name: 'preload' },
    renderer: { name: 'renderer' },
  };
  const startElectron = vi.fn(() => {
    expect(events).toEqual([
      'main:start',
      'main:end',
      'preload:start',
      'preload:end',
      'listen',
      'urls',
    ]);
    expect(env['ELECTRON_RENDERER_URL']).toBe('http://localhost:5173');
    events.push('electron');
    return new ChildProcess();
  });
  // Execute the installed sequencing logic while build/server ports stay in memory.
  const createServer = new Function(
    'process',
    'resolveConfig',
    'createLogger',
    'doBuild',
    'colors',
    'createServer$1',
    'resolveHostname',
    'startElectron',
    `${installedFunction('node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js', 'createServer')}; return createServer;`,
  )(
    { env },
    async () => ({ config }),
    () => logger,
    async (part: { name: string }) => {
      events.push(`${part.name}:start`);
      await Promise.resolve();
      events.push(`${part.name}:end`);
    },
    { green: color, gray: color, cyan: color },
    async () => ({
      httpServer: {},
      listen: async () => {
        events.push('listen');
      },
      config: { server: { host: 'localhost', port: 5173 }, logger },
      printUrls: () => events.push('urls'),
    }),
    (host: string) => host,
    startElectron,
  ) as (inline: { root: string }, options: { rendererOnly: boolean }) => Promise<void>;
  await createServer({ root: 'fixture' }, { rendererOnly: false });
  expect(startElectron).toHaveBeenCalledExactlyOnceWith('fixture');
  expect(events.at(-1)).toBe('electron');
  expect(env['NODE_ENV_ELECTRON_VITE']).toBe('development');
});
