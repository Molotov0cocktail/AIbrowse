function Find-UniqueInvokableButton([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $matches = @()
    foreach ($candidate in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        $qualifies = $false
        try {
            $qualifies = $candidate.Current.Name -ceq $Name -and
                $candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
                $candidate.Current.IsEnabled -and
                [bool]$candidate.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
        } catch { }
        if ($qualifies) { $matches += $candidate }
    }
    if ($matches.Count -gt 1) { throw "存在多个可调用UI按钮：$Name" }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Invoke-NamedButton([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $element = Wait-Until { Find-UniqueInvokableButton $Root $Name } "未找到唯一可调用UI按钮：$Name"
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        throw "UI按钮在调用前失去InvokePattern：$Name"
    }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Find-UniqueValueInput([Windows.Automation.AutomationElement]$Root, [string]$NamePart) {
    $matches = @()
    foreach ($candidate in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        $qualifies = $false
        try {
            $qualifies = $candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and
                $candidate.Current.IsEnabled -and
                $candidate.Current.Name -like "*$NamePart*" -and
                [bool]$candidate.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)
        } catch { }
        if ($qualifies) { $matches += $candidate }
    }
    if ($matches.Count -gt 1) { throw "存在多个UI输入框：$NamePart" }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Set-NamedValue([Windows.Automation.AutomationElement]$Root, [string]$NamePart, [string]$Value) {
    $element = Wait-Until { Find-UniqueValueInput $Root $NamePart } "未找到唯一可写UI输入框：$NamePart"
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        throw "UI输入框在写入前失去ValuePattern：$NamePart"
    }
    ([Windows.Automation.ValuePattern]$pattern).SetValue($Value)
    if ($NamePart -ne 'API Key') {
        [void](Wait-Until {
            $current = Find-UniqueValueInput $Root $NamePart
            if ($null -eq $current) { return $false }
            $currentPattern = $null
            if (-not $current.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$currentPattern)) { return $false }
            return ([Windows.Automation.ValuePattern]$currentPattern).Current.Value -ceq $Value
        } "非敏感UI输入框未在有界时间保持写入值：$NamePart" 5000)
    }
}

function Get-NamedValue([Windows.Automation.AutomationElement]$Root, [string]$NamePart) {
    if ($NamePart -notin @('接口地址', '模型')) { throw '只允许读取非敏感Provider配置字段' }
    $element = Wait-Until { Find-UniqueValueInput $Root $NamePart } "未找到唯一可读非敏感UI输入框：$NamePart"
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        throw "非敏感UI输入框在读取前失去ValuePattern：$NamePart"
    }
    return ([Windows.Automation.ValuePattern]$pattern).Current.Value
}

function Get-BoundedButtonCandidateMetadata([Windows.Automation.AutomationElement]$Root) {
    $result = @()
    foreach ($candidate in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        if ($result.Count -ge 16) { break }
        try {
            $name = $candidate.Current.Name
            if ($name -cne '取消' -and $name -cne '确认发送目标') { continue }
            $nativeHandle = [IntPtr]$candidate.Current.NativeWindowHandle
            $className = [Text.StringBuilder]::new(256)
            if ($nativeHandle -ne [IntPtr]::Zero) { [void][AIbrowseProductWindow]::GetClassName($nativeHandle, $className, $className.Capacity) }
            $msaa = $null
            $msaaError = $null
            if ($nativeHandle -ne [IntPtr]::Zero) {
                try { $msaa = [AIbrowseMsaaAction]::Inspect($nativeHandle) } catch { $msaaError = $_.Exception.Message }
            }
            $result += [ordered]@{
                name = $name
                controlType = $candidate.Current.ControlType.ProgrammaticName
                nativeWindowHandle = $nativeHandle.ToInt64()
                windowClass = $className.ToString()
                isEnabled = $candidate.Current.IsEnabled
                isInvokePatternAvailable = [bool]$candidate.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
                msaaHResult = if ($null -eq $msaa) { $null } else { $msaa.HResult }
                msaaName = if ($null -eq $msaa) { $null } else { $msaa.Name }
                msaaRole = if ($null -eq $msaa) { $null } else { $msaa.Role }
                msaaState = if ($null -eq $msaa) { $null } else { $msaa.State }
                msaaDefaultAction = if ($null -eq $msaa) { $null } else { $msaa.DefaultAction }
                msaaError = $msaaError
            }
        } catch { }
    }
    return $result
}

