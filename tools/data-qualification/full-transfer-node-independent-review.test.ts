import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const evidence = resolve(
  'log/stage7-e2/full-transfer-node-independent-review-001',
  'pure-' + randomUUID(),
);
const helperPath = 'tools/data-qualification/full-transfer/FixedTransferJob.cs';
const wrapperPath = 'tools/data-qualification/full-transfer/node-tiny.ps1';
const cases = [
  'import',
  'transfer',
  'console',
  'suffix',
  'length',
  'oversize',
  'changed',
  'nonmember',
  'late',
  'throws',
  'root',
  'unknown-exit',
  'attribute-fails',
] as const;
interface Outcome {
  name: string;
  accepted: boolean;
  flags: number;
  creates: number;
  queries: number;
  result: {
    Failure: string | null;
    FailureStage: string | null;
    FailedSampleImage: string | null;
    ActualZero: boolean;
    OwnershipRetained: boolean;
    Succeeded: boolean;
    Samples: number;
    ProcessLimit: number;
    ExitFailure: string | null;
  };
}
let outcomes: Outcome[];
function ps(name: string, body: string): string {
  mkdirSync(evidence, { recursive: true });
  const target = resolve(evidence, name + '.ps1');
  writeFileSync(
    target,
    "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" +
      body,
  );
  const output = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', target], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 262144,
  });
  writeFileSync(resolve(evidence, name + '.json'), output);
  return output;
}
const parse = `
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) '${wrapperPath}'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw '被审入口AST无效'}
function Function-Source([string]$Name) {
 $nodes=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
 if($nodes.Count -ne 1){throw '被审函数不唯一'}
 return $nodes[0].Extent.Text
}
`;

