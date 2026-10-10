[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '拒绝覆盖已有原件'}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Evidence))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'ui.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '真实UI入口存在语法错误'}
foreach($name in @('Check-Time','Assert-Request','Cancelled-Text','Unique','Native-Button','Nodes')) {
    $node=@($ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -ceq $name},$false))
    if($node.Count -ne 1){throw '真实UI函数缺失或重复'}
    . ([scriptblock]::Create($node[0].Extent.Text))
}
Add-Type -Path (Join-Path $PSScriptRoot 'UiPureTests.cs')
$checks=[Collections.Generic.List[string]]::new()
function Check([string]$Name,[bool]$Result) { if(-not $Result){throw ('UI纯反例失败：'+$Name)};$checks.Add($Name) }
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
function Request-Case([string]$Name,[scriptblock]$Change,[bool]$Expected) {
    $script:Scene='R';$script:Action='SelectRestore';$script:ActionSequence=1;$script:Variant=''
    $script:Journal=Join-Path $repository 'log/stage7-e1/disposable-profile/journal-0123456789abcdef0123456789abcdef'
    $script:Target=[IO.Path]::GetFullPath((Join-Path $script:Journal 'runner-output/restore-campaign/product-A.aibak'))
    & $Change
    $accepted=$true;try{Assert-Request $repository}catch{$accepted=$false}
    Check $Name ($accepted -eq $Expected)
}
Request-Case 'R固定备份输入允许' {} $true
Request-Case 'R固定保存允许' {$script:Action='SaveBackup'} $true
Request-Case 'P固定H允许' {$script:Scene='P';$script:Target=[IO.Path]::GetFullPath((Join-Path $script:Journal 'runner-output/restore-campaign/synthetic-H.aibak'))} $true
Request-Case '其它journal目录拒绝' {$script:Journal=Join-Path $repository 'log/stage7-e2/journal-0123456789abcdef0123456789abcdef'} $false
Request-Case 'journal名字越界拒绝' {$script:Journal=Join-Path $repository 'log/stage7-e1/disposable-profile/journal-test'} $false
Request-Case '缺目标拒绝' {$script:Target=''} $false
Request-Case '相对目标拒绝' {$script:Target='product-A.aibak'} $false
Request-Case '父目录目标拒绝' {$script:Target=Join-Path $repository 'product-A.aibak'} $false
Request-Case '错后缀拒绝' {$script:Target=$script:Target+'.json'} $false
Request-Case '非文件动作带目标拒绝' {$script:Action='Close'} $false
Request-Case 'P备份动作拒绝' {$script:Scene='P';$script:Action='SaveBackup'} $false
foreach($requestAction in @('BootPartial','BootRecovery','OpenPartial')) {
    Request-Case ('R不能执行'+$requestAction) {$script:Action=$requestAction;$script:Target=''} $false
}
Request-Case '非域读取不能带Variant' {$script:Variant='A'} $false
foreach($requestAction in @('ReadSources','ReadResearch','ReadWatch','ReadConversation')) {
    Request-Case ($requestAction+'正确A标记') {$script:Action=$requestAction;$script:Target='';$script:Variant='A'} $true
    Request-Case ($requestAction+'拒绝H混代') {$script:Action=$requestAction;$script:Target='';$script:Variant='H'} $false
    Request-Case ($requestAction+'拒绝缺Variant') {$script:Action=$requestAction;$script:Target=''} $false
}
$script:Scene='P';$script:ActionSequence=4
Check 'P首次取消保留partial语义' ((Cancelled-Text) -ceq '已取消重新启动，原数据业务保持关闭')
$script:ActionSequence=10
Check 'P恢复选择取消独立语义' ((Cancelled-Text) -ceq '操作已取消')
$script:Scene='R';$script:ActionSequence=4
Check 'R不能借partial取消文案' ((Cancelled-Text) -ceq '操作已取消')

