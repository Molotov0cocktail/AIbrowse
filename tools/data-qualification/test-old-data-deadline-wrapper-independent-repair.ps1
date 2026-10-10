[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = Join-Path $repository 'log/stage7-e2/old-data-deadline-independent-repair-001'
$candidate = Join-Path $PSScriptRoot 'old-data-deadline/run.ps1'
$text = [IO.File]::ReadAllText($candidate)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '候选PowerShell语法失败' }

# Execute the original parameter/strict-mode/argument prefix only, before any runtime checks.
$boundary = $ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.IfStatementAst] -and
    $_.Extent.Text.StartsWith('if([Environment]::Is64BitProcess')
} | Select-Object -First 1
if ($null -eq $boundary) { throw '入口只读前缀边界缺失' }
$prefix = $text.Substring(0, $boundary.Extent.StartOffset)
if ($prefix.Contains('Add-Type') -or $prefix.Contains('::Execute(')) { throw '前缀包含执行动作' }
$probe = Join-Path $evidence 'candidate-prefix-probe.ps1'
[IO.File]::WriteAllText($probe, $prefix, [Text.UTF8Encoding]::new($false))
$pwsh = (Get-Command pwsh -CommandType Application).Source
$output = & $pwsh -NoProfile -File $probe -ScopeId ('old-data-deadline-' + ('a' * 32)) 2>&1
$prefixExit = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $evidence 'candidate-prefix-probe-output.txt'), ($output | Out-String), [Text.UTF8Encoding]::new($false))

# Isolate the original reuse guard from all native calls and source/artifact preflight.
$guard = $ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.IfStatementAst] -and
    $_.Extent.Text.Contains("'report.json'")
} | Select-Object -First 1
if ($null -eq $guard) { throw '候选scope复用门缺失' }
$campaign = Join-Path $evidence ('receipt-only-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($campaign) | Out-Null
[IO.File]::WriteAllText((Join-Path $campaign 'job-result.json'), '{"version":1,"ok":false,"job":{"Started":true}}', [Text.UTF8Encoding]::new($false))
$reuseRejected = $false
try { & ([ScriptBlock]::Create($guard.Extent.Text)) } catch { $reuseRejected = $true }

$result = [ordered]@{
    schema = 1
    candidateSha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    pureOnly = $true
    jobInvoked = $false
    prefixAccepted = ($prefixExit -eq 0)
    prefixExit = $prefixExit
    priorJobReceiptWithoutRunnerReportRejected = $reuseRejected
}
$json = $result | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $evidence 'wrapper-independent-results.json'), $json, [Text.UTF8Encoding]::new($false))
$json
if ($prefixExit -ne 0 -or -not $reuseRejected) { exit 1 }

