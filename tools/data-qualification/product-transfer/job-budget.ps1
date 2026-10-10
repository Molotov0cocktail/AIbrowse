[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunId,[Parameter(Mandatory)][uint32]$RunnerId,[Parameter(Mandatory)][string]$Executable,[Parameter(Mandatory)][string]$Output,[switch]$Apply)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Write-ExclusiveReceipt([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 5))
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

Add-Type -Path (Join-Path $PSScriptRoot 'JobBudget.cs')
$sample=[ProductTransferJobBudget]::Inspect($RunId,$Apply.IsPresent,$RunnerId)
try {
    $members=$sample.Processes
    $runnerImage=($members | Where-Object Pid -eq $RunnerId).Image
    $probeImage=($members | Where-Object Pid -eq $PID).Image
    $guardian=[IO.Path]::Combine([IO.Path]::GetDirectoryName($Executable),'resources','lifecycle-guardian','guardian.exe')
    $conhost=[IO.Path]::Combine($env:SystemRoot,'System32','conhost.exe')
    $counts=@{ main=0; guardian=0; chromium=0; utility=0; tools=0 }
    foreach($member in $members) {
        $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($member.Pid)" -ErrorAction Stop
        if($null -eq $p -or $null -eq $p.CreationDate -or [string]::IsNullOrEmpty($p.ExecutablePath)) { throw 'Job进程CIM身份不可用' }
        [ProductTransferJobBudget]::ValidateIdentity($member.Pid,$member.CreatedFileTime,$member.Image,[uint32]$p.ProcessId,$p.CreationDate.ToUniversalTime().ToFileTimeUtc(),$p.ExecutablePath)
        if($member.Image -ieq $guardian) { $counts.guardian++ }
        elseif($member.Image -ieq $Executable) {
            if([string]::IsNullOrEmpty($p.CommandLine)) { throw '产品进程参数不可核验' }
            if($p.CommandLine -match '(?:^|\s)--type=utility(?:\s|$)') { $counts.utility++ }
            elseif($p.CommandLine -match '(?:^|\s)--type=(?:renderer|gpu-process|crashpad-handler)(?:\s|$)') { $counts.chromium++ }
            elseif($p.CommandLine -notmatch '(?:^|\s)--type=') { $counts.main++ }
            else { throw '发现未登记的产品进程类型' }
        } elseif($member.Image -ieq $runnerImage -or $member.Image -ieq $probeImage -or $member.Image -ieq $conhost) { $counts.tools++ }
        else { throw 'Job出现未知实体程序' }
    }
    if($counts.main -gt 1 -or $counts.guardian -gt 1 -or $counts.chromium -gt 16 -or $counts.utility -gt 2 -or $counts.tools -gt 4) { throw '产品进程角色计数超预算' }
    $sample.Verify()
    Write-ExclusiveReceipt $Output @{version=1;hardTotalLimit=$sample.ActiveProcessLimit;limitFlags=$sample.LimitFlags;sampledCounts=$counts;total=$members.Count;identities=$members}
} finally { $sample.Dispose() }