function Get-NativeDialogActionQualification(
    [Windows.Automation.AutomationElement]$Element,
    [IntPtr]$DialogHandle,
    [string]$Name
) {
    try {
        if ($Element.Current.Name -cne $Name -or -not $Element.Current.IsEnabled) { return $null }
        $handle = [IntPtr]$Element.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero -or -not [AIbrowseProductWindow]::IsChild($DialogHandle, $handle)) { return $null }
        [uint32]$dialogProcessId = 0
        [uint32]$elementProcessId = 0
        [void][AIbrowseProductWindow]::GetWindowThreadProcessId($DialogHandle, [ref]$dialogProcessId)
        [void][AIbrowseProductWindow]::GetWindowThreadProcessId($handle, [ref]$elementProcessId)
        if ($dialogProcessId -eq 0 -or $elementProcessId -ne $dialogProcessId) { return $null }
        $className = [Text.StringBuilder]::new(256)
        [void][AIbrowseProductWindow]::GetClassName($handle, $className, $className.Capacity)
        if ($className.ToString() -cne 'Button') { return $null }
        $metadata = [AIbrowseMsaaAction]::Inspect($handle)
        if ($metadata.HResult -ne 0 -or $metadata.Name -cne $Name -or $metadata.Role -ne 43 -or
            ($metadata.State -band 1) -ne 0 -or [string]::IsNullOrEmpty($metadata.DefaultAction)) { return $null }
        return [pscustomobject]@{
            Element = $Element
            Handle = $handle
            ProcessId = $elementProcessId
            Class = $className.ToString()
            Metadata = $metadata
        }
    } catch { return $null }
}

function Find-UniqueNativeDialogAction(
    [Windows.Automation.AutomationElement]$Root,
    [IntPtr]$DialogHandle,
    [string]$Name
) {
    $matches = @()
    foreach ($candidate in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        $qualified = Get-NativeDialogActionQualification $candidate $DialogHandle $Name
        if ($null -ne $qualified) { $matches += $qualified }
    }
    if ($matches.Count -gt 1) { throw "存在多个合格的原生对话框动作：$Name" }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Invoke-NativeDialogAction(
    [Windows.Automation.AutomationElement]$Root,
    [IntPtr]$DialogHandle,
    [IntPtr]$MainHandle,
    [string]$ExpectedBaseUrl,
    [string]$Name
) {
    $qualified = Wait-Until { Find-UniqueNativeDialogAction $Root $DialogHandle $Name } "未找到唯一合格的原生对话框动作：$Name"
    if ([IntPtr]$Root.Current.NativeWindowHandle -ne $DialogHandle -or
        $DialogHandle -eq [IntPtr]::Zero -or $DialogHandle -eq $MainHandle -or
        [AIbrowseProductWindow]::GetWindow($DialogHandle, 4) -ne $MainHandle -or
        $Root.Current.Name -cne '确认 API Key 的发送目标' -or
        -not (Test-ExactDialogTarget $Root $ExpectedBaseUrl)) {
        throw "原生确认对话框在动作前失去owner或精确目标绑定：$Name"
    }
    $current = Get-NativeDialogActionQualification $qualified.Element $DialogHandle $Name
    if ($null -eq $current -or $current.Handle -ne $qualified.Handle) { throw "原生对话框动作在调用前失去资格：$Name" }
    $metadata = [AIbrowseMsaaAction]::DoDefaultAction($current.Handle, $Name)
    return [ordered]@{
        mechanism = 'MSAA LegacyIAccessible default action'
        nativeWindowHandle = $current.Handle.ToInt64()
        processId = $current.ProcessId
        windowClass = $current.Class
        role = $metadata.Role
        state = $metadata.State
    }
}
