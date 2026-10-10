import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const cases = [
  'normal',
  'growth',
  'exited',
  'unknown-exited',
  'too-many-live',
  'import-too-many',
  'twice-more',
  'other-error',
  'partial-success',
  'oversized-count',
  'short-return',
  'duplicate',
  'zero-pid',
  'wide-pid',
  'wrong-member',
  'wrong-times',
  'bad-wait',
  'expired',
  'expires-between',
  'identity-budget',
  'second-error',
  'second-partial',
  'long-return',
  'peak-root',
  'peak-other',
] as const;
type Case = (typeof cases)[number];
interface Outcome {
  name: Case;
  accepted: boolean;
  reads: number;
  opened: number;
  tree: number;
  held: number;
  closed: number;
  result: {
    Samples: number;
    Failure: string;
    FailureStage: string;
    NativeErrorCode: number;
    RssPeakBytes: number;
    RssPeakProcessId: number;
    RssPeakCreatedFileTime: string | null;
    RssPeakRole: 'root' | 'other' | null;
    RssPeakSampleAttempt: number;
    PidListExpansions: number;
    PidListFirst: {
      Capacity: number;
      Assigned: number;
      Count: number;
      ReturnedBytes: number;
      Error: number;
      Succeeded: boolean;
    };
    PidListLast: {
      Capacity: number;
      Assigned: number;
      Count: number;
      ReturnedBytes: number;
      Error: number;
      Succeeded: boolean;
    };
  };
}
let root: string;
let outcomes: Outcome[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'full-transfer-pid-pure-'));
  let source = readFileSync(
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
    'utf8',
  ).replaceAll('\r\n', '\n');
  const replace = (name: string, replacement: string): void => {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern [^;\n]+\b${name}\([^;]+;`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`替身边界不唯一：${name}`);
    source = source.replace(pattern, replacement);
  };
  const hasReturnLength = source.includes('out uint returned);');
  replace(
    'ReadPids',
    hasReturnLength
      ? 'private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) { return FakeRead(buffer,size,out returned); }'
      : 'private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,IntPtr returned) { uint bytes; return FakeRead(buffer,size,out bytes); }',
  );
  replace(
    'OpenProcess',
    'private static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) { FakeOpened++; if(FakeCase=="unknown-exited"&&pid>=124){Marshal.SetLastPInvokeError(5);return new SafeFileHandle(IntPtr.Zero,false);} var handle=new SafeFileHandle(new IntPtr(pid),false);FakeHandles.Add(handle);return handle; }',
  );
  replace(
    'GetProcessTimes',
    'private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) { long pid=process.DangerousGetHandle().ToInt64(); int calls;FakeTimes.TryGetValue(pid,out calls);FakeTimes[pid]=calls+1;created=pid*10+(FakeCase=="wrong-times"&&calls>0?1:0);exited=kernel=user=0;return true; }',
  );
  replace(
    'IsProcessInJob',
    'private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool result) { result=FakeCase!="wrong-member";return true; }',
  );
  replace(
    'WaitForSingleObject',
    'private static uint WaitForSingleObject(SafeFileHandle process,uint timeout) { if(FakeCase=="bad-wait"){Marshal.SetLastPInvokeError(6);return 0xffffffff;}return FakeCase=="exited"&&process.DangerousGetHandle().ToInt64()>=124?0u:258u; }',
  );
  replace(
    'GetProcessMemoryInfo',
    'private static bool GetProcessMemoryInfo(SafeFileHandle process,ref MemoryCounters counters,uint size) { ulong pid=(ulong)process.DangerousGetHandle().ToInt64(); ulong mib=FakeCase=="peak-root"?(pid==100?3u:2u):FakeCase=="peak-other"?(pid==101?3u:1u):1u;counters.WorkingSet=new UIntPtr(mib*1048576);return true; }',
  );
  replace(
    'QueryFullProcessImageNameW',
    'private static bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder image,ref uint length) {return false;}',
  );
  source = source.replace(
    'public static class FixedTransferJob\n    {',
    `public static class FixedTransferJob\n    {
        public static string FakeCase;
        public static int FakeReads,FakeOpened;
        public static System.Collections.Generic.List<SafeFileHandle> FakeHandles=new System.Collections.Generic.List<SafeFileHandle>();
        public static int FakeClosed {get{return FakeHandles.Count(handle=>handle.IsClosed);}}
        private static System.Collections.Generic.Dictionary<long,int> FakeTimes=new System.Collections.Generic.Dictionary<long,int>();
        public static void FakeReset(string name) {FakeCase=name;FakeReads=FakeOpened=0;FakeTimes.Clear();FakeHandles.Clear();}
        private static bool FakeRead(IntPtr buffer,uint size,out uint returned) {
            FakeReads++;
            int count=1;bool success=true;int error=0;
            if(FakeCase=="growth"||FakeCase=="expires-between"||FakeCase=="second-error"||FakeCase=="second-partial")count=FakeReads==1?33:24;
            if(FakeCase=="exited"||FakeCase=="unknown-exited"||FakeCase=="too-many-live")count=33;
            if(FakeCase=="twice-more")count=129;
            if(count>(size-8)/8){success=false;error=234;}
            if(FakeCase=="other-error"){success=false;error=5;}
            if(FakeCase=="second-error"&&FakeReads==2){success=false;error=5;}
            if(FakeCase=="second-partial"&&FakeReads==2)count=25;
            if(FakeCase=="partial-success")count=25;
            if(FakeCase=="oversized-count")count=33;
            if(FakeCase=="duplicate"||FakeCase=="import-too-many")count=2;
            if(FakeCase=="peak-root"||FakeCase=="peak-other")count=2;
            int written=Math.Min(count,(int)(size-8)/8);
            if(FakeCase=="partial-success")written=24;
            if(FakeCase=="second-partial"&&FakeReads==2)written=24;
            if(FakeCase=="oversized-count")written=33;
            Marshal.WriteInt32(buffer,0,count);Marshal.WriteInt32(buffer,4,written);
            for(int i=0;i<Math.Min(written,(int)(size-8)/8);i++)Marshal.WriteInt64(buffer,8+i*8,FakeCase=="zero-pid"?0:FakeCase=="wide-pid"?4294967296L:FakeCase=="duplicate"?100:100+i);
            returned=(uint)(8+Math.Min(written,(int)(size-8)/8)*8);
            if(FakeCase=="short-return")returned=8;
            if(FakeCase=="long-return")returned=size+1;
            if(FakeCase=="expires-between"&&FakeReads==1)Thread.Sleep(100);
            Marshal.SetLastPInvokeError(error);return success;
        }
`,
  );
  // Match either newline convention without changing the production file.
  if (!source.includes('public static string FakeCase')) {
    throw new Error('测试源码接线失败');
  }
  writeFileSync(join(root, 'mock.cs'), source);
  const script = `$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mock.cs')
$owner=[AIbrowse.FullTransfer.FixedTransferJob];$flags=[Reflection.BindingFlags]'Static,NonPublic'
$contextType=$owner.GetNestedType('NativeDiagnostic',[Reflection.BindingFlags]::NonPublic)
$sampleType=$owner.GetNestedType('Sampled',[Reflection.BindingFlags]::NonPublic)
$dictionaryType=[Collections.Generic.Dictionary\`2].MakeGenericType([uint32],$sampleType)
$method=$owner.GetMethod('SampleJob',$flags)
$outputs=foreach($name in @(${cases.map((c) => `'${c}'`).join(',')})) {
 [AIbrowse.FullTransfer.FixedTransferJob]::FakeReset($name)
 $context=[Activator]::CreateInstance($contextType,$true);$held=[Activator]::CreateInstance($dictionaryType)
 $result=[AIbrowse.FullTransfer.FixedTransferJob+Result]::new();$result.ProcessLimit=if($name -eq 'import-too-many'){1}else{24}
 $result.ProcessId=100;$result.CreatedFileTime=1000
 if($name -eq 'identity-budget'){$result.SampledIdentities=128}
 $clock=[Diagnostics.Stopwatch]::StartNew();$workMs=if($name -eq 'expired'){0}elseif($name -eq 'expires-between'){50}else{12000}
 $accepted=$false;$tree=0
 try {
  $arguments=if($method.GetParameters().Count -eq 4){@($null,$held,$result,$context)}else{@($null,$held,$result,$context,$clock,$workMs)}
  $tree=$method.Invoke($null,$arguments);$accepted=$true
 } catch {
  $failure=$_.Exception
  while($failure -is [Management.Automation.MethodInvocationException] -or $failure -is [Reflection.TargetInvocationException]){$failure=$failure.InnerException}
  $null=$owner.GetMethod('RecordNativeFailure',$flags).Invoke($null,@($result,$context,$failure))
 }
 $heldCount=$held.Count;$closedCount=$owner::FakeClosed
 foreach($item in $held.Values){$item.Handle.Dispose()}
 [pscustomobject]@{name=$name;accepted=$accepted;reads=$owner::FakeReads;opened=$owner::FakeOpened;tree=$tree;held=$heldCount;closed=$closedCount;result=$result}
}
$outputs|ConvertTo-Json -Depth 8 -Compress
`;
  const path = join(root, 'test.ps1');
  writeFileSync(path, script);
  outcomes = JSON.parse(
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
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
  it(`真实采样器假API序列：${name}`, () => {
    const output = outcomes.find((value) => value.name === name)!;
    const accepted = ['normal', 'growth', 'exited', 'peak-root', 'peak-other'].includes(name);
    expect(output.accepted).toBe(accepted);
    expect(output.result.Samples).toBe(accepted ? 1 : 0);
    expect(output.reads).toBe(
      name === 'expired'
        ? 0
        : [
              'growth',
              'exited',
              'unknown-exited',
              'too-many-live',
              'twice-more',
              'second-error',
              'second-partial',
            ].includes(name)
          ? 2
          : 1,
    );
    if (accepted)
      expect(output.tree).toBe(
        (name === 'normal' ? 1 : name === 'peak-root' ? 5 : name === 'peak-other' ? 4 : 24) *
          1048576,
      );
    if (name === 'peak-root' || name === 'peak-other') {
      expect(output.result).toMatchObject({
        RssPeakBytes: 3 * 1048576,
        RssPeakProcessId: name === 'peak-root' ? 100 : 101,
        RssPeakCreatedFileTime: name === 'peak-root' ? '1000' : '1010',
        RssPeakRole: name === 'peak-root' ? 'root' : 'other',
        RssPeakSampleAttempt: 1,
      });
    }
    if (name === 'growth' || name === 'exited') {
      expect(output.result.PidListExpansions).toBe(1);
      expect(output.result.PidListFirst).toMatchObject({
        Capacity: 32,
        Assigned: 33,
        Count: 32,
        ReturnedBytes: 264,
        Error: 234,
        Succeeded: false,
      });
      expect(output.result.PidListLast).toMatchObject({ Capacity: 128, Error: 0, Succeeded: true });
    }
    if (['expired', 'expires-between'].includes(name))
      expect(output.result.Failure).toBe('deadline');
    if (name === 'twice-more') expect(output.result.NativeErrorCode).toBe(234);
    if (
      [
        'partial-success',
        'oversized-count',
        'short-return',
        'duplicate',
        'zero-pid',
        'wide-pid',
      ].includes(name)
    )
      expect(output.opened).toBe(0);
    if (name === 'unknown-exited') expect(output.result.FailureStage).toBe('SampleOpen');
    if (name === 'exited') {
      expect(output.held).toBe(24);
      expect(output.closed).toBe(9);
    }
    if (name === 'identity-budget') {
      expect(output.result.FailureStage).toBe('SampleHandleBudget');
      expect(output.closed).toBe(1);
    }
    if (name === 'second-error') expect(output.result.NativeErrorCode).toBe(5);
    if (['too-many-live', 'import-too-many'].includes(name))
      expect(output.result.FailureStage).toBe('SampleActiveBudget');
    expect(JSON.stringify(output)).not.toContain('private-path-and-body');
  });
}
