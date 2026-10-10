param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][long]$StartTicks,
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedImageSha256,
  [Parameter(Mandatory = $true)][string]$ObservationPath,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][ValidateSet('click', 'close', 'invoke', 'capture-preview')][string]$Action,
  [ValidateSet('诊断信息', '生成预览', '保存此预览')][string]$ButtonName = '',
  [string]$PreviewPath = '',
  [int]$X = 0,
  [int]$Y = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace AIbrowseVisibleAction {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  public static class Native {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  }
}
'@
if (Test-Path -LiteralPath $ReceiptPath) { throw 'receipt exists' }
$image = 'C:\Program Files\AIbrowse\AIbrowse.exe'
$observationBytes = [IO.File]::ReadAllBytes($ObservationPath)
$observation = [Text.Encoding]::UTF8.GetString($observationBytes) | ConvertFrom-Json
$observedUtc = [DateTime]::Parse($observation.utc).ToUniversalTime()
if (([DateTime]::UtcNow - $observedUtc).TotalSeconds -gt 90 -or $observedUtc -gt [DateTime]::UtcNow) { throw 'observation is stale' }
if ($observation.processId -ne $ProcessId -or $observation.startTicks -ne $StartTicks -or $observation.windowHandle -ne $WindowHandle -or $observation.imageSha256 -cne $ExpectedImageSha256) { throw 'observation identity mismatch' }
$imageHash = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
if ($imageHash -cne $ExpectedImageSha256) { throw 'installed image binding mismatch' }
$handle = [IntPtr]$WindowHandle
function Assert-Window {
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  [uint32]$ownerId = 0
  [void][AIbrowseVisibleAction.Native]::GetWindowThreadProcessId($handle, [ref]$ownerId)
  if ($process.StartTime.ToUniversalTime().Ticks -ne $StartTicks -or $process.Path -ine $image -or $process.MainWindowHandle -ne $handle -or $ownerId -ne $ProcessId -or -not [AIbrowseVisibleAction.Native]::IsWindow($handle)) { throw 'live window binding mismatch' }
  $rect = New-Object AIbrowseVisibleAction.Rect
  if (-not [AIbrowseVisibleAction.Native]::GetWindowRect($handle, [ref]$rect)) { throw 'window rectangle unavailable' }
  if ($Action -eq 'click' -and ($rect.Left -ne $observation.windowRect.left -or $rect.Top -ne $observation.windowRect.top -or ($rect.Right - $rect.Left) -ne $observation.windowRect.width -or ($rect.Bottom - $rect.Top) -ne $observation.windowRect.height)) { throw 'window rectangle changed' }
  return $rect
}
$rect = Assert-Window
$claim = [ordered]@{ schema = 1; utc = [DateTime]::UtcNow.ToString('o'); action = $Action; processId = $ProcessId; startTicks = $StartTicks; windowHandle = $WindowHandle; x = $X; y = $Y; observationSha256 = (Get-FileHash -LiteralPath $ObservationPath -Algorithm SHA256).Hash.ToLowerInvariant(); expectedImageSha256 = $ExpectedImageSha256; imageSha256 = $imageHash; sourceSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); completed = $false }
$receiptStream = [IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
function Save-Receipt {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($claim | ConvertTo-Json -Compress))
  $receiptStream.Position = 0
  $receiptStream.SetLength(0)
  $receiptStream.Write($bytes, 0, $bytes.Length)
  $receiptStream.Flush($true)
}
try {
  Save-Receipt
  if ($Action -eq 'close') {
    [void](Assert-Window)
    if (-not [AIbrowseVisibleAction.Native]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'normal close request failed' }
  } elseif ($Action -in @('invoke', 'capture-preview')) {
    if ($Action -eq 'invoke' -and $ButtonName -eq '') { throw 'diagnostic button missing' }
    [void](Assert-Window)
    $uiaRoot = [Windows.Automation.AutomationElement]::FromHandle($handle)
    $documentCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Document)
    $trustedDocuments = @()
    foreach ($document in $uiaRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $documentCondition)) {
      $valuePattern = $null
      if ($document.Current.AutomationId -eq 'RootWebArea' -and $document.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and ([Windows.Automation.ValuePattern]$valuePattern).Current.Value -ceq 'aibrowse://app/index.html') { $trustedDocuments += $document }
    }
    if ($trustedDocuments.Count -ne 1) { throw 'trusted application document is not unique' }
    $trusted = $trustedDocuments[0]
    if ($Action -eq 'capture-preview') {
      if (-not [IO.Path]::IsPathRooted($PreviewPath) -or (Test-Path -LiteralPath $PreviewPath)) { throw 'preview evidence path must be new and absolute' }
      $textCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
      $previewNames = @()
      foreach ($textElement in $trusted.FindAll([Windows.Automation.TreeScope]::Descendants, $textCondition)) {
        $textName = $textElement.Current.Name
        if ($textName.StartsWith('{"schemaVersion":')) { $previewNames += $textName }
      }
      if ($previewNames.Count -ne 1) { throw 'preview JSON is not unique' }
      $previewBytes = [Text.UTF8Encoding]::new($false).GetBytes($previewNames[0])
      if ($previewBytes.Length -gt 65536) { throw 'preview exceeds product budget' }
      [void](Assert-Window)
      $previewStream = [IO.File]::Open($PreviewPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      try { $previewStream.Write($previewBytes, 0, $previewBytes.Length); $previewStream.Flush($true) } finally { $previewStream.Dispose() }
      $claim.previewBytes = $previewBytes.Length
      $claim.previewSha256 = (Get-FileHash -LiteralPath $PreviewPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $claim.trustedDocumentUrl = 'aibrowse://app/index.html'
    } else {
    $buttonCondition = [Windows.Automation.AndCondition]::new(
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $ButtonName))
    $buttons = $trusted.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($buttons.Count -ne 1) { throw 'diagnostic button is not unique' }
    $button = $buttons[0]
    $pattern = $null
    if (-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'diagnostic button has no invoke pattern' }
    [void](Assert-Window)
    $documentValue = $null
    if (-not $trusted.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$documentValue) -or ([Windows.Automation.ValuePattern]$documentValue).Current.Value -cne 'aibrowse://app/index.html' -or $trusted.Current.AutomationId -ne 'RootWebArea') { throw 'application document changed' }
    $currentButton = $button.Current
    if ($currentButton.ControlType -ne [Windows.Automation.ControlType]::Button -or $currentButton.Name -cne $ButtonName -or -not $currentButton.IsEnabled -or $currentButton.IsOffscreen) { throw 'diagnostic button semantics changed' }
    $claim.buttonName = $ButtonName
    $claim.trustedDocumentUrl = ([Windows.Automation.ValuePattern]$documentValue).Current.Value
    Save-Receipt
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    }
  } else {
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $observation.windowRect.width -or $Y -ge $observation.windowRect.height) { throw 'click is outside observed window' }
    [void][AIbrowseVisibleAction.Native]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 150
    [void](Assert-Window)
    if ([AIbrowseVisibleAction.Native]::GetForegroundWindow() -ne $handle) { throw 'target window is not foreground' }
    $point = New-Object AIbrowseVisibleAction.Point
    $point.X = $rect.Left + $X
    $point.Y = $rect.Top + $Y
    if ([AIbrowseVisibleAction.Native]::GetAncestor([AIbrowseVisibleAction.Native]::WindowFromPoint($point), 2) -ne $handle) { throw 'click point is covered by another window' }
    if (-not [AIbrowseVisibleAction.Native]::SetCursorPos($point.X, $point.Y)) { throw 'cursor move failed' }
    [AIbrowseVisibleAction.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [AIbrowseVisibleAction.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  $claim.completed = $true
  $claim.endUtc = [DateTime]::UtcNow.ToString('o')
  Save-Receipt
} finally { $receiptStream.Dispose() }
$claim | ConvertTo-Json -Compress
