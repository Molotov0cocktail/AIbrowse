[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = Join-Path $repository 'log/stage7-e2/old-data-deadline-independent-repair-001'
$candidate = Join-Path $PSScriptRoot 'old-data-deadline/run.ps1'
$source = [IO.File]::ReadAllText($candidate)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '候选PS解析失败' }
$statements = @($ast.EndBlock.Statements)
$guard = $statements | Where-Object {
    $_ -is [Management.Automation.Language.IfStatementAst] -and
    $_.Extent.Text.Contains("'report.json'") -and $_.Extent.Text.Contains("'run-claim.json'")
} | Select-Object -First 1
$claimTry = $statements | Where-Object {
    $_ -is [Management.Automation.Language.TryStatementAst] -and
    $_.Extent.Text.Contains('$claimStream.Flush($true)')
} | Select-Object -First 1
if ($null -eq $guard -or $null -eq $claimTry) { throw 'claim闭合片段缺失' }
$claimBody = $source.Substring($guard.Extent.StartOffset, $claimTry.Extent.EndOffset - $guard.Extent.StartOffset)
if ($claimBody.Contains('Add-Type') -or $claimBody.Contains('::Execute(')) { throw '纯探针包含实际执行动作' }
$claimTail = $source.Substring($guard.Extent.EndOffset, $claimTry.Extent.EndOffset - $guard.Extent.EndOffset)
$header = @'
param([string]$campaign,[string]$ScopeId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$claimPath=Join-Path $campaign 'run-claim.json'
'@
$probe = Join-Path $evidence 'independent-claim-probe.ps1'
[IO.File]::WriteAllText($probe, $header + "`n" + $claimBody, [Text.UTF8Encoding]::new($false))
$pwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
$scope = 'old-data-deadline-' + ('b' * 32)
$checks = [Collections.Generic.List[object]]::new()

foreach ($marker in @('run-claim.json','report.json','job-result.json')) {
    $campaign = Join-Path $evidence ('marker-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($campaign) | Out-Null
    [IO.File]::WriteAllText((Join-Path $campaign $marker), '{}')
    & $pwsh -NoProfile -File $probe -campaign $campaign -ScopeId $scope *> (Join-Path $campaign 'probe.txt')
    $checks.Add([pscustomobject]@{ name = "existing-$marker"; pass = ($LASTEXITCODE -ne 0) })
}

$fresh = Join-Path $evidence ('fresh-claim-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fresh) | Out-Null
& $pwsh -NoProfile -File $probe -campaign $fresh -ScopeId $scope *> (Join-Path $fresh 'first.txt')
$firstExit = $LASTEXITCODE
$claimPath = Join-Path $fresh 'run-claim.json'
$firstHash = (Get-FileHash -LiteralPath $claimPath -Algorithm SHA256).Hash
$claim = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
$checks.Add([pscustomobject]@{ name = 'fresh-claim-exact-payload'; pass = ($firstExit -eq 0 -and $claim.version -eq 1 -and $claim.scopeId -ceq $scope -and $claim.consumed -eq $true -and @($claim.PSObject.Properties).Count -eq 3) })
& $pwsh -NoProfile -File $probe -campaign $fresh -ScopeId $scope *> (Join-Path $fresh 'second.txt')
$checks.Add([pscustomobject]@{ name = 'replay-rejected-original-preserved'; pass = ($LASTEXITCODE -ne 0 -and (Get-FileHash -LiteralPath $claimPath -Algorithm SHA256).Hash -ceq $firstHash) })

# Force both callers past the original read-only guard before either CreateNew.
$barrier = @'
[IO.File]::WriteAllText((Join-Path $campaign ('ready-' + $PID)), 'ready')
$timer=[Diagnostics.Stopwatch]::StartNew()
while (@([IO.Directory]::GetFiles($campaign,'ready-*')).Count -ne 2) {
    if ($timer.ElapsedMilliseconds -gt 5000) { throw '纯探针会合超时' }
    Start-Sleep -Milliseconds 10
}
'@
$raceProbe = Join-Path $evidence 'independent-claim-race-probe.ps1'
[IO.File]::WriteAllText($raceProbe, $header + "`n" + $guard.Extent.Text + "`n" + $barrier + "`n" + $claimTail, [Text.UTF8Encoding]::new($false))
$race = Join-Path $evidence ('claim-race-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($race) | Out-Null
$children = @()
for ($index=0; $index -lt 2; $index++) {
    $children += Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-File',$raceProbe,'-campaign',$race,'-ScopeId',$scope) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $race "out-$index.txt") -RedirectStandardError (Join-Path $race "err-$index.txt")
}
try {
    foreach ($child in $children) {
        if (-not $child.WaitForExit(10000)) { $child.Kill(); throw '纯claim子进程未按期退出' }
    }
    $exits = @($children | ForEach-Object { $_.ExitCode } | Sort-Object)
    $checks.Add([pscustomobject]@{ name = 'both-guards-passed-atomic-create-exactly-once'; pass = ($exits[0] -eq 0 -and $exits[1] -ne 0 -and @([IO.Directory]::GetFiles($race,'ready-*')).Count -eq 2) })
} finally { foreach ($child in $children) { $child.Dispose() } }

$prefix = Join-Path $evidence 'candidate-prefix-probe.ps1'
& $pwsh -NoProfile -File $prefix -ScopeId 'invalid' *> (Join-Path $evidence 'invalid-scope-prefix.txt')
$checks.Add([pscustomobject]@{ name = 'invalid-scope-rejected'; pass = ($LASTEXITCODE -ne 0) })
& $pwsh -NoProfile -File $prefix -ScopeId $scope -Extra 'forbidden' *> (Join-Path $evidence 'extra-argument-prefix.txt')
$checks.Add([pscustomobject]@{ name = 'extra-argument-rejected'; pass = ($LASTEXITCODE -ne 0) })

$result = [ordered]@{ version=1; pureOnly=$true; jobInvoked=$false; checks=$checks.ToArray(); raceExitCodes=$exits }
$json = $result | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $evidence 'claim-independent-results.json'), $json, [Text.UTF8Encoding]::new($false))
$json
if (@($checks | Where-Object {-not $_.pass}).Count -ne 0) { exit 1 }