beforeAll(() => {
  mkdirSync(evidence, { recursive: true });
  let source = readFileSync(helperPath, 'utf8').replaceAll('\r\n', '\n');
  const methods: Record<string, string> = {
    CreateJobObjectW:
      'Marshal.SetLastPInvokeError(0); return new SafeFileHandle(new IntPtr(10),false);',
    SetInformationJobObject: 'ReviewLimits=limits; return true;',
    ReadLimits: 'info=ReviewLimits; return true;',
    InitializeProcThreadAttributeList: 'size=new UIntPtr(16); return list!=IntPtr.Zero;',
    UpdateProcThreadAttribute:
      'if(attribute.ToUInt64()!=0x2000d||size.ToUInt64()!=8||Marshal.ReadIntPtr(value).ToInt64()!=10)throw new InvalidOperationException();return ReviewCase!="attribute-fails";',
    DeleteProcThreadAttributeList: '',
    CreateProcessW:
      'if(inherit||startup.Startup.Size!=(uint)Marshal.SizeOf<StartupEx>())throw new InvalidOperationException();ReviewCreates++;ReviewFlags=flags;process=new ProcessInformation {Process=new IntPtr(11),Thread=new IntPtr(12),ProcessId=101};return true;',
    GetProcessTimes:
      'created=process.DangerousGetHandle().ToInt64()==1102?2000:1000;if(ReviewQueries>1&&ReviewCase=="changed")created++;exited=kernel=user=0;return true;',
    IsProcessInJob: 'result=!(ReviewQueries>1&&ReviewCase=="nonmember");return true;',
    QueryInformationJobObject:
      'info=new Accounting {ActiveProcesses=ReviewDone?0u:1u};return true;',
    TerminateJobObject: 'ReviewDone=true;ReviewTerminated=true;return true;',
    WaitForSingleObject:
      'return process.DangerousGetHandle().ToInt64()==11&&ReviewCase!="unknown-exit"?0u:258u;',
    GetExitCodeProcess: 'code=ReviewTerminated?92u:0u;return true;',
    OpenProcess:
      'if(access!=0x101010||inherit)throw new InvalidOperationException();return new SafeFileHandle(new IntPtr(processId+1000),false);',
    GetProcessMemoryInfo: 'counters.WorkingSet=new UIntPtr(4096);return true;',
    ReadPids: `
      int count=ReviewCase=="import"?1:2;
      Marshal.WriteInt32(buffer,0,count);Marshal.WriteInt32(buffer,4,count);
      Marshal.WriteInt64(buffer,8,ReviewCase=="root"?102:101);
      if(count==2)Marshal.WriteInt64(buffer,16,ReviewCase=="root"?101:102);
      returned=(uint)(8+8*count);return true;`,
    QueryFullProcessImageNameW: `
      ReviewQueries++;
      if(process.DangerousGetHandle().ToInt64()==11){image.Append("fixed-node.exe");length=14;return true;}
      if(ReviewCase=="throws")throw new InvalidOperationException("private-review-image");
      string value=System.IO.Path.Combine(Environment.SystemDirectory,"conhost.exe").ToUpperInvariant();
      if(ReviewCase=="suffix")value+=@"\\private-review-image";
      image.Append(value);length=(uint)image.Length;
      if(ReviewCase=="length")length--;
      if(ReviewCase=="oversize")length=32768;
      if(ReviewCase=="late")ReviewTime=12001;
      return true;`,
  };
  const replaced = new Set<string>();
  source = source.replace(
    /\[DllImport\([^\]]+\)\]\s*private static extern ([^;]+?\b(\w+)\([^;]+);/g,
    (_whole: string, signature: string, name: string) => {
      if (replaced.has(name)) throw new Error('被审API不唯一');
      replaced.add(name);
      const body = methods[name] ?? 'throw new InvalidOperationException("未授权原生API");';
      return `private static ${signature} {${body}}`;
    },
  );
  expect(source).not.toContain('[DllImport');
  expect(Object.keys(methods).every((name) => replaced.has(name))).toBe(true);
  source = source
    .replaceAll('Stopwatch', 'ReviewStopwatch')
    .replaceAll('Thread.Sleep(', 'ReviewSleep(')
    .replace('new SafeFileHandle(info.Process,true)', 'new SafeFileHandle(info.Process,false)')
    .replace('new SafeFileHandle(info.Thread,true)', 'new SafeFileHandle(info.Thread,false)')
    .replace(
      'public static class FixedTransferJob\n    {',
      `public static class FixedTransferJob
    {
      public static string ReviewCase;public static uint ReviewFlags;
      public static int ReviewCreates,ReviewQueries;public static long ReviewTime;
      private static bool ReviewDone,ReviewTerminated;private static ExtendedLimits ReviewLimits;
      public static void Reset(string name){ReviewCase=name;ReviewCreates=ReviewQueries=0;ReviewFlags=0;ReviewTime=0;ReviewDone=ReviewTerminated=false;}
      private static void ReviewSleep(int n){ReviewTime+=n;ReviewDone=true;}
      public sealed class ReviewStopwatch {
        private long start;public static ReviewStopwatch StartNew(){return new ReviewStopwatch{start=ReviewTime};}
        public long ElapsedMilliseconds {get{return ReviewTime-start;}}
        public TimeSpan Elapsed {get{return TimeSpan.FromMilliseconds(ElapsedMilliseconds);}}
      }
`,
    );
  writeFileSync(resolve(evidence, 'isolated-helper.cs'), source);
  outcomes = JSON.parse(
    ps(
      'independent-control',
      parse +
        `
Add-Type -Path (Join-Path $PSScriptRoot 'isolated-helper.cs')
Invoke-Expression (Function-Source 'Test-NodeJob')
$owner=[AIbrowse.FullTransfer.FixedTransferJob]
$rows=foreach($name in @(${cases.map((name) => `'${name}'`).join(',')})) {
 $owner::Reset($name);$mode=if($name -ceq 'transfer'){'transfer'}else{'import'}
 $job=$owner::Execute($mode,'fixed-node.exe','tiny.cjs','fixed','.',('c'*32),12000)
 $accepted=$false;try{Test-NodeJob $job;$accepted=$true}catch{}
 [ordered]@{name=$name;accepted=$accepted;flags=$owner::ReviewFlags;creates=$owner::ReviewCreates;queries=$owner::ReviewQueries;result=$job}
}
$rows|ConvertTo-Json -Depth 9 -Compress
`,
    ),
  ) as Outcome[];
}, 20000);

