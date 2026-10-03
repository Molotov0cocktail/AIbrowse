[CmdletBinding()]
param(
    [ValidateSet('Cancel', 'Confirm', 'Duplicate')][string]$Mode = 'Cancel'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'ProductWindow.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ProductAccessibleAction.cs')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AIbrowseMsaaProbe
{
    public sealed class OpenResult
    {
        public int HResult { get; set; }
        public object Accessible { get; set; }
    }

    [DllImport("oleacc.dll")]
    static extern int AccessibleObjectFromWindow(
        IntPtr window,
        uint objectId,
        ref Guid interfaceId,
        out IntPtr accessible);

    public static OpenResult Open(IntPtr window, int objectId)
    {
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IntPtr pointer;
        int result = AccessibleObjectFromWindow(window, unchecked((uint)objectId), ref iid, out pointer);
        if (pointer == IntPtr.Zero) return new OpenResult { HResult = result, Accessible = null };
        try { return new OpenResult { HResult = result, Accessible = Marshal.GetObjectForIUnknown(pointer) }; }
        finally { Marshal.Release(pointer); }
    }
}
'@
function Get-MsaaObservation([IntPtr]$Window, [int32]$ObjectId) {
    $open = [AIbrowseMsaaProbe]::Open($Window, $ObjectId)
    if ($null -eq $open.Accessible) {
        return [ordered]@{ objectId = $ObjectId; hresult = $open.HResult; objectReturned = $false; error = 'MSAA未返回对象' }
    }
    $accessible = $open.Accessible
    $type = $accessible.GetType()
    try {
        $childCount = [int]$type.InvokeMember('accChildCount', [Reflection.BindingFlags]::GetProperty, $null, $accessible, $null)
    } catch {
        return [ordered]@{ objectId = $ObjectId; hresult = $open.HResult; objectReturned = $true; error = $_.Exception.Message }
    }
    if ($childCount -lt 0 -or $childCount -gt 16) { throw "MSAA子项数量越界：$childCount" }
    $items = @()
    foreach ($childId in 0..$childCount) {
        $item = [ordered]@{ childId = $childId }
        foreach ($property in @('accName', 'accRole', 'accState', 'accDefaultAction')) {
            try {
                $item[$property] = $type.InvokeMember($property, [Reflection.BindingFlags]::GetProperty, $null, $accessible, @([object]$childId))
            } catch {
                $item[$property] = $null
                $item[$property + 'Error'] = $_.Exception.Message
            }
        }
        $items += $item
    }
    return [ordered]@{ objectId = $ObjectId; hresult = $open.HResult; objectReturned = $true; childCount = $childCount; items = $items }
}

function Wait-Until([scriptblock]$Condition, [string]$Failure, [int]$TimeoutMs = 5000) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
        $value = & $Condition
        if ($null -ne $value -and $value -ne $false) { return $value }
        Start-Sleep -Milliseconds 25
    }
    throw $Failure
}
function Test-ExactDialogTarget([Windows.Automation.AutomationElement]$Root, [string]$ExpectedBaseUrl) {
    foreach ($element in @($Root) + @($Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition))) {
        try {
            foreach ($line in ($element.Current.Name -split '\r?\n')) {
                if ($line -ceq "新目标：$ExpectedBaseUrl") { return $true }
            }
        } catch { }
    }
    return $false
}
. (Join-Path $PSScriptRoot 'product-ui-selectors.ps1')

