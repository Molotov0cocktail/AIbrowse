import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function ps(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-native-pure-'));
  roots.push(root);
  const path = join(root, 'test.ps1');
  writeFileSync(path, "$ErrorActionPreference='Stop'\n" + text);
  return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    cwd: resolve('.'),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  });
}
it('两个PS入口原生AST语法有效且不执行Job', () => {
  expect(
    ps(
      `foreach($name in @('run.ps1','qualify-runner.ps1')){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) "tools/data-qualification/full-transfer/$name"),[ref]$tokens,[ref]$errors);if($errors.Count){throw $errors[0]}};'PASS'`,
    ),
  ).toContain('PASS');
});
it('固定tiny原生夹具的实际CSharp正文可编译，未执行Main', () => {
  expect(
    ps(`
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/qualify-runner.ps1'),[ref]$tokens,[ref]$errors)
$assignment=$ast.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$source'},$true)
$source=$assignment.Right.Find({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true).Value
Add-Type -TypeDefinition $source
'PASS'
`),
  ).toContain('PASS');
});
it('编译原生限额纯正负例：严格1/24、2/4GiB，未调用native', () => {
  expect(
    ps(`
$assembly=Join-Path $PSScriptRoot 'job.dll'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/FixedTransferJob.cs'))) -OutputAssembly $assembly
[void][Reflection.Assembly]::LoadFrom($assembly)
if(-not (Test-Path -LiteralPath ([Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location))){throw '编译器未绑定'}
[AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits('import',0x2308,1,2147483648,2147483648)
[AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits('transfer',0x2308,24,2147483648,4294967296)
$rejected=0
foreach($v in @(@('transfer',0x2308,25,2147483648,4294967296),@('transfer',0x2308,24,2147483648,2147483648),@('transfer',0x2300,24,2147483648,4294967296),@('import',0x2308,24,2147483648,2147483648),@('bad',0x2308,24,2147483648,4294967296))) {
try{[AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits($v[0],$v[1],$v[2],$v[3],$v[4])}catch{$rejected++}}
if($rejected -ne 5){throw '限额放宽'};'PASS'
`),
  ).toContain('PASS');
});
for (const kind of ['win32', 'membership'] as const) {
  it(`原采样控制流保留固定${kind}诊断且不回显异常正文，零native调用`, () => {
    const result = JSON.parse(
      ps(`
$source=[IO.File]::ReadAllText((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/FixedTransferJob.cs'))
$declaration='private static extern bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned);'
if(-not $source.Contains($declaration)){throw '原生声明未唯一绑定'}
$replacement='private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) { returned=200; ${kind === 'win32' ? 'throw new Win32Exception(5,"private-path-and-body");' : 'Marshal.WriteInt32(buffer,0,25);Marshal.WriteInt32(buffer,4,24);return true;'} }'
$attribute='[DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)]'
$source=$source.Replace($attribute+[char]10+'        '+$declaration,$replacement).Replace($attribute+[char]13+[char]10+'        '+$declaration,$replacement)
if($source.Contains($declaration)){throw '原采样替身未接线'}
Add-Type -TypeDefinition $source
$owner=[AIbrowse.FullTransfer.FixedTransferJob]
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$contextType=$owner.GetNestedType('NativeDiagnostic',[Reflection.BindingFlags]::NonPublic)
$context=[Activator]::CreateInstance($contextType,$true)
$sampleType=$owner.GetNestedType('Sampled',[Reflection.BindingFlags]::NonPublic)
$dictionaryType=[Collections.Generic.Dictionary\`2].MakeGenericType([uint32],$sampleType)
$held=[Activator]::CreateInstance($dictionaryType)
$result=[AIbrowse.FullTransfer.FixedTransferJob+Result]::new()
try{$null=$owner.GetMethod('SampleJob',$flags).Invoke($null,@($null,$held,$result,$context,[Diagnostics.Stopwatch]::StartNew(),12000));throw '没有拒绝坏采样'}
catch {
  $failure=$_.Exception
  while($failure -is [Management.Automation.MethodInvocationException] -or $failure -is [Reflection.TargetInvocationException]){$failure=$failure.InnerException}
  if($failure -isnot [ComponentModel.Win32Exception] -and $failure -isnot [InvalidOperationException]){throw}
  $null=$owner.GetMethod('RecordNativeFailure',$flags).Invoke($null,@($result,$context,$failure))
}
$result|ConvertTo-Json -Compress
`),
    ) as Record<string, unknown>;
    expect(result.Failure).toBe('native-failed');
    expect(result.Succeeded).toBe(false);
    expect(result.FailureStage).toBe(kind === 'win32' ? 'PidListRead' : 'PidListMembership');
    expect(result.NativeFailureType).toBe(kind === 'win32' ? 'win32' : 'invariant');
    expect(result.NativeErrorCode).toBe(kind === 'win32' ? 5 : 0);
    expect(result.SampleListObserved).toBe(kind === 'membership');
    if (kind === 'membership') {
      expect(result.SampleAssigned).toBe(25);
      expect(result.SampleCount).toBe(24);
    }
    expect(JSON.stringify(result)).not.toContain('private-path-and-body');
  });
}
it('固定输入名单拒绝50th缺失与路径片段，零native启动', () => {
  expect(
    ps(`
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/run.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Check-InputMembers'},$true);Invoke-Expression $fn.Extent.Text
$files=@(@{member='sources/sources.db'},@{member='research/research.db'},@{member='watch/watch.db'},@{member='conversations/index.json'})
for($i=0;$i -lt 50;$i++){$files+=@{member=('conversations/00000000-0000-4000-8000-{0:x12}.json' -f $i)}}
Check-InputMembers @{files=$files}
$rejected=0;try{Check-InputMembers @{files=$files[0..52]}}catch{$rejected++}
$files[53].member='../secret';try{Check-InputMembers @{files=$files}}catch{$rejected++}
if($rejected -ne 2){throw '缺失或逃逸未拒绝'};'PASS'
`),
  ).toContain('PASS');
});
it('回执独占创建且最后关闭仍在原总期限之内', () => {
  const code = readFileSync('tools/data-qualification/full-transfer/run.ps1', 'utf8');
  expect(code.indexOf('$clock=[Diagnostics.Stopwatch]::StartNew()')).toBeLessThan(
    code.indexOf('Add-Type -TypeDefinition'),
  );
  expect(code.lastIndexOf('if($clock.Elapsed.TotalMilliseconds -ge $workMs)')).toBeGreaterThan(
    code.lastIndexOf('$stream.Dispose()'),
  );
  expect(
    ps(`
$clock=[Diagnostics.Stopwatch]::StartNew();$workMs=10000;$locks=[Collections.Generic.List[IO.FileStream]]::new()
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/run.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Check-Time','Write-Receipt')){$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $fn.Extent.Text}
$path=Join-Path $PSScriptRoot 'receipt';Write-Receipt $path @{v=1};$before=[IO.File]::ReadAllBytes($path)
$rejected=$false;try{Write-Receipt $path @{v=2}}catch{$rejected=$true}
if(-not $rejected -or [Convert]::ToHexString($before) -cne [Convert]::ToHexString([IO.File]::ReadAllBytes($path))){throw '覆盖了原件'}
$workMs=0;$rejected=$false;try{Write-Receipt (Join-Path $PSScriptRoot 'late') @{}}catch{$rejected=$true}
if(-not $rejected -or (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'late'))){throw '过期仍写入'};'PASS'
`),
  ).toContain('PASS');
});
it('实际outer finally中Dispose跨deadline使先前completed变失败', () => {
  expect(
    ps(`
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/run.ps1'),[ref]$tokens,[ref]$errors)
$outer=$ast.FindAll({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains('$result.durationMs=')},$true)
if($outer.Count -ne 1){throw '收口未唯一绑定'}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=0}}
$workMs=120000;$result=@{completed=$true;error=$null;durationMs=0};$saved=$null
$stream=New-Object PSObject
$stream|Add-Member ScriptMethod Dispose {$clock.Elapsed.TotalMilliseconds=120001}
$locks=@($stream)
$text=$outer[0].Finally.Extent.Text
& ([scriptblock]::Create($text.Substring(1,$text.Length-2)))
if($result.completed -ne $false -or $result.durationMs -ne 120001){throw '关闭期间超时被忽略'};'PASS'
`),
  ).toContain('PASS');
});
