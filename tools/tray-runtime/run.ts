import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
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
const evidenceRoot = resolve(repository, 'log/tray-runtime-20261012');
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
      'tools/tray-runtime',
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
      'resources/aibrowse.ico',
      'electron-builder.yml',
    ]),
  ];
  save(join(runRoot, 'input.json'), {
    repository,
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    binding: Object.fromEntries(paths.map((path) => [path, hash(resolve(repository, path))])),
    deadlineMs: 180_000,
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
  if (input.repository !== repository || !checkBinding(input) || input.deadlineMs !== 180_000)
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
      cookie: request.headers.cookie?.includes('tray_runtime=synthetic') ?? false,
      revision: state.revision,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Set-Cookie', 'tray_runtime=synthetic; SameSite=Lax; Path=/');
    if (path === '/page')
      response.end(
        `<!doctype html><title>托盘监控合成页面</title><h1>稳定标题</h1><p>版本${state.revision}</p><p>${'合成主文档。'.repeat(90)}</p>`,
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
  const phases: Array<{
    phase: 'write' | 'reopen' | 'disabled';
    code: number;
    failures: string[];
  }> = [];
  try {
    for (const phase of ['write', 'reopen', 'disabled'] as const) {
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
        [join(repository, 'tools/tray-runtime/harness.cjs'), runRoot, phase],
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
  const sessionCookieObserved = requests.some(
    (request) => request.path === '/page' && request.revision === 'C' && request.cookie,
  );
  const passed =
    phases.length === 3 &&
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
    startupVisibility: 'NOTRUN；显式win.show建立初始可见夹具',
    syntheticDue: '仅隔离规则 next_due_at 与生产调度器 upsert；不改变系统时钟或HostGate',
    evidenceBoundary: '普通开发构建、程序化真实DOM操作；不代表物理点击或打包启动',
  });
  process.stdout.write(`${runRoot}\npassed=${passed}\n`);
  process.exitCode = passed ? 0 : 1;
} else if (args.length === 2 && ['--resume-ui', '--complete-ui'].includes(args[0]!)) {
  const completing = args[0] === '--complete-ui';
  const artifactPrefix = completing ? 'completion' : 'resume';
  const phasePrefix = completing ? 'completion-' : '';
  const runRoot = resolve(args[1]!);
  if (
    !isStrictChild(evidenceRoot, runRoot) ||
    realpathSync(runRoot) !== runRoot ||
    lstatSync(runRoot).isSymbolicLink()
  )
    throw new Error('补验目录非法');
  const original = JSON.parse(readFileSync(join(runRoot, 'input.json'), 'utf8')) as Input;
  const prior = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')) as {
    passed: boolean;
    sourceAndArtifactsUnchanged: boolean;
    phases: Array<{ code: number }>;
  };
  const writeReport = JSON.parse(readFileSync(join(runRoot, 'write.json'), 'utf8')) as {
    willQuit: boolean;
  };
  if (
    prior.passed ||
    !prior.sourceAndArtifactsUnchanged ||
    prior.phases.length !== 1 ||
    prior.phases[0]?.code !== 0 ||
    !writeReport.willQuit
  )
    throw new Error('原场退出事实不符');
  if (completing) {
    const failed = JSON.parse(readFileSync(join(runRoot, 'resume-ui.json'), 'utf8')) as {
      passed: boolean;
      willQuit: boolean;
      error: string;
      facts: Record<string, unknown>;
    };
    const result = JSON.parse(readFileSync(join(runRoot, 'resume-result.json'), 'utf8')) as {
      passed: boolean;
      sourceAndArtifactsUnchanged: boolean;
      phases: Array<{ code: number }>;
    };
    if (
      failed.passed ||
      !failed.willQuit ||
      !failed.error.includes('assert(ids.length > 0)') ||
      failed.facts['networkZero'] !== true ||
      failed.facts['rulesPaused'] !== true ||
      result.passed ||
      !result.sourceAndArtifactsUnchanged ||
      result.phases.length !== 1 ||
      result.phases[0]?.code !== 0
    )
      throw new Error('续验只允许已知空白Tab观测前置失败');
    const oldInput = JSON.parse(readFileSync(join(runRoot, 'resume-input.json'), 'utf8')) as Input;
    for (const filename of ['run.ts', 'harness.cjs', 'oracle.ts'])
      if (
        hash(join(runRoot, 'resume-tool-snapshot', filename)) !==
        oldInput.binding[`tools/tray-runtime/${filename}`]
      )
        throw new Error('补验原工具快照不符');
  }
  const productBinding = Object.fromEntries(
    Object.entries(original.binding).filter(
      ([path]) => !path.replaceAll('\\', '/').startsWith('tools/tray-runtime/'),
    ),
  );
  if (!checkBinding({ ...original, binding: productBinding }))
    throw new Error('产品绑定变化，不可复用原场');
  for (const filename of ['harness.cjs', 'run.ts', 'oracle.ts']) {
    if (
      hash(join(runRoot, 'tool-snapshot', filename)) !==
      original.binding[`tools/tray-runtime/${filename}`]
    )
      throw new Error('原工具快照不符');
  }
  const processOutput = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' } | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const parsed: unknown = processOutput.trim() === '' ? [] : JSON.parse(processOutput);
  const processes = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    ProcessId: number;
    CommandLine: string | null;
  }>;
  if (
    processes.some(
      (item) =>
        item.CommandLine === null || item.CommandLine.toLowerCase().includes(runRoot.toLowerCase()),
    )
  )
    throw new Error('无法证明隔离profile没有存活Electron持有者');
  const dbPath = join(runRoot, 'profile/watch/watch.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let scheduled: { id: string; state: string; next_due_at: string }[];
  let runCount: number;
  try {
    runCount = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM watch_runs').get() as { count: number }).count,
    );
    scheduled = db
      .prepare('SELECT id,state,next_due_at FROM watch_rules')
      .all() as typeof scheduled;
  } finally {
    db.close();
  }
  if (
    scheduled.length !== 1 ||
    runCount !== 2 ||
    scheduled.some((rule) =>
      completing
        ? rule.state !== 'paused'
        : rule.state !== 'enabled' ||
          !Number.isFinite(Date.parse(rule.next_due_at)) ||
          Date.parse(rule.next_due_at) <= Date.now() + 240_000,
    )
  )
    throw new Error('规则到期距离不足240秒，禁止启动补验');
  copyFileSync(dbPath, join(runRoot, `${artifactPrefix}-original-watch.db`), 1);
  const toolPaths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'tools/tray-runtime'],
    { cwd: repository, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path !== '');
  const input: Input = {
    ...original,
    binding: {
      ...productBinding,
      ...Object.fromEntries(toolPaths.map((path) => [path, hash(resolve(repository, path))])),
    },
  };
  save(join(runRoot, `${artifactPrefix}-input.json`), {
    ...input,
    executionHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    priorResultSha256: hash(join(runRoot, 'result.json')),
    originalDbSha256: hash(dbPath),
    processOwnerCheck: { matchingElectronProcesses: 0 },
    scheduled,
  });
  const replay = JSON.parse(readFileSync(join(runRoot, 'second-cycle-replay.json'), 'utf8')) as {
    passed: boolean;
    dbSha256: string;
  };
  if (
    !replay.passed ||
    replay.dbSha256 !== hash(completing ? join(runRoot, 'resume-original-watch.db') : dbPath)
  )
    throw new Error('缺少绑定原DB的离线回放');
  const phases: Array<{ phase: string; code: number; failures: string[] }> = [];
  for (const phase of ['resume-ui', 'resume-reopen', 'resume-disabled'] as const) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        key.startsWith('AIBROWSE_') ||
        ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
      )
        delete env[key];
    const log = openSync(join(runRoot, `${phasePrefix}${phase}-process.txt`), 'wx');
    const child = spawn(
      join(repository, 'node_modules/electron/dist/electron.exe'),
      [
        join(repository, 'tools/tray-runtime/harness.cjs'),
        runRoot,
        phase,
        ...(completing ? ['completion'] : []),
      ],
      { cwd: repository, env, windowsHide: true, stdio: ['ignore', log, log] },
    );
    closeSync(log);
    const deadline = setTimeout(() => child.kill(), input.deadlineMs + 20_000);
    let code: number;
    try {
      code = await new Promise<number>((done, reject) => {
        child.once('error', reject);
        child.once('exit', (value) => done(value ?? -1));
      });
    } finally {
      clearTimeout(deadline);
    }
    const reportPath = join(runRoot, `${phasePrefix}${phase}.json`);
    const failures = validatePhase(
      existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null,
      phase,
    );
    phases.push({ phase, code, failures });
    if (code !== 0 || failures.length > 0) break;
  }
  const unchanged = checkBinding(input);
  const passed =
    phases.length === 3 &&
    phases.every((phase) => phase.code === 0 && phase.failures.length === 0) &&
    unchanged;
  save(join(runRoot, `${artifactPrefix}-result.json`), {
    passed,
    phases,
    sourceAndArtifactsUnchanged: unchanged,
    providerCalls: 0,
    networkEvidence:
      '每阶段Session onSendHeaders与Node http/https.request/fetch只读计数；networkZero为必要事实',
    originalFailurePreserved: true,
    originalDbSnapshot: `${artifactPrefix}-original-watch.db`,
  });
  process.stdout.write(`${runRoot}\nresumePassed=${passed}\n`);
  process.exitCode = passed ? 0 : 1;
} else {
  throw new Error(
    '用法：--prepare-only / --run <目录> / --resume-ui <原失败目录> / --complete-ui <补验失败目录>',
  );
}
