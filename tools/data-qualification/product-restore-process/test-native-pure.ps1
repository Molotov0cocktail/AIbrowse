[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Compile and exercise pure predicates only; no observer session or native process is opened.
Add-Type -Path (Join-Path $PSScriptRoot 'SuccessorObserver.cs')
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'observe.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'helper语法无效' }
$script:cases = 0
function Reject([scriptblock]$Body) {
    $rejected = $false
    try { & $Body } catch { $rejected = $true }
    if (-not $rejected) { throw '反例未拒绝' }
    $script:cases++
}
[RestoreSuccessorObserver]::ValidateRoles(1,2,16,1,4,$true)
$script:cases++
Reject { [RestoreSuccessorObserver]::ValidateRoles(1,3,0,0,1,$true) }
Reject { [RestoreSuccessorObserver]::ValidateRoles(1,2,0,0,1,$false) }
Reject { [RestoreSuccessorObserver]::ValidateRoles(2,1,0,0,1,$true) }
Reject { [RestoreSuccessorObserver]::ValidateRoles(1,2,16,2,4,$true) }
Reject { [RestoreSuccessorObserver]::ValidateRoles(1,1,0,0,5,$false) }
[RestoreSuccessorObserver]::ValidateRoles(0,1,0,0,1,$false)
$script:cases++
$cim = [RestoreSuccessorObserver+Cim]::new()
$cim.Pid = 10
$cim.Created = '133000000000000000'
$cim.Image = 'D:\synthetic\AIbrowse.exe'
[RestoreSuccessorObserver]::ValidateCim(10,'133000000000000009','D:\synthetic\AIbrowse.exe',$cim)
$script:cases++
Reject { [RestoreSuccessorObserver]::ValidateCim(10,'133000000000000010','D:\synthetic\AIbrowse.exe',$cim) }
Reject { [RestoreSuccessorObserver]::ValidateCim(11,'133000000000000000','D:\synthetic\AIbrowse.exe',$cim) }
Reject { [RestoreSuccessorObserver]::ValidateCim(10,'133000000000000000','D:\other\AIbrowse.exe',$cim) }
Write-Output "原生源码编译与 $script:cases 项纯谓词检查通过；未创建观察session、产品、Job或UI。"
