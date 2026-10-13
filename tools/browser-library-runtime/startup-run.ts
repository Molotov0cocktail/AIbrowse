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

type Expectation = 'old-red' | 'fixed-clean';
interface Input {
  repository: string;
  expectation: Expectation;
  baseline: string;
  gitStatus: string;
  binding: Record<string, string>;
  electronDeadlineMs: number;
  outerDeadlineMs: number;
}

const repository = realpathSync(resolve(import.meta.dirname, '../..'));
const evidenceRoot = join(repository, 'log/browser-startup-20261014');
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = (root: string): string[] => {
  if (lstatSync(root).isSymbolicLink()) throw new Error('绑定目录不得为链接');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('绑定树不得包含链接');
    return entry.isDirectory() ? walk(path) : [path];
  });
};
const git = (...args: string[]): string => {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
};

const expectation = process.argv[2] as Expectation | undefined;
if (!['old-red', 'fixed-clean'].includes(expectation ?? '')) {
  throw new Error('用法：node --experimental-strip-types startup-run.ts old-red|fixed-clean');
}
for (const path of [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/lifecycle-guardian/guardian.exe',
  'node_modules/electron/dist/electron.exe',
]) {
  if (!existsSync(join(repository, path))) throw new Error(`缺少运行文件：${path}`);
}

mkdirSync(evidenceRoot, { recursive: true });
const root = join(evidenceRoot, `startup-${expectation}-${randomUUID()}`);
for (const part of ['profile', 'session', 'captures'])
  mkdirSync(join(root, part), { recursive: true });
const sourcePaths = git(
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
  'src',
  'tools/browser-library-runtime/startup-run.ts',
  'tools/browser-library-runtime/startup-harness.cjs',
  'tools/browser-library-runtime/startup-launch.ps1',
  'tools/release-profile/JobProcess.cs',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
)
  .split('\0')
  .filter((path) => path !== '' && !path.includes('.test.'));
const artifactPaths = ['main', 'preload', 'renderer'].flatMap((part) =>
  walk(join(repository, 'out', part)).map((path) => relative(repository, path)),
);
const paths = [
  ...new Set([
    ...sourcePaths,
    ...artifactPaths,
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
  electronDeadlineMs: 82_000,
  outerDeadlineMs: 90_000,
};
writeFileSync(join(root, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
  ) {
    delete environment[key];
  }
}
const phases = expectation === 'fixed-clean' ? ['first', 'reopen'] : ['first'];
const runStartedAt = Date.now();
let outerTimedOut = false;
const launcherCodes: number[] = [];
for (const phase of phases) {
  const remaining = input.outerDeadlineMs - (Date.now() - runStartedAt);
  if (remaining <= 5_000) {
    outerTimedOut = true;
    break;
  }
  const output = openSync(join(root, `launcher-${phase}.txt`), 'wx');
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      join(repository, 'tools/browser-library-runtime/startup-launch.ps1'),
      '-RunRoot',
      root,
      '-RunId',
      randomUUID().replaceAll('-', ''),
      '-Phase',
      phase,
      '-DeadlineMs',
      String(Math.min(input.electronDeadlineMs, remaining - 3_000)),
    ],
    { cwd: repository, env: environment, windowsHide: true, stdio: ['ignore', output, output] },
  );
  closeSync(output);
  const hardDeadline = setTimeout(() => {
    outerTimedOut = true;
    child.kill();
  }, remaining);
  const code = await new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => done(value ?? -1));
  });
  clearTimeout(hardDeadline);
  launcherCodes.push(code);
  if (code !== 0 || outerTimedOut) break;
}

const bindingAfter = Object.fromEntries(
  Object.keys(input.binding).map((path) => [
    path,
    existsSync(join(repository, path)) ? hash(join(repository, path)) : null,
  ]),
);
const bindingUnchanged = Object.entries(input.binding).every(
  ([path, digest]) => bindingAfter[path] === digest,
);
const runtimes = phases.map((phase) => {
  const path = join(root, `runtime-${phase}.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
});
const jobs = phases.map((phase) => {
  const path = join(root, `job-${phase}.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
});
const ledgerPath = join(root, 'profile/lifecycle-guardian/writers.json');
const ledger = existsSync(ledgerPath)
  ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>)
  : null;