it.each(cases)('独立真实Execute及tiny入口判定：%s', (name) => {
  const row = outcomes.find((item) => item.name === name)!;
  expect(row.result.ProcessLimit).toBe(name === 'transfer' ? 24 : 1);
  expect(row.creates).toBe(name === 'attribute-fails' ? 0 : 1);
  if (row.creates) expect(row.flags).toBe(name === 'transfer' ? 0x08080000 : 0x00080008);
  expect(row.accepted).toBe(name === 'import');
  const success = name === 'import' || name === 'transfer';
  expect(row.result.Succeeded).toBe(success);
  expect(row.result.Failure).toBe(success ? null : 'native-failed');
  if (!success && name !== 'attribute-fails') {
    expect(row.result.FailureStage).toBe('SampleActiveBudget');
    expect(row.result.FailedSampleImage).toBe(
      name === 'root'
        ? 'root'
        : name === 'suffix'
          ? 'other'
          : name === 'console' || name === 'unknown-exit'
            ? 'system-console-host'
            : 'unknown',
    );
    expect(row.result.Samples).toBe(0);
    expect(row.queries).toBe(2);
  }
  expect(row.result.ActualZero).toBe(name !== 'unknown-exit');
  expect(row.result.OwnershipRetained).toBe(name === 'unknown-exit');
  expect(row.result.ExitFailure).toBe(
    name === 'unknown-exit' ? 'exact-process-exit-unknown' : null,
  );
  expect(JSON.stringify(row)).not.toMatch(/private-review-image|system32|conhost\.exe/i);
});

it('独立AST执行拒绝截止、来源变化和不完整成功状态', () => {
  const rows = JSON.parse(
    ps(
      'independent-gates',
      parse +
        `
foreach($name in @('Check-Time','Test-Bindings','Test-NodeJob','Test-TinyReceipt')) {Invoke-Expression (Function-Source $name)}
Add-Type -TypeDefinition 'namespace AIbrowse.FullTransfer {public static class FixedTransferJob {public static int Calls;public static object InspectFile(object stream){Calls++;return "identity-new";}}}'
function Hash-Stream($Stream){return 'hash-new'}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=12000}};$workMs=12000
$rows=@()
foreach($case in @('deadline','identity','hash')) {
 if($case -cne 'deadline'){$clock.Elapsed.TotalMilliseconds=0}
 $fact=@{stream='fixed';sha256=if($case -ceq 'hash'){'hash-old'}else{'hash-new'};identity=if($case -ceq 'identity'){'identity-old'}else{'identity-new'}}
 $accepted=$false;try{Test-Bindings @($fact);$accepted=$true}catch{}
 $rows+=[ordered]@{case=$case;accepted=$accepted;calls=[AIbrowse.FullTransfer.FixedTransferJob]::Calls}
}
foreach($case in @('zero-samples','unknown-exit','retained','wrong-flags','altered-limit')) {
 $job=[pscustomobject]@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false;LimitsVerified=$true;ExitFailure=$null;Failure=$null;ExitCode=0;Samples=1;CreationFlags=524296;ProcessLimit=1;LimitFlags=0x2308;ProcessCommitLimit=2147483648;JobCommitLimit=2147483648;RssPeakBytes=1;TreeRssPeakBytes=1}
 switch($case){'zero-samples'{$job.Samples=0};'unknown-exit'{$job.ExitFailure='exact-process-exit-unknown'};'retained'{$job.OwnershipRetained=$true};'wrong-flags'{$job.CreationFlags=0x08080000};'altered-limit'{$job.ProcessLimit=2}}
 $accepted=$false;try{Test-NodeJob $job;$accepted=$true}catch{}
 $rows+=[ordered]@{case=$case;accepted=$accepted}
}
$rows|ConvertTo-Json -Compress
`,
    ),
  ) as { case: string; accepted: boolean; calls?: number }[];
  expect(rows).toHaveLength(8);
  expect(rows.every((row) => !row.accepted)).toBe(true);
  expect(rows[0].calls).toBe(0);
});

