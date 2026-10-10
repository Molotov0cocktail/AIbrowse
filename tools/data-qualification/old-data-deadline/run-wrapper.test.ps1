[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$evidence=Join-Path $repository 'log/stage7-e2/old-data-deadline-repair-001'
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$candidate=Join-Path $PSScriptRoot 'run.ps1'
$text=[IO.File]::ReadAllText($candidate)
$tokens=$null
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '候选PowerShell语法失败'}
$statements=@($ast.EndBlock.Statements)

$boundary=$statements|Where-Object {$_.Extent.Text.StartsWith('if([Environment]::Is64BitProcess')}|Select-Object -First 1
if($null -eq $boundary){throw '入口参数前缀边界缺失'}
$prefix=$text.Substring(0,$boundary.Extent.StartOffset)
$prefixPath=Join-Path $evidence 'repair-prefix-probe.ps1'
[IO.File]::WriteAllText($prefixPath,$prefix,[Text.UTF8Encoding]::new($false))
$pwsh=(Get-Command pwsh -CommandType Application|Select-Object -First 1).Source
$validScope='old-data-deadline-'+('a'*32)
& $pwsh -NoProfile -File $prefixPath -ScopeId $validScope *> (Join-Path $evidence 'prefix-valid.txt')
$validExit=$LASTEXITCODE
& $pwsh -NoProfile -File $prefixPath -ScopeId invalid *> (Join-Path $evidence 'prefix-invalid.txt')
$invalidExit=$LASTEXITCODE
& $pwsh -NoProfile -File $prefixPath -ScopeId $validScope -Extra forbidden *> (Join-Path $evidence 'prefix-extra.txt')
$extraExit=$LASTEXITCODE

$guard=$statements|Where-Object {$_.Extent.Text.Contains("'report.json'") -and $_.Extent.Text.Contains("'job-result.json'") -and $_.Extent.Text.Contains("'run-claim.json'")}|Select-Object -First 1
if($null -eq $guard){throw '三种scope消费证据门缺失'}
$guardIndex=[Array]::IndexOf($statements,$guard)
$claimTry=$statements|Select-Object -Skip ($guardIndex+1)|Where-Object {$_.Extent.Text.Contains('$claimStream.Flush($true)')}|Select-Object -First 1
if($null -eq $claimTry){throw '持久claim写入缺失'}
$claimBody=$text.Substring($guard.Extent.StartOffset,$claimTry.Extent.EndOffset-$guard.Extent.StartOffset)
if(-not $claimBody.Contains('[IO.FileMode]::CreateNew')){throw '原子一次性claim缺失'}
$claimProbe=Join-Path $evidence 'repair-claim-probe.ps1'
$probeText="param([string]`$campaign,[string]`$ScopeId)`n`$ErrorActionPreference='Stop'`nSet-StrictMode -Version Latest`n`$claimPath=Join-Path `$campaign 'run-claim.json'`n`$reportPath=Join-Path `$campaign 'report.json'`n`$receiptPath=Join-Path `$campaign 'job-result.json'`n$claimBody"
[IO.File]::WriteAllText($claimProbe,$probeText,[Text.UTF8Encoding]::new($false))

$receiptOnly=Join-Path $evidence ('receipt-only-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($receiptOnly)|Out-Null
[IO.File]::WriteAllText((Join-Path $receiptOnly 'job-result.json'),'{}',[Text.UTF8Encoding]::new($false))
& $pwsh -NoProfile -File $claimProbe -campaign $receiptOnly -ScopeId $validScope *> (Join-Path $receiptOnly 'probe.txt')
$receiptExit=$LASTEXITCODE

$race=Join-Path $evidence ('claim-race-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($race)|Out-Null
$one=Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-File',$claimProbe,'-campaign',$race,'-ScopeId',$validScope) -PassThru -WindowStyle Hidden
$two=Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-File',$claimProbe,'-campaign',$race,'-ScopeId',$validScope) -PassThru -WindowStyle Hidden
$one.WaitForExit()
$two.WaitForExit()
$raceExits=@($one.ExitCode,$two.ExitCode)|Sort-Object
$claim=Get-Content -LiteralPath (Join-Path $race 'run-claim.json') -Raw|ConvertFrom-Json

$result=[ordered]@{
    schema=1
    pureOnly=$true
    jobInvoked=$false
    validScopeAccepted=($validExit -eq 0)
    invalidScopeRejected=($invalidExit -ne 0)
    extraArgumentRejected=($extraExit -ne 0)
    priorReceiptRejected=($receiptExit -ne 0)
    raceExitCodes=$raceExits
    concurrentClaimExactlyOnce=($raceExits.Count -eq 2 -and $raceExits[0] -eq 0 -and $raceExits[1] -ne 0)
    claimBound=($claim.version -eq 1 -and $claim.scopeId -ceq $validScope -and $claim.consumed -eq $true)
}
$json=$result|ConvertTo-Json -Depth 3
[IO.File]::WriteAllText((Join-Path $evidence 'wrapper-repair-results.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if(-not ($result.validScopeAccepted -and $result.invalidScopeRejected -and $result.extraArgumentRejected -and $result.priorReceiptRejected -and $result.concurrentClaimExactlyOnce -and $result.claimBound)){exit 1}
