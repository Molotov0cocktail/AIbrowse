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
import { join, relative, resolve } from 'node:path';

type Expectation = 'old-red' | 'fixed-green';
interface Input {
  repository: string;
  expectation: Expectation;
  baseline: string;
  gitStatus: string;
  binding: Record<string, string>;
  deadlineMs: number;
  requestBudget: number;
}

const repository = realpathSync(resolve(import.meta.dirname, '../..'));
const evidenceRoot = join(repository, 'log/address-bar-runtime-20261014');
const expectation = process.argv[2] as Expectation | undefined;
if (!['old-red', 'fixed-green'].includes(expectation ?? '')) {
  throw new Error('用法：node --experimental-strip-types run.ts old-red|fixed-green');
}
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = (root: string): string[] => {
  if (lstatSync(root).isSymbolicLink()) throw new Error('绑定目录不能为链接');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('绑定树不能含链接');
    return entry.isDirectory() ? walk(path) : [path];
  });
};
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repository, encoding: 'utf8' });

for (const path of [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/lifecycle-guardian/guardian.exe',
  'node_modules/electron/dist/electron.exe',
  'tools/release-profile/JobProcess.cs',
]) {
  if (!existsSync(join(repository, path))) throw new Error(`缺少运行文件：${path}`);
}
mkdirSync(evidenceRoot, { recursive: true });
const root = join(evidenceRoot, `${expectation}-${randomUUID()}`);
for (const part of ['profile', 'session', 'captures'])
  mkdirSync(join(root, part), { recursive: true });
const sources = git(
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
  'src',
  'tools/address-bar-runtime',
  'tools/release-profile/JobProcess.cs',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
)
  .split('\0')
  .filter((path) => path !== '' && existsSync(join(repository, path)));
const paths = [
  ...new Set([
    ...sources,
    ...['main', 'preload', 'renderer'].flatMap((part) =>
      walk(join(repository, 'out', part)).map((path) => relative(repository, path)),
    ),
    'out/lifecycle-guardian/guardian.exe',
    'node_modules/electron/dist/electron.exe',
  ]),
];
const input: Input = {
  repository,
  expectation: expectation!,
  baseline: git('rev-parse', 'HEAD').trim(),
  gitStatus: git('status', '--short'),
  binding: Object.fromEntries(paths.map((path) => [path, hash(join(repository, path))])),
  deadlineMs: 90_000,
  requestBudget: 12,
};
writeFileSync(join(root, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });

const requests: string[] = [];
let exceeded = false;
let stop: (() => void) | undefined;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  requests.push(url.pathname);
  if (requests.length > input.requestBudget) {
    exceeded = true;
    response.writeHead(429).end('预算耗尽');
    stop?.();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    `<!doctype html><title>${url.pathname}</title><link rel="icon" href="data:"><p>地址栏本地夹具 ${url.pathname}</p>`,
  );
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', done);
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('本地服务未就绪');
writeFileSync(
  join(root, 'launch.json'),
  JSON.stringify({
    base: `http://127.0.0.1:${address.port}`,
    deadline: Date.now() + input.deadlineMs,
  }),
  { flag: 'wx' },
);

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
  ) {
    delete environment[key];
  }
}
const output = openSync(join(root, 'process.txt'), 'wx');
const child = spawn(
  'pwsh.exe',
  [
    '-NoProfile',
    '-File',
    join(repository, 'tools/address-bar-runtime/launch.ps1'),
    '-RunRoot',
    root,
    '-RunId',
    randomUUID().replaceAll('-', ''),
    '-DeadlineMs',
    String(input.deadlineMs - 4_000),
  ],
  { cwd: repository, env: environment, windowsHide: true, stdio: ['ignore', output, output] },
);
closeSync(output);
stop = () => child.kill();
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, input.deadlineMs);
const code = await new Promise<number>((done, reject) => {
  child.once('error', reject);
  child.once('exit', (value) => done(value ?? -1));
});
clearTimeout(timer);
stop = undefined;
await new Promise<void>((done) => server.close(() => done()));
const runtimePath = join(root, 'runtime.json');
const jobPath = join(root, 'job.json');
const runtime = existsSync(runtimePath)
  ? (JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>)
  : null;
const job = existsSync(jobPath)
  ? (JSON.parse(readFileSync(jobPath, 'utf8')) as Record<string, unknown>)
  : null;
const bindingAfter = Object.fromEntries(
  Object.keys(input.binding).map((path) => [
    path,
    existsSync(join(repository, path)) ? hash(join(repository, path)) : null,
  ]),
);
const bindingUnchanged = Object.entries(input.binding).every(
  ([path, digest]) => bindingAfter[path] === digest,
);
const checks = (runtime?.checks ?? {}) as Record<string, unknown>;
const allGreen = [
  'singleClickSelectsAll',
  'repeatedSingleClickSelectsAll',
  'dragSelectionPreserved',
  'doubleClickRestoresCaret',
  'rightClickPreservesSelection',
  'newTabClearsFocusedAddress',
  'sameUrlTabSyncsDraft',
  'sameTabDraftPreserved',
  'blurRestoresCurrentUrl',
  'enterNavigationWorks',
].every((key) => checks[key] === true);
const oldRed =
  checks.singleClickSelectsAll === false &&
  checks.repeatedSingleClickSelectsAll === false &&
  checks.doubleClickRestoresCaret === false &&
  checks.sameUrlTabSyncsDraft === false;
const commonPassed =
  !timedOut &&
  !exceeded &&
  code === 0 &&
  job?.jobReleased === true &&
  runtime?.completed === true &&
  runtime?.willQuit === true &&
  runtime?.error === null &&
  runtime?.externalNetwork === 0 &&
  runtime?.providerCalls === 0 &&
  bindingUnchanged;
const passed = commonPassed && (expectation === 'old-red' ? oldRed : allGreen);
writeFileSync(
  join(root, 'result.json'),
  JSON.stringify(
    {
      passed,
      expectation,
      baseline: input.baseline,
      commonPassed,
      oldRed,
      allGreen,
      checks,
      code,
      timedOut,
      requests,
      requestBudget: input.requestBudget,
      externalNetwork: runtime?.externalNetwork ?? null,
      providerCalls: runtime?.providerCalls ?? null,
      normalExit: runtime?.willQuit === true && job?.jobReleased === true,
      bindingUnchanged,
      binding: input.binding,
      boundary:
        '真实开发Electron产品renderer DOM与Chromium sendInputEvent；仅本机环回夹具，独立profile；不代表发行包、安装器或物理鼠标。',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(`${root}\npassed=${passed}\n`);
process.exitCode = passed ? 0 : 1;
