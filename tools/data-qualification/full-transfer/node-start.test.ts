import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const cases = [
  'import-success',
  'transfer-success',
  'extra-console',
  'extra-other',
  'extra-spoof',
  'extra-unreadable',
  'extra-throws',
  'extra-root',
  'extra-time-changed',
  'extra-member-changed',
  'extra-expired',
] as const;
interface Outcome {
  name: string;
  flags: number;
  inherited: boolean;
  attribute: number;
  limit: number;
  command: string;
  imageReads: number;
  result: {
    Succeeded: boolean;
    ActualZero: boolean;
    Failure: string | null;
    FailureStage: string | null;
    FailedSampleImage: string | null;
    ProcessLimit: number;
    CreationFlags: number;
    ExitFailure: string | null;
    Samples: number;
  };
}
let root: string;
let outputs: Outcome[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'full-transfer-node-start-pure-'));
  let source = readFileSync(
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
    'utf8',
  ).replaceAll('\r\n', '\n');
  const replace = (name: string, body: string): void => {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern [^;]+\b${name}\([^;]+;`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`替身边界不唯一：${name}`);
    source = source.replace(pattern, body);
  };
  replace(
    'CreateJobObjectW',
    'private static SafeFileHandle CreateJobObjectW(IntPtr attributes,string name) {Marshal.SetLastPInvokeError(0);return new SafeFileHandle(new IntPtr(1),false);}',
  );
  replace(
    'SetInformationJobObject',
    'private static bool SetInformationJobObject(SafeFileHandle job,int type,ref ExtendedLimits limits,uint length) {FakeLimits=limits;return true;}',
  );
  replace(
    'ReadLimits',
    'private static bool ReadLimits(SafeFileHandle job,int type,out ExtendedLimits info,uint length,IntPtr returned) {info=FakeLimits;return true;}',
  );
  replace(
    'InitializeProcThreadAttributeList',
    'private static bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size) {size=new UIntPtr(16);return list!=IntPtr.Zero;}',
  );
  replace(
    'UpdateProcThreadAttribute',
    'private static bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned) {FakeAttribute=attribute.ToUInt64();if(Marshal.ReadIntPtr(value)!=new IntPtr(1)||size.ToUInt64()!=8)throw new InvalidOperationException();return true;}',
  );
  replace(
    'DeleteProcThreadAttributeList',
    'private static void DeleteProcThreadAttributeList(IntPtr list) {}',
  );
  replace(
    'CreateProcessW',
    'private static bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInformation process) {FakeFlags=flags;FakeInherited=inherit;FakeCommand=command.ToString();process=new ProcessInformation {Process=new IntPtr(2),Thread=new IntPtr(3),ProcessId=100,ThreadId=101};return true;}',
  );
  replace(
    'GetProcessTimes',
    'private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) {long handle=process.DangerousGetHandle().ToInt64();created=handle==2?1000:(handle-1000)*10;if(FakeImages>1&&FakeCase=="extra-time-changed")created++;exited=kernel=user=0;return true;}',
  );
  replace(
    'IsProcessInJob',
    'private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool result) {result=!(FakeImages>1&&FakeCase=="extra-member-changed");return true;}',
  );
  replace(
    'QueryFullProcessImageNameW',
    `private static bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder image,ref uint length) {
    FakeImages++;if(process.DangerousGetHandle().ToInt64()==2){image.Append("fixture.exe");length=11;return true;}
    if(FakeCase=="extra-unreadable")return false;if(FakeCase=="extra-throws")throw new InvalidOperationException("private-image-path");
    string path=FakeCase=="extra-console"?System.IO.Path.Combine(Environment.SystemDirectory,"conhost.exe"):@"C:\\private-image-path\\conhost.exe";
    if(FakeCase=="extra-other")path=@"C:\\private-image-path\\other.exe";
    image.Append(path);length=(uint)path.Length;if(FakeCase=="extra-expired")FakeNow=12001;return true;
  }`,
  );
  replace(
    'QueryInformationJobObject',
    'private static bool QueryInformationJobObject(SafeFileHandle job,int type,out Accounting info,uint length,IntPtr returned) {info=new Accounting {ActiveProcesses=FakeDone?0u:1u};return true;}',
  );
  replace(
    'TerminateJobObject',
    'private static bool TerminateJobObject(SafeFileHandle job,uint code) {FakeDone=true;FakeTerminated=true;return true;}',
  );
  replace(
    'WaitForSingleObject',
    'private static uint WaitForSingleObject(SafeFileHandle process,uint timeout) {return process.DangerousGetHandle().ToInt64()==2?0u:258u;}',
  );
  replace(
    'GetExitCodeProcess',
    'private static bool GetExitCodeProcess(SafeFileHandle process,out uint code) {code=FakeTerminated?92u:0u;return true;}',
  );
  replace(
    'ReadPids',
    'private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) {int count=FakeCase.StartsWith("extra-")?2:1;Marshal.WriteInt32(buffer,0,count);Marshal.WriteInt32(buffer,4,count);Marshal.WriteInt64(buffer,8,FakeCase=="extra-root"?101:100);if(count==2)Marshal.WriteInt64(buffer,16,FakeCase=="extra-root"?100:101);returned=(uint)(8+count*8);return true;}',
  );
  replace(
    'OpenProcess',
    'private static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) {return new SafeFileHandle(new IntPtr(1000+pid),false);}',
  );
  replace(
    'GetProcessMemoryInfo',
    'private static bool GetProcessMemoryInfo(SafeFileHandle process,ref MemoryCounters counters,uint size) {counters.WorkingSet=new UIntPtr(1048576);return true;}',
  );
  source = source
    .replaceAll('Stopwatch', 'FakeStopwatch')
    .replaceAll('Thread.Sleep(', 'FakeSleep(')
    .replace('new SafeFileHandle(info.Process,true)', 'new SafeFileHandle(info.Process,false)')
    .replace('new SafeFileHandle(info.Thread,true)', 'new SafeFileHandle(info.Thread,false)')
    .replace(
      'public static class FixedTransferJob\n    {',
      `public static class FixedTransferJob
    {
      public static string FakeCase,FakeCommand;public static uint FakeFlags;public static ulong FakeAttribute;
      public static bool FakeInherited,FakeDone,FakeTerminated;public static int FakeImages;public static long FakeNow;
      private static ExtendedLimits FakeLimits;
      public static uint FakeLimit {get{return FakeLimits.Basic.ActiveProcessLimit;}}
      public static void Reset(string name){FakeCase=name;FakeDone=FakeTerminated=false;FakeImages=0;FakeNow=0;}
      private static void FakeSleep(int delay){FakeNow+=delay;FakeDone=true;}
      public sealed class FakeStopwatch {private long start;public static FakeStopwatch StartNew(){return new FakeStopwatch {start=FakeNow};}public long ElapsedMilliseconds {get{return FakeNow-start;}}public TimeSpan Elapsed {get{return TimeSpan.FromMilliseconds(ElapsedMilliseconds);}}}
`,
    );
  writeFileSync(join(root, 'mock.cs'), source);
  writeFileSync(
    join(root, 'test.ps1'),
    `$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mock.cs')
$owner=[AIbrowse.FullTransfer.FixedTransferJob]
$outputs=foreach($name in @(${cases.map((name) => `'${name}'`).join(',')})) {
 $owner::Reset($name);$mode=if($name -ceq 'transfer-success'){'transfer'}else{'import'}
 $result=$owner::Execute($mode,'fixture.exe','fixed.cjs','fixed','.',('a'*32),12000)
 [pscustomobject]@{name=$name;flags=$owner::FakeFlags;inherited=$owner::FakeInherited;attribute=$owner::FakeAttribute;limit=$owner::FakeLimit;command=$owner::FakeCommand;imageReads=$owner::FakeImages;result=$result}
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
  it(`真实Execute创建与失败成员分类：${name}`, () => {
    const output = outputs.find((value) => value.name === name)!;
    const transfer = name === 'transfer-success';
    expect(output.flags).toBe(transfer ? 0x08080000 : 0x00080008);
    expect(output.result.CreationFlags).toBe(output.flags);
    expect(output.flags & (0x01000000 | 0x10)).toBe(0);
    expect(output.attribute).toBe(0x2000d);
    expect(output.inherited).toBe(false);
    expect(output.limit).toBe(transfer ? 24 : 1);
    expect(output.result.ProcessLimit).toBe(output.limit);
    expect(output.command).toBe(
      transfer
        ? '"fixture.exe" "fixed.cjs" "fixed"'
        : '"fixture.exe" "--max-old-space-size=768" "fixed.cjs" "fixed"',
    );
    expect(output.result.ActualZero).toBe(true);
    expect(output.result.ExitFailure).toBeNull();
    const success = name.endsWith('success');
    expect(output.result.Succeeded).toBe(success);
    expect(output.result.Failure).toBe(success ? null : 'native-failed');
    if (success) {
      expect(output.imageReads).toBe(1);
      expect(output.result.Samples).toBe(1);
    } else {
      expect(output.result.FailureStage).toBe('SampleActiveBudget');
      expect(output.result.FailedSampleImage).toBe(
        name === 'extra-console'
          ? 'system-console-host'
          : name === 'extra-root'
            ? 'root'
            : ['extra-other', 'extra-spoof'].includes(name)
              ? 'other'
              : 'unknown',
      );
      expect(output.imageReads).toBeLessThanOrEqual(2);
    }
    expect(JSON.stringify(output)).not.toContain('private-image-path');
  });
}
