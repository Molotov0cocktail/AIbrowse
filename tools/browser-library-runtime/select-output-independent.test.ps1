[CmdletBinding()]
param([string]$CrashTool = '', [string]$CrashReview = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidenceRoot = Join-Path $repository 'log/browser-settings-20261012'

# The child only runs an isolated synthetic repository, never the selected output.
if ($CrashTool -ne '') {
  foreach ($path in @($CrashTool, $CrashReview)) {
    if (-not [IO.Path]::GetFullPath($path).StartsWith($evidenceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '中断子进程仅接受合成目录' }
  }
  function Get-Process { param([string[]]$Name, [string]$ErrorAction) }
  & $CrashTool -Action Switch -ReviewRecord $CrashReview
  throw '合成中断未触发'
}

$run = Join-Path $evidenceRoot ('output-selection-independent-' + [Guid]::NewGuid().ToString('N'))
$checks = [Collections.Generic.List[string]]::new()
$global:AIbrowseOutputSelectionSyntheticProcess = ''
$helperPath = Join-Path $PSScriptRoot 'select-output.test.ps1'
$parseTokens = $null; $parseErrors = $null
$helperAst = [Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '合成夹具解析失败' }
# Reuse fixture construction; failure injection and recovery assertions are independent.
foreach ($name in @('Need', 'WriteText', 'Save', 'Fact', 'Inventory', 'Same', 'InvokeFixtureGit', 'Get-Process', 'Rebind', 'Fixture', 'Reject')) {
  $definitions = @($helperAst.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name })
  if ($definitions.Count -ne 1) { throw '合成夹具定义不唯一' }
  . ([ScriptBlock]::Create($definitions[0].Extent.Text))
}
$sourcePath = Join-Path $PSScriptRoot 'select-output.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$sourceSha256 = (Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant()
$realOutputBefore = Inventory (Join-Path $repository 'output')
$oldMove = '[IO.Directory]::Move($output, $backup); $oldMoved = $true'
$newMove = '[IO.Directory]::Move($staging, $output); $newMoved = $true'
Need ($source.Contains($oldMove) -and $source.Contains($newMove)) '独立注入锚点失效'

try {
  Fixture 'failure-after-candidate-move' ($source.Replace($newMove, ($newMove + "; throw '独立合成：新目录移动后失败'")))
  $candidate = (& $tool -ReviewRecord $reviewPath | ConvertFrom-Json -AsHashtable).candidate.files
  Reject '新目录已移动后异常恢复完整旧树' { & $tool -Action Switch -ReviewRecord $reviewPath }
  $failurePaths = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File -Filter 'failure-*.json')
  Need ($failurePaths.Count -eq 1) '异常回执不唯一'
  $failure = Get-Content -LiteralPath $failurePaths[0].FullName -Raw | ConvertFrom-Json -AsHashtable
  Need ($failure.oldMoved -and $failure.newMoved -and $failure.originalUntouchedOrRestored -and $null -eq $failure.rollbackError) '新树后异常回退状态错误'
  $retained = @(Get-ChildItem -LiteralPath $failurePaths[0].DirectoryName -Directory | Where-Object { $_.Name.StartsWith('rolled-back-candidate-') })
  Need ($retained.Count -eq 1) '回退未保留新树'
  Same $candidate (Inventory $retained[0].FullName)
  $checks.Add('新树后异常保留新树逐文件字节和失败回执')

  $corruption = '; [IO.File]::WriteAllText((Join-Path $backup ''old.exe''), ''独立合成：已破坏的备份''); throw ''独立合成：备份损坏后失败'''
  Fixture 'damaged-backup' ($source.Replace($newMove, ($newMove + $corruption)))
  $candidate = (& $tool -ReviewRecord $reviewPath | ConvertFrom-Json -AsHashtable).candidate.files
  $rejected = $false
  try { & $tool -Action Switch -ReviewRecord $reviewPath | Out-Null } catch { $rejected = $true }
  Need $rejected '备份损坏未拒绝'
  Same $candidate (Inventory $output)
  $failurePaths = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File -Filter 'failure-*.json')
  Need ($failurePaths.Count -eq 1) '损坏备份回执不唯一'
  $failure = Get-Content -LiteralPath $failurePaths[0].FullName -Raw | ConvertFrom-Json -AsHashtable
  Need (-not $failure.originalUntouchedOrRestored -and $failure.rollbackError -is [string]) '损坏备份误报回退成功'
  $plan = Get-Content -LiteralPath (Join-Path $failurePaths[0].DirectoryName 'plan.json') -Raw | ConvertFrom-Json -AsHashtable
  $damagedBefore = Inventory $plan.backup
  $rejected = $false
  try { & $tool -Action Rollback -SwitchId $plan.id | Out-Null } catch { $rejected = $true }
  Need $rejected '显式回退未拒绝已坏备份'
  Same $candidate (Inventory $output); Same $damagedBefore (Inventory $plan.backup)
  $checks.Add('备份损坏拒绝自动及显式回退，保留两树且不谎报成功')

  foreach ($point in @(@{ name = 'after-old'; anchor = $oldMove }, @{ name = 'after-new'; anchor = $newMove })) {
    Fixture ('crash-' + $point.name) ($source.Replace($point.anchor, ($point.anchor + '; [Environment]::Exit(77)')))
    $candidate = (& $tool -ReviewRecord $reviewPath | ConvertFrom-Json -AsHashtable).candidate.files
    $childLog = Join-Path $fixture 'log/crash-child.log'
    & pwsh -NoProfile -File $PSCommandPath -CrashTool $tool -CrashReview $reviewPath *> $childLog
    Need ($LASTEXITCODE -eq 77) '真实子进程未按注入点中断'
    $plans = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File -Filter 'plan.json')
    Need ($plans.Count -eq 1) '中断后落盘计划不唯一'
    $plan = Get-Content -LiteralPath $plans[0].FullName -Raw | ConvertFrom-Json -AsHashtable
    Same $old (Inventory $plan.backup)
    if ($point.name -ceq 'after-old') {
      Need (-not (Test-Path -LiteralPath $output)) '旧目录移动后目标应空缺'
      Same $candidate (Inventory $plan.staging)
    } else { Same $candidate (Inventory $output) }
    $rolled = & $tool -Action Rollback -SwitchId $plan.id | ConvertFrom-Json -AsHashtable
    Need $rolled.restored '中断后显式回退失败'
    Same $old (Inventory $output)
    if ($point.name -ceq 'after-new') {
      $retained = @(Get-ChildItem -LiteralPath $plans[0].DirectoryName -Directory | Where-Object { $_.Name.StartsWith('rolled-back-candidate-') })
      Need ($retained.Count -eq 1) '中断回退未保留新树'
      Same $candidate (Inventory $retained[0].FullName)
    } else { Same $candidate (Inventory $plan.staging) }
    & $tool -Action Rollback -SwitchId $plan.id | Out-Null
    Same $old (Inventory $output)
    $checks.Add('真实子进程中断后完整回退、候选保留及幂等：' + $point.name)
  }
  Same $realOutputBefore (Inventory (Join-Path $repository 'output'))
  $checks.Add('真实 output 全部文件未变化')
  $result = @{ passed = $true; scope = 'independent-synthetic-output-selection'; productLaunched = $false; candidateToolSha256 = $sourceSha256; testSha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant(); count = $checks.Count; checks = $checks.ToArray(); retained = $run }
  Save (Join-Path $run 'result.json') $result
  $result | ConvertTo-Json -Depth 5
} catch {
  Save (Join-Path $run 'failure.json') @{ passed = $false; checks = $checks.ToArray(); error = $_.Exception.Message; stack = $_.ScriptStackTrace; candidateToolSha256 = $sourceSha256 }
  throw
}
