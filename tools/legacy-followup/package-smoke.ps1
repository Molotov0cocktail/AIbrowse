param([Parameter(Mandatory)][string]$Spec)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$started=[Diagnostics.Stopwatch]::StartNew()
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$specification=Get-Content -LiteralPath $Spec -Raw|ConvertFrom-Json
$output=[IO.Path]::GetDirectoryName($Spec)
$journal=$specification.journal
$lease=$null
$product=$null
function Save-New([string]$name,$value) {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 16))
  $stream=[IO.File]::Open((Join-Path $output $name),'CreateNew','Write','Read')
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
try {
  if((Get-FileHash -LiteralPath (Join-Path $output 'package-binding.json')).Hash.ToLowerInvariant() -cne $specification.bindingSha256){throw '包验收绑定变化'}
  foreach($source in $specification.sources){if((Get-FileHash -LiteralPath (Join-Path $repository $source.path)).Hash.ToLowerInvariant() -cne $source.sha256){throw '工具输入变化'}}
  Add-Type -Path (Join-Path $repository 'tools/release-profile/ProfileIsolation.cs'),(Join-Path $repository 'tools/release-profile/JobProcess.cs'),(Join-Path $repository 'tools/data-qualification/product-restore-process/SuccessorObserver.cs'),(Join-Path $PSScriptRoot 'package-lease.cs')
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PackageSmokeWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
'@
  $exe=Join-Path $specification.packageRoot 'AIbrowse.exe'
  $product=Start-Process -FilePath $exe -ArgumentList '--force-renderer-accessibility' -WorkingDirectory $specification.packageRoot -WindowStyle Hidden -PassThru
  $created=$product.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  $initial=@{pid=$product.Id;created=$created;image=$exe}
  Save-New 'package-launch.json' @{initial=$initial;utc=[DateTime]::UtcNow.ToString('o');arguments=@('--force-renderer-accessibility')}
  $trusted=$null
  $window=[IntPtr]::Zero
  $documentCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document)
  while($null -eq $trusted -and $started.ElapsedMilliseconds -lt 45000) {
    if($product.HasExited){throw '产品在可信UI就绪前退出'}
    $product.Refresh();$window=$product.MainWindowHandle
    if($window -ne [IntPtr]::Zero) {
      $uia=[Windows.Automation.AutomationElement]::FromHandle($window)
      $matches=@()
      foreach($doc in $uia.FindAll([Windows.Automation.TreeScope]::Descendants,$documentCondition)) {
        $value=$null
        if($doc.Current.AutomationId -ceq 'RootWebArea' -and $doc.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value) -and ([Windows.Automation.ValuePattern]$value).Current.Value -ceq 'aibrowse://app/index.html'){$matches+=$doc}
      }
      if($matches.Count -gt 1){throw '可信主文档不唯一'}
      if($matches.Count -eq 1){$trusted=$matches[0]}
    }
    if($null -eq $trusted){Start-Sleep -Milliseconds 50}
  }
  if($null -eq $trusted){throw '可信主文档就绪超时'}
  $inspect=[Func[uint32,RestoreSuccessorObserver+Cim]]{param([uint32]$candidate)
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$candidate" -ErrorAction Stop
    if($null -eq $p -or $null -eq $p.CreationDate -or [string]::IsNullOrEmpty($p.ExecutablePath)){throw '进程元数据不完整'}
    $value=[RestoreSuccessorObserver+Cim]::new();$value.Pid=$p.ProcessId;$value.Created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();$value.Image=$p.ExecutablePath;$value.Command=$p.CommandLine;return $value
  }
  $configuration=@{version=1;runId=$specification.runId;journal=$journal;runnerPid=$specification.runnerPid;initial=$initial;remainingMs=20000;executableSha256=$specification.executableSha256;guardianSha256=$specification.guardianSha256;bindingSha256=$specification.bindingSha256}|ConvertTo-Json -Compress -Depth 5
  $lease=[PackageSmokeLease]::new($configuration,$inspect,0)
  $ready=$lease.ReadyFrame()|ConvertFrom-Json
  Save-New 'package-ready.json' $ready
  $currentValue=$null
  $owner=0u
  [void][PackageSmokeWindow]::GetWindowThreadProcessId($window,[ref]$owner)
  if($owner -ne $product.Id -or $product.HasExited -or $product.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $created -or -not $trusted.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$currentValue) -or ([Windows.Automation.ValuePattern]$currentValue).Current.Value -cne 'aibrowse://app/index.html'){throw '关闭前主窗口身份改变'}
  if(-not [PackageSmokeWindow]::PostMessageW($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw '正常WM_CLOSE发送失败'}
  Save-New 'package-close.json' @{closeCount=1;window=$window.ToInt64();initial=$initial;trustedDocument='aibrowse://app/index.html';mechanism='WM_CLOSE'}
  while(-not $lease.Poll($inspect)){Start-Sleep -Milliseconds 25}
  $retired=$lease.RetiredFrame()|ConvertFrom-Json
  $receiptPath=Join-Path $output ("ordinary-"+$product.Id+'-'+$created+'/retired.json')
  if((Get-FileHash -LiteralPath $receiptPath).Hash.ToLowerInvariant() -cne $retired.receiptSha256){throw '原生退休回执不匹配'}
  Save-New 'package-native.json' @{passed=$true;elapsedMs=$started.ElapsedMilliseconds;ready=$ready;retired=$retired;receipt=($receiptPath);receiptSha256=$retired.receiptSha256;closeCount=1;providerCalls=0;syntheticProfile=$true}
} catch {
  Save-New 'package-native-failure.json' @{passed=$false;error=$_.Exception.Message;elapsedMs=$started.ElapsedMilliseconds;productPid=if($null -eq $product){$null}else{$product.Id};forcedTerminationIsFailure=$true}
  throw
} finally {
  if($null -ne $lease){$lease.Dispose()}
  if($null -ne $product){$product.Dispose()}
}
