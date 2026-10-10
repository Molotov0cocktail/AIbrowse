param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][long]$StartTicks,
  [Parameter(Mandatory = $true)][long]$MainWindowHandle,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedImageSha256,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][ValidateSet('observe', 'cancel', 'save')][string]$Action,
  [string]$SelectedPath = ''
)
$ErrorActionPreference = 'Stop'
# WM_SETTEXT readback does not prove IFileDialog has adopted the filename.
# The actual run saved the default name. Preserve that failure; inspect real output.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace AIbrowseDiagnosticDialog {
  public static class Native {
    public delegate bool Callback(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr ReadText(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    public static IntPtr[] Owned(IntPtr owner, uint pid) {
      var result = new List<IntPtr>();
      EnumWindows(delegate(IntPtr h, IntPtr l) { uint actual; GetWindowThreadProcessId(h, out actual); if(actual==pid && GetWindow(h,4)==owner) result.Add(h); return true; }, IntPtr.Zero);
      return result.ToArray();
    }
  }
}
'@
$image = 'C:\Program Files\AIbrowse\AIbrowse.exe'
$main = [IntPtr]$MainWindowHandle
function Check-Root {
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  if ($process.StartTime.ToUniversalTime().Ticks -ne $StartTicks -or $process.Path -ine $image -or $process.MainWindowHandle -ne $main -or (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedImageSha256) { throw 'installed process binding changed' }
}
Check-Root
if (Test-Path -LiteralPath $ReceiptPath) { throw 'receipt exists' }
$dialogs = @()
foreach ($handle in [AIbrowseDiagnosticDialog.Native]::Owned($main, [uint32]$ProcessId)) {
  $name = [Text.StringBuilder]::new(512)
  $class = [Text.StringBuilder]::new(256)
  [void][AIbrowseDiagnosticDialog.Native]::GetWindowText($handle, $name, 512)
  [void][AIbrowseDiagnosticDialog.Native]::GetClassName($handle, $class, 256)
  if ($name.ToString() -ceq '导出诊断信息' -and $class.ToString() -ceq '#32770') { $dialogs += $handle }
}
if ($dialogs.Count -ne 1) { throw 'owned diagnostic dialog is not unique' }
$dialogHandle = $dialogs[0]
$dialog = [Windows.Automation.AutomationElement]::FromHandle($dialogHandle)
$nodes = @($dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition))
if ($nodes.Count -gt 512) { throw 'dialog node budget exceeded' }
$nodeReport = @($nodes | ForEach-Object { $current = $_.Current; [ordered]@{ name=$current.Name; controlType=$current.ControlType.ProgrammaticName; automationId=$current.AutomationId; className=$current.ClassName; nativeHandle=$current.NativeWindowHandle; enabled=$current.IsEnabled; offscreen=$current.IsOffscreen } })
$receipt = [ordered]@{ schema=1; utc=[DateTime]::UtcNow.ToString('o'); action=$Action; processId=$ProcessId; startTicks=$StartTicks; mainWindowHandle=$MainWindowHandle; dialogHandle=$dialogHandle.ToInt64(); expectedImageSha256=$ExpectedImageSha256; imageSha256=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant(); sourceSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); nodes=$nodeReport; completed=$false }
function Check-Dialog {
  Check-Root
  $name=[Text.StringBuilder]::new(512)
  $class=[Text.StringBuilder]::new(256)
  [uint32]$dialogPid=0
  [void][AIbrowseDiagnosticDialog.Native]::GetWindowThreadProcessId($dialogHandle,[ref]$dialogPid)
  [void][AIbrowseDiagnosticDialog.Native]::GetWindowText($dialogHandle,$name,512)
  [void][AIbrowseDiagnosticDialog.Native]::GetClassName($dialogHandle,$class,256)
  if ($dialogPid -ne $ProcessId -or [AIbrowseDiagnosticDialog.Native]::GetWindow($dialogHandle,4) -ne $main -or $name.ToString() -cne '导出诊断信息' -or $class.ToString() -cne '#32770') { throw 'diagnostic dialog changed' }
}
function Check-Control($element,[string]$className,[int]$id,[string]$expectedName) {
  Check-Dialog
  $current=$element.Current
  $handle=[IntPtr]$current.NativeWindowHandle
  $actualClass=[Text.StringBuilder]::new(256)
  [uint32]$controlPid=0
  [void][AIbrowseDiagnosticDialog.Native]::GetClassName($handle,$actualClass,256)
  [void][AIbrowseDiagnosticDialog.Native]::GetWindowThreadProcessId($handle,[ref]$controlPid)
  if ($current.AutomationId -cne [string]$id -or $current.ClassName -cne $className -or ($expectedName -ne '' -and $current.Name -cne $expectedName) -or -not $current.IsEnabled -or $current.IsOffscreen -or $handle -eq [IntPtr]::Zero -or $controlPid -ne $ProcessId -or $actualClass.ToString() -cne $className -or [AIbrowseDiagnosticDialog.Native]::GetDlgCtrlID($handle) -ne $id -or [AIbrowseDiagnosticDialog.Native]::GetAncestor($handle,2) -ne $dialogHandle -or -not [AIbrowseDiagnosticDialog.Native]::IsWindowEnabled($handle)) { throw 'native control semantics changed' }
  return $handle
}
if ($Action -ne 'observe') {
  $buttonId=if($Action -eq 'save'){1}else{2}
  $buttonName=if($Action -eq 'save'){'保存(S)'}else{'取消'}
  $buttons=@($nodes|Where-Object{$_.Current.AutomationId -ceq [string]$buttonId -and $_.Current.ClassName -ceq 'Button' -and $_.Current.Name -ceq $buttonName})
  if($buttons.Count -ne 1){throw 'native button not unique'}
  if($Action -eq 'save'){
    if(-not [IO.Path]::IsPathRooted($SelectedPath) -or (Test-Path -LiteralPath $SelectedPath)){throw 'diagnostic target must be new and absolute'}
    $edits=@($nodes|Where-Object{$_.Current.AutomationId -ceq '1001' -and $_.Current.ClassName -ceq 'Edit' -and $_.Current.NativeWindowHandle -ne 0})
    if($edits.Count -ne 1){throw 'native filename edit not unique'}
    $editHandle=Check-Control $edits[0] 'Edit' 1001 ''
    [IntPtr]$result=[IntPtr]::Zero
    if([AIbrowseDiagnosticDialog.Native]::SendMessageTimeout($editHandle,0x000c,[IntPtr]::Zero,$SelectedPath,2,1000,[ref]$result) -eq [IntPtr]::Zero -or $result -eq [IntPtr]::Zero){throw 'filename write failed'}
    [void](Check-Control $edits[0] 'Edit' 1001 '')
    $readBack=[Text.StringBuilder]::new(32768)
    if([AIbrowseDiagnosticDialog.Native]::ReadText($editHandle,0x000d,[IntPtr]32768,$readBack,2,1000,[ref]$result) -eq [IntPtr]::Zero -or $readBack.ToString() -cne $SelectedPath){throw 'filename readback mismatch'}
    $receipt.selectedPathReadBack=$readBack.ToString()
  }
  [void][AIbrowseDiagnosticDialog.Native]::SetForegroundWindow($dialogHandle)
  $buttonHandle=Check-Control $buttons[0] 'Button' $buttonId $buttonName
  if([AIbrowseDiagnosticDialog.Native]::GetForegroundWindow() -ne $dialogHandle){throw 'native dialog is not foreground'}
  [IntPtr]$clickResult=[IntPtr]::Zero
  if([AIbrowseDiagnosticDialog.Native]::SendMessageTimeout($buttonHandle,0x00f5,[IntPtr]::Zero,$null,2,1000,[ref]$clickResult) -eq [IntPtr]::Zero){throw 'native button action timed out'}
}
$receipt.completed = $true
$stream=[IO.File]::Open($ReceiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 6)); $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
$receipt | Select-Object action,dialogHandle,completed | ConvertTo-Json -Compress
