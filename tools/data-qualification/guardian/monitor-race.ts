import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Compile a tool-only deterministic schedule from the exact product monitor body.
const sourcePath = resolve('native/lifecycle-guardian/Guardian.cs');
const source = readFileSync(sourcePath, 'utf8');
const compiler = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const root = mkdtempSync(resolve('log/stage7-e2/guardian-monitor-race-'));
const match = /Thread monitor = new Thread\(delegate\(\) \{ (.*?) \}\);/su.exec(source);
if (!match) throw new Error('monitor资格源码边界改变');
const marker = match[1]!.includes('while (!stopped) {') ? 'while (!stopped) {' : 'for (;;) {';
if (!match[1]!.includes(marker)) throw new Error('monitor资格循环边界改变');
const body = match[1]!.replace(marker, marker + ' ReviewEntered.Set(); ReviewResume.WaitOne();');
const harness = `
    private static readonly ManualResetEvent ReviewEntered = new ManualResetEvent(false);
    private static readonly ManualResetEvent ReviewResume = new ManualResetEvent(false);
    public static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        Exception fault = null;
        main = new Writer();
        main.Handle = OpenProcess(0x101000, false, (uint)Process.GetCurrentProcess().Id);
        Need(!main.Handle.IsInvalid);
        Thread reader = new Thread(delegate() { try { ${body} } catch (Exception error) { fault = error; } });
        reader.IsBackground = true; reader.Start();
        Need(ReviewEntered.WaitOne(2000));
        lock (Sync) { stopped = true; main.Handle.Dispose(); main = null; }
        ReviewResume.Set(); Need(reader.Join(2000));
        Console.WriteLine(fault == null ? "PASS：退休后monitor未解引用已释放writer" : "FAIL：" + fault.GetType().Name);
        return fault == null ? 0 : 1;
    }
`;
const instrumented = source
  .replace('public static int Main(string[] args)', 'public static int ProductMain(string[] args)')
  .replace(/\}\s*$/u, harness + '\n}');
const generated = join(root, 'MonitorRace.cs');
const executable = join(root, 'MonitorRace.exe');
writeFileSync(generated, instrumented);
execFileSync(
  compiler,
  ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${executable}`, generated],
  { windowsHide: true, timeout: 10_000 },
);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const result = spawnSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
const receipt = {
  sourceSha256: sha(sourcePath),
  compilerSha256: sha(compiler),
  generatedSha256: sha(generated),
  executableSha256: sha(executable),
  toolSha256: sha(resolve('tools/data-qualification/guardian/monitor-race.ts')),
  exitCode: result.status,
  output: result.stdout,
  error: result.error ? '资格子进程异常' : null,
};
writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
process.stdout.write(JSON.stringify({ root, ...receipt }) + '\n');
process.exitCode = result.status === 0 ? 0 : 1;
