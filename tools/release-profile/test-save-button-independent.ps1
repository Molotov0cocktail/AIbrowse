[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$BeforePath,
    [string]$Evidence = (Join-Path $PSScriptRoot '../../log/stage7-e2/save-button-independent-review-001')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
[void][IO.Directory]::CreateDirectory($Evidence)
$checks = [Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Condition) {
    $checks.Add([ordered]@{ name = $Name; pass = $Condition })
    [IO.File]::WriteAllText((Join-Path $Evidence 'results.json'), (@{ checks = $checks.ToArray(); actualUi = $false; nativeCalls = $false; actualJob = $false } | ConvertTo-Json -Depth 8))
    if (-not $Condition) { throw ('独审断言失败：' + $Name) }
}
function Parse([string]$Text) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw '被测源码解析失败' }
    return $ast
}
function Function-Text($Ast, [string]$Name) {
    $nodes = @($Ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name }, $true))
    if ($nodes.Count -ne 1) { throw '被测函数不唯一' }
    return $nodes[0].Extent.Text
}
# Explicitly replay the frozen historical diagnostic driver.
$source = [IO.File]::ReadAllText($sourcePath)
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
Check '绑定已交接候选源码' ($sourceHash -ceq '5791D4862BA306A4CF5DCA3E09B93A002001716F31F903BAEB5D099F34D3FD51')
$ast = Parse $source
$outer = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
Check '唯一顶层实际动作与回执代码' ($outer.Count -eq 1)
function Isolate([string]$Code) { return $Code.Replace('[Windows.Automation.', '[SaveButtonReview.') }
$outerCode = [scriptblock]::Create((Isolate $outer[0].Extent.Text))

