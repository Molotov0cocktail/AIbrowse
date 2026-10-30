import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const runRoot = resolve('log/video-fullscreen-20261030', randomUUID());
mkdirSync(join(runRoot, 'profile'), { recursive: true });
const output = join(runRoot, 'main.cjs');
const baseline = process.argv.find((argument) => argument.startsWith('--baseline='))?.slice(11);
if (baseline && (!/^[a-f0-9]{40}$/.test(baseline) || process.argv.includes('--shell')))
  throw new Error('baseline只接受完整SHA且不适用真实壳');
const baselineSources: Record<string, string> = {};
const result = await build({
  entryPoints: [
    process.argv.includes('--shell')
      ? 'tools/video-fullscreen-runtime/shell.ts'
      : 'tools/video-fullscreen-runtime/smoke.ts',
  ],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  metafile: true,
  plugins: baseline
    ? [
        {
          name: 'baseline-source',
          setup(builder) {
            builder.onLoad({ filter: /[/\\]src[/\\].*\.ts$/ }, (args) => {
              const path = relative(process.cwd(), args.path).replaceAll('\\', '/');
              const contents = execFileSync('git', ['show', `${baseline}:${path}`], {
                encoding: 'utf8',
              });
              baselineSources[path] = createHash('sha256').update(contents).digest('hex');
              return { contents, loader: 'ts' };
            });
          },
        },
      ]
    : [],
});
const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const sources = Object.fromEntries(
  [
    ...Object.keys(result.metafile.inputs),
    'tools/video-fullscreen-runtime/run.ts',
    'tools/video-fullscreen-runtime/native-input.ps1',
    ...(process.argv.includes('--shell')
      ? readdirSync('out', { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
      : []),
  ]
    .filter((file) => !baselineSources[file.replaceAll('\\', '/')])
    .map((file) => [file, hash(file)]),
);
writeFileSync(
  join(runRoot, 'binding.json'),
  JSON.stringify(
    {
      sources,
      baseline,
      baselineSources,
      artifact: hash(output),
      budgetMs: 180000,
      maxRequests: 40,
      providerCalls: 0,
      purpose: '真实Electron全屏权限、窗口布局、退出恢复与非用户请求拒绝',
      selection: '仅隔离profile与本机有界合成页面',
      oracle: 'DOM fullscreenElement、BaseWindow.isFullScreen、WebContentsView全内容bounds及恢复',
    },
    null,
    2,
  ),
);
const log = createWriteStream(join(runRoot, 'console.log'), { flags: 'wx' });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  resolve('node_modules/electron/dist/electron.exe'),
  [output, ...process.argv.slice(2)],
  {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const stop = setTimeout(() => child.kill(), 180000);
const code = await new Promise<number>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode) => resolveExit(exitCode ?? -1));
});
clearTimeout(stop);
log.end();
const sourceUnchanged = Object.entries(sources).every(([file, digest]) => hash(file) === digest);
const verdict: unknown = existsSync(join(runRoot, 'result.json'))
  ? JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  : null;
const oraclePassed =
  verdict !== null && typeof verdict === 'object' && 'passed' in verdict && verdict.passed === true;
writeFileSync(join(runRoot, 'exit.json'), JSON.stringify({ code, sourceUnchanged }, null, 2));
process.stdout.write(`${runRoot}\nexit=${code}, sourceUnchanged=${sourceUnchanged}\n`);
process.exitCode = code === 0 && sourceUnchanged && oraclePassed ? 0 : 1;
