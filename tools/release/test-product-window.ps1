[CmdletBinding()]
param(
    [switch]$Child,
    [Int64]$Owner = 0,
    [Int64]$WrongOwner = 0,
    [string]$Signal = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'ProductWindow.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ProductAccessibleAction.cs')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AIbrowseHiddenWindowFixture {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool EnableWindow(IntPtr window, bool enable);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)]
    static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
    public static IntPtr Create(IntPtr owner) {
        IntPtr window = CreateWindowExW(0x08000080, "STATIC", "", 0x90000000, -32000, -32000, 1, 1,
            owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        return window;
    }
    public static IntPtr CreateChild(IntPtr parent, string className, string title, bool enabled) {
        IntPtr window = CreateWindowExW(0, className, title, 0x50000000, 0, 0, 80, 24,
            parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!enabled) EnableWindow(window, false);
        return window;
    }
    public static void SetOwner(IntPtr window, IntPtr owner) {
        SetWindowLongPtr(window, -8, owner);
    }
}
'@

if ($Child) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if ($Owner -eq 0 -or $WrongOwner -eq 0 -or $Signal -eq '') { throw 'hidden window子夹具参数无效' }
    $form = [Windows.Forms.Form]::new()
    $form.Text = 'AIbrowse selector fixture'
    $form.ShowInTaskbar = $false
    $form.StartPosition = [Windows.Forms.FormStartPosition]::Manual
    $form.Location = [Drawing.Point]::new(-32000, -32000)
    $form.Size = [Drawing.Size]::new(400, 200)
    $cancelTextControl = [Windows.Forms.Label]::new(); $cancelTextControl.Text = '取消'
    $cancelButtonControl = [Windows.Forms.Button]::new(); $cancelButtonControl.Text = '取消'
    $confirmButtonControl = [Windows.Forms.Button]::new(); $confirmButtonControl.Text = '确认发送目标'
    $disabledButtonControl = [Windows.Forms.Button]::new(); $disabledButtonControl.Text = '禁用'; $disabledButtonControl.Enabled = $false
    $textOnlyControl = [Windows.Forms.Label]::new(); $textOnlyControl.Text = '仅文本'
    $duplicateFirstControl = [Windows.Forms.Button]::new(); $duplicateFirstControl.Text = '重复'
    $duplicateSecondControl = [Windows.Forms.Button]::new(); $duplicateSecondControl.Text = '重复'
    $baseUrlControl = [Windows.Forms.TextBox]::new(); $baseUrlControl.AccessibleName = '接口地址（baseUrl）'
    $controls = @($cancelTextControl, $cancelButtonControl, $confirmButtonControl, $disabledButtonControl, $textOnlyControl, $duplicateFirstControl, $duplicateSecondControl, $baseUrlControl)
    for ($index = 0; $index -lt $controls.Count; $index++) { $controls[$index].Location = [Drawing.Point]::new(5, 5 + 24 * $index); $form.Controls.Add($controls[$index]) }
    $owned = $form.Handle
    [AIbrowseHiddenWindowFixture]::SetOwner($owned, [IntPtr]$Owner)
    [void][AIbrowseHiddenWindowFixture]::ShowWindow($owned, 4)
    [Windows.Forms.Application]::DoEvents()
    [AIbrowseHiddenWindowFixture]::SetOwner($owned, [IntPtr]$Owner)
    $wrong = [AIbrowseHiddenWindowFixture]::Create([IntPtr]$WrongOwner)
    $unowned = [AIbrowseHiddenWindowFixture]::Create([IntPtr]::Zero)
    @{ owned = $owned.ToInt64(); wrong = $wrong.ToInt64(); unowned = $unowned.ToInt64(); processId = $PID; cancelText = $cancelTextControl.Handle.ToInt64(); cancelButton = $cancelButtonControl.Handle.ToInt64(); confirmButton = $confirmButtonControl.Handle.ToInt64(); disabledButton = $disabledButtonControl.Handle.ToInt64(); textOnly = $textOnlyControl.Handle.ToInt64(); duplicateFirst = $duplicateFirstControl.Handle.ToInt64(); duplicateSecond = $duplicateSecondControl.Handle.ToInt64(); baseUrl = $baseUrlControl.Handle.ToInt64() } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $Signal -Encoding utf8NoBOM
    $budget = [Diagnostics.Stopwatch]::StartNew()
    while ($budget.Elapsed.TotalSeconds -lt 30) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
    }
    exit 0
}