const phaseStatuses = runtimes.map((runtime) =>
  Array.isArray(runtime?.ipcStatuses)
    ? (runtime.ipcStatuses as Array<{ state?: string }>).map((entry) => entry.state)
    : [],
);
const phaseChannelStates = runtimes.map((runtime) => {
  const events = Array.isArray(runtime?.ipcStatusEvents)
    ? (runtime.ipcStatusEvents as Array<{ channel?: string; state?: string }>)
    : [];
  return Object.fromEntries(
    ['browser-library:status', 'conversation:storage-status', 'data-transfer:status'].map(
      (channel) => [
        channel,
        events.filter((entry) => entry.channel === channel).map((entry) => entry.state),
      ],
    ),
  );
});
const statuses = phaseStatuses.flat();
const alertObserved = runtimes.some((runtime) => runtime?.alertObserved === true);
const visibleAlertObserved = runtimes.some((runtime) => runtime?.visibleAlertObserved === true);
const commonPassed =
  !outerTimedOut &&
  launcherCodes.length === phases.length &&
  launcherCodes.every((code) => code === 0) &&
  jobs.every((job) => job?.jobReleased === true) &&
  runtimes.every(
    (runtime, index) =>
      runtime?.phase === phases[index] &&
      runtime?.passedHarness === true &&
      runtime?.willQuit === true &&
      runtime?.error === null &&
      runtime?.networkTotal === 0 &&
      runtime?.providerCalls === 0 &&
      Array.isArray(runtime?.timeline) &&
      (runtime.timeline as Array<{ name?: string }>).some(
        (entry) => entry.name === 'window:normal-close-request',
      ),
  ) &&
  phaseStatuses.every((states) => states.includes('available')) &&
  ledger?.main === null &&
  ledger?.utility === null &&
  bindingUnchanged;
const expectationPassed =
  expectation === 'old-red'
    ? statuses.includes('unavailable') && alertObserved
    : phaseChannelStates.every(
        (states) =>
          states['browser-library:status']?.includes('available') &&
          states['conversation:storage-status']?.includes('ready') &&
          states['data-transfer:status']?.includes('idle') &&
          Object.values(states)
            .flat()
            .every(
              (state) =>
                ![
                  'unavailable',
                  'storage-error',
                  'recovery-required',
                  'rejected',
                  'failed',
                ].includes(state ?? ''),
            ),
      ) &&
      !statuses.includes('unavailable') &&
      !statuses.includes('storage-error') &&
      !visibleAlertObserved;
const passed = commonPassed && expectationPassed;
writeFileSync(
  join(root, 'result.json'),
  JSON.stringify(
    {
      passed,
      expectation,
      phases,
      baseline: input.baseline,
      launcherCodes,
      outerTimedOut,
      commonPassed,
      expectationPassed,
      statuses,
      phaseStatuses,
      phaseChannelStates,
      initializingCoverage: phaseChannelStates.map((states, index) => ({
        phase: phases[index],
        channels: Object.fromEntries(
          Object.entries(states).map(([channel, values]) => [
            channel,
            values.includes('initializing'),
          ]),
        ),
      })),
      alertObserved,
      visibleAlertObserved,
      visibleAlerts: runtimes.flatMap((runtime) =>
        Array.isArray(runtime?.visibleAlerts) ? runtime.visibleAlerts : [],
      ),
      normalExit:
        runtimes.every((runtime) => runtime?.willQuit === true) &&
        jobs.every((job) => job?.jobReleased === true),
      guardianLedger: ledger,
      networkTotal: runtimes.reduce(
        (total, runtime) => total + Number(runtime?.networkTotal ?? 0),
        0,
      ),
      providerCalls: runtimes.reduce(
        (total, runtime) => total + Number(runtime?.providerCalls ?? 0),
        0,
      ),
      bindingUnchanged,
      binding: input.binding,
      boundary:
        '隔离开发Electron完整启动；不读取真实profile、Cookie、凭据或正文，不代表发行包/安装器启动',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(`${root}\npassed=${passed}\n`);
process.exitCode = passed ? 0 : 1;
