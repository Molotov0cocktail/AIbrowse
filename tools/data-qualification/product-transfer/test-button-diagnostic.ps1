[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$BeforeSource,
    [string]$Evidence = (Join-Path $PSScriptRoot '../../../log/stage7-e2/save-button-diagnostic-001/green')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[void][IO.Directory]::CreateDirectory($Evidence)
$checks = [Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Condition) {
    $checks.Add([ordered]@{ name = $Name; pass = $Condition })
    [IO.File]::WriteAllText((Join-Path $Evidence 'results.json'), (@{ checks = $checks.ToArray(); actualUi = $false; nativeCalls = $false } | ConvertTo-Json -Depth 10))
    if (-not $Condition) { throw ('按钮诊断反例失败：' + $Name) }
}
function Parse([string]$Text) {
    $tokens = $null; $errors = $null
    $parsed = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw '被测脚本语法错误' }
    return $parsed
}
function Function-Text($Ast, [string]$Name) {
    $found = @($Ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name }, $true))
    if ($found.Count -ne 1) { throw '被测函数不唯一' }
    return $found[0].Extent.Text
}
function Action-Text($Ast) {
    $found = @($Ast.FindAll({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] }, $true) | ForEach-Object { $_.Clauses } | Where-Object { $_.Item1.Extent.Text.Contains("'InspectSaveDialog'") })
    if ($found.Count -ne 1) { throw '被测动作不唯一' }
    $text = $found[0].Item2.Extent.Text
    return $text.Substring(1, $text.Length - 2)
}
$sourceText = [IO.File]::ReadAllText($Source)
$ast = Parse $sourceText
$beforeText = [IO.File]::ReadAllText($BeforeSource)
$before = Parse $beforeText

