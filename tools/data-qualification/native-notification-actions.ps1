param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][long]$StartTicks,
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedImageSha256,
  [Parameter(Mandatory=$true)][string]$ReceiptPath,
  [Parameter(Mandatory=$true)][ValidateSet('observe','invoke','navigate','session','authorize','toast','live-toast','historical-observe','close')][string]$Action,
  [ValidateSet('监控此页','监控工作区','下一步','采集 Baseline 预览','确认创建','规则','事件','立即检查','暂停','← 返回浏览','取消')][string]$ButtonName,
  [string]$FixtureUrl,
  [switch]$OpenNotificationCenter
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NotificationUiNative {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int k,out int v,int n,out int r);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static bool Elevated(IntPtr p){IntPtr t;if(!OpenProcessToken(p,8,out t))throw new System.ComponentModel.Win32Exception();try{int v,r;if(!GetTokenInformation(t,20,out v,4,out r))throw new System.ComponentModel.Win32Exception();return v!=0;}finally{CloseHandle(t);}}
}
'@
$image='C:\Program Files\AIbrowse\AIbrowse.exe'
$handle=[IntPtr]$WindowHandle
$clock=[Diagnostics.Stopwatch]::StartNew()
if(Test-Path -LiteralPath $ReceiptPath){throw 'Receipt already exists'}
function Assert-App {
 $p=Get-Process -Id $ProcessId -ErrorAction Stop
 try {
  [uint32]$owner=0;[void][NotificationUiNative]::GetWindowThreadProcessId($handle,[ref]$owner)
  if($p.StartTime.ToUniversalTime().Ticks -ne $StartTicks -or $p.Path -ine $image -or (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedImageSha256 -or ![NotificationUiNative]::IsWindow($handle) -or [NotificationUiNative]::GetAncestor($handle,2) -ne $handle -or $owner -ne $ProcessId -or [NotificationUiNative]::Elevated($p.Handle)){throw 'Ordinary installed app/window identity mismatch'}
 }finally{$p.Dispose()}
 if($clock.ElapsedMilliseconds -gt 15000){throw 'UI action exceeds its bounded deadline'}
}
function Trusted-Document {
 Assert-App
 $root=[Windows.Automation.AutomationElement]::FromHandle($handle)
 $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document)
 $found=@()
 foreach($element in $root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)){
  $pattern=$null
  if($element.Current.AutomationId -ceq 'RootWebArea' -and $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -and ([Windows.Automation.ValuePattern]$pattern).Current.Value -ceq 'aibrowse://app/index.html'){$found += $element}
 }
 if($found.Count -ne 1){throw 'Trusted application document not unique'}
 return $found[0]
}
function Control($document,$type,[string]$name){
 $condition=[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name))
 $all=$document.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
 $visible=@($all | Where-Object {$_.Current.IsEnabled -and !$_.Current.IsOffscreen})
 if($visible.Count -ne 1){throw ('Unique enabled visible control missing: '+$name+' count='+$visible.Count)}
 return $visible[0]
}
function Nodes($document){
 $all=$document.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
 if($all.Count -gt 600){throw 'Application UI exceeds bounded node budget'}
 $result=@()
 foreach($element in $all){
  $c=$element.Current;$value=$null;$p=$null;$toggleState=$null
  if($c.ControlType -in @([Windows.Automation.ControlType]::Edit,[Windows.Automation.ControlType]::ComboBox) -and $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$p)){$value=([Windows.Automation.ValuePattern]$p).Current.Value}
  if($c.ControlType -eq [Windows.Automation.ControlType]::CheckBox -and $element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$p)){$toggleState=([Windows.Automation.TogglePattern]$p).Current.ToggleState.ToString()}
  $result += [ordered]@{type=$c.ControlType.ProgrammaticName;name=$c.Name;id=$c.AutomationId;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen;value=$value;toggleState=$toggleState}
 }
 return ,$result
}
function Focus-Control($element){
 [void][NotificationUiNative]::SetForegroundWindow($handle)
 $element.SetFocus()
 $focusClock=[Diagnostics.Stopwatch]::StartNew()
 while($focusClock.ElapsedMilliseconds -lt 1000 -and ([NotificationUiNative]::GetForegroundWindow() -ne $handle -or !$element.Current.HasKeyboardFocus)){Start-Sleep -Milliseconds 50}
 if([NotificationUiNative]::GetForegroundWindow() -ne $handle -or !$element.Current.HasKeyboardFocus){throw ('Exact keyboard focus not established: foreground='+[NotificationUiNative]::GetForegroundWindow().ToInt64()+' target='+$WindowHandle+' focused='+$element.Current.HasKeyboardFocus)}
}
function Browser-Document {
 $doc=Trusted-Document
 $watch=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'监控此页')
 $back=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'← 返回浏览')
 $watchButtons=@($doc.FindAll([Windows.Automation.TreeScope]::Descendants,$watch)|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled -and !$_.Current.IsOffscreen})
 $backButtons=@($doc.FindAll([Windows.Automation.TreeScope]::Descendants,$back)|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and !$_.Current.IsOffscreen})
 if($watchButtons.Count -ne 1 -or $backButtons.Count -ne 0){throw 'Application is not in the bounded browser view'}
 return $doc
}
function Open-NotificationCenter {
 [void][NotificationUiNative]::SetForegroundWindow($handle)
 if([NotificationUiNative]::GetForegroundWindow() -ne $handle){throw 'App must be foreground before the single notification-center action'}
 [NotificationUiNative]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
 [NotificationUiNative]::keybd_event(0x4E,0,0,[UIntPtr]::Zero)
 [NotificationUiNative]::keybd_event(0x4E,0,2,[UIntPtr]::Zero)
 [NotificationUiNative]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)
}
function Close-NotificationCenter {
 [uint32]$foregroundOwner=0
 [void][NotificationUiNative]::GetWindowThreadProcessId([NotificationUiNative]::GetForegroundWindow(),[ref]$foregroundOwner)
 if(@(Get-Process ShellExperienceHost -ErrorAction SilentlyContinue|Where-Object Id -EQ $foregroundOwner).Count -eq 1){
  [NotificationUiNative]::keybd_event(0x1B,0,0,[UIntPtr]::Zero)
  [NotificationUiNative]::keybd_event(0x1B,0,2,[UIntPtr]::Zero)
 }
 [void][NotificationUiNative]::SetForegroundWindow($handle)
 Start-Sleep -Milliseconds 150
 return ([NotificationUiNative]::GetForegroundWindow() -eq $handle)
}
function Find-TargetCard([Diagnostics.Stopwatch]$budget) {
 $titleCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'AIbrowse 监控提醒')
 $matches=@()
 foreach($shellProcess in @(Get-Process ShellExperienceHost -ErrorAction SilentlyContinue)){
  if($budget.ElapsedMilliseconds -gt 10000){throw 'Single notification-card operation exceeded ten seconds'}
  if(!$shellProcess.Path.StartsWith((Join-Path $env:WINDIR 'SystemApps\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Notification shell image outside Windows SystemApps'}
  $shellFilter=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$shellProcess.Id)
  foreach($shellRoot in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$shellFilter)){
   foreach($match in $shellRoot.FindAll([Windows.Automation.TreeScope]::Descendants,$titleCondition)){
    if(!$match.Current.IsOffscreen){$matches += [ordered]@{element=$match;shellPid=$shellProcess.Id;shellStartTicks=$shellProcess.StartTime.ToUniversalTime().Ticks;shellPath=$shellProcess.Path}}
   }
  }
 }
 if($matches.Count -eq 0){return [pscustomobject]@{status='no-card';visibleCount=0}}
 if($matches.Count -ne 1){return [pscustomobject]@{status='multiple-cards';visibleCount=$matches.Count}}
 $match=$matches[0];$card=$null;$pattern=$null;$candidate=$match.element
 for($level=0;$level -lt 5 -and $null -ne $candidate;$level++){
  $candidatePattern=$null
  if($candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$candidatePattern)){$card=$candidate;$pattern=$candidatePattern;break}
  $candidate=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($candidate)
 }
 if($null -eq $card){return [pscustomobject]@{status='boundary-unavailable';visibleCount=1}}
 # Establish the single-card boundary and geometry before reading any text inside it.
 $elements=$card.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
 $currentCard=$card.Current;$bounds=$currentCard.BoundingRectangle
 $boundaryOk=$elements.Count -ge 2 -and $elements.Count -le 24 -and $currentCard.IsEnabled -and !$currentCard.IsOffscreen -and $currentCard.ProcessId -eq $match.shellPid -and $bounds.Width -gt 0 -and $bounds.Width -le 600 -and $bounds.Height -gt 0 -and $bounds.Height -le 400
 foreach($element in $elements){
  $current=$element.Current;$childBounds=$current.BoundingRectangle
  if($current.ProcessId -ne $match.shellPid -or $current.ControlType -eq [Windows.Automation.ControlType]::Window -or (!$current.IsOffscreen -and !$childBounds.IsEmpty -and !$bounds.Contains($childBounds))){$boundaryOk=$false}
 }
 if(!$boundaryOk){return [pscustomobject]@{status='boundary-unproven';visibleCount=1}}
 try{$runtimeId=$card.GetRuntimeId()}catch{return [pscustomobject]@{status='identity-unproven';visibleCount=1}}
 if($runtimeId -isnot [int[]] -or $runtimeId.Count -lt 1 -or $runtimeId.Count -gt 32){return [pscustomobject]@{status='identity-unproven';visibleCount=1}}
 $bodyCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'受保护来源发生变化')
 if($card.FindAll([Windows.Automation.TreeScope]::Descendants,$titleCondition).Count -ne 1 -or $card.FindAll([Windows.Automation.TreeScope]::Descendants,$bodyCondition).Count -ne 1){return [pscustomobject]@{status='text-unproven';visibleCount=1}}
 [pscustomobject]@{status='ready';visibleCount=1;card=$card;pattern=$pattern;runtimeId=[int[]]$runtimeId.Clone();nodeCount=$elements.Count;left=$bounds.Left;top=$bounds.Top;width=$bounds.Width;height=$bounds.Height;shellPid=$match.shellPid;shellStartTicks=$match.shellStartTicks;shellPath=$match.shellPath}
}
function Same-TargetCardIdentity($first,$second) {
 if($first.status -cne 'ready' -or $second.status -cne 'ready' -or $first.shellPid -ne $second.shellPid -or $first.shellStartTicks -ne $second.shellStartTicks -or $first.shellPath -cne $second.shellPath -or $first.nodeCount -ne $second.nodeCount -or $first.left -ne $second.left -or $first.top -ne $second.top -or $first.width -ne $second.width -or $first.height -ne $second.height){return $false}
 if($first.runtimeId -isnot [int[]] -or $second.runtimeId -isnot [int[]] -or $first.runtimeId.Count -lt 1 -or $first.runtimeId.Count -gt 32 -or $first.runtimeId.Count -ne $second.runtimeId.Count){return $false}
 for($index=0;$index -lt $first.runtimeId.Count;$index++){if($first.runtimeId[$index] -ne $second.runtimeId[$index]){return $false}}
 return $true
}
$imageHash=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
if($imageHash -cne $ExpectedImageSha256){throw 'Installed image hash mismatch'}
$receipt=[ordered]@{utc=[DateTime]::UtcNow.ToString('o');processId=$ProcessId;startTicks=$StartTicks;windowHandle=$WindowHandle;expectedImageSha256=$ExpectedImageSha256;imageSha256=$imageHash;tokenElevation=$false;action=$Action;buttonName=$ButtonName;trustedDocument='aibrowse://app/index.html';sourceSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();completed=$false}
$stream=[IO.File]::Open($ReceiptPath,'CreateNew','Write','Read')
function Save-Receipt { $b=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $receipt -Depth 10));$stream.Position=0;$stream.SetLength(0);$stream.Write($b,0,$b.Length);$stream.Flush($true) }
try{
 Save-Receipt
 Assert-App
 if($Action -eq 'toast'){
  throw 'The legacy 40-second toast automation is retired; use live-toast with the bounded single-card contract'
 }elseif($Action -eq 'historical-observe'){
  [void](Trusted-Document)
  $receipt.observeOnly=$true;$receipt.toastInvoked=$false;$receipt.desktopScreenshot=$false
  $receipt.notificationCenterOpened=$false;$receipt.notificationCenterClosed=$false
  $historyClock=[Diagnostics.Stopwatch]::StartNew()
  try{
   Open-NotificationCenter
   $receipt.notificationCenterOpened=$true;Save-Receipt
   Start-Sleep -Milliseconds 600
   $target=Find-TargetCard $historyClock
   $receipt.visibleAiBrowseTitleMatches=$target.visibleCount
   if($target.status -eq 'ready'){
    $receipt.targetBoundary=[ordered]@{runtimeId=@($target.runtimeId);nodeCount=$target.nodeCount;left=$target.left;top=$target.top;width=$target.width;height=$target.height;shellPid=$target.shellPid;shellStartTicks=$target.shellStartTicks;shellPath=$target.shellPath}
    $receipt.result='OBSERVED: historical AIbrowse card boundary and fixed title/body; no click and no routing claim'
   }else{$receipt.result='NOTOBSERVED: '+$target.status}
   if($historyClock.ElapsedMilliseconds -gt 10000){throw 'Single historical observation exceeded ten seconds'}
  }finally{
   if($receipt.notificationCenterOpened){$receipt.notificationCenterClosed=Close-NotificationCenter;if(!$receipt.notificationCenterClosed){throw 'Notification center did not close'}}
   $receipt.observationElapsedMs=$historyClock.ElapsedMilliseconds;Save-Receipt
  }
 }elseif($Action -eq 'live-toast'){
  $receipt.observeOnly=$false;$receipt.toastInvoked=$false;$receipt.routeVerified=$false
  $receipt.notificationCenterOpened=$false;$receipt.notificationCenterClosed=$false
  $liveClock=[Diagnostics.Stopwatch]::StartNew()
  try{
   [void](Browser-Document)
   if($OpenNotificationCenter){Open-NotificationCenter;$receipt.notificationCenterOpened=$true;Save-Receipt;Start-Sleep -Milliseconds 300}
   $target=$null
   while($liveClock.ElapsedMilliseconds -lt 10000){
    Assert-App
    $target=Find-TargetCard $liveClock
    if($target.status -eq 'ready'){break}
    if($target.status -ne 'no-card'){throw ('Live target card rejected: '+$target.status)}
    Start-Sleep -Milliseconds 100
   }
   if($null -eq $target -or $target.status -ne 'ready'){throw 'No live target card within ten seconds'}
   Assert-App;[void](Browser-Document)
   $again=Find-TargetCard $liveClock
   if(!(Same-TargetCardIdentity $target $again)){throw 'Live target card identity or bounds changed before invoke'}
   if($liveClock.ElapsedMilliseconds -gt 10000 -or !$again.card.Current.IsEnabled -or $again.card.Current.IsOffscreen){throw 'Live target card expired before invoke'}
   $receipt.targetBoundary=[ordered]@{runtimeId=@($again.runtimeId);nodeCount=$again.nodeCount;left=$again.left;top=$again.top;width=$again.width;height=$again.height;shellPid=$again.shellPid;shellStartTicks=$again.shellStartTicks;shellPath=$again.shellPath}
   $receipt.toastObservedUtc=[DateTime]::UtcNow.ToString('o');Save-Receipt
   ([Windows.Automation.InvokePattern]$again.pattern).Invoke()
   $receipt.toastInvoked=$true;$receipt.toastInvokedUtc=[DateTime]::UtcNow.ToString('o');Save-Receipt
   Start-Sleep -Milliseconds 300
   Assert-App;[void](Trusted-Document)
   $receipt.trustedApplicationRootAfterInvoke=$true
   $receipt.routeResult='NOT_ASSERTED: product route requires separate visible-state evidence'
  }finally{
   if($receipt.notificationCenterOpened){$receipt.notificationCenterClosed=Close-NotificationCenter;if(!$receipt.notificationCenterClosed){throw 'Notification center did not close'}}
   $receipt.liveElapsedMs=$liveClock.ElapsedMilliseconds;Save-Receipt
  }
 }elseif($Action -eq 'close'){
  if(![NotificationUiNative]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Normal close request failed'}
 }else{
  $doc=Trusted-Document
  $receipt.before=Nodes $doc
  Save-Receipt
  if($Action -eq 'invoke'){
   $element=Control $doc ([Windows.Automation.ControlType]::Button) $ButtonName
   $p=$null;$invoke=$element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$p)
   if(!$invoke -and ($ButtonName -notin @('规则','事件') -or !$element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$p))){throw 'Button has no supported semantic pattern'}
   Assert-App;[void](Trusted-Document)
   if($invoke){([Windows.Automation.InvokePattern]$p).Invoke()}else{([Windows.Automation.TogglePattern]$p).Toggle()}
  }elseif($Action -eq 'navigate'){
   if($FixtureUrl -cnotmatch '^http://127\.0\.0\.1:[0-9]{2,5}/page$'){throw 'Only the bounded local fixture URL is allowed'}
   $element=Control $doc ([Windows.Automation.ControlType]::Edit) '地址栏'
   $p=$null;if(!$element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$p)){throw 'Address input has no ValuePattern'}
   Focus-Control $element
   ([Windows.Automation.ValuePattern]$p).SetValue($FixtureUrl)
   [Windows.Forms.SendKeys]::SendWait('{ENTER}')
   $receipt.fixtureUrl=$FixtureUrl
   $receipt.valueReadbackIsNotNavigationProof=$true
  }elseif($Action -eq 'session'){
   $element=Control $doc ([Windows.Automation.ControlType]::ComboBox) '访问方式'
   Focus-Control $element
   [Windows.Forms.SendKeys]::SendWait('{HOME}{DOWN}{ENTER}')
  }elseif($Action -eq 'authorize'){
   $element=Control $doc ([Windows.Automation.ControlType]::CheckBox) '我授权读取当前登录页进行一次性预览；授权 5 分钟后失效'
   $p=$null;if(!$element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$p)){throw 'Authorization checkbox has no TogglePattern'}
   if(([Windows.Automation.TogglePattern]$p).Current.ToggleState -ne [Windows.Automation.ToggleState]::Off){throw 'Session preview authorization already granted'}
   ([Windows.Automation.TogglePattern]$p).Toggle()
  }
  $receipt.after=Nodes (Trusted-Document)
 }
 $receipt.completed=$true;$receipt.endUtc=[DateTime]::UtcNow.ToString('o');$receipt.elapsedMs=$clock.ElapsedMilliseconds
 Save-Receipt
}catch{$receipt.error=$_.Exception.Message;Save-Receipt;throw}finally{$stream.Dispose()}
[pscustomobject]@{completed=$receipt.completed;action=$Action;receipt=$ReceiptPath;elapsedMs=$clock.ElapsedMilliseconds} | ConvertTo-Json -Compress
