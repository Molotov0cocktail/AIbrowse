[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('OpenBackup', 'InspectSaveDialog', 'CancelSave', 'SaveBackup', 'WaitCancelled', 'WaitCompleted', 'Close')][string]$Action,
    [Parameter(Mandatory)][uint32]$ProcessId,
    [Parameter(Mandatory)][string]$CreatedFileTime,
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Output,
    [string]$Target = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot '..\..\release\ProductWindow.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'NativeSaveControl.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'NativeSaveButton.cs')
$clock = [Diagnostics.Stopwatch]::StartNew()
$phase = 'identity'
$diagnostic = [ordered]@{ version = 1; action = $Action; ok = $false; phase = $phase }
function Check-Time {
    if ($clock.ElapsedMilliseconds -ge 30000) { throw '产品界面动作超过固定期限' }
}
function Check-Process {
    Check-Time
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $CreatedFileTime -or
        -not [string]::Equals($p.MainModule.FileName, $Executable, [StringComparison]::OrdinalIgnoreCase)) { throw '产品进程身份变化' }
    return $p
}
function Wait-For([scriptblock]$Read) {
    while ($true) { Check-Time; $v = & $Read; if ($null -ne $v -and $v -ne $false) { return $v }; Start-Sleep -Milliseconds 100 }
}
function Descendants($Root) {
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [Collections.Generic.Queue[Windows.Automation.AutomationElement]]::new()
    $queue.Enqueue($Root)
    $all = [Collections.Generic.List[Windows.Automation.AutomationElement]]::new()
    while ($queue.Count -gt 0) {
        Check-Time
        $node = $queue.Dequeue()
        $child = $walker.GetFirstChild($node)
        while ($null -ne $child) {
            if ($all.Count -ge 512) { throw '界面可访问节点超出本场景预算' }
            $all.Add($child); $queue.Enqueue($child); $child = $walker.GetNextSibling($child)
        }
    }
    return $all.ToArray()
}
function Unique($Nodes, [scriptblock]$Test) {
    $matches = @($Nodes | Where-Object $Test)
    if ($matches.Count -gt 1) { throw '界面选择器不唯一，停止操作' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}
function Invoke-Button($Root, [string]$Name) {
    $button = Wait-For { Unique (Descendants $Root) { $_.Current.Name -ceq $Name -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled } }
    $pattern = $null
    if (-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw '按钮没有Invoke语义' }
    [void](Check-Process)
    if (-not $button.Current.IsEnabled -or $button.Current.Name -cne $Name) { throw '按钮动作前资格变化' }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
}
function Assert-Dialog($Dialog, [IntPtr]$Main) {
    [void](Check-Process)
    $hwnd = [IntPtr]$Dialog.Current.NativeWindowHandle
    [uint32]$ownerPid = 0
    [void][AIbrowseProductWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
    $class = [Text.StringBuilder]::new(256)
    [void][AIbrowseProductWindow]::GetClassName($hwnd, $class, $class.Capacity)
    if ($hwnd -eq [IntPtr]::Zero -or $hwnd -eq $Main -or
        [AIbrowseProductWindow]::GetWindow($hwnd, 4) -ne $Main -or $ownerPid -ne $ProcessId -or
        $Dialog.Current.Name -cne '保存本地数据备份' -or $class.ToString() -cne '#32770') { throw '原生保存窗口不满足精确所有权与标题' }
    return $hwnd
}
function Save-Dialog([IntPtr]$Main) {
    return Wait-For {
        $matches = @()
        foreach ($handle in [AIbrowseProductWindow]::OwnedTopLevelWindows($Main, 32)) {
            $node = [Windows.Automation.AutomationElement]::FromHandle($handle)
            if ($node.Current.Name -ceq '保存本地数据备份') { [void](Assert-Dialog $node $Main); $matches += $node }
        }
        if ($matches.Count -gt 1) { throw '原生保存窗口不唯一' }
        if ($matches.Count -eq 1) { return $matches[0] }
        return $null
    }
}
function Dialog-Button($Dialog, [string]$Id) {
    if ($Id -cnotin @('1', '2')) { throw '原生按钮ID不在固定集合' }
    $allowed = if ($Id -ceq '1') { @('保存', '保存(S)', '保存(&S)', 'Save', '&Save') } else { @('取消', 'Cancel') }
    $nodes = @(Descendants $Dialog)
    if ($nodes.Count -gt 511) { throw '原生按钮整树超过512节点' }
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($node in $nodes) {
        Check-Time
        # Explicit accessors fail closed on provider errors, including nonselected nodes.
        $current = $node.get_Current()
        if ($current.get_AutomationId() -cne $Id -or $current.get_ClassName() -cne 'Button') { continue }
        $window = [IntPtr]$current.get_NativeWindowHandle()
        $name = $current.get_Name()
        if ($current.get_ProcessId() -eq $ProcessId -and $current.get_IsEnabled() -and
            -not $current.get_IsOffscreen() -and $window -ne [IntPtr]::Zero -and $name -cin $allowed) {
            $matches.Add([pscustomobject]@{ Element = $node; Window = $window; Name = $name })
        }
    }
    Check-Time
    if ($matches.Count -ne 1) { throw '原生保存动作未取得唯一固定HWND按钮' }
    return $matches[0]
}
function Assert-NativeDialogButton($Binding, $Dialog, [IntPtr]$Main, [string]$Id, $Native) {
    [void](Assert-Dialog $Dialog $Main)
    $current = Dialog-Button $Dialog $Id
    if ($current.Window -ne $Binding.Window -or $current.Name -cne $Binding.Name -or
        -not [Windows.Automation.Automation]::Compare($current.Element, $Binding.Element)) {
        throw '原生按钮的UIA绑定变化'
    }
    $Native.Validate()
    Check-Time
}
function Get-ButtonAutomationIdClass([AllowNull()][string]$AutomationId) {
    if ([string]::IsNullOrEmpty($AutomationId)) { return 'empty' }
    if ($AutomationId -ceq '1') { return 'id-1' }
    if ($AutomationId -ceq '2') { return 'id-2' }
    return 'other'
}
function Get-ButtonNameClass([AllowNull()][string]$Name) {
    if ($Name -cin @('保存', '保存(S)', '保存(&S)', 'Save', '&Save')) { return 'save' }
    if ($Name -cin @('取消', 'Cancel')) { return 'cancel' }
    return 'other'
}
function Inspect-DialogButtons($Dialog, [IntPtr]$Main, $Diagnostic) {
    $state = [ordered]@{ version = 1; status = 'collecting'; scannedNodes = 0; candidateCount = 0; nodes = @() }
    $Diagnostic.saveButtonStructure = $state
    try {
        Check-Time
        $dialogWindow = Assert-Dialog $Dialog $Main
        $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
        $queue = [Collections.Generic.Queue[object]]::new()
        $queue.Enqueue($Dialog)
        $state.scannedNodes = 1
        $projection = [Collections.Generic.List[object]]::new()
        while ($queue.Count -gt 0) {
            Check-Time
            $parent = $queue.Dequeue()
            $child = $walker.GetFirstChild($parent)
            while ($null -ne $child) {
                Check-Time
                if ($state.scannedNodes -ge 512) { $state.status = 'tree-budget'; throw '按钮诊断整树节点超限' }
                $state.scannedNodes++
                # Explicit accessors propagate provider exceptions instead of treating failed properties as null.
                $current = $child.get_Current()
                $idClass = Get-ButtonAutomationIdClass ($current.get_AutomationId())
                $typeClass = if ($current.get_ControlType().get_ProgrammaticName() -ceq 'ControlType.Button') { 'button' } else { 'other' }
                $className = $current.get_ClassName()
                $windowClass = if ($className -ceq 'Button') { 'button' } elseif ([string]::IsNullOrEmpty($className)) { 'empty' } else { 'other' }
                if ($idClass -cin @('id-1', 'id-2') -or $typeClass -ceq 'button' -or $windowClass -ceq 'button') {
                    if ($projection.Count -ge 32) { $state.status = 'candidate-budget'; throw '按钮诊断候选超限' }
                    $pattern = $null
                    $hasInvokePattern = $child.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)
                    $projection.Add([ordered]@{
                        automationIdClass = $idClass; controlTypeClass = $typeClass; windowClass = $windowClass
                        nameClass = Get-ButtonNameClass ($current.get_Name())
                        sameProcess = $current.get_ProcessId() -eq $ProcessId
                        enabled = $current.get_IsEnabled(); offscreen = $current.get_IsOffscreen()
                        nativeHandlePresent = $current.get_NativeWindowHandle() -ne 0
                        invokePattern = $hasInvokePattern
                    })
                    $state.candidateCount = $projection.Count
                }
                $queue.Enqueue($child)
                $child = $walker.GetNextSibling($child)
            }
        }
        Check-Time
        if ((Assert-Dialog $Dialog $Main) -ne $dialogWindow) { throw '原生保存窗口身份变化' }
        Check-Time
        $state.nodes = $projection.ToArray()
        $state.status = 'complete'
    } catch {
        if ($state.status -ceq 'collecting') { $state.status = 'read-failed' }
        throw '原生按钮只读诊断失败，停止操作'
    }
}
function Get-FilenameAutomationIdClass([AllowNull()][string]$AutomationId) {
    if ([string]::IsNullOrEmpty($AutomationId)) { return 'empty' }
    if ($AutomationId -ceq '1001') { return 'id-1001' }
    if ($AutomationId -ceq 'FileNameControlHost') { return 'file-name-control-host' }
    return 'other'
}
function Get-FilenameStructureControlTypeClass([AllowNull()][string]$ProgrammaticName) {
    switch -CaseSensitive ($ProgrammaticName) {
        'ControlType.Edit' { return 'edit' }
        'ControlType.ComboBox' { return 'combo-box' }
        'ControlType.Pane' { return 'pane' }
        'ControlType.Custom' { return 'custom' }
        'ControlType.Group' { return 'group' }
        'ControlType.Window' { return 'window' }
        'ControlType.Button' { return 'button' }
        'ControlType.Text' { return 'text' }
        default { return 'other' }
    }
}
function Get-FilenameStructureWindowClass([AllowNull()][string]$ClassName) {
    if ([string]::IsNullOrEmpty($ClassName)) { return 'empty' }
    switch -CaseSensitive ($ClassName) {
        '#32770' { return 'dialog' }
        'Edit' { return 'edit' }
        'ComboBox' { return 'combo-box' }
        'ComboBoxEx32' { return 'combo-box-ex32' }
        'DirectUIHWND' { return 'direct-ui' }
        'DUIViewWndClassName' { return 'dui-view' }
        'FileNameControlHost' { return 'file-name-control-host' }
        'Button' { return 'button' }
        'Static' { return 'static' }
        default { return 'other' }
    }
}
function Inspect-FilenameHostStructure($Dialog, $Diagnostic, [bool]$ReturnBinding = $false) {
    $state = [ordered]@{
        version = 1; status = 'collecting'; scannedNodes = 0; hostCount = 0
        ancestorCount = 0; descendantCount = 0; nodes = @()
    }
    $Diagnostic.filenameHostStructure = $state
    try {
        Check-Time
        $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
        $records = [Collections.Generic.List[object]]::new()
        $records.Add([pscustomobject]@{ Element = $Dialog; Parent = -1; IdClass = Get-FilenameAutomationIdClass $Dialog.Current.AutomationId })
        $state.scannedNodes = 1
        $queue = [Collections.Generic.Queue[int]]::new()
        $queue.Enqueue(0)
        $hosts = [Collections.Generic.List[int]]::new()
        while ($queue.Count -gt 0) {
            Check-Time
            $parentIndex = $queue.Dequeue()
            $child = $walker.GetFirstChild($records[$parentIndex].Element)
            while ($null -ne $child) {
                Check-Time
                if ($records.Count -ge 512) { $state.status = 'tree-budget'; throw '文件名结构整树节点超限' }
                $index = $records.Count
                $idClass = Get-FilenameAutomationIdClass $child.Current.AutomationId
                $records.Add([pscustomobject]@{ Element = $child; Parent = $parentIndex; IdClass = $idClass })
                $state.scannedNodes = $records.Count
                if ($idClass -ceq 'file-name-control-host') { $hosts.Add($index); $state.hostCount = $hosts.Count }
                $queue.Enqueue($index)
                $child = $walker.GetNextSibling($child)
            }
        }
        if ($hosts.Count -ne 1) { $state.status = 'host-nonunique'; throw '文件名结构host不唯一' }
        $hostIndex = $hosts[0]
        $ancestors = [Collections.Generic.HashSet[int]]::new()
        $parentIndex = $records[$hostIndex].Parent
        while ($parentIndex -ge 0) {
            Check-Time
            if ($ancestors.Count -ge 8) { $state.status = 'ancestor-budget'; throw '文件名结构祖先超限' }
            [void]$ancestors.Add($parentIndex)
            $state.ancestorCount = $ancestors.Count
            $parentIndex = $records[$parentIndex].Parent
        }
        $subtree = [Collections.Generic.HashSet[int]]::new()
        [void]$subtree.Add($hostIndex)
        for ($index = $hostIndex + 1; $index -lt $records.Count; $index++) {
            Check-Time
            if (-not $subtree.Contains($records[$index].Parent)) { continue }
            if ($state.descendantCount -ge 16) { $state.status = 'descendant-budget'; throw '文件名结构后代超限' }
            [void]$subtree.Add($index)
            $state.descendantCount++
        }
        $projection = [Collections.Generic.List[object]]::new()
        $nativeCandidates = [Collections.Generic.List[object]]::new()
        $localIndices = [Collections.Generic.Dictionary[int,int]]::new()
        for ($index = 0; $index -lt $records.Count; $index++) {
            Check-Time
            if (-not $ancestors.Contains($index) -and -not $subtree.Contains($index)) { continue }
            $record = $records[$index]
            $node = $record.Element
            $localIndex = $projection.Count
            $localIndices.Add($index, $localIndex)
            $parent = if ($record.Parent -lt 0) { -1 } else { $localIndices[$record.Parent] }
            $pattern = $null
            $hasValuePattern = $node.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
            $readOnly = if ($hasValuePattern) { ([Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly } else { $null }
            $projection.Add([ordered]@{
                index = $localIndex; parent = $parent
                relation = if ($index -eq $hostIndex) { 'host' } elseif ($ancestors.Contains($index)) { 'ancestor' } else { 'descendant' }
                automationIdClass = $record.IdClass
                controlTypeClass = Get-FilenameStructureControlTypeClass $node.Current.ControlType.ProgrammaticName
                windowClass = Get-FilenameStructureWindowClass $node.Current.ClassName
                sameProcess = $node.Current.ProcessId -eq $ProcessId
                enabled = $node.Current.IsEnabled; offscreen = $node.Current.IsOffscreen
                valuePattern = $hasValuePattern; readOnly = $readOnly
            })
            if ($index -ne $hostIndex -and $subtree.Contains($index) -and
                $record.IdClass -ceq 'id-1001' -and $projection[$localIndex].windowClass -ceq 'edit') {
                $nativeCandidates.Add($node)
            }
        }
        Check-Time
        $state.nodes = $projection.ToArray()
        $state.status = 'complete'
        if ($ReturnBinding) {
            $selection = [ordered]@{ status = 'checking'; candidates = $nativeCandidates.Count; nativeHandlePresent = $false }
            $Diagnostic.filenameNativeSelection = $selection
            if ($nativeCandidates.Count -ne 1) { $selection.status = 'candidate-nonunique'; throw '文件名原生输入不唯一' }
            $hostNode = $records[$hostIndex].Element
            $inputNode = $nativeCandidates[0]
            $window = [IntPtr]$inputNode.Current.NativeWindowHandle
            $selection.nativeHandlePresent = $window -ne [IntPtr]::Zero
            if ($window -eq [IntPtr]::Zero -or $hostNode.Current.ProcessId -ne $ProcessId -or
                $inputNode.Current.ProcessId -ne $ProcessId -or -not $hostNode.Current.IsEnabled -or
                -not $inputNode.Current.IsEnabled -or $hostNode.Current.IsOffscreen -or $inputNode.Current.IsOffscreen) {
                $selection.status = 'uia-ineligible'; throw '文件名原生输入的UIA资格不符'
            }
            Check-Time
            $selection.status = 'uia-bound'
            return [pscustomobject]@{ Host = $hostNode; Element = $inputNode; Window = $window }
        }
    } catch {
        if ($state.status -ceq 'collecting') { $state.status = 'read-failed' }
        throw '文件名host结构诊断失败，停止操作'
    }
}
function Get-NativeFilenameInput($Dialog, $Diagnostic) {
    return Inspect-FilenameHostStructure $Dialog $Diagnostic $true
}
function Assert-NativeFilenameInput($Binding, $Dialog, [IntPtr]$Main, $Diagnostic, $Native) {
    [void](Assert-Dialog $Dialog $Main)
    $current = Get-NativeFilenameInput $Dialog $Diagnostic
    if ($current.Window -ne $Binding.Window -or
        -not [Windows.Automation.Automation]::Compare($current.Host, $Binding.Host) -or
        -not [Windows.Automation.Automation]::Compare($current.Element, $Binding.Element)) {
        throw '文件名原生输入的host关系或身份变化'
    }
    $Native.Validate()
    Check-Time
}
function Get-FilenameValueClass([AllowNull()][string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return 'empty' }
    if ($Value -ceq 'AIbrowse-backup.aibak') { return 'exact-default' }
    if ($Value -ceq 'AIbrowse-backup') { return 'exact-stem' }
    return 'other'
}
function New-FilenameControlTypeDiagnostic {
    return [ordered]@{
        total = 0
        enabled = 0
        valuePattern = 0
        writableValuePattern = 0
        value = [ordered]@{ empty = 0; exactDefault = 0; exactStem = 0; other = 0 }
        automationId = [ordered]@{ empty = 0; id1001 = 0; fileNameControlHost = 0; other = 0 }
    }
}
function New-FilenameQualificationDiagnostic {
    return [ordered]@{
        version = 1
        scannedNodes = 0
        controlType = [ordered]@{
            edit = New-FilenameControlTypeDiagnostic
            comboBox = New-FilenameControlTypeDiagnostic
            other = New-FilenameControlTypeDiagnostic
        }
        qualifiedCandidate = 0
    }
}
function Add-FilenameQualificationObservation(
    $State,
    [string]$ControlTypeClass,
    [AllowNull()][string]$AutomationId,
    [bool]$IsEnabled,
    [bool]$HasValuePattern,
    [AllowNull()]$IsReadOnly,
    [AllowNull()][string]$Value
) {
    $State.scannedNodes++
    $type = if ($ControlTypeClass -cin @('edit', 'comboBox')) { $ControlTypeClass } else { 'other' }
    $row = $State.controlType[$type]
    $row.total++
    switch (Get-FilenameAutomationIdClass $AutomationId) {
        'empty' { $row.automationId.empty++ }
        'id-1001' { $row.automationId.id1001++ }
        'file-name-control-host' { $row.automationId.fileNameControlHost++ }
        default { $row.automationId.other++ }
    }
    if ($IsEnabled) { $row.enabled++ }
    if (-not $HasValuePattern) { return }
    $row.valuePattern++
    if ($IsReadOnly -eq $false) { $row.writableValuePattern++ }
    $valueClass = Get-FilenameValueClass $Value
    switch ($valueClass) {
        'empty' { $row.value.empty++ }
        'exact-default' { $row.value.exactDefault++ }
        'exact-stem' { $row.value.exactStem++ }
        default { $row.value.other++ }
    }
    if ($type -ceq 'edit' -and $IsEnabled -and $IsReadOnly -eq $false -and $valueClass -ceq 'exact-default') {
        $State.qualifiedCandidate++
    }
}
function Filename-Input($Dialog, $Diagnostic) {
    $candidates = @()
    $qualification = New-FilenameQualificationDiagnostic
    foreach ($node in @(Descendants $Dialog)) {
        $type = $node.Current.ControlType
        $typeClass = if ($type -eq [Windows.Automation.ControlType]::Edit) { 'edit' } elseif ($type -eq [Windows.Automation.ControlType]::ComboBox) { 'comboBox' } else { 'other' }
        $automationId = $node.Current.AutomationId
        $isEnabled = $node.Current.IsEnabled
        $pattern = $null
        $hasValuePattern = $node.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        $isReadOnly = $null
        $value = $null
        if ($hasValuePattern) {
            $isReadOnly = ([Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly
            $value = ([Windows.Automation.ValuePattern]$pattern).Current.Value
        }
        $valueClass = Get-FilenameValueClass $value
        Add-FilenameQualificationObservation $qualification $typeClass $automationId $isEnabled $hasValuePattern $isReadOnly $value
        if ($typeClass -ceq 'edit' -and $isEnabled -and $hasValuePattern -and $isReadOnly -eq $false -and $valueClass -ceq 'exact-default') {
            $candidates += [pscustomobject]@{ Element = $node; Pattern = $pattern }
        }
    }
    $Diagnostic.filenameQualification = $qualification
    if ($candidates.Count -ne 1) { throw '文件名输入未取得唯一默认值与ValuePattern资格' }
    return $candidates[0]
}
try {
    $process = Check-Process
    $handle = Wait-For { $process.Refresh(); if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $process.MainWindowHandle } }
    $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($root.Current.ProcessId -ne $ProcessId -or $root.Current.Name -cne 'AIbrowse') { throw '产品主窗口身份不符' }
    $phase = $Action
    switch ($Action) {
        'OpenBackup' {
            $shown = Unique (Descendants $root) { $_.Current.Name -ceq '备份本地数据' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and -not $_.Current.IsOffscreen }
            if ($null -eq $shown) {
                $summary = Wait-For { Unique (Descendants $root) { $_.Current.Name -ceq '本地数据' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button } }
                $pattern = $null
                if ($summary.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { ([Windows.Automation.ExpandCollapsePattern]$pattern).Expand() }
                elseif ($summary.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { ([Windows.Automation.InvokePattern]$pattern).Invoke() }
                else { throw '本地数据折叠控件未取得语义动作资格' }
            }
            Invoke-Button $root '备份本地数据'
            [void](Save-Dialog $handle)
        }
        { $_ -in @('InspectSaveDialog', 'CancelSave', 'SaveBackup') } {
            $dialog = Save-Dialog $handle
            $hwnd = Assert-Dialog $dialog $handle
            $binding = Get-NativeFilenameInput $dialog $diagnostic
            $native = [AIbrowseNativeSaveControl]::new($ProcessId, $CreatedFileTime, $Executable, $handle, $hwnd, $binding.Window, $clock)
            try {
                Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                $initialClass = Get-FilenameValueClass ($native.ReadText())
                $diagnostic.filenameInitialValueClass = $initialClass
                Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                if ($initialClass -cne 'exact-default' -and $initialClass -cne 'exact-stem') { throw '原生文件名初值未通过闭合默认名资格' }
                $save = Dialog-Button $dialog '1'
                $cancel = Dialog-Button $dialog '2'
                $saveNative = $null; $cancelNative = $null
                try {
                    $saveNative = [AIbrowseNativeSaveButton]::new($ProcessId, $CreatedFileTime, $Executable, $handle, $hwnd, $save.Window, 1, $save.Name, $clock)
                    $cancelNative = [AIbrowseNativeSaveButton]::new($ProcessId, $CreatedFileTime, $Executable, $handle, $hwnd, $cancel.Window, 2, $cancel.Name, $clock)
                    Assert-NativeDialogButton $save $dialog $handle '1' $saveNative
                    $saveProof = $saveNative.Inspect()
                    Assert-NativeDialogButton $cancel $dialog $handle '2' $cancelNative
                    $cancelProof = $cancelNative.Inspect()
                    $diagnostic.dialog = @{ hwnd = $hwnd.ToInt64(); owner = $handle.ToInt64(); processId = $ProcessId; filenameIdClass = Get-FilenameAutomationIdClass $binding.Element.Current.AutomationId; filenameControlType = 'native-edit'; saveName = $save.Name; cancelName = $cancel.Name; mechanism = 'Win32 fixed text / MSAA default action'; saveButton = $saveProof; cancelButton = $cancelProof }
                    if ($Action -eq 'SaveBackup') {
                        Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                        $native.WriteTarget($Target)
                        Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                        if ($native.ReadText() -cne $Target) { throw '原生文件名读回不匹配' }
                        Assert-NativeDialogButton $save $dialog $handle '1' $saveNative
                        Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                        if ($native.ReadText() -cne $Target) { throw '原生文件名在提交前变化' }
                        Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                        $diagnostic.buttonAction = $saveNative.Act()
                    } elseif ($Action -eq 'CancelSave') {
                        Assert-NativeFilenameInput $binding $dialog $handle $diagnostic $native
                        Assert-NativeDialogButton $cancel $dialog $handle '2' $cancelNative
                        $diagnostic.buttonAction = $cancelNative.Act()
                    }
                } finally {
                    if ($null -ne $cancelNative) { $cancelNative.Dispose() }
                    if ($null -ne $saveNative) { $saveNative.Dispose() }
                }
            } finally { $native.Dispose() }
        }
        { $_ -in @('WaitCancelled', 'WaitCompleted') } {
            $expected = if ($Action -eq 'WaitCancelled') { '操作已取消' } else { '备份已完整保存，原数据业务已恢复' }
            [void](Wait-For { Unique (Descendants $root) { $_.Current.Name -ceq $expected -and -not $_.Current.IsOffscreen } })
            [void](Wait-For { Unique (Descendants $root) { $_.Current.Name -ceq '备份本地数据' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled } })
        }
        'Close' {
            [void](Check-Process)
            $pattern = $null
            if (-not $root.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { throw '主窗口没有Window.Close语义' }
            ([Windows.Automation.WindowPattern]$pattern).Close()
        }
    }
    Check-Time
    $diagnostic.ok = $true
} catch {
    $diagnostic.phase = $phase
    $diagnostic.failure = '固定UI动作未通过；窗口及原件保留'
    $diagnostic.errorType = $_.Exception.GetType().FullName
    throw
} finally {
    $diagnostic.elapsedMs = $clock.ElapsedMilliseconds
    $stream = [IO.File]::Open($Output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($diagnostic | ConvertTo-Json -Depth 5)); $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    Check-Time
}