# Only synthetic ports are compiled. Production top-level Add-Type and Win32 code never execute.
$ports = @'
using System;
using System.Collections.Generic;
namespace ButtonDiagnosticPort {
    public static class State {
        public static long Time;
        public static int NameReads, DetailReads, PatternReads, Invokes, Writes, Disposals, FirstReads, SiblingReads;
        public static string Text, Failure;
        public static void Reset() {
            Time=0; NameReads=DetailReads=PatternReads=Invokes=Writes=Disposals=FirstReads=SiblingReads=0;
            Text="AIbrowse-backup"; Failure="";
        }
    }
    public sealed class ControlType {
        private string name;
        public string ProgrammaticName { get {
            if(State.Failure=="type-name") throw new Exception("PRIVATE_TYPE_FAILURE");
            return name;
        } set { name=value; } }
    }
    public sealed class NodeState {
        private string id="", className="";
        public string NameValue="";
        private ControlType type=new ControlType { ProgrammaticName="ControlType.Pane" };
        public string AutomationId { get { if(State.Failure=="id") throw new Exception("PRIVATE_ID_FAILURE"); return id; } set { id=value; } }
        public string ClassName { get { if(State.Failure=="class") throw new Exception("PRIVATE_CLASS_FAILURE"); return className; } set { className=value; } }
        public ControlType ControlType { get { if(State.Failure=="type") throw new Exception("PRIVATE_TYPE_FAILURE"); return type; } }
        public int Pid=42, Handle=0;
        public bool Enabled=true, Offscreen=false, ForbidName=true;
        public string Name { get {
            State.NameReads++;
            if(ForbidName || State.Failure=="name") throw new Exception("PRIVATE_NAME_READ");
            return NameValue;
        } }
        public int ProcessId { get { State.DetailReads++; if(State.Failure=="pid") throw new Exception("PRIVATE_PID_FAILURE"); return Pid; } }
        public int NativeWindowHandle { get { State.DetailReads++; if(State.Failure=="handle") throw new Exception("PRIVATE_HANDLE_FAILURE"); return Handle; } }
        public bool IsEnabled { get { State.DetailReads++; if(State.Failure=="enabled") throw new Exception("PRIVATE_ENABLED_FAILURE"); return Enabled; } }
        public bool IsOffscreen { get { State.DetailReads++; if(State.Failure=="offscreen") throw new Exception("PRIVATE_OFFSCREEN_FAILURE"); return Offscreen; } }
    }
    public sealed class Node {
        private NodeState current=new NodeState();
        public NodeState Current { get { if(State.Failure=="current") throw new Exception("PRIVATE_CURRENT_FAILURE"); return current; } }
        public Node Parent;
        public readonly List<Node> Children=new List<Node>();
        public bool HasInvoke;
        public bool TryGetCurrentPattern(object token,out object pattern) {
            State.PatternReads++;
            if(!object.ReferenceEquals(token,InvokePattern.Pattern)) throw new Exception("不允许的模式");
            if(State.Failure=="pattern") throw new Exception("PRIVATE_PATTERN_FAILURE");
            if(State.Failure=="pattern-time") State.Time=30000;
            pattern=HasInvoke ? new InvokePattern() : null;
            return HasInvoke;
        }
    }
    public sealed class TreeWalker {
        public static readonly TreeWalker ControlViewWalker=new TreeWalker();
        public Node GetFirstChild(Node node) {
            State.FirstReads++;
            if(State.Failure=="first") throw new Exception("PRIVATE_TREE_FAILURE");
            if(State.Failure=="first-time") State.Time=30000;
            return node.Children.Count==0 ? null : node.Children[0];
        }
        public Node GetNextSibling(Node node) {
            State.SiblingReads++;
            if(State.Failure=="sibling") throw new Exception("PRIVATE_TREE_FAILURE");
            if(State.Failure=="sibling-time") State.Time=30000;
            var index=node.Parent.Children.IndexOf(node)+1;
            return index<node.Parent.Children.Count ? node.Parent.Children[index] : null;
        }
    }
    public sealed class InvokePattern {
        public static readonly object Pattern=new object();
        public void Invoke() { State.Invokes++; }
    }
    public sealed class NativeSaveControl : IDisposable {
        public NativeSaveControl(uint p,string c,string e,IntPtr m,IntPtr d,IntPtr w,object clock) {}
        public string ReadText() { return State.Text; }
        public void WriteTarget(string value) { State.Writes++; State.Text=value; }
        public void Dispose() { State.Disposals++; }
    }
}
'@
Check '内存端口没有原生声明或外部进程调用' (-not ($ports -match 'DllImport|extern |Process\.|File\.|Directory\.|SendMessage'))
Add-Type -TypeDefinition $ports
function Isolate([string]$Code) {
    return $Code.Replace('[Windows.Automation.', '[ButtonDiagnosticPort.').Replace('[AIbrowseNativeSaveControl]', '[ButtonDiagnosticPort.NativeSaveControl]')
}
$functionNames = @('Check-Time', 'Get-FilenameValueClass', 'Get-FilenameAutomationIdClass', 'Get-ButtonAutomationIdClass', 'Get-ButtonNameClass', 'Inspect-DialogButtons')
foreach ($name in $functionNames) {
    $found = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    if ($found.Count -eq 1) { . ([scriptblock]::Create((Isolate $found[0].Extent.Text))) }
}
$actionCode = [scriptblock]::Create((Isolate (Action-Text $ast)))
$clock = [pscustomobject]@{}
$clock | Add-Member -MemberType ScriptProperty -Name ElapsedMilliseconds -Value { [ButtonDiagnosticPort.State]::Time }
$ProcessId = [uint32]42; $CreatedFileTime = '123'; $Executable = 'C:\synthetic\AIbrowse.exe'; $handle = [IntPtr]71
$Target = 'C:\synthetic\fixed-target.aibak'
function Assert-Dialog($Dialog, [IntPtr]$Main) {
    $script:assertCalls++
    Check-Time
    if (-not [object]::ReferenceEquals($Dialog, $script:dialogRoot) -or $Main -ne [IntPtr]71) { throw '对话框身份不符' }
    if ($script:assertCalls -eq $script:failAssert) { throw 'PRIVATE_OWNER_FAILURE' }
    if ($script:assertCalls -eq $script:lateAssert) { [ButtonDiagnosticPort.State]::Time = 30000 }
    if ($script:assertCalls -eq $script:changedAssert) { return [IntPtr]74 }
    return [IntPtr]73
}
function Save-Dialog($Main) { return $script:dialogRoot }
function Get-NativeFilenameInput($Dialog, $Diagnostic) { return [pscustomobject]@{ Window = [IntPtr]79; Element = [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = '1001' } } } }
function Assert-NativeFilenameInput($Binding, $Dialog, $Main, $Diagnostic, $Native) { Check-Time; if ($script:failFilename) { throw '文件名资格失败' } }
function Dialog-Button($Dialog, [string]$Id) {
    $script:buttonCalls++
    return [pscustomobject]@{ Pattern = [ButtonDiagnosticPort.InvokePattern]::new(); Element = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $(if ($Id -ceq '1') { '保存' } else { '取消' }) } } }
}
function New-Node([string]$Id = '', [string]$Type = 'Pane', [string]$Class = '', [string]$Name = '', [bool]$AllowName = $false) {
    $node = [ButtonDiagnosticPort.Node]::new()
    $node.Current.AutomationId = $Id; $node.Current.ControlType.ProgrammaticName = 'ControlType.' + $Type
    $node.Current.ClassName = $Class; $node.Current.NameValue = $Name; $node.Current.ForbidName = -not $AllowName
    return $node
}
function Add-Child($Parent, $Child) { $Child.Parent = $Parent; $Parent.Children.Add($Child) }
function Reset-Case {
    [ButtonDiagnosticPort.State]::Reset()
    $script:assertCalls = 0; $script:buttonCalls = 0; $script:failAssert = -1; $script:lateAssert = -1; $script:changedAssert = -1; $script:failFilename = $false
    $script:dialogRoot = New-Node '' 'Window' '#32770'
}
function Run-Case([string]$Action = 'InspectSaveDialog', [bool]$Direct = $false) {
    $diagnostic = [ordered]@{ ok = $false }; $accepted = $false; $failure = ''
    try {
        if ($Direct) { Inspect-DialogButtons $script:dialogRoot $handle $diagnostic }
        else { & $actionCode; $diagnostic.ok = $true }
        $accepted = $true
    } catch { $failure = $_.Exception.Message }
    return @{ accepted = $accepted; diagnostic = $diagnostic; failure = $failure }
}
function Standard-Tree {
    $save = New-Node '1' 'Pane' 'Button' '保存(&S)' $true; $save.HasInvoke = $true; $save.Current.Handle = 95
    $cancel = New-Node '2' 'Button' 'PRIVATE_CLASS' 'Cancel' $true; $cancel.Current.Enabled = $false; $cancel.Current.Offscreen = $true; $cancel.Current.Pid = 99
    Add-Child $script:dialogRoot $save; Add-Child $script:dialogRoot $cancel
    Add-Child $script:dialogRoot (New-Node 'PRIVATE_FILE_ID' 'Edit' 'Edit' 'C:\PRIVATE_FILE.aibak')
}

