import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const cases = [
  'timeout-root-late',
  'timeout-job-late',
  'timeout-job-never',
  'timeout-root-never',
  'timeout-wait-failed',
  'timeout-terminate-slow',
  'timeout-terminate-expired',
  'timeout-job-query-expired',
  'timeout-signal-expired',
  'native-failure-root-never',
  'rss-failure-root-never',
  'timeout-final-limits',
  'timeout-final-limits-unreadable',
  'timeout-exit-unreadable',
  'normal-success',
  'normal-near-deadline',
  'normal-late-signal',
] as const;
type Case = (typeof cases)[number];
interface Outcome {
  name: Case;
  wait: number;
  waits: number;
  terminate: number;
  activeReads: number;
  clocks: number;
  retained: number;
  openHandles: number;
  result: {
    Failure: string | null;
    ExitFailure: string | null;
    ActualZero: boolean;
    OwnershipRetained: boolean;
    Succeeded: boolean;
    LimitsVerified: boolean;
    ExitCode: number;
    DurationMs: number;
  };
}
let root: string;
let outputs: Outcome[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'full-transfer-exit-pure-'));
  let source = readFileSync(
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
    'utf8',
  ).replaceAll('\r\n', '\n');
  const replace = (name: string, replacement: string): void => {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern [^;]+\b${name}\([^;]+;`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`替身边界不唯一：${name}`);
    source = source.replace(pattern, replacement);
  };
  replace(
    'CreateJobObjectW',
    'private static SafeFileHandle CreateJobObjectW(IntPtr attributes,string name) {Marshal.SetLastPInvokeError(0);return FakeHandle(new IntPtr(1));}',
  );
  replace(
    'SetInformationJobObject',
    'private static bool SetInformationJobObject(SafeFileHandle job,int type,ref ExtendedLimits limits,uint length) {FakeLimits=limits;return true;}',
  );
  replace(
    'ReadLimits',
    'private static bool ReadLimits(SafeFileHandle job,int type,out ExtendedLimits info,uint length,IntPtr returned) {info=FakeLimits;if(FakeTerminating&&FakeCase=="timeout-final-limits")info.Basic.Flags=0;return !(FakeTerminating&&FakeCase=="timeout-final-limits-unreadable");}',
  );
  replace(
    'InitializeProcThreadAttributeList',
    'private static bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size) {size=new UIntPtr(16);return list!=IntPtr.Zero;}',
  );
  replace(
    'UpdateProcThreadAttribute',
    'private static bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned) {return true;}',
  );
  replace(
    'DeleteProcThreadAttributeList',
    'private static void DeleteProcThreadAttributeList(IntPtr list) {}',
  );
  replace(
    'CreateProcessW',
    'private static bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInformation process) {process=new ProcessInformation {Process=new IntPtr(2),Thread=new IntPtr(3),ProcessId=100,ThreadId=101};return true;}',
  );
  replace(
    'GetProcessTimes',
    'private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) {if(FakeCase=="native-failure-root-never")throw new Win32Exception(5,"private-exit-path-and-body");created=1000;exited=kernel=user=0;return true;}',
  );
  replace(
    'IsProcessInJob',
    'private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool result) {result=true;return true;}',
  );
  replace(
    'QueryFullProcessImageNameW',
    'private static bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder image,ref uint length) {image.Append("fixture.exe");return true;}',
  );
  replace(
    'QueryInformationJobObject',
    'private static bool QueryInformationJobObject(SafeFileHandle job,int type,out Accounting info,uint length,IntPtr returned) {info=new Accounting {ActiveProcesses=FakeActive()};return true;}',
  );
  replace(
    'TerminateJobObject',
    'private static bool TerminateJobObject(SafeFileHandle job,uint code) {FakeTerminating=true;FakeTerminations++;if(FakeCase=="timeout-terminate-slow")FakeNow+=29980;if(FakeCase=="timeout-terminate-expired")FakeNow+=30001;return true;}',
  );
  replace(
    'WaitForSingleObject',
    'private static uint WaitForSingleObject(SafeFileHandle process,uint timeout) {return process.DangerousGetHandle().ToInt64()==2?FakeWait(timeout):258u;}',
  );
  replace(
    'GetExitCodeProcess',
    'private static bool GetExitCodeProcess(SafeFileHandle process,out uint code) {code=FakeTerminating?92u:0u;return FakeCase!="timeout-exit-unreadable";}',
  );
  replace(
    'ReadPids',
    'private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) {Marshal.WriteInt32(buffer,0,1);Marshal.WriteInt32(buffer,4,1);Marshal.WriteInt64(buffer,8,100);returned=16;return true;}',
  );
  replace(
    'OpenProcess',
    'private static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) {return FakeHandle(new IntPtr(4));}',
  );
  replace(
    'GetProcessMemoryInfo',
    'private static bool GetProcessMemoryInfo(SafeFileHandle process,ref MemoryCounters counters,uint size) {counters.WorkingSet=new UIntPtr(2147483648UL);return true;}',
  );
  source = source
    .replaceAll('Stopwatch', 'FakeStopwatch')
    .replaceAll('Thread.Sleep(', 'FakeSleep(')
    .replace('new SafeFileHandle(info.Process,true)', 'FakeHandle(info.Process)')
    .replace('new SafeFileHandle(info.Thread,true)', 'FakeHandle(info.Thread)');
  source = source.replace(
    'public static class FixedTransferJob\n    {',
    `public static class FixedTransferJob\n    {
        public static string FakeCase;
        public static long FakeNow;
        public static int FakeClocks,FakeTerminations,FakeRootWaits,FakeActiveReads;
        public static uint FakeLastWait;
        private static bool FakeTerminating;
        private static ExtendedLimits FakeLimits;
        private static System.Collections.Generic.List<SafeFileHandle> FakeHandles=new System.Collections.Generic.List<SafeFileHandle>();
        public static int FakeOpenHandles {get{return FakeHandles.Count(handle=>!handle.IsClosed);}}
        public static int FakeRetained {get{return retained.Count;}}
        private static SafeFileHandle FakeHandle(IntPtr value) {var handle=new SafeFileHandle(value,false);FakeHandles.Add(handle);return handle;}
        private static void FakeSleep(int delay) {FakeNow+=delay;}
        public sealed class FakeStopwatch {
            private long started;
            public static FakeStopwatch StartNew() {FakeClocks++;return new FakeStopwatch {started=FakeNow};}
            public long ElapsedMilliseconds {get{return FakeNow-started;}}
            public TimeSpan Elapsed {get{return TimeSpan.FromMilliseconds(ElapsedMilliseconds);}}
        }
        public static void FakeReset(string name) {
            foreach(var handle in FakeHandles)handle.Dispose();FakeHandles.Clear();retained.Clear();
            FakeCase=name;FakeNow=0;FakeClocks=FakeTerminations=FakeRootWaits=FakeActiveReads=0;FakeLastWait=0;FakeTerminating=false;
        }
        private static uint FakeActive() {
            FakeActiveReads++;
            if(!FakeTerminating) {
                if(FakeCase.StartsWith("normal-")){FakeNow=FakeCase=="normal-success"?100:1490;return 0;}
                if(FakeCase=="rss-failure-root-never")return 1;
                FakeNow=1500;return 1;
            }
            if(FakeCase=="timeout-job-never")return 1;
            if(FakeCase=="timeout-job-late")FakeNow+=29750;
            if(FakeCase=="timeout-job-query-expired")FakeNow+=30001;
            return 0;
        }
        private static uint FakeWait(uint timeout) {
            FakeRootWaits++;FakeLastWait=timeout;
            if(FakeCase=="timeout-wait-failed"){Marshal.SetLastPInvokeError(6);return 0xffffffff;}
            if(FakeCase.EndsWith("root-never")){FakeNow+=timeout;return 258;}
            if(FakeCase=="timeout-signal-expired"||FakeCase=="normal-late-signal"){FakeNow+=timeout+1;return 0;}
            uint need=FakeCase=="timeout-terminate-slow"?10u:20u;
            if(timeout<need){FakeNow+=timeout;return 258;}
            FakeNow+=need;return 0;
        }
`,
  );
  if (!source.includes('public static string FakeCase')) throw new Error('虚拟时钟接线失败');
  writeFileSync(join(root, 'mock.cs'), source);
  writeFileSync(
    join(root, 'test.ps1'),
    `$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mock.cs')
$owner=[AIbrowse.FullTransfer.FixedTransferJob]
$outputs=foreach($name in @(${cases.map((name) => `'${name}'`).join(',')})) {
 $owner::FakeReset($name)
 $workMs=if($name -eq 'normal-success'){12000}else{1500}
 $result=$owner::Execute('transfer','fixture.exe','fixed','fixed','.',('a'*32),$workMs)
 [pscustomobject]@{name=$name;wait=$owner::FakeLastWait;waits=$owner::FakeRootWaits;terminate=$owner::FakeTerminations;activeReads=$owner::FakeActiveReads;clocks=$owner::FakeClocks;retained=$owner::FakeRetained;openHandles=$owner::FakeOpenHandles;result=$result}
}
$outputs|ConvertTo-Json -Depth 8 -Compress
`,
  );
  outputs = JSON.parse(
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test.ps1')], {
      cwd: resolve('.'),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 131072,
    }),
  ) as Outcome[];
}, 20000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

for (const name of cases) {
  it(`真实Execute/finally与虚拟时钟：${name}`, () => {
    const output = outputs.find((value) => value.name === name)!;
    const normal = name.startsWith('normal-');
    const retained = [
      'timeout-job-never',
      'timeout-root-never',
      'timeout-wait-failed',
      'timeout-terminate-expired',
      'timeout-job-query-expired',
      'timeout-signal-expired',
      'native-failure-root-never',
      'rss-failure-root-never',
      'normal-near-deadline',
    ].includes(name);
    expect(output.result.ActualZero).toBe(!retained);
    expect(output.result.OwnershipRetained).toBe(retained);
    expect(output.openHandles).toBe(retained ? (name === 'rss-failure-root-never' ? 3 : 2) : 0);
    expect(output.retained).toBe(output.openHandles);
    expect(output.result.Succeeded).toBe(name === 'normal-success');
    expect(output.terminate).toBe(normal ? 0 : 1);
    expect(output.clocks).toBe(normal ? 1 : 2);
    const failure =
      name === 'normal-success'
        ? null
        : name === 'normal-near-deadline'
          ? 'exact-process-exit-unknown'
          : name === 'native-failure-root-never'
            ? 'native-failed'
            : name === 'rss-failure-root-never'
              ? 'rss-sample-limit'
              : 'deadline';
    expect(output.result.Failure).toBe(failure);
    if (name === 'timeout-root-late') expect(output.wait).toBe(30000);
    if (name === 'timeout-job-late') expect(output.wait).toBe(250);
    if (name === 'timeout-terminate-slow') expect(output.wait).toBe(20);
    if (name === 'normal-success') expect(output.wait).toBe(10000);
    if (name === 'normal-near-deadline' || name === 'normal-late-signal')
      expect(output.wait).toBe(10);
    if (
      ['timeout-job-never', 'timeout-terminate-expired', 'timeout-job-query-expired'].includes(name)
    )
      expect(output.waits).toBe(0);
    if (name === 'timeout-terminate-expired') expect(output.activeReads).toBe(1);
    if (name === 'timeout-final-limits' || name === 'timeout-final-limits-unreadable') {
      expect(output.result.LimitsVerified).toBe(false);
      expect(output.result.ExitFailure).toBe(
        name === 'timeout-final-limits' ? 'limits-changed' : 'limits-unknown',
      );
    }
    if (name === 'timeout-exit-unreadable') {
      expect(output.result.ExitFailure).toBe('exit-unknown');
      expect(output.result.ExitCode).not.toBe(92);
    }
    if (name === 'timeout-root-never') expect(output.result.DurationMs).toBe(31500);
    expect(JSON.stringify(output)).not.toContain('private-exit-path-and-body');
  });
}