it('独立核对无参数入口', () => {
  expect(
    JSON.parse(ps('independent-entry', parse + '$ast.ParamBlock.Parameters.Count|ConvertTo-Json')),
  ).toBe(0);
});

it.each([
  { name: 'no-arguments', args: [], accepted: true },
  { name: 'position', args: ['review-position'], accepted: false },
  { name: 'unknown-name', args: ['-ReviewUnknown', 'value'], accepted: false },
  { name: 'common-verbose', args: ['-Verbose'], accepted: false },
  { name: 'common-verbose-false', args: ['-Verbose:$false'], accepted: false },
  { name: 'common-error-action', args: ['-ErrorAction', 'Continue'], accepted: false },
  { name: 'common-out-variable', args: ['-OutVariable', 'reviewOutput'], accepted: false },
])('实际高级脚本前缀参数资格：$name', ({ name, args, accepted }) => {
  const prefix = JSON.parse(
    ps(
      'independent-prefix-extract-' + name,
      parse +
        `
$clockNodes=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$clock'})
if($clockNodes.Count -ne 1 -or $clockNodes[0].Right.Extent.Text -cne '[Diagnostics.Stopwatch]::StartNew()'){throw '入口截断边界变化'}
$ast.Extent.Text.Substring(0,$clockNodes[0].Extent.StartOffset)|ConvertTo-Json -Compress
`,
    ),
  ) as string;
  expect(prefix).not.toContain('$scope');
  expect(prefix).not.toContain('::Execute');
  const target = resolve(evidence, 'real-prefix-' + name + '.ps1');
  const sentinel = 'REVIEW_PREFIX_ACCEPTED_WITHOUT_SCOPE_OR_NATIVE';
  writeFileSync(target, prefix + `\n[Console]::WriteLine('${sentinel}')\n`);
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', target, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 65536,
  });
  writeFileSync(
    resolve(evidence, 'real-prefix-' + name + '.json'),
    JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }, null, 2),
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(accepted ? 0 : 1);
  expect(child.stdout.includes(sentinel)).toBe(accepted);
});

it.each(['on-time', 'late', 'first-failure'] as const)(
  '实际最终回执写入与原工作截止：%s',
  (name) => {
    const output = JSON.parse(
      ps(
        'independent-receipt-deadline-' + name,
        parse +
          `
$outer=$ast.FindAll({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains('$result=[ordered]')},$true)
if($outer.Count -ne 1){throw '被审最终收口不唯一'}
$body=$outer[0].Finally.Extent.Text
$scopeId='review';$ok=${name === 'first-failure' ? '$false' : '$true'};$phase='finish';$failurePhase=${name === 'first-failure' ? "'receipt'" : '$null'};$scopeCreated=$true;$saved=$null;$binding=$null;$job=$null;$locks=@()
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=11999}};$workMs=12000
function Write-New([string]$Name,[string]$Text){$clock.Elapsed.TotalMilliseconds=${name === 'on-time' ? 11999 : 12001}}
. ([scriptblock]::Create($body.Substring(1,$body.Length-2)))
`,
      ),
    ) as { ok: boolean; phase: string; durationMs: number };
    expect(output.ok).toBe(name === 'on-time');
    expect(output.phase).toBe(name === 'first-failure' ? 'receipt' : 'finish');
    if (name !== 'on-time') expect(output.durationMs).toBeGreaterThanOrEqual(12000);
  },
);