Reset-Case; Standard-Tree
$r = Run-Case
Check '实际Inspect收集完成后受控失败且不选按钮不写不Invoke' (!$r.accepted -and !$r.diagnostic.ok -and $r.diagnostic.Contains('saveButtonStructure') -and $r.diagnostic.saveButtonStructure.status -ceq 'complete' -and $script:buttonCalls -eq 0 -and [ButtonDiagnosticPort.State]::Writes -eq 0 -and [ButtonDiagnosticPort.State]::Invokes -eq 0 -and [ButtonDiagnosticPort.State]::Disposals -eq 1)
Check '完成投影有固定错误和前后身份复核' ($r.failure -ceq '原生按钮只读诊断完成，停止后续动作' -and $script:assertCalls -eq 3)
$projection = $r.diagnostic.saveButtonStructure
Check '只读同dialog一遍且Name仅用于两候选' ($projection.scannedNodes -eq 4 -and $projection.candidateCount -eq 2 -and [ButtonDiagnosticPort.State]::FirstReads -eq 4 -and [ButtonDiagnosticPort.State]::SiblingReads -eq 3 -and [ButtonDiagnosticPort.State]::NameReads -eq 2)
Check '闭合根字段' (($projection.Keys | Sort-Object) -join ',' -ceq 'candidateCount,nodes,scannedNodes,status,version')
foreach ($row in $projection.nodes) {
    Check '闭合候选字段' (($row.Keys | Sort-Object) -join ',' -ceq 'automationIdClass,controlTypeClass,enabled,invokePattern,nameClass,nativeHandlePresent,offscreen,sameProcess,windowClass')
}
$one = $projection.nodes[0]; $two = $projection.nodes[1]
Check '投影保留ID类型class与Invoke差异' ($one.automationIdClass -ceq 'id-1' -and $one.controlTypeClass -ceq 'other' -and $one.windowClass -ceq 'button' -and $one.nameClass -ceq 'save' -and $one.invokePattern -and $one.nativeHandlePresent)
Check '投影保留禁用异PID离屏而不授权动作' ($two.automationIdClass -ceq 'id-2' -and $two.controlTypeClass -ceq 'button' -and $two.windowClass -ceq 'other' -and $two.nameClass -ceq 'cancel' -and !$two.invokePattern -and !$two.nativeHandlePresent -and !$two.enabled -and !$two.sameProcess -and $two.offscreen)
Check '投影不含私人字符串与数值句柄PID' (-not (($projection | ConvertTo-Json -Depth 6) -cmatch 'PRIVATE_|Cancel|保存|95|99'))

