[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'ConfigureCancel', 'ConfigureConfirm', 'VerifyRestartedState', 'SubmitPrompt', 'Minimize', 'VerifyRestoredForeground')][string]$Action,
    [Parameter(Mandatory)][int]$ProcessId,
    [Parameter(Mandatory)][string]$Output,
    [string]$BaseUrl = '',
    [string]$Model = '',
    [string]$Question = '',
    [string]$ResponseMarker = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'ProductWindow.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ProductAccessibleAction.cs')
. (Join-Path $PSScriptRoot 'product-ui-selectors.ps1')

function Wait-Until([scriptblock]$Condition, [string]$Failure, [int]$TimeoutMs = 15000) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
        $value = & $Condition
        if ($null -ne $value -and $value -ne $false) { return $value }
        Start-Sleep -Milliseconds 100
    }
    throw $Failure
}

function Get-MainWindow {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $process.Refresh()
    $handle = Wait-Until {
        $process.Refresh()
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $process.MainWindowHandle } else { $null }
    } '未发现产品主窗口'
    return [pscustomobject]@{
        Handle = [IntPtr]$handle
        Root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    }
}

function Find-ByName([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $condition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::NameProperty,
        $Name
    )
    return $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-NameContaining([Windows.Automation.AutomationElement]$Root, [string]$Text) {
    foreach ($element in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        try {
            if ($element.Current.Name -like "*$Text*") { return $element }
        } catch { }
    }
    return $null
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

function Invoke-Named([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    Invoke-NamedButton $Root $Name
}

function Wait-NativeDialog([IntPtr]$Owner, [string]$ExpectedBaseUrl) {
    return Wait-Until {
        $matches = @()
        foreach ($handle in [AIbrowseProductWindow]::OwnedTopLevelWindows($Owner, 16)) {
            $candidate = $null
            try { $candidate = [Windows.Automation.AutomationElement]::FromHandle($handle) } catch { continue }
            if ([IntPtr]$candidate.Current.NativeWindowHandle -ne $handle) { continue }
            $hasTitle = $candidate.Current.Name -eq '确认 API Key 的发送目标' -or $null -ne (Find-ByName $candidate '确认 API Key 的发送目标')
            $candidateHandle = [IntPtr]$candidate.Current.NativeWindowHandle
            $qualifies = $hasTitle -and (Test-ExactDialogTarget $candidate $ExpectedBaseUrl) -and $null -ne (Find-UniqueNativeDialogAction $candidate $candidateHandle '取消') -and $null -ne (Find-UniqueNativeDialogAction $candidate $candidateHandle '确认发送目标')
            if ($qualifies) { $matches += $candidate }
        }
        if ($matches.Count -gt 1) { throw '存在多个符合固定内容与owner的原生确认对话框' }
        if ($matches.Count -eq 1) { return $matches[0] }
        return $null
    } '未发现由产品主窗口拥有的原生确认对话框'
}

function Write-Result([hashtable]$Result) {
    $directory = Split-Path -Parent ([IO.Path]::GetFullPath($Output))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $Result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Output -Encoding utf8NoBOM
}

function Get-BoundedNames([Windows.Automation.AutomationElement]$Root) {
    $names = @()
    foreach ($element in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        if ($names.Count -ge 160) { break }
        try {
            $name = $element.Current.Name
            if ($name -ne '') { $names += $name }
        } catch { }
    }
    return $names
}

function Get-WindowClass([IntPtr]$Handle) {
    $builder = [Text.StringBuilder]::new(256)
    [void][AIbrowseProductWindow]::GetClassName($Handle, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Get-WindowProcessId([IntPtr]$Handle) {
    [uint32]$windowProcessId = 0
    [void][AIbrowseProductWindow]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId)
    return $windowProcessId
}

function Assert-NativeDialogOwnership([Windows.Automation.AutomationElement]$Dialog, [IntPtr]$MainHandle) {
    $handle = [IntPtr]$Dialog.Current.NativeWindowHandle
    $owner = [AIbrowseProductWindow]::GetWindow($handle, 4)
    $windowProcessId = Get-WindowProcessId $handle
    if ($handle -eq [IntPtr]::Zero -or $handle -eq $MainHandle -or $owner -ne $MainHandle -or $windowProcessId -eq 0) {
        throw '原生确认对话框HWND、owner或PID复验失败'
    }
    return [ordered]@{
        Handle = $handle
        Owner = $owner
        ProcessId = $windowProcessId
        Class = Get-WindowClass $handle
    }
}

function Get-BoundedTopLevelWindows([IntPtr]$Owner) {
    $windows = @()
    if ($Owner -eq [IntPtr]::Zero) { return $windows }
    foreach ($handle in @($Owner) + @([AIbrowseProductWindow]::OwnedTopLevelWindows($Owner, 31))) {
        try {
            $ownerHandle = [AIbrowseProductWindow]::GetWindow($handle, 4)
            $windowProcessId = Get-WindowProcessId $handle
            $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
            $windows += [ordered]@{
                title = $window.Current.Name
                nativeWindowHandle = $handle.ToInt64()
                ownerWindowHandle = $ownerHandle.ToInt64()
                processId = $windowProcessId
                windowClass = Get-WindowClass $handle
            }
        } catch { }
    }
    return $windows
}

$main = $null
try {
    $main = Get-MainWindow
    switch ($Action) {
    'Snapshot' {
        $initialNames = @(Get-BoundedNames $main.Root)
        Write-Result @{
            ok = $false
            diagnostic = $true
            action = $Action
            phase = 'initial'
            windowTitle = $main.Root.Current.Name
            windowHandle = $main.Handle.ToInt64()
            accessibleNames = $initialNames
        }
        if ($main.Root.Current.Name -notlike '*AIbrowse*') { throw '产品主窗口标题不匹配' }
        $openedAiPanel = $false
        if ($null -eq (Find-ByName $main.Root '设置')) {
            Invoke-Named $main.Root 'AI 侧栏'
            [void](Wait-Until { Find-ByName $main.Root '设置' } '打开AI侧栏后仍未出现设置入口')
            $openedAiPanel = $true
        }
        $names = @(Get-BoundedNames $main.Root)
        Write-Result @{ ok = $true; action = $Action; windowTitle = $main.Root.Current.Name; windowHandle = $main.Handle.ToInt64(); openedAiPanel = $openedAiPanel; accessibleNames = $names }
    }
    'ConfigureCancel' {
        $key = $env:AIBROWSE_E1_SYNTHETIC_KEY
        if ([string]::IsNullOrEmpty($key)) { throw '缺少合成Provider Key' }
        Invoke-Named $main.Root '设置'
        $settings = Wait-Until { Find-NameContaining $main.Root 'Provider 设置' } 'Provider设置页未打开'
        Set-NamedValue $main.Root '接口地址' $BaseUrl
        Set-NamedValue $main.Root '模型' $Model
        Set-NamedValue $main.Root 'API Key' $key
        Invoke-Named $main.Root '保存'
        $dialog = Wait-NativeDialog $main.Handle $BaseUrl
        $dialogNames = @($dialog.Current.Name) + @($dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { try { $_.Current.Name } catch { '' } })
        $dialogText = $dialogNames -join "`n"
        if ($dialogText -notlike '*确认 API Key 的发送目标*' -or -not (Test-ExactDialogTarget $dialog $BaseUrl)) { throw '原生确认对话框未显示精确待授权目标' }
        $dialogIdentity = Assert-NativeDialogOwnership $dialog $main.Handle
        $dialogAction = Invoke-NativeDialogAction $dialog ([IntPtr]$dialogIdentity.Handle) $main.Handle $BaseUrl '取消'
        [void](Wait-Until { Find-NameContaining $main.Root '配置未提交' } '取消后未出现配置未提交提示')
        [void](Wait-Until { Find-ByName $main.Root 'API Key 已保存' } '取消目标授权后Key保存状态不正确')
        [void](Wait-Until { Find-ByName $main.Root '删除 Key' } '取消目标授权后缺少删除Key入口')
        Write-Result @{ ok = $true; action = $Action; nativeDialogHandle = $dialogIdentity.Handle.ToInt64(); nativeDialogProcessId = $dialogIdentity.ProcessId; nativeDialogOwner = $dialogIdentity.Owner.ToInt64(); nativeDialogClass = $dialogIdentity.Class; nativeAction = $dialogAction; cancelled = $true }
    }
    'ConfigureConfirm' {
        Invoke-Named $main.Root '保存'
        $dialog = Wait-NativeDialog $main.Handle $BaseUrl
        $dialogNames = @($dialog.Current.Name) + @($dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { try { $_.Current.Name } catch { '' } })
        $dialogText = $dialogNames -join "`n"
        if ($dialogText -notlike '*确认 API Key 的发送目标*' -or -not (Test-ExactDialogTarget $dialog $BaseUrl)) { throw '原生确认对话框未绑定精确待授权目标' }
        $dialogIdentity = Assert-NativeDialogOwnership $dialog $main.Handle
        $dialogAction = Invoke-NativeDialogAction $dialog ([IntPtr]$dialogIdentity.Handle) $main.Handle $BaseUrl '确认发送目标'
        [void](Wait-Until { Find-ByName $main.Root '已保存' } '确认后未出现已保存提示')
        Write-Result @{ ok = $true; action = $Action; nativeDialogHandle = $dialogIdentity.Handle.ToInt64(); nativeDialogProcessId = $dialogIdentity.ProcessId; nativeDialogOwner = $dialogIdentity.Owner.ToInt64(); nativeDialogClass = $dialogIdentity.Class; nativeAction = $dialogAction; confirmed = $true }
    }
    'VerifyRestartedState' {
        if ([string]::IsNullOrEmpty($BaseUrl) -or [string]::IsNullOrEmpty($Model) -or [string]::IsNullOrEmpty($ResponseMarker)) {
            throw '冷重启检查缺少固定非敏感期望值'
        }
        if ($null -eq (Find-ByName $main.Root '设置')) {
            Invoke-Named $main.Root 'AI 侧栏'
            [void](Wait-Until { Find-ByName $main.Root '设置' } '冷重启后AI侧栏未就绪')
        }
        [void](Wait-Until { Find-NameContaining $main.Root $ResponseMarker } '冷重启后未显示已持久化会话答复')
        Invoke-Named $main.Root '设置'
        [void](Wait-Until { Find-NameContaining $main.Root 'Provider 设置' } '冷重启后Provider设置页未打开')
        [void](Wait-Until { Find-ByName $main.Root 'API Key 已保存' } '冷重启后未显示Key持久化状态')
        [void](Wait-Until { Find-ByName $main.Root '删除 Key' } '冷重启后缺少删除Key入口')
        $storedBaseUrl = Get-NamedValue $main.Root '接口地址'
        $storedModel = Get-NamedValue $main.Root '模型'
        if ($storedBaseUrl -ne $BaseUrl -or $storedModel -ne $Model) { throw '冷重启读取的Provider配置与已保存值不一致' }
        Invoke-Named $main.Root '返回'
        [void](Wait-Until { Find-NameContaining $main.Root $ResponseMarker } '退出设置后持久化会话答复不可见')
        Write-Result @{
            ok = $true
            action = $Action
            hasPersistedKey = $true
            hasDeleteKeyAction = $true
            providerConfigMatches = $true
            conversationResponseVisible = $true
        }
    }
    'SubmitPrompt' {
        $back = Find-ByName $main.Root '返回'
        if ($null -ne $back) { Invoke-Named $main.Root '返回' }
        $composer = Find-NameContaining $main.Root '输入问题或任务目标'
        if ($null -eq $composer -or -not $composer.Current.IsEnabled) {
            Invoke-Named $main.Root '新建会话'
        }
        Set-NamedValue $main.Root '输入问题或任务目标' $Question
        Invoke-Named $main.Root '发送'
        if ($ResponseMarker -ne '') {
            [void](Wait-Until { Find-NameContaining $main.Root $ResponseMarker } 'UI未显示受控Provider响应' 30000)
        }
        Write-Result @{ ok = $true; action = $Action; submitted = $true; responseObserved = ($ResponseMarker -ne '') }
    }
    'Minimize' {
        if (-not [AIbrowseProductWindow]::ShowWindowAsync($main.Handle, 6)) { throw '主窗口最小化调用失败' }
        [void](Wait-Until { [AIbrowseProductWindow]::IsIconic($main.Handle) } '主窗口未进入最小化状态')
        Write-Result @{ ok = $true; action = $Action; minimized = $true; windowHandle = $main.Handle.ToInt64() }
    }
    'VerifyRestoredForeground' {
        [void](Wait-Until {
            (-not [AIbrowseProductWindow]::IsIconic($main.Handle)) -and
            [AIbrowseProductWindow]::GetForegroundWindow() -eq $main.Handle
        } '第二实例未恢复并聚焦已有产品窗口')
        Write-Result @{ ok = $true; action = $Action; restored = $true; foreground = $true; windowHandle = $main.Handle.ToInt64() }
    }
    }
} catch {
    $mainNames = @()
    $buttonCandidates = @()
    $mainTitle = ''
    $mainHandle = 0
    if ($null -ne $main) {
        try { $mainNames = @(Get-BoundedNames $main.Root) } catch { }
        try { $buttonCandidates = @(Get-BoundedButtonCandidateMetadata $main.Root) } catch { }
        try { $mainTitle = $main.Root.Current.Name } catch { }
        try { $mainHandle = $main.Handle.ToInt64() } catch { }
    }
    Write-Result @{
        ok = $false
        diagnostic = $true
        action = $Action
        error = $_.Exception.Message
        mainWindowTitle = $mainTitle
        mainWindowHandle = $mainHandle
        accessibleNames = $mainNames
        buttonCandidates = $buttonCandidates
        topLevelWindows = @(Get-BoundedTopLevelWindows ([IntPtr]$mainHandle))
    }
    throw
}
