[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^old-data-deadline-[a-f0-9]{32}$')][string]$ScopeId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$campaign=Join-Path $repository "log/stage7-e2/$ScopeId"
$runner=Join-Path $campaign 'runner.cjs'
$helper=Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs'
$runId=$ScopeId.Substring($ScopeId.Length-32)
$proofPath=Join-Path $campaign 'build-proof.json'
$worker=Join-Path $campaign 'worker.cjs'
$runtimeProof=Join-Path $campaign 'runtime-proof.json'
$claimPath=Join-Path $campaign 'run-claim.json'
$reportPath=Join-Path $campaign 'report.json'
$receiptPath=Join-Path $campaign 'job-result.json'
$result=$null
$ok=$false

if([Environment]::Is64BitProcess -ne $true -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw '仅支持Windows x64'}
$campaignInfo=Get-Item -LiteralPath $campaign -Force
if(-not $campaignInfo.PSIsContainer -or ($campaignInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '资格scope目录无效'}
if((Test-Path -LiteralPath (Join-Path $campaign 'run-claim.json')) -or (Test-Path -LiteralPath (Join-Path $campaign 'report.json')) -or (Test-Path -LiteralPath (Join-Path $campaign 'job-result.json'))){throw '资格scope已消费，禁止复用'}
$claim=[ordered]@{version=1;scopeId=$ScopeId;consumed=$true}|ConvertTo-Json -Compress
$claimBytes=[Text.UTF8Encoding]::new($false).GetBytes($claim)
if($claimBytes.Length -gt 4096){throw '运行scope一次性标记超限'}
$claimStream=[IO.File]::Open($claimPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {
    $claimStream.Write($claimBytes,0,$claimBytes.Length)
    $claimStream.Flush($true)
} finally {$claimStream.Dispose()}
$node=(Get-Command node -CommandType Application|Select-Object -First 1).Source
if((& $node --version) -cne 'v24.18.0'){throw '固定Node版本不符'}
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -cne '9A4EB5F1C29C6A2E93852EAD46B999E284A6A5CA8BAB4D4E241D587D025A52DE'){throw '固定Node身份不符'}
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -cne 'BE1FBF5623AE06DA19848F33C5837C1C3CA42827935961D99453A1397CBCD167'){throw '固定Job helper身份不符'}
foreach($path in @($runner,$worker,$runtimeProof,$proofPath)){if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'build-only制品不完整'}}
$proofFile=Get-Item -LiteralPath $proofPath
if($proofFile.Length -lt 2 -or $proofFile.Length -gt 262144 -or ($proofFile.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'build proof文件无效'}
$proof=Get-Content -LiteralPath $proofPath -Raw|ConvertFrom-Json
if($proof.version -ne 1 -or $proof.kind -cne 'old-data-deadline-build' -or $proof.scopeId -cne $ScopeId -or $proof.nodeVersion -cne 'v24.18.0' -or $proof.node.sha256 -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de' -or $proof.fixedJobSha256 -cne 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167' -or $proof.productE2Pass -ne $false){throw 'build proof合同不符'}
foreach($pair in @(@($runner,$proof.runner),@($worker,$proof.worker),@($runtimeProof,$proof.runtimeProof))){
    if(-not [IO.Path]::GetFullPath($pair[0]).Equals([IO.Path]::GetFullPath($pair[1].path),[StringComparison]::OrdinalIgnoreCase)){throw '制品路径身份不符'}
    if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1].sha256){throw '制品字节身份不符'}
}
$helperSource=@($proof.sources|Where-Object {$_.path -and [IO.Path]::GetFullPath($_.path).Equals([IO.Path]::GetFullPath($helper),[StringComparison]::OrdinalIgnoreCase)})
if($helperSource.Count -ne 1 -or $helperSource[0].sha256 -cne 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167'){throw 'Job helper来源绑定不符'}
try {
    if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须使用新的PowerShell进程'}
    Add-Type -Path $helper
    $result=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('transfer',$node,$runner,$ScopeId,$campaign,$runId,360000)
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits('transfer',$result.LimitFlags,$result.ProcessLimit,$result.ProcessCommitLimit,$result.JobCommitLimit)
    if(-not $result.Succeeded -or -not $result.ActualZero -or $result.OwnershipRetained -or -not $result.LimitsVerified -or $result.ExitCode -ne 0){throw '固定Job执行、资源门或实际退出不完整'}
    $report=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json
    if($report.status -cne 'PASS' -or $report.claims.fileProtocolOldDeadline -ne $true -or $report.claims.e2Complete -ne $false){throw '资格报告未闭合'}
    $ok=$true
} finally {
    $receipt=[ordered]@{
        version=1
        ok=$ok
        job=$result
        fixedHelperSha256='be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167'
        productE2Pass=$false
    }|ConvertTo-Json -Depth 12
    if([Text.Encoding]::UTF8.GetByteCount($receipt) -gt 65536){throw 'Job回执超限'}
    $stream=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes($receipt)
        $stream.Write($bytes,0,$bytes.Length)
        $stream.Flush($true)
    } finally {$stream.Dispose()}
}
[pscustomobject]@{scope=$ScopeId;ok=$ok;actualZero=$result.ActualZero;productE2Pass=$false}|ConvertTo-Json -Compress
if(-not $ok){exit 2}
