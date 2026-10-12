import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = 'matrix-' + randomUUID().replaceAll('-', '');
const root = resolve('log/legacy-followup-20261012/shutdown', id);
const appRoot = join(root, 'app');
mkdirSync(join(appRoot, 'profile'), { recursive: true });
let job = readFileSync(resolve('tools/release-profile/JobProcess.cs'), 'utf8');
function replace(before: string, after: string): void {
  if (job.indexOf(before) < 0 || job.indexOf(before) !== job.lastIndexOf(before))
    throw new Error('固定Job派生边界改变');
  job = job.replace(before, after);
}
replace('namespace AIbrowse.ReleaseProfile', 'namespace AIbrowse.ShutdownFollowup');
replace('Flags = 0x2000 }', 'Flags = 0x2008, ActiveProcessLimit = 8 }');
replace(
  '(stoppedAt >= 0 ? stoppedAt : timeoutMs) + 30000',
  '(stoppedAt >= 0 ? stoppedAt : timeoutMs) + 10000',
);
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
  join(appRoot, 'package.json'),
  JSON.stringify({ name: 'shutdown-diagnostic', version: '1.0.0', main: 'main.js' }),
  { flag: 'wx' },
);
const built = await build({
  entryPoints: [resolve('tools/legacy-followup/shutdown-matrix.ts')],
  outfile: join(appRoot, 'main.js'),
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
  'tools/legacy-followup/shutdown-build.ts',
  'tools/legacy-followup/shutdown-run.ps1',
  'tools/release-profile/JobProcess.cs',
  'tools/legacy-followup/native-dialog-clicker.cs',
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
      sources,
      artifacts,
      electron: hash(resolve('node_modules/electron/dist/electron.exe')),
      budget: { cases: 9, workMs: 40000, exitMs: 10000, processes: 8, diskBytes: 8388608 },
      purpose: '用户批准后的真实快照退休、可信原生按钮与其它写入排空；不替代完整guardian生产验收',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(id + '\n');
