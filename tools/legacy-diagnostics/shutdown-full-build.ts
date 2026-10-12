import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareDefaultApp } from '../data-qualification/default-smoke/scope.ts';
import { snapshotOut } from '../data-qualification/cross-smoke-scope.ts';

const repository = resolve('.');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = 'full-' + randomUUID().replaceAll('-', '');
const root = resolve('log/legacy-diagnosis-20261012/shutdown', id);
const appRoot = join(root, 'app');
mkdirSync(root, { recursive: true });
const electron = join(repository, 'node_modules/electron/dist/electron.exe');
const originalOut = snapshotOut(repository);
prepareDefaultApp({ repository, appRoot, receipt: join(root, 'before-build.json'), electron });
for (const entry of originalOut) {
  const target = join(appRoot, entry.path);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (hash(target) !== entry.sha256) throw new Error('复制已有制品不符');
  } else copyFileSync(join(repository, entry.path), target);
}
writeFileSync(
  join(appRoot, 'package.json'),
  JSON.stringify({ name: 'aibrowse', version: '0.1.1', main: 'out/main/index.js' }),
);
const main = join(appRoot, 'out/main/index.js');
const observer = join(appRoot, 'out/main/shutdown-observer.cjs');
const compiled = await build({
  entryPoints: [resolve('tools/legacy-diagnostics/shutdown-observer.ts')],
  outfile: observer,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  target: 'node24',
  external: ['electron'],
  metafile: true,
});
const tail =
  '\nrequire("./shutdown-observer.cjs").install({ PageReader, BrowserControllerImpl, ConversationServiceImpl });\n';
appendFileSync(main, tail);
const originalMain = readFileSync(join(repository, 'out/main/index.js'));
if (!readFileSync(main).subarray(0, originalMain.length).equals(originalMain))
  throw new Error('产品制品前缀改变');
let job = readFileSync(join(repository, 'tools/release-profile/JobProcess.cs'), 'utf8');
for (const [before, after] of [
  ['namespace AIbrowse.ReleaseProfile', 'namespace AIbrowse.ShutdownFullDiagnostic'],
  ['Flags = 0x2000 }', 'Flags = 0x2008, ActiveProcessLimit = 64 }'],
  [
    'private static uint Active(SafeFileHandle job)',
    '[DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] private static extern bool QueryLimits(SafeFileHandle job,int kind,out ExtendedLimits limits,uint size,IntPtr returned);\n        private static uint Active(SafeFileHandle job)',
  ],
  [
    'UIntPtr bytes = UIntPtr.Zero;',
    'ExtendedLimits actual; if(!QueryLimits(job,9,out actual,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero) || actual.Basic.Flags!=0x2008 || actual.Basic.ActiveProcessLimit!=64) throw new InvalidOperationException("固定Job上限未生效");\n                UIntPtr bytes = UIntPtr.Zero;',
  ],
] as const) {
  if (job.indexOf(before) < 0 || job.indexOf(before) !== job.lastIndexOf(before))
    throw new Error('固定Job派生边界改变');
  job = job.replace(before, after);
}
writeFileSync(join(root, 'JobProcess.cs'), job, { flag: 'wx' });
const sources: Record<string, string> = {};
for (const path of [
  ...Object.keys(compiled.metafile!.inputs),
  'tools/legacy-diagnostics/shutdown-full-build.ts',
  'tools/legacy-diagnostics/shutdown-full-run.ps1',
  'tools/data-qualification/default-smoke/scope.ts',
  'tools/data-qualification/cross-smoke-scope.ts',
  'tools/release-profile/JobProcess.cs',
])
  sources[path] = hash(resolve(path));
const artifacts: Record<string, string> = {};
for (const path of [
  'JobProcess.cs',
  'app/package.json',
  'app/out/main/index.js',
  'app/out/main/shutdown-observer.cjs',
])
  artifacts[path] = hash(join(root, path));
if (JSON.stringify(originalOut) !== JSON.stringify(snapshotOut(repository)))
  throw new Error('普通out发生改变');
writeFileSync(
  join(root, 'binding.json'),
  JSON.stringify(
    {
      id,
      sources,
      artifacts,
      originalOut,
      electron: hash(electron),
      mainOriginalSha256: hash(join(repository, 'out/main/index.js')),
      appendix: tail,
      budget: {
        processes: 64,
        applicationMs: 300000,
        exitMs: 30000,
        observationAfterQuitMs: 10000,
        events: 20000,
        diagnosticBytes: 8388608,
        artifactBytes: 268435456,
      },
      purpose: '一次默认场请求/Tab/原nativePromise关联诊断；不授普通构建退出通过',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(id + '\n');
