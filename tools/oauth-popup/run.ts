import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const expected = process.argv.includes('--expect-fixed') ? 'fixed' : 'legacy';
const baseline = process.argv.includes('--baseline-b8f782c');
const scope = process.argv.includes('--sandbox-only')
  ? 'sandbox'
  : process.argv.includes('--close-diagnostic')
    ? 'close'
    : process.argv.includes('--close-switch-diagnostic')
      ? 'close-switch'
      : 'full';
if (baseline && expected !== 'legacy') throw new Error('冻结基线只用于保留旧缺陷红态');
const evidenceParent = resolve('log/oauth-popup-20261013');
const runRoot = join(
  evidenceParent,
  `${baseline ? 'red-baseline' : expected}-${scope}-${randomUUID()}`,
);
mkdirSync(join(runRoot, 'profile'), { recursive: true });

const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const productionEntry = 'src/main/index.ts';
const productionBlinkSwitchConfigured = readFileSync(productionEntry, 'utf8').includes(
  "app.commandLine.appendSwitch('blink-settings', 'allowScriptsToCloseWindows=false')",
);
if (!baseline && !productionBlinkSwitchConfigured)
  throw new Error('产品入口未固定关闭跨历史脚本窗口关闭能力');
const frozenBaseline = join(evidenceParent, 'baseline-b8f782c', 'baseline-product.cjs');
if (baseline && !existsSync(frozenBaseline)) throw new Error('冻结 b8f782c 产品包不存在');
if (scope === 'close' && !existsSync(frozenBaseline)) throw new Error('关闭对照缺少冻结基线包');
const productBundle = baseline ? frozenBaseline : join(runRoot, 'product.cjs');
let productMetafile: Awaited<ReturnType<typeof build>>['metafile'] | null = null;
if (!baseline) {
  const productBuild = await build({
    entryPoints: ['src/main/browser/browser-controller.ts'],
    outfile: productBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    define: { __RELEASE__: 'false' },
    metafile: true,
  });
  productMetafile = productBuild.metafile;
}
const harnessBundle = join(runRoot, 'harness.cjs');
const harnessBuild = await build({
  entryPoints: ['tools/oauth-popup/harness.ts'],
  outfile: harnessBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  metafile: true,
});
const sourcePaths = [
  ...Object.keys(harnessBuild.metafile.inputs),
  ...(productMetafile ? Object.keys(productMetafile.inputs) : []),
  productionEntry,
  'tools/oauth-popup/run.ts',
];
const sourceHashes = Object.fromEntries(
  [...new Set(sourcePaths)].sort().map((file) => [file, hash(resolve(file))]),
);
const binding = {
  expected,
  scope,
  baseline: baseline ? 'b8f782c078881194590d7a77f58a17fcb3844a2e' : null,
  productionBlinkSwitchConfigured,
  sourceHashes,
  productBundleSha256: hash(productBundle),
  baselineBundleSha256: scope === 'close' ? hash(frozenBaseline) : null,
  harnessBundleSha256: hash(harnessBundle),
  requestBudget: 30,
  externalRequests: 0,
  providerCalls: 0,
  realCookies: 0,
  wallClockBudgetMs: 60_000,
  cleanupGraceMs: 5_000,
};
writeFileSync(join(runRoot, 'binding.json'), JSON.stringify(binding, null, 2));

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  AIBROWSE_OAUTH_PROBE_ROOT: runRoot,
  AIBROWSE_OAUTH_PRODUCT_BUNDLE: productBundle,
  AIBROWSE_OAUTH_EXPECTED: expected,
  AIBROWSE_OAUTH_SCOPE: scope,
  ...(scope === 'close' ? { AIBROWSE_OAUTH_BASELINE_BUNDLE: frozenBaseline } : {}),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
delete environment.NODE_OPTIONS;
const output = createWriteStream(join(runRoot, 'process.log'), { flags: 'wx' });
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [harnessBundle], {
  cwd: resolve('.'),
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  const processId = child.pid;
  if (processId === undefined) {
    child.kill();
    return;
  }
  const killer = spawn('taskkill.exe', ['/pid', String(processId), '/t', '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  killer.unref();
}, 60_000);
const childExit = new Promise<number>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code ?? -1));
});
let hardTimeout: NodeJS.Timeout | null = null;
const hardStop = new Promise<number>((resolveExit) => {
  hardTimeout = setTimeout(() => {
    timedOut = true;
    child.kill();
    resolveExit(-2);
  }, 65_000);
});
const exitCode = await Promise.race([childExit, hardStop]);
clearTimeout(timeout);
if (hardTimeout !== null) clearTimeout(hardTimeout);
output.end();
const sourceUnchanged = Object.entries(sourceHashes).every(
  ([file, digest]) => hash(resolve(file)) === digest,
);
const resultPath = join(runRoot, 'result.json');
const result = existsSync(resultPath)
  ? (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
  : null;
writeFileSync(
  join(runRoot, 'exit.json'),
  JSON.stringify({ exitCode, timedOut, sourceUnchanged, resultPresent: result !== null }, null, 2),
);
process.stdout.write(
  `${runRoot}\nexit=${exitCode}, sourceUnchanged=${sourceUnchanged}, expectationPassed=${String(result?.expectationPassed)}\n`,
);
process.exitCode =
  !timedOut && exitCode === 0 && sourceUnchanged && result?.expectationPassed === true ? 0 : 1;