$ownerWindow = [AIbrowseHiddenWindowFixture]::Create([IntPtr]::Zero)
$wrongOwnerWindow = [AIbrowseHiddenWindowFixture]::Create([IntPtr]::Zero)
$signalPath = Join-Path ([IO.Path]::GetTempPath()) ('aibrowse-owned-window-' + [Guid]::NewGuid().ToString('N') + '.json')
$process = $null
try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardOutput = $true
    foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-Child', '-Owner', $ownerWindow.ToInt64(), '-WrongOwner', $wrongOwnerWindow.ToInt64(), '-Signal', $signalPath)) {
        [void]$start.ArgumentList.Add([string]$argument)
    }
    $process = [Diagnostics.Process]::Start($start)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $signalPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path -LiteralPath $signalPath)) {
        $diagnostic = if ($process.HasExited) { $process.StandardError.ReadToEnd() + $process.StandardOutput.ReadToEnd() } else { 'child仍运行' }
        throw "hidden window子夹具未就绪：$diagnostic"
    }
    $fixture = Get-Content -LiteralPath $signalPath -Raw | ConvertFrom-Json
    $actual = @([AIbrowseProductWindow]::OwnedTopLevelWindows($ownerWindow, 16) | ForEach-Object { $_.ToInt64() })
    if ($actual.Count -gt 16 -or $actual -notcontains $fixture.owned) {
        throw ('EnumWindows未精确返回跨进程owned窗口：' + (@{ actual = $actual; fixture = $fixture; observedOwner = [AIbrowseProductWindow]::GetWindow([IntPtr]$fixture.owned, 4).ToInt64() } | ConvertTo-Json -Compress))
    }
    if ($actual -contains $fixture.wrong -or $actual -contains $fixture.unowned) { throw 'EnumWindows错误接纳了非owned窗口' }
    if ([AIbrowseProductWindow]::GetWindow([IntPtr]$fixture.owned, 4) -ne $ownerWindow) { throw 'GW_OWNER未绑定固定owner' }
    [uint32]$windowProcessId = 0
    [void][AIbrowseProductWindow]::GetWindowThreadProcessId([IntPtr]$fixture.owned, [ref]$windowProcessId)
    if ($windowProcessId -ne $fixture.processId -or $windowProcessId -eq $PID) { throw 'owned窗口跨进程PID观测无效' }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    function Wait-Until([scriptblock]$Condition, [string]$Failure, [int]$TimeoutMs = 15000) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
            $value = & $Condition
            if ($null -ne $value -and $value -ne $false) { return $value }
            Start-Sleep -Milliseconds 20
        }
        throw $Failure
    }
    . (Join-Path $PSScriptRoot 'product-ui-selectors.ps1')
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$fixture.owned)
    $cancel = Find-UniqueInvokableButton $root '取消'
    if ($null -eq $cancel -or $cancel.Current.NativeWindowHandle -ne $fixture.cancelButton) { throw ('selector未从同名Text/Button中唯一选择可调用Button：' + (@{ expected = $fixture.cancelButton; selected = $(if ($null -eq $cancel) { 0 } else { $cancel.Current.NativeWindowHandle }); candidates = @(Get-BoundedButtonCandidateMetadata $root) } | ConvertTo-Json -Depth 6 -Compress)) }
    if ($null -ne (Find-UniqueInvokableButton $root '禁用') -or $null -ne (Find-UniqueInvokableButton $root '仅文本')) { throw 'selector接纳了disabled Button或非Button' }
    $duplicateRejected = $false
    try { [void](Find-UniqueInvokableButton $root '重复') } catch { $duplicateRejected = $true }
    if (-not $duplicateRejected) { throw 'selector未拒绝重复合格Button' }
    Set-NamedValue $root '接口地址' 'http://127.0.0.1:12345/v1'
    if ((Get-NamedValue $root '接口地址') -cne 'http://127.0.0.1:12345/v1') { throw '非敏感Value selector写读不一致' }
    @{ ok = $true; owner = $ownerWindow.ToInt64(); owned = $fixture.owned; wrongOwnerRejected = $true; unownedRejected = $true; ownerProcessId = $PID; ownedProcessId = $windowProcessId; sameNameTextRejected = $true; disabledButtonRejected = $true; duplicateQualifiedRejected = $duplicateRejected; selectedCancelButton = $cancel.Current.NativeWindowHandle; nonSecretValueRoundTrip = $true } |
        ConvertTo-Json -Compress
} finally {
    if ($null -ne $process -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    if (Test-Path -LiteralPath $signalPath) { Remove-Item -LiteralPath $signalPath -Force }
    [void][AIbrowseHiddenWindowFixture]::DestroyWindow($wrongOwnerWindow)
    [void][AIbrowseHiddenWindowFixture]::DestroyWindow($ownerWindow)
}
