[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '原件目录已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'confirm.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '真实确认入口语法错误'}
Add-Type -Path @((Join-Path $PSScriptRoot '../product-transfer/NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeRestoreConfirmation.cs'),(Join-Path $PSScriptRoot 'ConfirmationPureTests.cs'))
$cases=[Collections.Generic.List[string]]::new()
foreach($case in [RestoreConfirmationPureTests]::Run()){$cases.Add($case)}
foreach($name in @('Check-Time','Context')){
    $node=$ast.FindAll({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -ceq $name},$false)
    if(@($node).Count -ne 1){throw '固定真实函数缺失'}
    . ([scriptblock]::Create($node.Extent.Text))
}
function Dialog-Owner([IntPtr]$Handle){return [IntPtr]$script:testOwner}
function Nodes($Root){return $script:testNodes}
function Context-Case([string]$Name,[scriptblock]$Mutation,[bool]$Reject){
    $script:clock=[Diagnostics.Stopwatch]::StartNew()
    $script:BudgetMs=30000
    $script:ProcessId=42;$script:MainWindowHandle=10;$script:Purpose='restore';$script:testOwner=10
    $dialog=[RestoreContextNode]::new();$dialog.Text='确认恢复本地数据';$dialog.Handle=20
    $body=[RestoreContextNode]::new();$body.Text=[AIbrowseRestoreConfirmation]::Message('restore')
    $approve=[RestoreContextNode]::new();$approve.Text='恢复并重新启动';$approve.Handle=21
    $cancel=[RestoreContextNode]::new();$cancel.Text='取消';$cancel.Handle=22
    $script:testNodes=@($dialog,$body,$approve,$cancel)
    & $Mutation
    $rejected=$false
    try{[void](Context $dialog ([IntPtr]20))}catch{$rejected=$true}
    if($rejected -ne $Reject){throw ('真实Context反例失败：'+$Name)}
    $cases.Add($Name)
}
Context-Case '真实PS正文与唯一双按钮正向' {} $false
Context-Case '真实PS取消正文不符' {$body.Text='其它'} $true
Context-Case '真实PS重复正文拒绝' {$script:testNodes+=,$body} $true
Context-Case '真实PS缺批准拒绝' {$script:testNodes=@($dialog,$body,$cancel)} $true
Context-Case '真实PS重复取消拒绝' {$script:testNodes+=,$cancel} $true
Context-Case '真实PS错误目的正文拒绝' {$script:Purpose='partial'} $true
Context-Case '真实PS错误标题拒绝' {$dialog.Text='其它'} $true
Context-Case '真实PS错误owner拒绝' {$script:testOwner=99} $true
Context-Case '真实PS错误PID拒绝' {$approve.Pid=99} $true
Context-Case '真实PS错误原生class拒绝' {$approve.Class='Edit'} $true
Context-Case '真实PS空HWND拒绝' {$approve.Handle=0} $true
Context-Case '真实PS隐藏按钮拒绝' {$cancel.Offscreen=$true} $true
Context-Case '真实PS禁用按钮拒绝' {$cancel.Enabled=$false} $true
Context-Case '真实PS超长文本拒绝' {$body.Text='x'*4097} $true
Context-Case '真实PS原时钟已过拒绝' {$script:clock=[pscustomobject]@{ElapsedMilliseconds=30000}} $true
Context-Case '真实PS更短boot剩额拒绝' {$script:BudgetMs=1;$script:clock=[pscustomobject]@{ElapsedMilliseconds=1}} $true
$result=@{version=1;passed=$cases.Count;cases=$cases;nativeUiRun=$false;jobRun=$false}
[IO.File]::WriteAllText((Join-Path $Evidence 'result.json'),($result|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
$result|ConvertTo-Json -Compress -Depth 4
