[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('R','P')][string]$Scene,
    [Parameter(Mandatory)][ValidateRange(1,2)][int]$Transition,
    [Parameter(Mandatory)][ValidateRange(1,64)][int]$ActionSequence,
    [Parameter(Mandatory)][ValidateSet('restore','partial')][string]$Purpose,
    [Parameter(Mandatory)][ValidateSet('Approve','Cancel')][string]$Action,
    [Parameter(Mandatory)][uint32]$ProcessId,
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{0,18}$')][string]$CreatedFileTime,
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][long]$MainWindowHandle,
    [Parameter(Mandatory)][ValidateRange(1,30000)][int]$BudgetMs,
    [Parameter(Mandatory)][string]$Journal
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$clock=[Diagnostics.Stopwatch]::StartNew()
$native=$null
$report=[ordered]@{version=1;scene=$Scene;transition=$Transition;actionSequence=$ActionSequence;purpose=$Purpose;result='failed';ok=$false;actionCount=0;elapsedMs=0;failure='confirmation-failed'}
function Check-Time {
    if($clock.ElapsedMilliseconds -ge $BudgetMs){throw '原生确认超过原UI期限'}
}
function Check-Parents([string]$Path) {
    for($item=$Path;-not [string]::IsNullOrEmpty($item);$item=[IO.Path]::GetDirectoryName($item)) {
        $entry=Get-Item -LiteralPath $item -Force
        if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '原生确认目录身份无效'}
    }
}
function Write-New([string]$Path,$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress -Depth 4))
    if($bytes.Length -gt 65536){throw '原生确认回执超限'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Nodes($Root) {
    $all=[Collections.Generic.List[Windows.Automation.AutomationElement]]::new()
    $queue=[Collections.Generic.Queue[Windows.Automation.AutomationElement]]::new()
    $all.Add($Root);$queue.Enqueue($Root)
    $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
    while($queue.Count -gt 0) {
        Check-Time
        $child=$walker.GetFirstChild($queue.Dequeue())
        while($null -ne $child) {
            Check-Time
            if($all.Count -ge 512){throw '原生确认可访问树超限'}
            $all.Add($child);$queue.Enqueue($child)
            $child=$walker.GetNextSibling($child)
        }
    }
    Check-Time
    return $all.ToArray()
}
function Dialog-Owner([IntPtr]$Handle) { return [AIbrowseProductWindow]::GetWindow($Handle,4) }
function Context($Dialog,[IntPtr]$Handle) {
    Check-Time
    $current=$Dialog.get_Current()
    if($current.get_Name() -cne '确认恢复本地数据' -or
       [IntPtr]$current.get_NativeWindowHandle() -ne $Handle -or $current.get_ProcessId() -ne $ProcessId -or
       (Dialog-Owner $Handle) -ne [IntPtr]$MainWindowHandle){throw '原生确认对话框身份变化'}
    $text=[AIbrowseRestoreConfirmation]::Message($Purpose)
    $body=0
    $approve=[Collections.Generic.List[object]]::new()
    $cancel=[Collections.Generic.List[object]]::new()
    foreach($node in @(Nodes $Dialog)) {
        Check-Time
        $value=$node.get_Current()
        $name=$value.get_Name()
        if($name.Length -gt 4096){throw '原生确认文本超限'}
        if($name -ceq $text){$body++}
        if($name -cnotin @('恢复并重新启动','取消')){continue}
        $window=[IntPtr]$value.get_NativeWindowHandle()
        if($value.get_ProcessId() -ne $ProcessId -or $value.get_ClassName() -cne 'Button' -or
           $window -eq [IntPtr]::Zero -or -not $value.get_IsEnabled() -or $value.get_IsOffscreen()){
            throw '原生确认动作控件资格不符'
        }
        $record=[pscustomobject]@{Element=$node;Handle=$window;Name=$name}
        if($name -ceq '取消'){$cancel.Add($record)}else{$approve.Add($record)}
    }
    if($body -ne 1 -or $approve.Count -ne 1 -or $cancel.Count -ne 1){throw '原生确认正文或动作不唯一'}
    Check-Time
    return [pscustomobject]@{Approve=$approve[0];Cancel=$cancel[0]}
}
$output=$null
try {
    if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess -or
       [Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA){throw '原生确认需要既有64位STA PowerShell'}
    if(($Scene -ceq 'R' -and ($Transition -ne 1 -or $Purpose -cne 'restore')) -or
       ($Scene -ceq 'P' -and (($Transition -eq 1 -and $Purpose -cne 'partial') -or ($Transition -eq 2 -and $Purpose -cne 'restore')))){
        throw '原生确认场景与目的不符'
    }
    $repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
    $Journal=[IO.Path]::GetFullPath($Journal)
    if([IO.Path]::GetDirectoryName($Journal) -cne (Join-Path $repository 'log/stage7-e1/disposable-profile') -or
       [IO.Path]::GetFileName($Journal) -cnotmatch '^journal-[a-f0-9]{32}$'){throw '原生确认不是固定journal'}
    $directory=Join-Path $Journal 'runner-output/restore-native'
    Check-Parents $directory
    $prefix=Join-Path $directory ($Scene+'-t'+$Transition+'-a'+$ActionSequence)
    Write-New ($prefix+'-start.json') @{version=1;scene=$Scene;transition=$Transition;actionSequence=$ActionSequence;purpose=$Purpose;action=$Action}
    $output=$prefix+'-native.json'
    Check-Time
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    Add-Type -Path @((Join-Path $PSScriptRoot '../../release/ProductWindow.cs'),(Join-Path $PSScriptRoot '../product-transfer/NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeRestoreConfirmation.cs'))
    Check-Time
    $owner=[IntPtr]$MainWindowHandle
    if($owner -eq [IntPtr]::Zero -or $owner -eq [IntPtr]::new(-1)){throw '原生确认owner无效'}
    $matches=[Collections.Generic.List[object]]::new()
    $owned=@([AIbrowseProductWindow]::OwnedTopLevelWindows($owner,32))
    if($owned.Count -ge 32){throw '原生确认owned窗口达到枚举上界'}
    foreach($handle in $owned) {
        Check-Time
        $dialog=[Windows.Automation.AutomationElement]::FromHandle($handle)
        if($dialog.get_Current().get_Name() -cne '确认恢复本地数据'){continue}
        $binding=Context $dialog $handle
        $matches.Add([pscustomobject]@{Dialog=$dialog;Handle=$handle;Binding=$binding})
    }
    if($matches.Count -ne 1){throw '原生恢复确认对话框不唯一'}
    $chosen=$matches[0]
    $binding=if($Action -ceq 'Approve'){$chosen.Binding.Approve}else{$chosen.Binding.Cancel}
    $controlId=[AIbrowseRestoreConfirmation]::ControlId($binding.Handle)
    $validate=[Action]{
        $current=Context $chosen.Dialog $chosen.Handle
        $candidate=if($Action -ceq 'Approve'){$current.Approve}else{$current.Cancel}
        if($candidate.Handle -ne $binding.Handle -or
           -not [Windows.Automation.Automation]::Compare($candidate.Element,$binding.Element)){
            throw '原生确认动作在执行前变化'
        }
    }
    $native=[AIbrowseRestoreConfirmation]::new($ProcessId,$CreatedFileTime,$Executable,$owner,$chosen.Handle,$binding.Handle,$controlId,$Purpose,($Action -ceq 'Approve'),$clock,$validate,$BudgetMs)
    $proof=$native.Act()
    $report.actionCount=$proof.actionCount
    $native.Dispose();$native=$null
    Check-Time
    $report.result=$proof.result
    $report.ok=$true
    $report.failure='none'
} catch {
    if($null -ne $native){$report.actionCount=$native.ActionCount}
    $report.ok=$false;$report.result='failed'
} finally {
    if($null -ne $native){try{$native.Dispose()}catch{$report.ok=$false;$report.result='failed';$report.failure='release-failed'}}
}
try {
    Check-Time
    $report.elapsedMs=$clock.ElapsedMilliseconds
    if($null -ne $output){Write-New $output $report}
    Check-Time
    if(-not $report.ok){exit 1}
    exit 0
} catch {exit 1}