# Replace only the UIA type prefix to prevent PowerShell from loading System.Windows.Automation.
$ports = @'
using System;
using System.Collections.Generic;
using System.Text;
public static class ReviewPort {
    public static long Time;
    public static int Names, Details, Patterns, Invokes, Writes, Disposals, First, Next, Owners, DriftsAt;
    public static string Fault, Initial;
    public static SaveButtonReview.AutomationElement Root, Dialog;
    public static void Reset() {
        Time=0; Names=Details=Patterns=Invokes=Writes=Disposals=First=Next=Owners=DriftsAt=0;
        Fault=""; Initial="AIbrowse-backup";
    }
    public static void Touch(string field, bool canary) {
        if(!canary) return;
        if(Fault==field) throw new Exception("REVIEW_PRIVATE_"+field+"_C:\\canary\\secret.aibak");
        if(Fault==field+"-late") Time=30000;
    }
}
public sealed class ReviewClock { public long ElapsedMilliseconds { get { return ReviewPort.Time; } } }
public sealed class ReviewProcess { public IntPtr MainWindowHandle { get { return new IntPtr(11); } } public void Refresh() {} }
public static class AIbrowseProductWindow {
    public static int GetWindowThreadProcessId(IntPtr handle, out uint pid) { pid=41; return 51; }
    public static int GetClassName(IntPtr handle, StringBuilder text, int count) { ReviewPort.Owners++; text.Append("#32770"); return 6; }
    public static IntPtr GetWindow(IntPtr handle, int command) { return new IntPtr(ReviewPort.Owners==ReviewPort.DriftsAt ? 999 : 11); }
}
public sealed class AIbrowseNativeSaveControl : IDisposable {
    public AIbrowseNativeSaveControl(uint p,string c,string e,IntPtr main,IntPtr dialog,IntPtr input,object clock) {}
    public string ReadText() { return ReviewPort.Initial; }
    public void WriteTarget(string text) { ReviewPort.Writes++; ReviewPort.Initial=text; }
    public void Dispose() { ReviewPort.Disposals++; }
}
namespace SaveButtonReview {
    public sealed class ControlType {
        private readonly string name;
        public bool Canary;
        public ControlType(string value) { name=value; }
        public string ProgrammaticName { get { ReviewPort.Touch("type-name",Canary); return name; } }
        public static readonly ControlType Button=new ControlType("ControlType.Button");
        public static readonly ControlType Pane=new ControlType("ControlType.Pane");
    }
    public sealed class Information {
        public bool Canary, ForbidName;
        public string Id="", Class="", Text="";
        public int Pid=41, Handle=0;
        public bool Enabled=true, Offscreen=false;
        public ControlType Type=ControlType.Pane;
        public string AutomationId { get { ReviewPort.Touch("id",Canary); return Id; } }
        public string ClassName { get { ReviewPort.Touch("class",Canary); return Class; } }
        public ControlType ControlType { get { ReviewPort.Touch("type",Canary); return Type; } }
        public string Name { get {
            if(Canary) ReviewPort.Names++;
            if(ForbidName) throw new Exception("REVIEW_PRIVATE_FORBIDDEN_NAME");
            ReviewPort.Touch("name",Canary); return Text;
        } }
        public int ProcessId { get { if(Canary) ReviewPort.Details++; ReviewPort.Touch("pid",Canary); return Pid; } }
        public int NativeWindowHandle { get { if(Canary) ReviewPort.Details++; ReviewPort.Touch("handle",Canary); return Handle; } }
        public bool IsEnabled { get { if(Canary) ReviewPort.Details++; ReviewPort.Touch("enabled",Canary); return Enabled; } }
        public bool IsOffscreen { get { if(Canary) ReviewPort.Details++; ReviewPort.Touch("offscreen",Canary); return Offscreen; } }
    }
    public sealed class AutomationElement {
        public readonly Information Info=new Information();
        public AutomationElement Parent;
        public readonly List<AutomationElement> Children=new List<AutomationElement>();
        public bool HasInvoke;
        public Information Current { get { ReviewPort.Touch("current",Info.Canary); return Info; } }
        public static AutomationElement FromHandle(IntPtr handle) { return ReviewPort.Root; }
        public bool TryGetCurrentPattern(object key,out object result) {
            ReviewPort.Patterns++;
            if(!object.ReferenceEquals(key,InvokePattern.Pattern)) throw new Exception("模式越界");
            ReviewPort.Touch("pattern",Info.Canary);
            result=HasInvoke ? new InvokePattern() : null; return HasInvoke;
        }
    }
    public sealed class TreeWalker {
        public static readonly TreeWalker ControlViewWalker=new TreeWalker();
        public AutomationElement GetFirstChild(AutomationElement node) {
            ReviewPort.First++; ReviewPort.Touch("first",true);
            return node.Children.Count==0 ? null : node.Children[0];
        }
        public AutomationElement GetNextSibling(AutomationElement node) {
            ReviewPort.Next++; ReviewPort.Touch("next",true);
            int next=node.Parent.Children.IndexOf(node)+1;
            return next<node.Parent.Children.Count ? node.Parent.Children[next] : null;
        }
    }
    public sealed class InvokePattern {
        public static readonly object Pattern=new object();
        public void Invoke() { ReviewPort.Invokes++; }
    }
}
'@
Check '端口仅内存无原生调用或进程启动' (-not ($ports -match 'DllImport|extern |Process\.|File\.|Directory\.|SendMessage'))
Add-Type -TypeDefinition $ports
foreach ($name in @('Check-Time', 'Wait-For', 'Descendants', 'Unique', 'Assert-Dialog', 'Dialog-Button', 'Get-ButtonAutomationIdClass', 'Get-ButtonNameClass', 'Inspect-DialogButtons', 'Get-FilenameValueClass', 'Get-FilenameAutomationIdClass')) {
    . ([scriptblock]::Create((Isolate (Function-Text $ast $name))))
}
function Check-Process { Check-Time; return [ReviewProcess]::new() }
function Save-Dialog([IntPtr]$Main) { return [ReviewPort]::Dialog }
function Get-NativeFilenameInput($Dialog, $Diagnostic) { return [pscustomobject]@{ Window = [IntPtr]13; Element = [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = '1001' } } } }
function Assert-NativeFilenameInput($Binding, $Dialog, $Main, $Diagnostic, $Native) { Check-Time }
function New-Node([string]$Id, [string]$Type, [string]$Class, [string]$Name, [bool]$Canary = $true) {
    $node = [SaveButtonReview.AutomationElement]::new()
    $node.Info.Id = $Id; $node.Info.Class = $Class; $node.Info.Text = $Name; $node.Info.Canary = $Canary
    $node.Info.Type = if ($Type -ceq 'Button') { [SaveButtonReview.ControlType]::Button } else { [SaveButtonReview.ControlType]::new('ControlType.' + $Type) }
    if ($Type -cne 'Button') { $node.Info.Type.Canary = $Canary }
    return $node
}
function Child($Parent, $Child) { $Child.Parent = $Parent; $Parent.Children.Add($Child) }
function Reset-Case {
    [ReviewPort]::Reset()
    [ReviewPort]::Root = New-Node '' 'Window' '' 'AIbrowse' $false
    [ReviewPort]::Dialog = New-Node '' 'Window' '#32770' '保存本地数据备份' $false
    [ReviewPort]::Dialog.Info.Handle = 12
}
function Standard-Tree {
    $save = New-Node '1' 'Pane' 'Button' 'REVIEW_PRIVATE_NAME'; $save.Info.Handle = 731; $save.HasInvoke = $true
    $cancel = New-Node 'REVIEW_PRIVATE_ID' 'Button' 'REVIEW_PRIVATE_CLASS' 'Cancel'; $cancel.Info.Pid = 732; $cancel.Info.Enabled = $false; $cancel.Info.Offscreen = $true
    $plain = New-Node 'REVIEW_PRIVATE_NONBUTTON' 'Edit' 'Edit' 'REVIEW_PRIVATE_FILE'; $plain.Info.ForbidName = $true
    Child ([ReviewPort]::Dialog) $save; Child ([ReviewPort]::Dialog) $cancel; Child $save $plain
}
$caseNumber = 0
function Run-Case([string]$Action = 'InspectSaveDialog') {
    $script:caseNumber++
    $Output = Join-Path $Evidence ('case-' + $script:caseNumber.ToString('000') + '.json')
    $ProcessId = [uint32]41; $CreatedFileTime = '123'; $Executable = 'C:\synthetic\AIbrowse.exe'; $Target = 'C:\synthetic\review-target.aibak'
    $clock = [ReviewClock]::new(); $phase = 'identity'; $diagnostic = [ordered]@{ version = 1; action = $Action; ok = $false; phase = $phase }
    $failure = ''; $accepted = $false; $pipeline = @()
    try { $pipeline = @(& $outerCode *>&1); $accepted = $true } catch { $failure = $_.ToString() + $_.Exception.ToString() }
    $json = [IO.File]::ReadAllText($Output)
    $row = $json | ConvertFrom-Json -AsHashtable
    Check ('实际回执与异常流隐私：' + $caseNumber) (-not (($json + $failure + ($pipeline | Out-String)) -cmatch 'REVIEW_PRIVATE_|731|732'))
    return @{ accepted = $accepted; row = $row; json = $json; failure = $failure }
}

