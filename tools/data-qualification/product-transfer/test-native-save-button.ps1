[CmdletBinding()]
param([string]$Source = (Join-Path $PSScriptRoot 'ui-driver.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw '脚本解析失败' }
$definition = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Dialog-Button' }, $true))
if ($definition.Count -ne 1) { throw '选择函数不唯一' }
. ([scriptblock]::Create($definition[0].Extent.Text))
function Check-Time {}
function Descendants($root) { return $script:nodes }
function Unique($nodes, [scriptblock]$test) { $found = @($nodes | Where-Object $test); if ($found.Count -gt 1) { throw '不唯一' }; if ($found.Count -eq 1) { return $found[0] }; return $null }
function Node([int]$id, [string]$name, [string]$class, [int]$hwnd) {
    $node = [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = [string]$id; Name = $name; ClassName = $class; ProcessId = 42; IsEnabled = $true; IsOffscreen = $false; NativeWindowHandle = $hwnd; ControlType = [Windows.Automation.ControlType]::Pane } }
    foreach ($field in @('AutomationId','ClassName','ProcessId','IsEnabled','IsOffscreen','NativeWindowHandle','Name')) { $node.Current | Add-Member ScriptMethod ('get_' + $field) ([scriptblock]::Create('return $this.' + $field)) }
    $node | Add-Member ScriptMethod get_Current { return $this.Current }
    return $node
}
$ProcessId = 42
$save = Node 1 '保存(&S)' 'Button' 31
$cancel = Node 2 '取消' 'Button' 32
$script:nodes = @($save, $cancel, (Node 1 'PRIVATE_OTHER' 'Other' 0), (Node 2 'PRIVATE_OTHER' 'Other' 0))
$result = Dialog-Button $null '1'
if ($result.Window -ne [IntPtr]31) { throw '008形状必须取得唯一原生保存按钮' }
$result = Dialog-Button $null '2'
if ($result.Window -ne [IntPtr]32) { throw '008形状必须取得唯一原生取消按钮' }
$checks = 2
foreach ($fault in @('duplicate', 'pid', 'hidden', 'disabled', 'class', 'name', 'zero', 'id', 'property-error')) {
    $save = Node 1 '保存(&S)' 'Button' 31
    $script:nodes = @($save, $cancel)
    switch ($fault) {
        duplicate { $script:nodes += Node 1 '保存(&S)' 'Button' 33 }
        pid { $save.Current.ProcessId = 43 }
        hidden { $save.Current.IsOffscreen = $true }
        disabled { $save.Current.IsEnabled = $false }
        class { $save.Current.ClassName = 'Other' }
        name { $save.Current.Name = 'PRIVATE_OTHER' }
        zero { $save.Current.NativeWindowHandle = 0 }
        id { $save.Current.AutomationId = '01' }
        property-error { $save.Current | Add-Member -Force ScriptMethod get_AutomationId { throw '固定属性错误' } }
    }
    $rejected = $false
    try { [void](Dialog-Button $null '1') } catch { $rejected = $true }
    if (-not $rejected) { throw ('未拒绝：' + $fault) }
    $checks++
}
@{ checks = $checks; actualUi = $false; nativeCalls = $false; ok = $true } | ConvertTo-Json -Compress
