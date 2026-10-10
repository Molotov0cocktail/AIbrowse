import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

interface Outcome {
  terminateOk: boolean;
  accepted: boolean;
  rootWaitMs: number;
  result: {
    ActualZero: boolean;
    OwnershipRetained: boolean;
    LimitsVerified: boolean;
    Failure: string;
    ExitFailure: string | null;
    ExitCode: number;
    Succeeded: boolean;
  };
}
let outcomes: Outcome[];

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-exit-independent-'));
  let source = readFileSync('tools/data-qualification/full-transfer/FixedTransferJob.cs', 'utf8');
  const replace = (name: string, replacement: string): void => {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern [^;]+\b${name}\([^;]+;`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`API边界未唯一绑定：${name}`);
    source = source.replace(pattern, replacement);
  };
  replace(
    'CreateJobObjectW',
    'private static SafeFileHandle CreateJobObjectW(IntPtr a,string n) { Marshal.SetLastPInvokeError(0); return new SafeFileHandle(new IntPtr(1),false); }',
  );
  replace(
    'SetInformationJobObject',
    'private static bool SetInformationJobObject(SafeFileHandle j,int t,ref ExtendedLimits l,uint n) { TestLimits=l;return true; }',
  );
  replace(
    'ReadLimits',
    'private static bool ReadLimits(SafeFileHandle j,int t,out ExtendedLimits l,uint n,IntPtr r) { l=TestLimits;return true; }',
  );
  replace(
    'InitializeProcThreadAttributeList',
    'private static bool InitializeProcThreadAttributeList(IntPtr p,int n,uint f,ref UIntPtr s) { s=new UIntPtr(16);return p!=IntPtr.Zero; }',
  );
  replace(
    'UpdateProcThreadAttribute',
    'private static bool UpdateProcThreadAttribute(IntPtr p,uint f,UIntPtr a,IntPtr v,UIntPtr s,IntPtr q,IntPtr r) { return true; }',
  );
  replace(
    'DeleteProcThreadAttributeList',
    'private static void DeleteProcThreadAttributeList(IntPtr p) {}',
  );
  replace(
    'CreateProcessW',
    'private static bool CreateProcessW(string a,StringBuilder c,IntPtr p,IntPtr t,bool h,uint f,IntPtr e,string d,ref StartupEx s,out ProcessInformation i) { i=new ProcessInformation {Process=new IntPtr(2),Thread=new IntPtr(3),ProcessId=100,ThreadId=101};return true; }',
  );
  replace(
    'GetProcessTimes',
    'private static bool GetProcessTimes(SafeFileHandle p,out long c,out long e,out long k,out long u) { c=1000;e=k=u=0;return true; }',
  );
  replace(
    'IsProcessInJob',
    'private static bool IsProcessInJob(SafeFileHandle p,SafeFileHandle j,out bool m) { m=true;return true; }',
  );
  replace(
    'QueryFullProcessImageNameW',
    'private static bool QueryFullProcessImageNameW(SafeFileHandle p,uint f,StringBuilder b,ref uint l) { b.Append("fixture.exe");return true; }',
  );
  replace(
    'QueryInformationJobObject',
    'private static bool QueryInformationJobObject(SafeFileHandle j,int t,out Accounting a,uint n,IntPtr r) { if(!TestTerminating)TestNow=1500;a=new Accounting {ActiveProcesses=TestTerminating?0u:1u};return true; }',
  );
  replace(
    'TerminateJobObject',
    'private static bool TerminateJobObject(SafeFileHandle j,uint c) { TestTerminating=true;return TestTerminateOk; }',
  );
  replace(
    'WaitForSingleObject',
    'private static uint WaitForSingleObject(SafeFileHandle p,uint t) { if(p.DangerousGetHandle().ToInt64()!=2)throw new InvalidOperationException("非原root句柄");TestWait=t;TestNow+=20;return 0; }',
  );
  replace(
    'GetExitCodeProcess',
    'private static bool GetExitCodeProcess(SafeFileHandle p,out uint c) { c=92;return true; }',
  );
  source = source
    .replaceAll('\r\n', '\n')
    .replaceAll('Stopwatch', 'TestStopwatch')
    .replaceAll('Thread.Sleep(', 'TestSleep(')
    .replace('new SafeFileHandle(info.Process,true)', 'new SafeFileHandle(info.Process,false)')
    .replace('new SafeFileHandle(info.Thread,true)', 'new SafeFileHandle(info.Thread,false)');
  source = source.replace(
    'public static class FixedTransferJob\n    {',
    `public static class FixedTransferJob
    {
        public static bool TestTerminateOk,TestTerminating;
        public static long TestNow;
        public static uint TestWait;
        private static ExtendedLimits TestLimits;
        private static void TestSleep(int n) {throw new InvalidOperationException("不应休眠");}
        public sealed class TestStopwatch {
            private long start;
            public static TestStopwatch StartNew() {return new TestStopwatch {start=TestNow};}
            public long ElapsedMilliseconds {get{return TestNow-start;}}
            public TimeSpan Elapsed {get{return TimeSpan.FromMilliseconds(ElapsedMilliseconds);}}
        }
`,
  );
  if (!source.includes('public sealed class TestStopwatch')) throw new Error('虚拟时钟未绑定');
  // Any unexpected sampling path must fail before it can invoke native APIs.
  for (const name of ['ReadPids', 'OpenProcess', 'GetProcessMemoryInfo']) {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern ([^;]+\b${name}\([^;]+);`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`未用API边界缺失：${name}`);
    source = source.replace(pattern, 'private static $1 {throw new InvalidOperationException();}');
  }
  writeFileSync(join(root, 'subject.cs'), source);
  const command = `$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
    Add-Type -Path (Join-Path $PSScriptRoot 'subject.cs');
    $tokens=$null;$errors=$null;
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/qualify-runner.ps1'),[ref]$tokens,[ref]$errors);
    if($errors.Count){throw '入口AST无效'};
    $outer=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
    if($outer.Count -ne 1){throw '入口终态块不唯一'};
    $statements=$outer[0].Body.Statements;
    if(-not $statements[0].Extent.Text.Contains('::Execute(') -or -not $statements[1].Extent.Text.Contains('$job.ActualZero') -or -not $statements[2].Extent.Text.Contains('::ValidateLimits(') -or -not $statements[3].Extent.Text.Contains("'timeout'")){throw '实际判定块形状变化'};
    $gate=($statements[1..3]|ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine;
    $owner=[AIbrowse.FullTransfer.FixedTransferJob];$mode='transfer';$Case='timeout';
    $results=foreach($terminateOk in @($true,$false)) {
      $owner::TestTerminateOk=$terminateOk;$owner::TestTerminating=$false;$owner::TestNow=0;
      $job=$owner::Execute('transfer','fixture.exe','fixed','fixed','.',('b'*32),1500);
      $accepted=$false;try{. ([scriptblock]::Create($gate));$accepted=$true}catch{};
      [ordered]@{terminateOk=$terminateOk;accepted=$accepted;rootWaitMs=$owner::TestWait;result=$job}
    };
    $results|ConvertTo-Json -Depth 8 -Compress;`;
  const script = join(root, 'test.ps1');
  writeFileSync(script, command);
  outcomes = JSON.parse(
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
      cwd: resolve('.'),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    }),
  ) as Outcome[];
}, 20000);

it.each([true, false])('实际helper和入口判定必须区分终止API返回%s', (terminateOk) => {
  const outcome = outcomes.find((value) => value.terminateOk === terminateOk)!;
  expect(outcome.result).toMatchObject({
    ActualZero: true,
    OwnershipRetained: false,
    LimitsVerified: true,
    Failure: 'deadline',
    ExitFailure: terminateOk ? null : 'terminate-failed',
    ExitCode: 92,
    Succeeded: false,
  });
  expect(outcome.rootWaitMs).toBe(30000);
  expect(outcome.accepted).toBe(terminateOk);
});