Reset-Case; Standard-Tree
$r = Run-Case
Check '实际顶层Inspect投影完整后失败并写入受控回执' (!$r.accepted -and !$r.row.ok -and $r.row.saveButtonStructure.status -ceq 'complete' -and $r.failure.Contains('原生按钮只读诊断完成，停止后续动作'))
Check '只遍历owned dialog含嵌套节点一遍' ([ReviewPort]::First -eq 4 -and [ReviewPort]::Next -eq 3 -and [ReviewPort]::Owners -eq 3 -and $r.row.saveButtonStructure.scannedNodes -eq 4)
Check '候选局部读取且无按钮动作和文件写入' ([ReviewPort]::Names -eq 2 -and [ReviewPort]::Details -eq 8 -and [ReviewPort]::Patterns -eq 2 -and [ReviewPort]::Invokes -eq 0 -and [ReviewPort]::Writes -eq 0 -and [ReviewPort]::Disposals -eq 1)
$state = $r.row.saveButtonStructure
Check '完整投影闭合字段和反常状态保持' (($state.Keys | Sort-Object) -join ',' -ceq 'candidateCount,nodes,scannedNodes,status,version' -and $state.candidateCount -eq 2 -and $state.nodes[0].nameClass -ceq 'other' -and $state.nodes[1].nameClass -ceq 'cancel' -and !$state.nodes[1].sameProcess -and !$state.nodes[1].enabled -and $state.nodes[1].offscreen)
foreach ($row in $state.nodes) { Check '九个固定字段无数值身份原文' (($row.Keys | Sort-Object) -join ',' -ceq 'automationIdClass,controlTypeClass,enabled,invokePattern,nameClass,nativeHandlePresent,offscreen,sameProcess,windowClass') }

