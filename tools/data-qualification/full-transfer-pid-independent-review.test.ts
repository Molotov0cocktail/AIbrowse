import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('多轮真实采样保持精确句柄、退出后复核与累计身份门，零原生调用', () => {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-pid-independent-'));
  const resolved = resolve(root);
  if (!resolved.startsWith(resolve(tmpdir()) + '\\')) throw new Error('临时目录边界不符');
  try {
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
    replace(
      'ReadPids',
      `private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) {
        Marshal.WriteInt32(buffer,0,1);Marshal.WriteInt32(buffer,4,1);
        Marshal.WriteInt64(buffer,8,ProbeCase=="cumulative"?100+ProbeRound:100);returned=16;return true;
      }`,
    );
    replace(
      'OpenProcess',
      `private static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) {
        var handle=new SafeFileHandle(new IntPtr(++ProbeOpened),false);ProbeHandles.Add(handle);return handle;
      }`,
    );
    replace(
      'GetProcessTimes',
      `private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) {
        int key=process.DangerousGetHandle().ToInt32();int calls;ProbeTimes.TryGetValue(key,out calls);ProbeTimes[key]=calls+1;
        created=1000+(ProbeCase=="known-identity-change"&&ProbeRound==1?1:ProbeCase=="signaled-identity-change"&&ProbeRound==1&&calls>0?1:0);
        exited=kernel=user=0;return true;
      }`,
    );
    replace(
      'IsProcessInJob',
      `private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool result) {
        int key=process.DangerousGetHandle().ToInt32();int calls;ProbeMembership.TryGetValue(key,out calls);ProbeMembership[key]=calls+1;
        result=!(ProbeCase=="signaled-membership-lost"&&ProbeRound==1&&calls>0);return true;
      }`,
    );
    replace(
      'WaitForSingleObject',
      `private static uint WaitForSingleObject(SafeFileHandle process,uint timeout) {
        if(ProbeCase=="prior-wait-failed"&&ProbeRound==1){Marshal.SetLastPInvokeError(6);return 0xffffffff;}
        return ProbeCase=="cumulative"||(ProbeRound==1&&ProbeCase.StartsWith("signaled"))?0u:258u;
      }`,
    );
    replace(
      'GetProcessMemoryInfo',
      'private static bool GetProcessMemoryInfo(SafeFileHandle process,ref MemoryCounters counters,uint size) { counters.WorkingSet=new UIntPtr(1048576);return true; }',
    );
    source = source.replace(
      'public static class FixedTransferJob\n    {',
      `public static class FixedTransferJob
    {
      private static string ProbeCase;private static int ProbeRound,ProbeOpened;
      private static System.Collections.Generic.List<SafeFileHandle> ProbeHandles=new System.Collections.Generic.List<SafeFileHandle>();
      private static System.Collections.Generic.Dictionary<int,int> ProbeTimes=new System.Collections.Generic.Dictionary<int,int>();
      private static System.Collections.Generic.Dictionary<int,int> ProbeMembership=new System.Collections.Generic.Dictionary<int,int>();
      public static string ProbeSequence(string name) {
        ProbeCase=name;ProbeRound=ProbeOpened=0;ProbeHandles.Clear();ProbeTimes.Clear();ProbeMembership.Clear();
        var result=new Result {ProcessLimit=24};var diagnostic=new NativeDiagnostic();
        var held=new System.Collections.Generic.Dictionary<uint,Sampled>();var clock=Stopwatch.StartNew();
        bool accepted=true;ulong tree=0;
        try {for(ProbeRound=0;ProbeRound<(name=="cumulative"?129:2);ProbeRound++)tree=SampleJob(null,held,result,diagnostic,clock,12000);}
        catch(Exception error){accepted=false;RecordNativeFailure(result,diagnostic,error);}
        int retained=held.Count,closed=ProbeHandles.Count(handle=>handle.IsClosed);
        foreach(var item in held.Values)item.Handle.Dispose();
        return String.Join("|",name,accepted,result.Samples,result.SampledIdentities,ProbeOpened,retained,closed,tree,result.FailureStage??"none");
      }
`,
    );
    if (!source.includes('public static string ProbeSequence')) throw new Error('独立入口未接线');
    writeFileSync(join(root, 'mock.cs'), source);
    const script = `$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mock.cs')
foreach($name in @('reused-live','signaled-clean','prior-wait-failed','known-identity-change','signaled-identity-change','signaled-membership-lost','cumulative')) {
 [AIbrowse.FullTransfer.FixedTransferJob]::ProbeSequence($name)
}
`;
    const scriptPath = join(root, 'probe.ps1');
    writeFileSync(scriptPath, script);
    const output = execFileSync(
      'pwsh.exe',
      ['-NoProfile', '-NonInteractive', '-File', scriptPath],
      {
        cwd: resolve('.'),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 32768,
      },
    );
    expect(output.trim().split(/\r?\n/)).toEqual([
      'reused-live|True|2|1|1|1|0|1048576|none',
      'signaled-clean|True|2|2|2|0|2|0|none',
      'prior-wait-failed|False|1|1|1|1|0|1048576|PriorHandleWait',
      'known-identity-change|False|1|1|1|1|0|1048576|SampleCurrentTimes',
      'signaled-identity-change|False|1|2|2|1|1|1048576|SampleCurrentTimes',
      'signaled-membership-lost|False|1|2|2|1|1|1048576|SampleCurrentMembership',
      'cumulative|False|128|128|129|0|129|0|SampleHandleBudget',
    ]);
  } finally {
    rmSync(resolved, { recursive: true, force: true });
  }
}, 20000);
