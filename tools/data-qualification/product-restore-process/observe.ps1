[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$startupClock = [Diagnostics.Stopwatch]::StartNew()
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现成PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'SuccessorObserver.cs')
$inspect = [Func[uint32,RestoreSuccessorObserver+Cim]] {
    param([uint32]$CandidateId)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$CandidateId" -ErrorAction Stop
    if ($null -eq $p -or $null -eq $p.CreationDate -or [string]::IsNullOrEmpty($p.ExecutablePath)) { throw 'CIM身份不完整' }
    $result = [RestoreSuccessorObserver+Cim]::new()
    $result.Pid = [uint32]$p.ProcessId
    $result.Created = $p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
    $result.Image = $p.ExecutablePath
    $result.Command = $p.CommandLine
    return $result
}
$observer = $null
try {
    $init = [RestoreSuccessorObserver]::ReadFrame().GetAwaiter().GetResult()
    if ($null -eq $init) { throw '缺少初始化协议' }
    $observer = [RestoreSuccessorObserver]::new($init, $inspect, $startupClock.ElapsedMilliseconds)
    $inputTask = [RestoreSuccessorObserver]::ReadFrame()
    while ($true) {
        foreach ($frame in $observer.DrainFrames()) { [Console]::Out.WriteLine($frame); [Console]::Out.Flush() }
        if ($observer.Terminal) { break }
        if ($inputTask.IsCompleted) {
            $line = $inputTask.GetAwaiter().GetResult()
            if ($null -eq $line) { $observer.Fail('input-closed') }
            else { $observer.Command($line, $inspect); $inputTask = [RestoreSuccessorObserver]::ReadFrame() }
        } else { $observer.Poll($inspect); [Threading.Thread]::Sleep(25) }
    }
} catch {
    if ($null -ne $observer) {
        $observer.Fail('helper-failed')
        foreach ($frame in $observer.DrainFrames()) { [Console]::Out.WriteLine($frame); [Console]::Out.Flush() }
    }
    [Console]::Error.WriteLine('恢复身份观察器失败')
    exit 2
} finally { if ($null -ne $observer) { $observer.Dispose() } }
