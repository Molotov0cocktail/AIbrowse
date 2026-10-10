import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mode = process.argv[2] ?? 'diagnostic';
if (!['diagnostic', 'snapshot-cancel'].includes(mode) || process.argv.length > 3)
  throw new Error('未知固定资格模式');
const entry = mode === 'snapshot-cancel' ? 'snapshot-cancel.ts' : 'main.ts';
const id = 'page-reader-exit-' + randomUUID().replaceAll('-', '');
const root = resolve('log/stage7-e2', id),
  app = join(root, 'app');
mkdirSync(join(app, 'profile'), { recursive: true });
let job = readFileSync(resolve('tools/release-profile/JobProcess.cs'), 'utf8');
function replace(before: string, after: string) {
  if (job.indexOf(before) < 0 || job.indexOf(before) !== job.lastIndexOf(before))
    throw new Error('固定Job派生边界改变');
  job = job.replace(before, after);
}
replace('namespace AIbrowse.ReleaseProfile', 'namespace AIbrowse.PageReaderQualification');
replace('Flags = 0x2000 }', 'Flags = 0x2008, ActiveProcessLimit = 8 }');
replace('timeoutMs + 30000', 'timeoutMs + 10000');
replace(
  'private static uint Active(SafeFileHandle job)',
  '[DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] private static extern bool QueryLimits(SafeFileHandle job,int kind,out ExtendedLimits limits,uint size,IntPtr returned);\n        private static uint Active(SafeFileHandle job)',
);
replace(
  'UIntPtr bytes = UIntPtr.Zero;',
  'ExtendedLimits actual; if(!QueryLimits(job,9,out actual,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero) || actual.Basic.Flags!=0x2008 || actual.Basic.ActiveProcessLimit!=8) throw new InvalidOperationException("固定Job上限未生效");\n                UIntPtr bytes = UIntPtr.Zero;',
);
writeFileSync(join(root, 'JobProcess.cs'), job, { flag: 'wx' });
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'page-reader-exit-qualification', version: '1.0.0', main: 'main.js' }),
  { flag: 'wx' },
);
const built = await build({
  entryPoints: [resolve('tools/data-qualification/page-reader-exit', entry)],
  outfile: join(app, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  metafile: true,
});
const sources: Record<string, string> = {};
for (const file of [
  ...Object.keys(built.metafile!.inputs),
  'tools/data-qualification/page-reader-exit/build.ts',
  'tools/data-qualification/page-reader-exit/run.ps1',
  'tools/data-qualification/page-reader-exit/README.md',
  'tools/release-profile/JobProcess.cs',
])
  sources[file] = hash(resolve(file));
const artifacts: Record<string, string> = {};
for (const file of ['JobProcess.cs', 'app/main.js', 'app/package.json'])
  artifacts[file] = hash(join(root, file));
writeFileSync(
  join(root, 'binding.json'),
  JSON.stringify(
    {
      id,
      mode,
      sources,
      artifacts,
      electron: hash(resolve('node_modules/electron/dist/electron.exe')),
      budget: { cases: 4, workMs: 20000, exitMs: 10000, processes: 8, diskBytes: 8388608 },
      purpose:
        mode === 'snapshot-cancel'
          ? '独立快照取消四场景功能复验；不授E2或默认冒烟通过'
          : '原Promise结算机制诊断；不授产品通过',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(id + '\n');