$script:clock=[pscustomobject]@{ElapsedMilliseconds=0};$script:BudgetMs=30000;$script:ProcessId=42
$realNodes=(Get-Item Function:Nodes).ScriptBlock
function Tree-Walker { return [RestoreUiPureWalker]::new() }
function Tree-Case([string]$Name,[int]$Count,[int]$Maximum,[int]$TextLength,[bool]$Expected) {
    $script:clock=[pscustomobject]@{ElapsedMilliseconds=0}
    $root=[RestoreUiPureNode]::new();$root.Name='固定根';$previous=$null
    for($i=1;$i -lt $Count;$i++) {
        $node=[RestoreUiPureNode]::new();$node.Name='x'*$TextLength
        if($null -eq $previous){$root.First=$node}else{$previous.Next=$node};$previous=$node
    }
    $accepted=$true;try{$found=@(& $realNodes $root $Maximum);$accepted=$found.Count -eq $Count}catch{$accepted=$false}
    Check $Name ($accepted -eq $Expected)
}
Tree-Case '真实遍历恰好512节点允许' 512 512 1 $true
Tree-Case '真实遍历第513节点拒绝' 513 512 1 $false
Tree-Case 'host恰好16后代允许' 17 17 1 $true
Tree-Case 'host第17后代拒绝' 18 17 1 $false
Tree-Case '文本恰好4096允许' 2 512 4096 $true
Tree-Case '文本4097拒绝' 2 512 4097 $false
Tree-Case '不得放宽512原门' 1 513 1 $false
Tree-Case '不得使用零节点预算' 1 0 1 $false
function Nodes($Root) { Check-Time;if($script:late){$script:clock.ElapsedMilliseconds=30000};return $script:nodes }
function Button-Case([string]$Name,[scriptblock]$Change,[bool]$Expected,[bool]$Open=$true,[bool]$Cancel=$false) {
    $script:clock=[pscustomobject]@{ElapsedMilliseconds=0};$script:BudgetMs=30000;$script:late=$false
    $button=[RestoreUiPureNode]::new();$script:nodes=@($button)
    & $Change
    $accepted=$true;try{[void](Native-Button ([pscustomobject]@{Node=$null}) $Open $Cancel)}catch{$accepted=$false}
    Check $Name ($accepted -eq $Expected)
}
Button-Case '原生Open正向完整资格' {} $true
Button-Case '原生Save正向完整资格' {$button.Name='保存'} $true $false
Button-Case '原生Cancel正向完整资格' {$button.Name='取消';$button.Id='2'} $true $true $true
Button-Case '缺按钮拒绝' {$script:nodes=@()} $false
Button-Case '重复按钮拒绝' {$script:nodes+=,$button} $false
Button-Case '错误名字拒绝' {$button.Name='执行'} $false
Button-Case '错误按钮ID拒绝' {$button.Id='99'} $false
Button-Case '错误原生class拒绝' {$button.Class='Edit'} $false
Button-Case '错误PID拒绝' {$button.Pid=99} $false
Button-Case '空句柄拒绝' {$button.Handle=0} $false
Button-Case '禁用拒绝' {$button.Enabled=$false} $false
Button-Case '不可见拒绝' {$button.Offscreen=$true} $false
Button-Case 'Save不能借Open名字' {} $false $false
Button-Case 'Cancel不能借Open按钮' {} $false $true $true
Button-Case '读取跨期拒绝' {$script:late=$true} $false
Button-Case 'caller更短剩额到期拒绝' {$script:BudgetMs=1;$script:clock.ElapsedMilliseconds=1} $false
Button-Case '已到原期限拒绝' {$script:clock.ElapsedMilliseconds=30000} $false
Check 'Unique零匹配不选' ($null -eq (Unique @(1,2) {$_ -eq 3}))
Check 'Unique单匹配只选该项' ((Unique @(1,2) {$_ -eq 2}) -eq 2)
$rejected=$false;try{[void](Unique @(2,2) {$_ -eq 2})}catch{$rejected=$true}
Check 'Unique重复匹配拒绝' $rejected
$report=@{version=1;passed=$checks.Count;checks=$checks;actualUi=$false;actualCom=$false;actualJob=$false;uiSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'ui.ps1')).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path ([IO.Path]::GetFullPath($Evidence)) 'result.json'),($report|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
$report|ConvertTo-Json -Depth 4 -Compress
