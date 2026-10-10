[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '拒绝覆盖独立反例原件'}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Evidence))
$source=Join-Path $PSScriptRoot 'product-restore-ui/ui.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '真实入口语法无效'}
foreach($name in @('Check-Time','Wait-For','Unique','Button','Invoke-Node','Has-Text')) {
    $found=@($ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -ceq $name},$false))
    if($found.Count -ne 1){throw '实际函数缺失或重复'}
    . ([scriptblock]::Create($found[0].Extent.Text))
}
# In-memory UIA boundary only. No real window, native process, COM, or Job exists.
Add-Type -TypeDefinition @'
namespace Windows.Automation {
 public sealed class ControlType { public static readonly ControlType Button = new ControlType(); public static readonly ControlType Text = new ControlType(); }
 public sealed class InvokePattern { public static readonly object Pattern = new object(); public int Calls; public void Invoke(){Calls++;} }
}
public sealed class RestoreIndependentNode {
 public string Name = "选择备份恢复";
 public string Document = "app";
 public int Pid = 42;
 public bool Enabled = true, Offscreen;
 public Windows.Automation.ControlType Type = Windows.Automation.ControlType.Button;
 public readonly Windows.Automation.InvokePattern Invoker = new Windows.Automation.InvokePattern();
 public RestoreIndependentNode get_Current(){return this;}
 public string get_Name(){return Name;}
 public int get_ProcessId(){return Pid;}
 public Windows.Automation.ControlType get_ControlType(){return Type;}
 public bool get_IsEnabled(){return Enabled;}
 public bool get_IsOffscreen(){return Offscreen;}
 public bool TryGetCurrentPattern(object token,out object value){value=Invoker;return true;}
}
'@
$clock=[pscustomobject]@{ElapsedMilliseconds=0};$BudgetMs=30000;$ProcessId=42
function Check-Process { Check-Time }
function Root { return $null }
function Nodes($Root) { return $script:nodes }
$rows=[Collections.Generic.List[object]]::new()
function Record([string]$Name,[bool]$Pass,$Details) {$rows.Add(@{case=$Name;pass=$Pass;details=$Details})}
$node=[RestoreIndependentNode]::new();$script:nodes=@($node)
$selected=Button '选择备份恢复';Invoke-Node $selected
Record '固定按钮正常动作一次' ($node.Invoker.Calls -eq 1) @{calls=$node.Invoker.Calls}

$node=[RestoreIndependentNode]::new();$node.Document='web';$node.Pid=999;$script:nodes=@($node)
$accepted=$false
try{$selected=Button '选择备份恢复';$accepted=$null -ne $selected}catch{}
Record '其它Document的同名按钮必须拒绝' (-not $accepted) @{accepted=$accepted;origin='合成外部Document';pid=999}

foreach($change in @('name','type','document','process','duplicate')) {
    $node=[RestoreIndependentNode]::new();$script:nodes=@($node)
    $selected=Button '选择备份恢复'
    switch($change){
        'name' {$node.Name='其它动作'}
        'type' {$node.Type=[Windows.Automation.ControlType]::Text}
        'document' {$node.Document='web'}
        'process' {$node.Pid=999}
        'duplicate' {$script:nodes+=,[RestoreIndependentNode]::new()}
    }
    try{Invoke-Node $selected}catch{}
    Record ('动作前'+$change+'漂移必须零动作') ($node.Invoker.Calls -eq 0) @{calls=$node.Invoker.Calls}
}
$node=[RestoreIndependentNode]::new();$node.Document='web';$node.Pid=999;$node.Name='备份已完整保存，原数据业务已恢复';$script:nodes=@($node)
$accepted=Has-Text '备份已完整保存，原数据业务已恢复'
Record '其它Document的同名成功文字必须拒绝' (-not $accepted) @{accepted=$accepted}
$report=@{version=1;sourceSha256=(Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant();passed=@($rows|Where-Object pass).Count;failed=@($rows|Where-Object {-not $_.pass}).Count;cases=$rows;actualUi=$false;actualCom=$false;actualJob=$false;actualProduct=$false}
$report|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $Evidence 'result.json') -Encoding utf8
$report|ConvertTo-Json -Depth 6 -Compress
if($report.failed -ne 0){exit 1}
