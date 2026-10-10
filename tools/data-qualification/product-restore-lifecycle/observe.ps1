[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$startup = [Diagnostics.Stopwatch]::StartNew()
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现成PowerShell 7' }
Add-Type -Path @((Join-Path $PSScriptRoot '../product-restore-process/SuccessorObserver.cs'), (Join-Path $PSScriptRoot 'Lease.cs'))
$inspect = [Func[uint32,RestoreSuccessorObserver+Cim]] {
    param([uint32]$CandidateId)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$CandidateId" -ErrorAction Stop
    if ($null -eq $p -or $null -eq $p.CreationDate -or [string]::IsNullOrEmpty($p.ExecutablePath)) { throw 'CIM身份不完整' }
    $value = [RestoreSuccessorObserver+Cim]::new()
    $value.Pid = [uint32]$p.ProcessId
    $value.Created = $p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
    $value.Image = $p.ExecutablePath
    $value.Command = $p.CommandLine
    return $value
}
$lease = $null
try {
    $configuration = [RestoreSuccessorObserver]::ReadFrame().GetAwaiter().GetResult()
    if ($null -eq $configuration) { throw '缺少普通退出初始化' }
    $lease = [OrdinaryLifecycleLease]::new($configuration, $inspect, $startup.ElapsedMilliseconds)
    [Console]::Out.WriteLine($lease.ReadyFrame())
    [Console]::Out.Flush()
    while (-not $lease.Poll($inspect)) { [Threading.Thread]::Sleep(25) }
    [Console]::Out.WriteLine($lease.RetiredFrame())
    [Console]::Out.Flush()
} catch {
    [Console]::Error.WriteLine('普通退出观察失败')
    exit 2
} finally { if ($null -ne $lease) { $lease.Dispose() } }
