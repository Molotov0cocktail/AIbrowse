import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = process.cwd();
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourcePath = resolve('native/lifecycle-guardian/Guardian.cs');
if (hash(sourcePath) !== '648d4e97ba15899d8bc9aa8cbde2e6b77a10a4d6db52d6327aa1bf5e9318fb85')
  throw new Error('诊断native基线不符');
const id = 'guardian-probe-' + randomUUID().replaceAll('-', '');
const root = resolve('log/stage7-e2', id),
  app = join(root, 'app');
mkdirSync(join(app, 'profile'), { recursive: true });
mkdirSync(join(app, 'out/lifecycle-guardian'), { recursive: true });
let source = readFileSync(sourcePath, 'utf8');
function replace(before: string, after: string): void {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error('诊断插桩边界改变');
  source = source.replace(before, after);
}
replace(
  'private static string stage = "启动";',
  'private static string stage = "启动"; private static string diagnosticStage = "startup"; private static uint observedWait = 4294967295;',
);
replace(
  'byte[] text = Utf8.GetBytes(',
  `try {
                long mainWait = main == null ? -1 : (long)WaitForSingleObject(main.Handle, 0);
                long utilityWait = utility == null ? -1 : (long)WaitForSingleObject(utility.Handle, 0);
                string kind = error is InvalidOperationException ? "validation" : error is Win32Exception ? "win32" : "io";
                byte[] proof = Utf8.GetBytes("{\\"stage\\":\\"" + diagnosticStage + "\\",\\"seq\\":" + sequence + ",\\"session\\":\\"" + nonce + "\\",\\"mainWait\\":" + mainWait + ",\\"utilityWait\\":" + utilityWait + ",\\"observedWait\\":" + observedWait + ",\\"errorClass\\":\\"" + kind + "\\",\\"errorCode\\":" + error.HResult + "}");
                Need(proof.Length <= 512);
                using (FileStream evidence = new FileStream(Path.Combine(root, "guardian-diagnostic.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { evidence.Write(proof, 0, proof.Length); evidence.Flush(true); }
            } catch { }
            byte[] text = Utf8.GetBytes(`,
);
replace(
  'Need(!handle.IsInvalid && WaitForSingleObject(handle, 0) == 258);',
  'diagnosticStage = role == "main" ? "main-open" : "authorize-open"; Need(!handle.IsInvalid); observedWait = WaitForSingleObject(handle, 0); Need(observedWait == 258);',
);
replace(
  'Need(Parent(pid) == parent);',
  'diagnosticStage = role == "main" ? "main-parent" : "authorize-parent"; Need(Parent(pid) == parent);',
);
replace(
  'bool contains; Need(IsProcessInJob(pending.Handle, job, out contains) && contains);',
  'diagnosticStage = "authorize-membership"; bool contains; Need(IsProcessInJob(pending.Handle, job, out contains) && contains);',
);
replace(
  'utility = pending; Persist(); Deadline(); Need(WaitForSingleObject(pending.Handle, 0) == 258);',
  'diagnosticStage = "authorize-persist"; utility = pending; Persist(); Deadline(); diagnosticStage = "authorize-alive"; observedWait = WaitForSingleObject(pending.Handle, 0); Need(observedWait == 258);',
);
replace(
  'uint pid; Need(fields.Length == 5 && UInt32.TryParse(fields[4], out pid) && fields[4] == pid.ToString() && utility != null && utility.Pid == pid);',
  'diagnosticStage = "retire-identity"; uint pid; Need(fields.Length == 5 && UInt32.TryParse(fields[4], out pid) && fields[4] == pid.ToString() && utility != null && utility.Pid == pid); diagnosticStage = "retire-wait";',
);
replace(
  'uint wait = WaitForSingleObject(utility.Handle, 0);',
  'uint wait = WaitForSingleObject(utility.Handle, 0); observedWait = wait;',
);
replace(
  'Thread.Sleep(1); wait = WaitForSingleObject(utility.Handle, 0);',
  'Thread.Sleep(1); wait = WaitForSingleObject(utility.Handle, 0); observedWait = wait;',
);
replace(
  'Writer old = utility; utility = null; Persist(); old.Handle.Dispose();',
  'diagnosticStage = "retire-persist"; Writer old = utility; utility = null; Persist(); old.Handle.Dispose();',
);
replace(
  'int value = input.ReadByte(); if (value == -1) { Stop(true); return 2; }',
  'int value = input.ReadByte(); if (value == -1) { if (finished == null) { diagnosticStage = "unfinished-eof"; Report(new InvalidOperationException()); } Stop(true); return 2; }',
);
const generated = join(root, 'Guardian.diagnostic.cs');
writeFileSync(generated, source);
const compiler = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const helper = join(app, 'out/lifecycle-guardian/guardian.exe');
execFileSync(
  compiler,
  ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${helper}`, generated],
  { windowsHide: true, timeout: 10_000 },
);
const manifest = JSON.stringify({ version: 1, bytes: statSync(helper).size, sha256: hash(helper) });
writeFileSync(join(app, 'lifecycle-guardian-integrity.json'), manifest);
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'guardian-probe-qualification', version: '1.0.0', main: 'main.js' }),
);
const sources: Record<string, string> = {};
for (const [entry, output] of [
  ['tools/data-qualification/guardian/probe-main.ts', 'main.js'],
  ['src/main/storage/startup-probe-worker.ts', 'startup-probe-worker.js'],
] as const) {
  const built = await build({
    entryPoints: [resolve(entry)],
    outfile: join(app, output),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
  });
  for (const path of Object.keys(built.metafile!.inputs)) sources[path] = hash(resolve(path));
}
for (const path of [
  'native/lifecycle-guardian/Guardian.cs',
  'tools/data-qualification/guardian/probe-build.ts',
  'tools/data-qualification/guardian/probe-run.ps1',
  'tools/release-profile/JobProcess.cs',
])
  sources[path] = hash(resolve(path));
const artifacts: Record<string, string> = {};
for (const path of [
  'Guardian.diagnostic.cs',
  'app/main.js',
  'app/startup-probe-worker.js',
  'app/package.json',
  'app/lifecycle-guardian-integrity.json',
  'app/out/lifecycle-guardian/guardian.exe',
])
  artifacts[path] = hash(join(root, path));
writeFileSync(
  join(root, 'binding.json'),
  JSON.stringify(
    {
      id,
      repository,
      sourceHashes: sources,
      artifacts,
      compilerSha256: hash(compiler),
      electronSha256: hash(resolve('node_modules/electron/dist/electron.exe')),
      budget: { probes: 20, ms: 30_000, disk: 50 * 1024 * 1024 },
      classification: '仅诊断，不授产品通过',
    },
    null,
    2,
  ),
);
process.stdout.write(id + '\n');