$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../log/stage7-e1/task-dialog-fixture'))
$runRoot = Join-Path $evidenceRoot ('run-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($runRoot) | Out-Null
$signalPath = Join-Path $runRoot 'signal.json'
$profilePath = Join-Path $runRoot 'profile'
$process = $null
try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Resolve-Path (Join-Path $PSScriptRoot '../../node_modules/electron/dist/electron.exe')).Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardOutput = $true
    [void]$start.ArgumentList.Add((Resolve-Path (Join-Path $PSScriptRoot 'product-task-dialog-fixture.mjs')).Path)
    [void]$start.Environment.Remove('ELECTRON_RUN_AS_NODE')
    [void]$start.Environment.Remove('NODE_OPTIONS')
    $start.Environment['AIBROWSE_TASK_DIALOG_SIGNAL'] = $signalPath
    $start.Environment['AIBROWSE_TASK_DIALOG_USER_DATA'] = $profilePath
    $start.Environment['AIBROWSE_TASK_DIALOG_MODE'] = $Mode
    $process = [Diagnostics.Process]::Start($start)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $signalPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
    if (-not (Test-Path -LiteralPath $signalPath)) {
        $diagnostic = if ($process.HasExited) { $process.StandardError.ReadToEnd() + $process.StandardOutput.ReadToEnd() } else { 'Electron TaskDialog子夹具仍运行' }
        throw "Electron TaskDialog子夹具未写入owner：$diagnostic"
    }
    $fixture = Get-Content -LiteralPath $signalPath -Raw | ConvertFrom-Json
    $ownerWindow = [IntPtr][Int64]$fixture.owner
    $dialogHandle = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($dialogHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
        foreach ($candidate in [AIbrowseProductWindow]::OwnedTopLevelWindows($ownerWindow, 16)) {
            try {
                $element = [Windows.Automation.AutomationElement]::FromHandle($candidate)
                if ($element.Current.Name -ceq '确认 API Key 的发送目标') {
                    $dialogHandle = $candidate
                    break
                }
            } catch { }
        }
        if ($dialogHandle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 25 }
    }
    if ($dialogHandle -eq [IntPtr]::Zero) {
        $diagnostic = if ($process.HasExited) { $process.StandardError.ReadToEnd() + $process.StandardOutput.ReadToEnd() } else { 'TaskDialog子夹具仍运行' }
        throw "TaskDialog子夹具未就绪：$diagnostic"
    }
    $dialog = [Windows.Automation.AutomationElement]::FromHandle($dialogHandle)
    $dialogOwnerBeforeAction = [AIbrowseProductWindow]::GetWindow($dialogHandle, 4).ToInt64()
    $observed = @()
    foreach ($candidate in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        try {
            $acceptedName = if ($Mode -ne 'Duplicate') {
                $candidate.Current.Name -ceq '取消' -or $candidate.Current.Name -ceq '确认发送目标'
            } else {
                $candidate.Current.Name -ceq '重复'
            }
            if (-not $acceptedName) { continue }
            $nativeHandle = [IntPtr]$candidate.Current.NativeWindowHandle
            $className = [Text.StringBuilder]::new(256)
            if ($nativeHandle -ne [IntPtr]::Zero) { [void][AIbrowseProductWindow]::GetClassName($nativeHandle, $className, $className.Capacity) }
            $msaaClient = if ($nativeHandle -eq [IntPtr]::Zero) { $null } else { Get-MsaaObservation $nativeHandle 0xFFFFFFFC }
            $msaaWindow = if ($nativeHandle -eq [IntPtr]::Zero) { $null } else { Get-MsaaObservation $nativeHandle 0 }
            $observed += [ordered]@{
                name = $candidate.Current.Name
                controlType = $candidate.Current.ControlType.ProgrammaticName
                nativeWindowHandle = $nativeHandle.ToInt64()
                windowClass = $className.ToString()
                isEnabled = $candidate.Current.IsEnabled
                isInvokePatternAvailable = [bool]$candidate.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
                msaaClient = $msaaClient
                msaaWindow = $msaaWindow
                supportedPatterns = @($candidate.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
            }
        } catch {
            $observed += [ordered]@{ error = $_.Exception.Message }
        }
    }
    if ($observed.Count -eq 0) { throw 'TaskDialog夹具未暴露预期语义元素' }
    $errors = @($observed | Where-Object { $_.Contains('error') })
    $invoked = $null
    $fixtureResult = $null
    $fixtureExitCode = $null
    $actionQualified = $false
    $duplicateRejected = $false
    if ($Mode -ne 'Duplicate') {
        $cancel = Find-UniqueNativeDialogAction $dialog $dialogHandle '取消'
        $confirm = Find-UniqueNativeDialogAction $dialog $dialogHandle '确认发送目标'
        if ($null -eq $cancel -or $null -eq $confirm) { throw 'TaskDialog夹具动作未满足严格MSAA selector' }
        $actionName = if ($Mode -eq 'Cancel') { '取消' } else { '确认发送目标' }
        $expectedResponse = if ($Mode -eq 'Cancel') { 0 } else { 1 }
        $invoked = Invoke-NativeDialogAction $dialog $dialogHandle $ownerWindow 'http://127.0.0.1:1/v1' $actionName
        [void](Wait-Until { $process.Refresh(); $process.HasExited } 'TaskDialog MSAA默认动作未关闭夹具')
        if ($process.ExitCode -ne 0) { throw "TaskDialog夹具退出码异常：$($process.ExitCode)" }
        $resultPath = $signalPath + '.result.json'
        if (-not (Test-Path -LiteralPath $resultPath)) { throw 'TaskDialog夹具未保存分支结果' }
        $fixtureResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($fixtureResult.response -ne $expectedResponse) { throw "MSAA默认动作未选择预期分支：$($fixtureResult.response)" }
        $fixtureExitCode = $process.ExitCode
        $actionQualified = $true
    } else {
        try { [void](Find-UniqueNativeDialogAction $dialog $dialogHandle '重复') } catch { $duplicateRejected = $true }
        if (-not $duplicateRejected) { throw 'TaskDialog selector未拒绝重复合格的MSAA动作' }
    }
    $report = [ordered]@{
        ok = ($errors.Count -eq 0)
        owner = $ownerWindow.ToInt64()
        dialog = $dialogHandle.ToInt64()
        dialogOwner = $dialogOwnerBeforeAction
        dialogProcessId = $process.Id
        electronVersion = $fixture.electronVersion
        evidenceDirectory = $runRoot
        mode = $Mode
        actionQualified = $actionQualified
        duplicateQualifiedRejected = $duplicateRejected
        invoked = $invoked
        fixtureExitCode = $fixtureExitCode
        fixtureResponse = if ($Mode -ne 'Duplicate') { $fixtureResult.response } else { $null }
        candidates = $observed
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runRoot 'pattern-observation.json') -Encoding utf8NoBOM
    if ($errors.Count -ne 0) { throw 'TaskDialog夹具存在未完成的候选观察' }
    $report | ConvertTo-Json -Depth 6 -Compress
} finally {
    if ($null -ne $process -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
}
