import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export function phasePassed(value: unknown, phase: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  if (
    report.phase !== phase ||
    report.passed !== true ||
    report.willQuit !== true ||
    report.error !== null
  )
    return false;
  const facts = report.facts;
  if (facts === null || typeof facts !== 'object') return false;
  const required =
    phase === 'write'
      ? [
          'isolation',
          'groups',
          'groupEditorControls',
          'uiReloadGroups',
          'appearance',
          'downloadToolEntry',
          'downloadToolAppearance',
          'scriptLifecycle',
          'scriptIsolation',
          'unsupportedRejected',
          'persistencePrepared',
        ]
      : phase === 'reopen'
        ? ['isolation', 'scriptsPersisted', 'persistedExecution']
        : [];
  return (
    required.length > 0 &&
    required.every((key) => Object.hasOwn(facts, key) && Reflect.get(facts, key) === true)
  );
}

const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx' });
function files(root: string): string[] {
  if (lstatSync(root).isSymbolicLink()) throw new Error('绑定目录不能为链接');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('绑定树不能包含链接');
    return entry.isDirectory() ? files(path) : [path];
  });
}
interface Input {
  repository: string;
  baseline: string;
  binding: Record<string, string>;
  deadlineMs: number;
  requestBudget: number;
}

async function main(): Promise<void> {
  const repository = realpathSync(resolve(import.meta.dirname, '../..'));
  const evidenceRoot = join(repository, 'log/browser-groups-userscripts-20261013');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--prepare-only') {
    for (const path of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      if (!existsSync(join(repository, path))) throw new Error('请先完成普通构建');
    }
    const root = join(evidenceRoot, `runtime-${randomUUID()}`);
    for (const part of ['profile', 'session', 'captures', 'fixtures'])
      mkdirSync(join(root, part), { recursive: true });
    const sources = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        'src',
        'native/idm',
        'resources/qualified-userscripts',
        'tools/build/idm-build.ts',
        'tools/browser-features-runtime',
        'package.json',
        'package-lock.json',
        'electron.vite.config.ts',
      ],
      { cwd: repository, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
    const paths = [
      ...new Set([
        ...sources,
        ...files(join(repository, 'out')).map((path) => relative(repository, path)),
        'node_modules/electron/dist/electron.exe',
      ]),
    ];
    save(join(root, 'input.json'), {
      repository,
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      binding: Object.fromEntries(paths.map((path) => [path, hash(join(repository, path))])),
      deadlineMs: 180_000,
      requestBudget: 20,
    } satisfies Input);
    process.stdout.write(`${root}\n`);
    return;
  }
  if (args.length !== 2 || args[0] !== '--run')
    throw new Error('用法：--prepare-only 或 --run <运行目录>');
  const root = resolve(args[1]!);
  if (
    !inside(evidenceRoot, root) ||
    realpathSync(root) !== root ||
    lstatSync(root).isSymbolicLink()
  )
    throw new Error('运行目录越界或包含链接');
  const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8')) as Input;
  const bindingNow = (): Record<string, string> =>
    Object.fromEntries(
      Object.keys(input.binding).map((path) => {
        const full = resolve(repository, path);
        if (!inside(repository, full) || !existsSync(full)) throw new Error('绑定文件越界或丢失');
        return [path, hash(full)];
      }),
    );
  const unchanged = (current: Record<string, string>): boolean =>
    Object.entries(input.binding).every(([path, digest]) => current[path] === digest);
  if (
    input.repository !== repository ||
    input.deadlineMs !== 180_000 ||
    input.requestBudget !== 20 ||
    !unchanged(bindingNow())
  )
    throw new Error('源码/工具/构建绑定失效，保留原件并重新prepare');
  save(join(root, 'before.json'), bindingNow());
  const requests: string[] = [];
  let exceeded = false;
  let stop: (() => void) | undefined;
  const server = createServer((request, response) => {
    requests.push(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    if (requests.length > input.requestBudget) {
      exceeded = true;
      response.writeHead(429).end('请求预算耗尽');
      stop?.();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html><head><title>脚本合成页面</title><link rel="icon" href="data:,"><script>window.__fixturePageSecret="page-world";</script></head><body><h1>本地合成页面</h1><p id="fixture">仅用于脚本功能验证</p></body></html>',
    );
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('合成本地服务未就绪');
  const deadline = Date.now() + input.deadlineMs;
  save(join(root, 'launch.json'), { base: `http://127.0.0.1:${address.port}`, deadline });
  const phases: Array<{ phase: string; code: number; passed: boolean }> = [];
  try {
    for (const phase of ['write', 'reopen']) {
      if (Date.now() >= deadline || exceeded) break;
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (
          key.startsWith('AIBROWSE_') ||
          ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
        )
          delete env[key];
      const log = openSync(join(root, `${phase}-process.txt`), 'wx');
      const child = spawn(
        join(repository, 'node_modules/electron/dist/electron.exe'),
        [join(repository, 'tools/browser-features-runtime/harness.cjs'), root, phase],
        { cwd: repository, env, windowsHide: true, stdio: ['ignore', log, log] },
      );
      closeSync(log);
      stop = () => child.kill();
      const timer = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now()));
      let code: number;
      try {
        code = await new Promise<number>((done, reject) => {
          child.once('error', reject);
          child.once('exit', (value) => done(value ?? -1));
        });
      } finally {
        clearTimeout(timer);
        stop = undefined;
      }
      const reportPath = join(root, `${phase}.json`);
      const passed =
        existsSync(reportPath) &&
        phasePassed(JSON.parse(readFileSync(reportPath, 'utf8')) as unknown, phase);
      phases.push({ phase, code, passed });
      if (code !== 0 || !passed) break;
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
  const after = bindingNow();
  save(join(root, 'after.json'), after);
  const passed =
    phases.length === 2 &&
    phases.every((phase) => phase.code === 0 && phase.passed) &&
    !exceeded &&
    requests.length <= 20 &&
    unchanged(after);
  save(join(root, 'result.json'), {
    passed,
    phases,
    requests,
    budget: 20,
    budgetExceeded: exceeded,
    sourceAndArtifactsUnchanged: unchanged(after),
    providerCalls: 0,
    boundary:
      '普通构建、程序化真实UI/bridge、隔离profile/session；原生选文件/确认受控；物理输入和打包启动NOTRUN',
    taskTabs: '任务所有权拒绝由独立核心单元测试覆盖，本工具未创建Research/Watch任务',
  });
  process.stdout.write(`${root}\npassed=${passed}\n`);
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
