import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
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
import { join, relative, resolve } from 'node:path';
import { isStrictChild, recordRequest, requestBudgetPassed, validatePhase } from './oracle.ts';

const repository = realpathSync(resolve(import.meta.dirname, '../..'));
const evidenceRoot = resolve(repository, 'log/watch-repair-20261012');
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx' });
function ordinaryTree(root: string): string[] {
  if (lstatSync(root).isSymbolicLink()) throw new Error('构建或证据目录不得为链接');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('构建树不得包含链接');
    return entry.isDirectory() ? ordinaryTree(path) : [path];
  });
}

interface Input {
  repository: string;
  baseline: string;
  binding: Record<string, string>;
  deadlineMs: number;
}
function checkBinding(input: Input): boolean {
  return Object.entries(input.binding).every(([path, digest]) => {
    const full = resolve(repository, path);
    return isStrictChild(repository, full) && existsSync(full) && hash(full) === digest;
  });
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--prepare-only') {
  const productPaths = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'];
  if (productPaths.some((path) => !existsSync(resolve(repository, path))))
    throw new Error('请先运行 npm run build');
  const runRoot = join(evidenceRoot, `runtime-${randomUUID()}`);
  mkdirSync(join(runRoot, 'profile'), { recursive: true });
  mkdirSync(join(runRoot, 'session'), { recursive: true });
  mkdirSync(join(runRoot, 'captures'), { recursive: true });
  const sourcePaths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      'src',
      'tools/watch-repair-runtime',
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json',
    ],
    { cwd: repository, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path !== '' && !path.endsWith('.test.ts'));
  const paths = [
    ...new Set([
      ...sourcePaths,
      ...['main', 'preload', 'renderer'].flatMap((part) =>
        ordinaryTree(join(repository, 'out', part)).map((path) => relative(repository, path)),
      ),
      'node_modules/electron/dist/electron.exe',
    ]),
  ];
  save(join(runRoot, 'input.json'), {
    repository,
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    binding: Object.fromEntries(paths.map((path) => [path, hash(resolve(repository, path))])),
    deadlineMs: 150_000,
  } satisfies Input);
  save(join(runRoot, 'fixture-state.json'), { revision: 'A' });
  process.stdout.write(`${runRoot}\n`);
} else if (args.length === 2 && args[0] === '--run') {
  const runRoot = resolve(args[1]!);
  if (
    !isStrictChild(evidenceRoot, runRoot) ||
    realpathSync(runRoot) !== runRoot ||
    lstatSync(runRoot).isSymbolicLink()
  )
    throw new Error('运行目录必须位于本轮证据根内');
  const input = JSON.parse(readFileSync(join(runRoot, 'input.json'), 'utf8')) as Input;
  if (input.repository !== repository || !checkBinding(input) || input.deadlineMs !== 150_000)
    throw new Error('源码、工具或构建绑定失效，请保留原目录并重新prepare');
  const requests: Array<{ path: string; cookie: boolean; revision: string }> = [];
  const rejectedRequestSamples: string[] = [];
  const requestBudget = { receivedRequests: 0, rejectedRequests: 0, budgetExceeded: false };
  let stopActiveRun: (() => void) | undefined;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const state = JSON.parse(readFileSync(join(runRoot, 'fixture-state.json'), 'utf8')) as {
      revision: string;
    };
    if (!recordRequest(requestBudget)) {
      if (rejectedRequestSamples.length < 8) rejectedRequestSamples.push(path);
      response.writeHead(429);
      response.end('请求预算耗尽');
      stopActiveRun?.();
      return;
    }
    requests.push({
      path,
      cookie: request.headers.cookie?.includes('watch_runtime=synthetic') ?? false,
      revision: state.revision,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Set-Cookie', 'watch_runtime=synthetic; SameSite=Lax; Path=/');
    if (path === '/frame')
      response.end('<!doctype html><title>同源框架</title><p>框架内容不进入主文档基线</p>');
    else if (path === '/login')
      response.end(
        '<!doctype html><title>登录验证</title><form><input type="password"><button type="submit">登录</button></form>',
      );
    else if (path === '/long')
      response.end(
        `<!doctype html><title>正文超限</title><p>${'x'.repeat(100_001)}</p><iframe src="/frame"></iframe>`,
      );
    else if (path === '/page')
      response.end(
        `<!doctype html><title>独立监控验收页面</title><h1>稳定标题</h1><p>版本${state.revision}</p><p>${'合成主文档。'.repeat(90)}</p><iframe src="/frame" title="同源框架"></iframe>`,
      );
    else {
      response.statusCode = 404;
      response.end('未找到合成页面');
    }
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('合成服务器不可用');
  save(join(runRoot, 'launch.json'), { base: `http://127.0.0.1:${address.port}` });
  const phases: Array<{ phase: 'write' | 'reopen'; code: number; failures: string[] }> = [];
  try {
    for (const phase of ['write', 'reopen'] as const) {
      if (!requestBudgetPassed(requestBudget)) break;
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (
          key.startsWith('AIBROWSE_') ||
          ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
        )
          delete env[key];
      const log = openSync(join(runRoot, `${phase}-process.txt`), 'wx');
      const child = spawn(
        join(repository, 'node_modules/electron/dist/electron.exe'),
        [join(repository, 'tools/watch-repair-runtime/harness.cjs'), runRoot, phase],
        { cwd: repository, env, windowsHide: true, stdio: ['ignore', log, log] },
      );
      stopActiveRun = () => child.kill();
      closeSync(log);
      const hardDeadline = setTimeout(() => {
        child.kill();
      }, input.deadlineMs + 20_000);
      let code: number;
      try {
        code = await new Promise<number>((done, reject) => {
          child.once('error', reject);
          child.once('exit', (value) => done(value ?? -1));
        });
      } finally {
        stopActiveRun = undefined;
        clearTimeout(hardDeadline);
      }
      const reportPath = join(runRoot, `${phase}.json`);
      const failures = validatePhase(
        existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as unknown) : null,
        phase,
      );
      phases.push({ phase, code, failures });
      if (code !== 0 || failures.length > 0) break;
    }
  } finally {
    server.close();
  }
  const unchanged = checkBinding(input);
  const beforeLogin = requests.findIndex((request) => request.path === '/login');
  const sessionCookieObserved =
    beforeLogin >= 0 &&
    requests
      .slice(0, beforeLogin)
      .filter((request) => request.path === '/page' && request.revision === 'B' && request.cookie)
      .length >= 2;
  const passed =
    phases.length === 2 &&
    phases.every((phase) => phase.code === 0 && phase.failures.length === 0) &&
    unchanged &&
    requestBudgetPassed(requestBudget) &&
    sessionCookieObserved;
  save(join(runRoot, 'result.json'), {
    passed,
    sourceAndArtifactsUnchanged: unchanged,
    phases,
    sessionCookieObserved,
    requests,
    requestBudget,
    rejectedRequestSamples,
    providerCalls: 0,
    externalNetwork: '未请求；仅本地 Session 页面',
    publicAcquisition: 'NOTRUN',
    longIntervalWait: 'NOTRUN',
    migrationV5: '不在本工具内重跑；应关联持久化worker迁移证据',
    evidenceBoundary: '普通开发构建、程序化真实DOM操作；不代表物理点击或打包启动',
  });
  process.stdout.write(`${runRoot}\npassed=${passed}\n`);
  process.exitCode = passed ? 0 : 1;
} else {
  throw new Error('用法：run.ts --prepare-only；冻结源码后 run.ts --run <返回目录>');
}