foreach ($fault in @('current', 'id', 'type', 'type-name', 'class', 'name', 'pid', 'handle', 'enabled', 'offscreen', 'pattern', 'first', 'next', 'id-late', 'name-late', 'handle-late', 'pattern-late', 'first-late', 'next-late')) {
    Reset-Case; Standard-Tree; [ReviewPort]::Fault = $fault
    $r = Run-Case
    Check ('实际异常或迟到回执拒绝完整投影：' + $fault) (!$r.accepted -and !$r.row.ok -and $r.row.saveButtonStructure.status -ceq 'read-failed' -and $r.row.saveButtonStructure.nodes.Count -eq 0 -and [ReviewPort]::Invokes -eq 0 -and [ReviewPort]::Writes -eq 0 -and [ReviewPort]::Disposals -eq 1)
}
foreach ($drift in @(2, 3)) {
    Reset-Case; Standard-Tree; [ReviewPort]::DriftsAt = $drift
    $r = Run-Case
    Check ('真实Assert-Dialog前后owner变化拒绝：' + $drift) (!$r.accepted -and $r.row.saveButtonStructure.status -ceq 'read-failed' -and $r.row.saveButtonStructure.nodes.Count -eq 0 -and [ReviewPort]::Invokes -eq 0)
}
Reset-Case; Standard-Tree
[ReviewPort]::Dialog.Children[0].Info.Canary = $false
[ReviewPort]::Fault = 'name'
$r = Run-Case
Check '已有首候选后异常仍不落盘部分投影' (!$r.accepted -and $r.row.saveButtonStructure.status -ceq 'read-failed' -and $r.row.saveButtonStructure.candidateCount -eq 1 -and $r.row.saveButtonStructure.nodes.Count -eq 0)
Reset-Case; Standard-Tree; [ReviewPort]::Initial = 'REVIEW_PRIVATE_INVALID_INITIAL'
$r = Run-Case
Check '文件名资格失败不进入诊断或动作' (!$r.accepted -and !$r.row.ContainsKey('saveButtonStructure') -and [ReviewPort]::First -eq 0 -and [ReviewPort]::Invokes -eq 0 -and [ReviewPort]::Writes -eq 0)
foreach ($size in @(511, 512)) {
    Reset-Case
    for ($i = 0; $i -lt $size; $i++) { $node = New-Node 'REVIEW_PRIVATE_ID' 'Pane' '' ''; $node.Info.ForbidName = $true; Child ([ReviewPort]::Dialog) $node }
    $r = Run-Case
    Check ('实际顶层含根512节点门：' + $size) (!$r.accepted -and !$r.row.ok -and $r.row.saveButtonStructure.scannedNodes -eq 512 -and $r.row.saveButtonStructure.status -ceq $(if ($size -eq 511) { 'complete' } else { 'tree-budget' }) -and [ReviewPort]::Names -eq 0 -and [ReviewPort]::Patterns -eq 0)
}
foreach ($size in @(0, 32, 33)) {
    Reset-Case
    for ($i = 0; $i -lt $size; $i++) { Child ([ReviewPort]::Dialog) (New-Node '' 'Pane' 'Button' 'REVIEW_PRIVATE_NAME') }
    $r = Run-Case
    Check ('实际顶层候选32门及完整后仍失败：' + $size) (!$r.accepted -and !$r.row.ok -and $r.row.saveButtonStructure.candidateCount -eq [Math]::Min($size, 32) -and $r.row.saveButtonStructure.status -ceq $(if ($size -le 32) { 'complete' } else { 'candidate-budget' }) -and $r.row.saveButtonStructure.nodes.Count -eq $(if ($size -le 32) { $size } else { 0 }) -and [ReviewPort]::Names -eq [Math]::Min($size, 32))
}
foreach ($entry in @(@('1', 'Pane', ''), @('2', 'Pane', ''), @('REVIEW_PRIVATE_ID', 'Button', ''), @('REVIEW_PRIVATE_ID', 'Pane', 'Button'), @('01', 'button', 'button'))) {
    Reset-Case; Child ([ReviewPort]::Dialog) (New-Node $entry[0] $entry[1] $entry[2] 'REVIEW_PRIVATE_NAME')
    $r = Run-Case
    Check '三个独立候选入口及大小写近似拒绝' ($r.row.saveButtonStructure.candidateCount -eq $(if ($entry[0] -ceq '01') { 0 } else { 1 }))
}
foreach ($initial in @('AIbrowse-backup', 'AIbrowse-backup.aibak')) {
    foreach ($action in @('CancelSave', 'SaveBackup')) {
        Reset-Case; [ReviewPort]::Initial = $initial
        $save = New-Node '1' 'Button' 'Button' '保存' $false; $save.HasInvoke = $true
        $cancel = New-Node '2' 'Button' 'Button' '取消' $false; $cancel.HasInvoke = $true
        Child ([ReviewPort]::Dialog) $save; Child ([ReviewPort]::Dialog) $cancel
        $r = Run-Case $action
        Check ('实际原Dialog-Button和动作路径：' + $initial + '/' + $action) ($r.accepted -and $r.row.ok -and !$r.row.ContainsKey('saveButtonStructure') -and [ReviewPort]::Invokes -eq 1 -and [ReviewPort]::Writes -eq [int]($action -ceq 'SaveBackup') -and [ReviewPort]::Disposals -eq 1)
    }
}

