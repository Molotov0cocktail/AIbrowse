[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Only compile and exercise the actual retirement predicate; no native session is opened.
Add-Type -Path @((Join-Path $PSScriptRoot '../product-restore-process/SuccessorObserver.cs'), (Join-Path $PSScriptRoot 'Lease.cs'))
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
if (-not [OrdinaryLifecycleLease]::CanRetire($true,0,$true,0,$true,0)) { throw '完整退休未接纳' }
$script:cases++
if ([OrdinaryLifecycleLease]::CanRetire($false,$null,$true,0,$true,0)) { throw '未signal被接纳' }
$script:cases++
if ([OrdinaryLifecycleLease]::CanRetire($true,0,$false,$null,$true,0)) { throw 'guardian未signal被接纳' }
$script:cases++
if ([OrdinaryLifecycleLease]::CanRetire($true,0,$true,0,$true,1)) { throw '残留产品被接纳' }
$script:cases++
Reject { [OrdinaryLifecycleLease]::CanRetire($true,1,$true,0,$true,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,0,$true,1,$true,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,$null,$true,0,$true,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,0,$true,$null,$true,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($false,0,$true,0,$true,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,0,$true,0,$false,0) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,0,$true,0,$true,-1) }
Reject { [OrdinaryLifecycleLease]::CanRetire($true,0,$true,0,$true,25) }
Write-Output "原生源码编译与 $script:cases 项实际退休谓词检查通过；未创建观察session、产品、Job或UI。"
