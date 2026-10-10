[CmdletBinding()]
param([Parameter(Mandatory)][string]$BaselineSource)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Keep the original six red oracles unchanged and execute them first.
. (Join-Path $PSScriptRoot 'test-product-completed-archive-review.ps1') -BaselineSource $BaselineSource
$savedRepository = $env:AIBROWSE_PROFILE_TOOL_REPOSITORY

function Accept-Projection([string]$Name, [scriptblock]$Mutate) {
    $fixture = Make-Fixture
    & $Mutate $fixture
    Write-Dialog $fixture
    $lease = Load $fixture
    try {
        Assert $Name ($null -ne $lease)
        Assert ($Name + '-no-intent') (-not (Test-Path -LiteralPath (Join-Path $fixture.journal 'archive-intent.json')))
    } finally { ([IDisposable]$lease).Dispose() }
}
function Add-Intermediate($Fixture) {
    $projectionHost = $Fixture.dialog.filenameHostStructure.nodes[1]
    $input = $Fixture.dialog.filenameHostStructure.nodes[2]
    $intermediate = Clone $projectionHost
    $intermediate.index = 2; $intermediate.parent = 1; $intermediate.relation = 'descendant'
    $intermediate.automationIdClass = 'other'; $intermediate.windowClass = 'combo-box'; $intermediate.controlTypeClass = 'combo-box'
    $input.index = 3; $input.parent = 2
    $Fixture.dialog.filenameHostStructure.nodes = @($Fixture.dialog.filenameHostStructure.nodes[0], $projectionHost, $intermediate, $input)
    $Fixture.dialog.filenameHostStructure.descendantCount = 2
}

try {
    Accept-Projection 'repair-real-host-other-input-pane' { param($f) $f.dialog.filenameHostStructure.nodes[1].windowClass = 'other' }
    Accept-Projection 'repair-deep-input-under-intermediate' { param($f) Add-Intermediate $f }
    Accept-Projection 'repair-ui-readonly-not-native-oracle' { param($f) $n = $f.dialog.filenameHostStructure.nodes[2]; $n.valuePattern = $true; $n.readOnly = $true }
    Accept-Projection 'repair-noncandidate-id1001-sibling' {
        param($f)
        $extra = Clone $f.dialog.filenameHostStructure.nodes[2]
        $extra.index = 3; $extra.windowClass = 'other'
        $f.dialog.filenameHostStructure.nodes += $extra
        $f.dialog.filenameHostStructure.descendantCount = 2
    }
    Accept-Projection 'repair-max-eight-ancestors-sixteen-descendants' {
        param($f)
        $template = $f.dialog.filenameHostStructure.nodes
        $nodes = @()
        for ($i = 0; $i -lt 8; $i++) {
            $n = Clone $template[0]
            $n.index = $i; $n.parent = $i - 1
            $nodes += $n
        }
        $projectionHost = Clone $template[1]
        $projectionHost.index = 8; $projectionHost.parent = 7; $projectionHost.windowClass = 'other'; $nodes += $projectionHost
        for ($i = 9; $i -le 24; $i++) {
            $n = Clone $template[2]
            $n.index = $i; $n.parent = if ($i -lt 17) { 8 } else { 9 }
            if ($i -ne 24) { $n.automationIdClass = 'other'; $n.windowClass = 'other' }
            $nodes += $n
        }
        $f.dialog.filenameHostStructure.nodes = $nodes
        $f.dialog.filenameHostStructure.ancestorCount = 8
        $f.dialog.filenameHostStructure.descendantCount = 16
    }
    Reject 'repair-two-native-candidates' {
        param($f)
        $extra = Clone $f.dialog.filenameHostStructure.nodes[2]
        $extra.index = 3
        $f.dialog.filenameHostStructure.nodes += $extra
        $f.dialog.filenameHostStructure.descendantCount = 2
        Write-Dialog $f
    }
    Reject 'repair-extra-host-automation-id' {
        param($f)
        Add-Intermediate $f
        $f.dialog.filenameHostStructure.nodes[2].automationIdClass = 'file-name-control-host'
        Write-Dialog $f
    }
    Reject 'repair-host-wrong-process' { param($f) $f.dialog.filenameHostStructure.nodes[1].sameProcess = $false; Write-Dialog $f }
    Reject 'repair-host-disabled' { param($f) $f.dialog.filenameHostStructure.nodes[1].enabled = $false; Write-Dialog $f }
    Reject 'repair-host-offscreen' { param($f) $f.dialog.filenameHostStructure.nodes[1].offscreen = $true; Write-Dialog $f }
    Reject 'repair-deep-descendant-escapes-host' { param($f) Add-Intermediate $f; $f.dialog.filenameHostStructure.nodes[2].parent = 0; Write-Dialog $f }
    Reject 'repair-host-detached-from-ancestor-chain' {
        param($f)
        $ancestor = Clone $f.dialog.filenameHostStructure.nodes[0]
        $ancestor.index = 1; $ancestor.parent = 0
        $projectionHost = $f.dialog.filenameHostStructure.nodes[1]; $projectionHost.index = 2; $projectionHost.parent = 0
        $input = $f.dialog.filenameHostStructure.nodes[2]; $input.index = 3; $input.parent = 2
        $f.dialog.filenameHostStructure.nodes = @($f.dialog.filenameHostStructure.nodes[0], $ancestor, $projectionHost, $input)
        $f.dialog.filenameHostStructure.ancestorCount = 2
        Write-Dialog $f
    }
    Reject 'repair-descendant-relation-forged' { param($f) $f.dialog.filenameHostStructure.nodes[2].relation = 'ancestor'; Write-Dialog $f }
    Reject 'repair-candidate-count-contradiction' { param($f) $f.dialog.filenameNativeSelection.candidates = 2; Write-Dialog $f }
    Reject 'repair-no-native-edit-class' { param($f) $f.dialog.filenameHostStructure.nodes[2].windowClass = 'other'; Write-Dialog $f }
    Reject 'repair-host-count-contradiction' { param($f) $f.dialog.filenameHostStructure.hostCount = 2; Write-Dialog $f }
    $failed = @($results | Where-Object { -not $_.pass })
    Write-Output ('修复差量作者回归：' + $results.Count + '项，失败' + $failed.Count + '；' + $runRoot)
    if ($failed.Count -gt 0) { throw '修复差量未闭合；全部原件保留' }
} finally { $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $savedRepository }