foreach ($sample in @(@('1', 'Pane', 'unknown', 'id-1', 'other', 'other'), @('2', 'Pane', '', 'id-2', 'other', 'empty'), @('', 'Button', '', 'empty', 'button', 'empty'), @('PRIVATE_ID', 'Pane', 'Button', 'other', 'other', 'button'))) {
    Reset-Case
    Add-Child $script:dialogRoot (New-Node $sample[0] $sample[1] $sample[2] 'PRIVATE_NAME' $true)
    $r = Run-Case 'InspectSaveDialog' $true
    $row = $r.diagnostic.saveButtonStructure.nodes[0]
    Check 'ID或UIA类型或Windows类独立入选并闭合未知Name' ($r.accepted -and $row.automationIdClass -ceq $sample[3] -and $row.controlTypeClass -ceq $sample[4] -and $row.windowClass -ceq $sample[5] -and $row.nameClass -ceq 'other')
}
foreach ($name in @('保存', '保存(S)', '保存(&S)', 'Save', '&Save', '取消', 'Cancel', '', 'save', 'Save ', '取消(&C)', 'C:\PRIVATE.aibak')) {
    Reset-Case; Add-Child $script:dialogRoot (New-Node '1' 'Pane' '' $name $true)
    $r = Run-Case 'InspectSaveDialog' $true
    $expected = if ($name -cin @('保存', '保存(S)', '保存(&S)', 'Save', '&Save')) { 'save' } elseif ($name -cin @('取消', 'Cancel')) { 'cancel' } else { 'other' }
    Check '名称仅按原有限语言集合精确分类' ($r.accepted -and $r.diagnostic.saveButtonStructure.nodes[0].nameClass -ceq $expected)
}
foreach ($count in @(0, 32, 33)) {
    Reset-Case
    for ($i = 0; $i -lt $count; $i++) { Add-Child $script:dialogRoot (New-Node '' 'Button' '' 'PRIVATE_NAME' $true) }
    $r = Run-Case 'InspectSaveDialog' $true
    $valid = $count -le 32
    Check ('候选预算边界' + $count) ($r.accepted -eq $valid -and $r.diagnostic.saveButtonStructure.candidateCount -eq [Math]::Min($count, 32) -and $r.diagnostic.saveButtonStructure.status -ceq $(if ($valid) { 'complete' } else { 'candidate-budget' }) -and [ButtonDiagnosticPort.State]::NameReads -eq [Math]::Min($count, 32))
}
foreach ($count in @(512, 513)) {
    Reset-Case
    for ($i = 1; $i -lt $count; $i++) { Add-Child $script:dialogRoot (New-Node 'PRIVATE_ID' 'Edit' 'Edit') }
    $r = Run-Case 'InspectSaveDialog' $true
    Check ('含根整树预算边界' + $count) ($r.accepted -eq ($count -eq 512) -and $r.diagnostic.saveButtonStructure.scannedNodes -eq 512 -and $r.diagnostic.saveButtonStructure.status -ceq $(if ($count -eq 512) { 'complete' } else { 'tree-budget' }) -and [ButtonDiagnosticPort.State]::NameReads -eq 0 -and [ButtonDiagnosticPort.State]::PatternReads -eq 0)
}
foreach ($fault in @('first', 'sibling', 'current', 'id', 'type', 'type-name', 'class', 'name', 'pid', 'handle', 'enabled', 'offscreen', 'pattern', 'first-time', 'sibling-time', 'pattern-time', 'before-owner', 'after-owner', 'changed-owner', 'after-time', 'before-time')) {
    Reset-Case; Standard-Tree
    switch ($fault) {
        'before-owner' { $script:failAssert = 1 }
        'after-owner' { $script:failAssert = 2 }
        'changed-owner' { $script:changedAssert = 2 }
        'after-time' { $script:lateAssert = 2 }
        'before-time' { [ButtonDiagnosticPort.State]::Time = 30000 }
        default { [ButtonDiagnosticPort.State]::Failure = $fault }
    }
    $r = Run-Case 'InspectSaveDialog' $true
    Check ('异常或超时不complete不泄漏原始错误：' + $fault) (!$r.accepted -and $r.diagnostic.saveButtonStructure.status -cne 'complete' -and $r.diagnostic.saveButtonStructure.nodes.Count -eq 0 -and $r.failure -ceq '原生按钮只读诊断失败，停止操作' -and [ButtonDiagnosticPort.State]::Invokes -eq 0)
}
foreach ($fault in @('filename', 'initial', 'timeout')) {
    Reset-Case; Standard-Tree
    if ($fault -ceq 'filename') { $script:failFilename = $true }
    if ($fault -ceq 'initial') { [ButtonDiagnosticPort.State]::Text = 'PRIVATE_FILE.aibak' }
    if ($fault -ceq 'timeout') { [ButtonDiagnosticPort.State]::Time = 30000 }
    $r = Run-Case
    Check ('文件名或原期限失败不开始按钮采集：' + $fault) (!$r.accepted -and !$r.diagnostic.Contains('saveButtonStructure') -and [ButtonDiagnosticPort.State]::FirstReads -eq 0 -and $script:buttonCalls -eq 0 -and [ButtonDiagnosticPort.State]::Disposals -eq $(if ($fault -ceq 'timeout') { 0 } else { 1 }))
}
foreach ($initial in @('AIbrowse-backup', 'AIbrowse-backup.aibak')) {
    foreach ($action in @('CancelSave', 'SaveBackup')) {
        Reset-Case; Standard-Tree; [ButtonDiagnosticPort.State]::Text = $initial
        $r = Run-Case $action
        Check ('原动作仍独立不采集：' + $initial + '/' + $action) ($r.accepted -and !$r.diagnostic.Contains('saveButtonStructure') -and $script:buttonCalls -eq 3 -and [ButtonDiagnosticPort.State]::FirstReads -eq 0 -and [ButtonDiagnosticPort.State]::Invokes -eq 1 -and [ButtonDiagnosticPort.State]::Writes -eq [int]($action -ceq 'SaveBackup') -and [ButtonDiagnosticPort.State]::Disposals -eq 1)
    }
}
Check '原Dialog-Button函数全文不变' ((Function-Text $ast 'Dialog-Button') -ceq (Function-Text $before 'Dialog-Button'))
$actionAst = Parse (Action-Text $ast)
$insertions = @($actionAst.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -ceq '$Action -eq ''InspectSaveDialog''' }, $true))
Check '新诊断只插入一个Inspect条件' ($insertions.Count -eq 1)
$without = (Action-Text $ast).Remove($insertions[0].Extent.StartOffset, $insertions[0].Extent.EndOffset - $insertions[0].Extent.StartOffset)
Check '剔除Inspect插入后原动作字节语义相同' (($without -replace '\s', '') -ceq ((Action-Text $before) -replace '\s', ''))
$diagnosticCode = Function-Text $ast 'Inspect-DialogButtons'
Check '诊断函数无Invoke写入消息或桌面入口' (-not ($diagnosticCode -match '\.Invoke\(|WriteTarget|ReadText|SendMessage|RootElement|OwnedTopLevelWindows|Start-Process'))
[ordered]@{ passed = $checks.Count; actualUi = $false; nativeCalls = $false; sourceSha256 = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash } | ConvertTo-Json