# These deliberate in-memory mutations prove that the oracle distinguishes the repaired behavior.
$diagnosticText = Function-Text $ast 'Inspect-DialogButtons'
$getterMutant = $diagnosticText.Replace('$current.get_Name()', '$current.Name')
Check 'getter反例只替换一个读取表达式' ($getterMutant -cne $diagnosticText)
. ([scriptblock]::Create((Isolate $getterMutant)))
Reset-Case; Standard-Tree; [ReviewPort]::Fault = 'name'
$r = Run-Case
Check '隐式getter突变被完整性oracle甄别' ($r.row.saveButtonStructure.status -ceq 'complete')
. ([scriptblock]::Create((Isolate $diagnosticText)))
$originalOuter = $outerCode
$outerCode = [scriptblock]::Create((Isolate ($outer[0].Extent.Text.Replace("throw '原生按钮只读诊断完成，停止后续动作'", ''))))
Reset-Case
$save = New-Node '1' 'Button' 'Button' '保存' $false; $save.HasInvoke = $true
$cancel = New-Node '2' 'Button' 'Button' '取消' $false; $cancel.HasInvoke = $true
Child ([ReviewPort]::Dialog) $save; Child ([ReviewPort]::Dialog) $cancel
$r = Run-Case
Check '去掉受控停止突变被顶层ok oracle甄别' ($r.accepted -and $r.row.ok -and $r.row.saveButtonStructure.status -ceq 'complete')
$outerCode = $originalOuter

# Compare the entire candidate after removing only the new diagnostic functions and Inspect insertion.
Check '绑定诊断前冻结源码' ((Get-FileHash -LiteralPath $beforePath -Algorithm SHA256).Hash -ceq '4B4A89243F966C01F9762715856E089B34DC65501F8AA9FCA220226076192F30')
$stripped = $source
foreach ($name in @('Get-ButtonAutomationIdClass', 'Get-ButtonNameClass', 'Inspect-DialogButtons')) { $stripped = $stripped.Replace((Function-Text $ast $name), '') }
$insertions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -ceq '$Action -eq ''InspectSaveDialog''' }, $true))
Check '诊断仅一个Inspect入口' ($insertions.Count -eq 1)
$stripped = $stripped.Replace($insertions[0].Extent.Text, '')
Check '剔除诊断后全脚本与冻结版本一致' (($stripped -replace '\s', '') -ceq ([IO.File]::ReadAllText($beforePath) -replace '\s', ''))
Check '测试期间候选源码未变' ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ceq $sourceHash)
[ordered]@{ passed = $checks.Count; sourceSha256 = $sourceHash; actualUi = $false; nativeCalls = $false; actualJob = $false } | ConvertTo-Json
