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

type Expectation = 'fixed-green' | 'keyboard-probe';
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
const evidenceRoot = join(repository, 'log/ux-polish-20261029');
const expectation = process.argv[2] as Expectation | undefined;
if (!['fixed-green', 'keyboard-probe'].includes(expectation ?? '')) {
  throw new Error('用法：node --experimental-strip-types run.ts fixed-green|keyboard-probe');
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
  'tools/ux-polish-runtime',
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
  deadlineMs: 180_000,
  requestBudget: 30,
};
writeFileSync(join(root, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });

const requests: string[] = [];
let exceeded = false;
let stop: (() => void) | undefined;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  requests.push(url.pathname);
  writeFileSync(
    join(root, 'requests.json'),
    JSON.stringify({ requests, budget: input.requestBudget }, null, 2),
  );
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
    `<!doctype html><title>${url.pathname}</title><link rel="icon" href="data:"><p>体验验收本地夹具 ${url.pathname}</p>`,
  );
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', done);
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('本地服务未就绪');

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
  )
    delete environment[key];
}
const results: Record<string, unknown>[] = [];
const phases = expectation === 'keyboard-probe' ? ['keyboard'] : ['write', 'reopen'];
for (const phase of phases) {
  const phaseRoot = join(root, phase);
  mkdirSync(phaseRoot);
  mkdirSync(join(phaseRoot, 'captures'));
  writeFileSync(join(phaseRoot, 'input.json'), JSON.stringify(input, null, 2));
  writeFileSync(
    join(phaseRoot, 'launch.json'),
    JSON.stringify({
      base: `http://127.0.0.1:${address.port}`,
      phase,
      deadline: Date.now() + input.deadlineMs - 8000,
    }),
  );
  const output = openSync(join(phaseRoot, 'process.txt'), 'wx');
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      join(repository, 'tools/ux-polish-runtime/launch.ps1'),
      '-RunRoot',
      phaseRoot,
      '-RunId',
      randomUUID().replaceAll('-', ''),
      '-DeadlineMs',
      String(input.deadlineMs - 4000),
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
  const read = (name: string): Record<string, unknown> | null =>
    existsSync(join(phaseRoot, name))
      ? (JSON.parse(readFileSync(join(phaseRoot, name), 'utf8').replace(/^\uFEFF/, '')) as Record<
          string,
          unknown
        >)
      : null;
  const runtime = read('runtime.json');
  const job = read('job.json');
  const checks = (runtime?.checks ?? {}) as Record<string, unknown>;
  const required =
    phase === 'keyboard'
      ? [
          'start-visible',
          'start-native-views-hidden',
          'watch-status-visible',
          'return-submits',
          'search-current-tab',
          'start-hidden-on-web',
          'web-native-view-visible',
        ]
      : [
          'start-visible',
          'watch-status-visible',
          'bookmark-group-name-persisted',
          'bookmark-group-two-members',
          'bookmark-group-default-collapsed',
          'bookmark-group-expanded',
          'expand-opens-no-tabs',
          'single-bookmark-opens-one-tab',
          ...(phase === 'write'
            ? [
                'search-current-tab',
                'start-hidden-on-web',
                'recent-history-bounded',
                'history-click-current-tab',
                ...['light', 'dark'].flatMap((theme) =>
                  [1280, 600].flatMap((width) =>
                    ['ai', 'sources', 'research'].flatMap((panel) => [
                      `${theme}-${width}-${panel}-geometry`,
                      `${theme}-${width}-${panel}-keyboard`,
                    ]),
                  ),
                ),
              ]
            : ['history-reopened']),
        ];
  const passed =
    !timedOut &&
    !exceeded &&
    code === 0 &&
    job?.jobReleased === true &&
    runtime?.completed === true &&
    runtime?.willQuit === true &&
    runtime?.error === null &&
    runtime?.externalNetwork === 0 &&
    runtime?.providerCalls === 0 &&
    required.every((key) => checks[key] === true) &&
    Object.values(checks).every((value) => value === true);
  results.push({ phase, passed, code, timedOut, runtime, job });
  if (!passed) break;
}
await new Promise<void>((done) => server.close(() => done()));
const bindingUnchanged = Object.entries(input.binding).every(
  ([path, digest]) => existsSync(join(repository, path)) && hash(join(repository, path)) === digest,
);
const passed =
  results.length === phases.length &&
  results.every((result) => result.passed === true) &&
  bindingUnchanged;
writeFileSync(
  join(root, 'result.json'),
  JSON.stringify(
    {
      passed,
      results,
      requests,
      requestBudget: input.requestBudget,
      bindingUnchanged,
      boundary:
        '真实开发Electron默认GPU；独立profile/session；环回夹具；native input；二进程自然quit。非发行包/安装器/物理鼠标验收。',
    },
    null,
    2,
  ),
);
process.stdout.write(`${root}\npassed=${passed}\n`);
process.exitCode = passed ? 0 : 1;
