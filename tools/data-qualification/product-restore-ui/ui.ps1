[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('R','P')][string]$Scene,
    [Parameter(Mandatory)][ValidateRange(1,32)][int]$ActionSequence,
    [Parameter(Mandatory)][ValidateSet('BootHealthy','BootPartial','BootRecovery','OpenBackup','SaveBackup','WaitBackupCompleted','OpenRestore','CancelOpen','SelectRestore','WaitCancelled','OpenPartial','ReadSources','ReadResearch','ReadWatch','ReadConversation','Close')][string]$Action,
    [Parameter(Mandatory)][uint32]$ProcessId,
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{0,18}$')][string]$CreatedFileTime,
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Journal,
    [Parameter(Mandatory)][ValidateRange(1,30000)][int]$BudgetMs,
    [string]$Target='',
    [ValidateSet('','A','B','H')][string]$Variant=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$startedTick=[Diagnostics.Stopwatch]::GetTimestamp()
$clock=[Diagnostics.Stopwatch]::StartNew()
$output=$null;$main=[IntPtr]::Zero;$process=$null;$inputLease=$null
$report=[ordered]@{version=1;scene=$Scene;actionSequence=$ActionSequence;action=$Action;ok=$false;identity=@{pid=$ProcessId;created=$CreatedFileTime;image=$Executable};mainWindowHandle='0';elapsedMs=0;failure='ui-failed'}
function Check-Time { if($clock.ElapsedMilliseconds -ge $BudgetMs){throw '界面动作原期限已过'} }
function Assert-Request([string]$Repository) {
    if([IO.Path]::GetDirectoryName($Journal) -cne (Join-Path $Repository 'log/stage7-e1/disposable-profile') -or
       [IO.Path]::GetFileName($Journal) -cnotmatch '^journal-[a-f0-9]{32}$'){throw '界面工具不是固定journal'}
    $needsTarget=$Action -cin @('SaveBackup','SelectRestore');$needsVariant=$Action.StartsWith('Read',[StringComparison]::Ordinal)
    if($needsTarget -ne (-not [string]::IsNullOrEmpty($Target)) -or $needsVariant -ne (-not [string]::IsNullOrEmpty($Variant))){throw '界面动作参数组合无效'}
    if(($Scene -ceq 'P' -and $Action -cin @('OpenBackup','SaveBackup','WaitBackupCompleted')) -or
       ($Scene -ceq 'R' -and $Action -cin @('BootPartial','BootRecovery','OpenPartial'))){throw '界面动作不属于本场'}
    if($needsVariant -and $Variant -cne $(if($Scene -ceq 'R'){'A'}else{'H'})){throw '界面域标记不属于本场'}
    if($needsTarget) {
        $expected=[IO.Path]::GetFullPath((Join-Path $Journal ('runner-output/restore-campaign/'+$(if($Scene -ceq 'R'){'product-A.aibak'}else{'synthetic-H.aibak'}))))
        if($Target -cne $expected){throw '界面文件目标不是固定路径'}
    }
}
function Cancelled-Text {
    if($Scene -ceq 'P' -and $ActionSequence -eq 4){return '已取消重新启动，原数据业务保持关闭'}
    return '操作已取消'
}
function Check-Parents([string]$Path) {
    for($current=$Path;-not [string]::IsNullOrEmpty($current);$current=[IO.Path]::GetDirectoryName($current)) {
        $entry=Get-Item -LiteralPath $current -Force
        if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '界面目录不是固定普通目录'}
    }
}
function Write-New([string]$Path,$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 4 -Compress))
    if($bytes.Length -gt 65536){throw '界面回执超限'}
    $file=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Check-Process {
    Check-Time
    $process.Refresh()
    if($process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $CreatedFileTime -or
       -not [string]::Equals($process.MainModule.FileName,$Executable,[StringComparison]::OrdinalIgnoreCase)){throw '产品进程身份变化'}
    Check-Time
}
function Wait-For([scriptblock]$Read) {
    while($true){Check-Process;$value=& $Read;Check-Time;if($null -ne $value -and $value -ne $false){return $value};Start-Sleep -Milliseconds 50}
}
function Tree-Walker { return [Windows.Automation.TreeWalker]::ControlViewWalker }
function Nodes($Root,[int]$Maximum=512) {
    if($Maximum -lt 1 -or $Maximum -gt 512){throw '产品界面节点额度无效'}
    Check-Time
    if($Root.get_Current().get_Name().Length -gt 4096){throw '产品界面根文本超限'}
    $list=[Collections.Generic.List[object]]::new();$list.Add($Root)
    $walker=Tree-Walker
    for($i=0;$i -lt $list.Count;$i++) {
        Check-Time;$child=$walker.GetFirstChild($list[$i])
        while($null -ne $child) {
            Check-Time
            if($list.Count -ge $Maximum){throw '产品界面树超限'}
            if($child.get_Current().get_Name().Length -gt 4096){throw '产品界面文本超限'}
            $list.Add($child);$child=$walker.GetNextSibling($child)
        }
    }
    Check-Time;return $list.ToArray()
}
function Unique($Items,[scriptblock]$Predicate) {
    $found=@($Items|Where-Object $Predicate)
    if($found.Count -gt 1){throw '产品界面选择器不唯一'}
    if($found.Count -eq 1){return $found[0]};return $null
}
function Root {
    Check-Process
    $node=[Windows.Automation.AutomationElement]::FromHandle($main)
    $value=$node.get_Current()
    if($value.get_ProcessId() -ne $ProcessId -or $value.get_Name() -cne 'AIbrowse' -or
       $value.get_NativeWindowHandle() -ne $main.ToInt64()){throw '产品主窗口绑定变化'}
    Check-Time;return $node
}
function Button([string]$Name,[bool]$Enabled=$true) {
    return Wait-For { Unique (Nodes (Root)) {
        $v=$_.get_Current();$v.get_Name() -ceq $Name -and $v.get_ControlType() -eq [Windows.Automation.ControlType]::Button -and
        -not $v.get_IsOffscreen() -and $v.get_IsEnabled() -eq $Enabled
    } }
}
function Invoke-Node($Node) {
    Check-Process
    $value=$Node.get_Current()
    if(-not $value.get_IsEnabled() -or $value.get_IsOffscreen()){throw '产品按钮动作前已失效'}
    $pattern=$null
    if(-not $Node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw '产品按钮没有Invoke语义'}
    Check-Time;([Windows.Automation.InvokePattern]$pattern).Invoke();Check-Time
}
function Invoke-Button([string]$Name) { Invoke-Node (Button $Name) }
function Has-Text([string]$Text) {
    return @((Nodes (Root))|Where-Object {$_.get_Current().get_Name() -ceq $Text -and -not $_.get_Current().get_IsOffscreen()}).Count -gt 0
}
function Wait-Text([string]$Text) { [void](Wait-For { Has-Text $Text }) }
function Local-Data {
    $visible=Unique (Nodes (Root)) {$_.get_Current().get_Name() -ceq '选择备份恢复' -and -not $_.get_Current().get_IsOffscreen()}
    if($null -ne $visible){return}
    $summary=Button '本地数据';$pattern=$null
    Check-Process
    if($summary.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) {
        ([Windows.Automation.ExpandCollapsePattern]$pattern).Expand();Check-Time
    } else { Invoke-Node $summary }
    [void](Wait-For { Unique (Nodes (Root)) {$_.get_Current().get_Name() -ceq '选择备份恢复' -and -not $_.get_Current().get_IsOffscreen()} })
}
function Dialog([bool]$Open) {
    $title=if($Open){'选择要恢复的 AIbrowse 备份'}else{'保存本地数据备份'}
    return Wait-For {
        $windows=@([AIbrowseProductWindow]::OwnedTopLevelWindows($main,32))
        if($windows.Count -ge 32){throw '产品owned窗口枚举达到上界'}
        $found=[Collections.Generic.List[object]]::new()
        foreach($handle in $windows) {
            Check-Time;$node=[Windows.Automation.AutomationElement]::FromHandle($handle);$v=$node.get_Current()
            if($v.get_Name() -cne $title){continue}
            if($v.get_ProcessId() -ne $ProcessId -or $v.get_ClassName() -cne '#32770' -or
               [AIbrowseProductWindow]::GetWindow($handle,4) -ne $main){throw '原生文件对话框绑定失配'}
            $found.Add([pscustomobject]@{Node=$node;Handle=$handle})
        }
        if($found.Count -gt 1){throw '原生文件对话框不唯一'}
        if($found.Count -eq 1){return $found[0]};return $null
    }
}
function Native-Button($Dialog,[bool]$Open,[bool]$Cancel) {
    Check-Time
    $id=if($Cancel){'2'}else{'1'}
    $names=if($Cancel){@('取消','Cancel')}elseif($Open){@('打开','打开(O)','打开(&O)','Open','&Open')}else{@('保存','保存(S)','保存(&S)','Save','&Save')}
    $found=Unique (Nodes $Dialog.Node) {
        $v=$_.get_Current();$v.get_AutomationId() -ceq $id -and $v.get_ClassName() -ceq 'Button' -and
        $v.get_Name() -cin $names -and $v.get_ProcessId() -eq $ProcessId -and $v.get_NativeWindowHandle() -ne 0 -and
        $v.get_IsEnabled() -and -not $v.get_IsOffscreen()
    }
    if($null -eq $found){throw '原生文件按钮未取得完整资格'}
    Check-Time
    return $found
}
function Filename($Dialog) {
    $all=@(Nodes $Dialog.Node)
    $hostNode=Unique $all {$_.get_Current().get_AutomationId() -ceq 'FileNameControlHost'}
    if($null -eq $hostNode){throw '文件名host不唯一'}
    $walker=Tree-Walker;$ancestor=$hostNode;$depth=0
    while(-not [Windows.Automation.Automation]::Compare($ancestor,$Dialog.Node)) {
        if(++$depth -gt 8){throw '文件名host祖先超限'}
        $ancestor=$walker.GetParent($ancestor);if($null -eq $ancestor){throw '文件名host脱离dialog'}
    }
    $children=@(Nodes $hostNode 17)
    $edit=Unique $children {$_.get_Current().get_AutomationId() -ceq '1001' -and $_.get_Current().get_ClassName() -ceq 'Edit'}
    if($null -eq $edit){throw '文件名Edit不唯一'}
    foreach($node in @($hostNode,$edit)) {
        $v=$node.get_Current()
        if($v.get_ProcessId() -ne $ProcessId -or -not $v.get_IsEnabled() -or $v.get_IsOffscreen()){throw '文件名节点资格无效'}
    }
    if($edit.get_Current().get_NativeWindowHandle() -eq 0){throw '文件名Edit句柄为空'}
    return $edit
}
function Check-Input {
    if($null -eq $inputLease){return}
    Check-Time;$inputLease.Position=0
    if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($inputLease)) -cne $inputHash){throw '恢复输入变化'}
    $inputLease.Position=0;Check-Time
}
function Select-File([bool]$Open,[bool]$Cancel) {
    $dialog=Dialog $Open;$edit=$null;$button=$null
    try {
        # Shift the 30-second helper origin by the caller's already consumed allowance.
        $origin=$startedTick-[long]([decimal](30000-$BudgetMs)*[Diagnostics.Stopwatch]::Frequency/1000)
        $deadline=[AIbrowseSelectionDeadline]::new($origin,[Diagnostics.Stopwatch]::Frequency)
        if(-not $Cancel) {
            $node=Filename $dialog
            $edit=[AIbrowseProductFileSelection]::new($ProcessId,$CreatedFileTime,$Executable,$main,$dialog.Handle,[IntPtr]$node.get_Current().get_NativeWindowHandle(),$deadline,$Open)
            $initial=$edit.ReadText();Check-Time;Check-Input
            $edit.ReplaceOnce($Target,$initial);Check-Time
            $current=Filename $dialog
            if(-not [Windows.Automation.Automation]::Compare($node,$current) -or $edit.ReadText() -cne $Target){throw '文件名提交前绑定或值变化'}
        }
        $node=Native-Button $dialog $Open $Cancel;$v=$node.get_Current()
        if($Cancel) {
            $button=[AIbrowseProductFileCancel]::new($ProcessId,$CreatedFileTime,$Executable,$main,$dialog.Handle,[IntPtr]$v.get_NativeWindowHandle(),$v.get_Name(),$deadline)
        } else {
            $button=[AIbrowseSelectionButton]::new($ProcessId,$CreatedFileTime,$Executable,$main,$dialog.Handle,[IntPtr]$v.get_NativeWindowHandle(),$v.get_Name(),$Open,$deadline)
        }
        [void]$button.Inspect();Check-Time;Check-Process;Check-Input
        $current=Native-Button $dialog $Open $Cancel
        if(-not [Windows.Automation.Automation]::Compare($node,$current)){throw '文件按钮动作前绑定变化'}
        if($null -ne $edit -and $edit.ReadText() -cne $Target){throw '文件名最终完整值失配'}
        Check-Time;$button.Act();Check-Time;Check-Input
    } finally {
        if($null -ne $button){$button.Dispose()}
        if($null -ne $edit){$edit.Dispose()}
    }
}
try {
    if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess -or
       [Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA){throw '界面工具需要64位STA PowerShell'}
    $repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'));$Journal=[IO.Path]::GetFullPath($Journal)
    Assert-Request $repository
    $directory=Join-Path $Journal 'runner-output/restore-ui';Check-Parents $directory
    if($Action -cin @('SaveBackup','SelectRestore')) {
        Check-Parents ([IO.Path]::GetDirectoryName($Target))
        if($Action -ceq 'SaveBackup') {if(Test-Path -LiteralPath $Target){throw '保存目标已存在'}}
        else {
            $entry=Get-Item -LiteralPath $Target -Force
            if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '恢复输入不是普通文件'}
            $inputLease=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            if($inputLease.Length -le 0 -or $inputLease.Length -gt 16MB){throw '小恢复输入超限'}
            $inputHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($inputLease));$inputLease.Position=0
        }
    }
    $prefix=Join-Path $directory ($Scene+'-a'+$ActionSequence)
    Write-New ($prefix+'-start.json') @{version=1;scene=$Scene;actionSequence=$ActionSequence;action=$Action}
    $output=$prefix+'.json';Check-Time
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    Add-Type -Path @((Join-Path $PSScriptRoot '../../release/ProductWindow.cs'),(Join-Path $PSScriptRoot '../product-transfer/NativeSaveControl.cs'),(Join-Path $PSScriptRoot '../product-transfer/NativeSaveButton.cs'),(Join-Path $PSScriptRoot '../native-file-selection/NativeSelectionEdit.cs'),(Join-Path $PSScriptRoot 'NativeProductFileSelection.cs'))
    $process=[Diagnostics.Process]::GetProcessById($ProcessId)
    $main=[IntPtr](Wait-For { $process.Refresh();if($process.MainWindowHandle -ne [IntPtr]::Zero){return $process.MainWindowHandle};return $null })
    [void](Root);$report.mainWindowHandle=$main.ToInt64().ToString()
    switch($Action) {
        'BootHealthy' { Local-Data;Wait-Text '尚未开始数据维护';[void](Button '备份本地数据');[void](Button '选择备份恢复') }
        'BootPartial' { Local-Data;Wait-Text '本地数据服务未完整启动。恢复需要先关闭标签页并重新启动，再选择备份。';[void](Button '备份本地数据' $false);[void](Button '选择备份恢复') }
        'BootRecovery' { Local-Data;Wait-Text '本地数据需要恢复。请选择备份；原件和失败现场将保留。';[void](Button '备份本地数据' $false);[void](Button '选择备份恢复') }
        'OpenBackup' { Local-Data;Invoke-Button '备份本地数据';[void](Dialog $false) }
        'SaveBackup' { Select-File $false $false }
        'WaitBackupCompleted' { Wait-Text '备份已完整保存，原数据业务已恢复';[void](Button '备份本地数据') }
        'OpenRestore' { Local-Data;Invoke-Button '选择备份恢复';[void](Dialog $true) }
        'CancelOpen' { Select-File $true $true }
        'SelectRestore' { Select-File $true $false }
        'WaitCancelled' {
            Wait-Text (Cancelled-Text);[void](Button '选择备份恢复')
        }
        'OpenPartial' { Local-Data;Invoke-Button '选择备份恢复' }
        'ReadSources' { Invoke-Button '信源面板';[void](Button ('恢复夹具'+$Variant));Wait-Text ('https://example.invalid/restore-'+$Variant+'/') }
        'ReadResearch' {
            Invoke-Button '研究面板';$marker='恢复夹具'+$Variant
            $node=Wait-For {Unique (Nodes (Root)) {$_.get_Current().get_Name() -ceq $marker -and $_.get_Current().get_ControlType() -eq [Windows.Automation.ControlType]::Text}}
            $walker=Tree-Walker;$depth=0
            while($node.get_Current().get_ControlType() -ne [Windows.Automation.ControlType]::Button) {
                if(++$depth -gt 4){throw '研究条目按钮层级超限'};$node=$walker.GetParent($node);if($null -eq $node){throw '研究条目按钮缺失'}
            }
            Invoke-Node $node;Invoke-Button '打开结果';Wait-Text ($marker+'研究结论')
        }
        'ReadWatch' { Invoke-Button '监控工作区';Invoke-Button '规则';Wait-Text ('恢复夹具'+$Variant);Wait-Text '状态：paused / user / 未静音';Invoke-Button '← 返回浏览' }
        'ReadConversation' { Invoke-Button 'AI 侧栏';Invoke-Button ('恢复夹具'+$Variant);Wait-Text ('恢复夹具'+$Variant+'问题');Wait-Text ('恢复夹具'+$Variant+'回答') }
        'Close' {
            $node=Root;$pattern=$null
            if(-not $node.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern,[ref]$pattern)){throw '主窗口没有Close语义'}
            Check-Time;([Windows.Automation.WindowPattern]$pattern).Close();Check-Time
        }
    }
    Check-Time;$report.ok=$true;$report.failure='none'
} catch { $report.ok=$false;$report.failure='ui-failed' }
finally {
    if($null -ne $inputLease){$inputLease.Dispose()}
    if($null -ne $process){$process.Dispose()}
    $report.elapsedMs=$clock.ElapsedMilliseconds
    if($report.elapsedMs -ge $BudgetMs){$report.ok=$false;$report.failure='ui-deadline'}
    if($null -ne $output){Write-New $output $report}
}
if(-not $report.ok){exit 1}
try{Check-Time}catch{exit 1}
exit 0
