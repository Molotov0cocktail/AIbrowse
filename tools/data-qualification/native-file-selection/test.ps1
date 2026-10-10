[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence,[switch]$RepairOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath $Evidence) { throw '测试原件已存在，拒绝覆盖' }
[void][IO.Directory]::CreateDirectory($Evidence)
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeSelectionFixture.cs'))
$start=$fixture.IndexOf('    public sealed class ChoiceLedger',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('    internal static class FlatJson',[StringComparison]::Ordinal)
$orderStart=$fixture.IndexOf('    public static class CampaignOrder',[StringComparison]::Ordinal)
$orderEnd=$fixture.IndexOf('    public sealed class OpenInputLease',[StringComparison]::Ordinal)
$inputEnd=$fixture.IndexOf('    [StructLayout(LayoutKind.Sequential, CharSet',[StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start -or $orderStart -lt 0 -or $orderEnd -le $orderStart -or $inputEnd -le $orderEnd) { throw '实际纯函数边界无效' }
$pure='using System; using System.Collections.Generic; using System.IO; using System.Text; using System.Security.Cryptography; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; namespace AIbrowse.SelectionQualification {'+$fixture.Substring($start,$end-$start)+$fixture.Substring($orderStart,$inputEnd-$orderStart)+'}'
$purePath=Join-Path $Evidence 'fixture-pure.cs'
[IO.File]::WriteAllText($purePath,$pure,[Text.UTF8Encoding]::new($false))
$old=Join-Path $PSScriptRoot '../product-transfer'
Add-Type -Path @((Join-Path $old 'NativeSaveControl.cs'),(Join-Path $old 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeSelectionEdit.cs'),$purePath,(Join-Path $PSScriptRoot 'SelectionPureTests.cs'))
$results=[Collections.Generic.List[object]]::new()
$nativeResults=if($RepairOnly){[SelectionPureTests]::RunRepair()}else{[SelectionPureTests]::Run()}
foreach($result in $nativeResults) { $results.Add(@{name=$result.Name;pass=$result.Pass}) }
function Check([string]$Name,[scriptblock]$Action) {
    if($RepairOnly -and $Name -cnotlike '完整词法-*' -and $Name -cnotin @('真实JSON转义重复字段拒绝','严格UTF8不放宽')) { return }
    try { & $Action; $results.Add(@{name=$Name;pass=$true}) } catch { $results.Add(@{name=$Name;pass=$false}) }
}
function Must-Reject([scriptblock]$Action) { $rejected=$false; try { & $Action } catch { $rejected=$true }; if(-not $rejected){throw '反例未拒绝'} }
# Extract and execute the real wrapper functions without dispatching Build/Run/Helper.
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '真实入口语法错误' }
foreach($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
    if ($function.Parent -is [Management.Automation.Language.NamedBlockAst]) { . ([scriptblock]::Create($function.Extent.Text)) }
}
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$clock=[Diagnostics.Stopwatch]::StartNew(); $uiStartedTick=$null
Check '真实小控制文件摘要和锁' {
    $path=Join-Path $Evidence 'control.aibak'
    [IO.File]::WriteAllBytes($path,[AIbrowse.SelectionQualification.OpenInputLease]::Content)
    $lease=[AIbrowse.SelectionQualification.OpenInputLease]::new($path)
    try {
        $lease.Verify()
        Must-Reject { [IO.File]::WriteAllBytes($path,[byte[]]@(1,2)) }
        Must-Reject { [IO.File]::Move($path,(Join-Path $Evidence 'replacement.aibak')) }
        $lease.Verify()
    } finally { $lease.Dispose() }
}
Check '打开控制文件在建立持有前被替换拒绝' {
    $path=Join-Path $Evidence 'wrong.aibak'
    $content=[AIbrowse.SelectionQualification.OpenInputLease]::Content; $content[0]=0
    [IO.File]::WriteAllBytes($path,$content)
    Must-Reject { $lease=[AIbrowse.SelectionQualification.OpenInputLease]::new($path); $lease.Dispose() }
}
Check '真实回执CreateNew不覆盖' {
    $path=Join-Path $Evidence 'claim.json'; Write-New $path @{version=1}
    Must-Reject { Write-New $path @{version=2} }
    if((Read-ClosedJson $path @('version')).version -ne 1){throw '原claim变化'}
}
Check '真实JSON转义重复字段拒绝' {
    $path=Join-Path $Evidence 'duplicate.json'
    [IO.File]::WriteAllText($path,'{"version":1,"\u0076ersion":2}')
    Must-Reject { Read-ClosedJson $path @('version') }
}
$jsonCases=@(
    @{name='顶层单独转义字段名';text='{"\u0076ersion":1}';keys=@('version');reject=$true},
    @{name='嵌套单独转义字段名';text='{"version":1,"sources":{"\u004eativeSelectionEdit.cs":"fixed"}}';keys=@('version','sources');reject=$true},
    @{name='字段名转义引号';text='{"version":1,"bad\"key":"fixed"}';keys=@('version','bad"key');reject=$true},
    @{name='字段名转义反斜杠';text='{"version":1,"bad\\key":"fixed"}';keys=@('version','bad\key');reject=$true},
    @{name='字段名转义斜杠';text='{"version":1,"bad\/key":"fixed"}';keys=@('version','bad/key');reject=$true},
    @{name='转义字段后空白';text="{`"\u0076ersion`" `t`r`n:1}";keys=@('version');reject=$true},
    @{name='值内全部合法转义';text='{"version":1,"label":"quote\": colon, backslash\\, unicode\u0061, slash\/, controls\b\f\n\r\t"}';keys=@('version','label');reject=$false},
    @{name='值内模拟转义字段';text='{"version":1,"sources":{"literal":"\\u004eative: \"x\""}}';keys=@('version','sources');reject=$false},
    @{name='尾部另一个对象';text='{"version":1}{}';keys=@('version');reject=$true},
    @{name='未闭合字符串';text='{"version":1,"label":"broken}';keys=@('version','label');reject=$true},
    @{name='非法值转义';text='{"version":1,"label":"\x20"}';keys=@('version','label');reject=$true},
    @{name='整数前导零';text='{"version":01}';keys=@('version');reject=$true},
    @{name='数字指数不冒充整数';text='{"version":1e0}';keys=@('version');reject=$true},
    @{name='嵌套深度不放宽';text='{"version":1,"sources":{"a":{"b":{"c":1}}}}';keys=@('version','sources');reject=$true}
)
$jsonIndex=0
foreach($jsonCase in $jsonCases) {
    $jsonIndex++
    Check ('完整词法-'+$jsonCase.name) {
        $path=Join-Path $Evidence "lexical-$jsonIndex.json"
        [IO.File]::WriteAllText($path,$jsonCase.text,[Text.UTF8Encoding]::new($false))
        if($jsonCase.reject){Must-Reject {Read-ClosedJson $path $jsonCase.keys}}
        elseif((Read-ClosedJson $path $jsonCase.keys).version -ne 1){throw '合法转义值被误读'}
    }
}
Check '严格UTF8不放宽' {
    $path=Join-Path $Evidence 'invalid-utf8.json'
    [IO.File]::WriteAllBytes($path,[byte[]]@(123,34,118,34,58,34,255,34,125))
    Must-Reject {Read-ClosedJson $path @('v')}
}
Check '真实闭包缺来源拒绝' {
    $path=Join-Path $Evidence 'closure'; [void][IO.Directory]::CreateDirectory($path)
    [IO.File]::WriteAllText((Join-Path $path 'one'),'fixed')
    Must-Reject { Assert-ExactNames $path @('one','two') }
    Assert-ExactNames $path @('one')
    Must-Reject { Assert-ExactNames $path @() }
}
Check '目的不可改为旧资格' { Must-Reject { Assert-Purpose 'selection-qualification' 'qualification' } }
Check '真实64KiB回执上界' { Must-Reject { Write-New (Join-Path $Evidence 'oversize.json') @{text=('x'*65536)} } }
Check '磁盘pending迟到不授成功' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=120000}
    $report=@{qualified=$false;terminal='pending';elapsedMs=0}
    Must-Reject { Complete-WrapperResult $report $true {} {} }
    if($report.qualified -or $report.terminal -cne 'pending'){throw '迟到授成功'}
}
Check '最终验证迟到不授成功' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    $report=@{qualified=$false;terminal='pending';elapsedMs=0}
    Must-Reject { Complete-WrapperResult $report $true {$clock.ElapsedMilliseconds=120000} {} }
    if($report.qualified){throw '迟到授成功'}
}
Check '最终释放迟到不授成功' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    $report=@{qualified=$false;terminal='pending';elapsedMs=0}
    Must-Reject { Complete-WrapperResult $report $true {} {$clock.ElapsedMilliseconds=120000} }
    if($report.qualified){throw '迟到授成功'}
}
Check '最终释放失败不授成功' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    $report=@{qualified=$false;terminal='pending';elapsedMs=0}
    Must-Reject { Complete-WrapperResult $report $true {} {throw '固定释放失败'} }
    if($report.qualified){throw '释放失败授成功'}
}
Check '完整收尾才发最终stdout' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    $report=@{qualified=$false;terminal='pending';elapsedMs=0}
    $terminal=Complete-WrapperResult $report $true {} {} | ConvertFrom-Json
    if(-not $terminal.qualified -or $terminal.terminal -cne 'wrapper-complete'){throw '完整收尾没有成功'}
}
Check '最终序列化迟到拒绝' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    function ConvertTo-Json { param([Parameter(ValueFromPipeline)]$InputObject,[switch]$Compress) process { $clock.ElapsedMilliseconds=120000; Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $InputObject -Compress:$Compress } }
    Must-Reject { Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {} {} }
}
Check '最终输出迟到拒绝' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=100}
    function Write-Output { param($InputObject) $clock.ElapsedMilliseconds=120000; Microsoft.PowerShell.Utility\Write-Output $InputObject }
    Must-Reject { Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {} {} }
}
$clock=[Diagnostics.Stopwatch]::StartNew()
Check '真实Run预检失败消耗claim且禁止复用' {
    $repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
    $scopeId='native-file-selection-'+[Guid]::NewGuid().ToString('N')
    $scope=Join-Path $repository "log/stage7-e2/$scopeId"
    [void][IO.Directory]::CreateDirectory((Join-Path $scope 'source'))
    # The intentionally empty source directory and missing executable make Job entry unreachable.
    & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $PSScriptRoot 'run.ps1') -Mode Run -ScopeId $scopeId *> (Join-Path $Evidence 'claim-first.txt')
    if($LASTEXITCODE -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $scope 'claim.json')) -or (Test-Path -LiteralPath (Join-Path $scope 'runtime.json'))){throw '早claim失败'}
    $hash=(Get-FileHash -LiteralPath (Join-Path $scope 'claim.json')).Hash
    & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $PSScriptRoot 'run.ps1') -Mode Run -ScopeId $scopeId *> (Join-Path $Evidence 'claim-second.txt')
    if($LASTEXITCODE -eq 0 -or (Get-FileHash -LiteralPath (Join-Path $scope 'claim.json')).Hash -cne $hash -or (Test-Path -LiteralPath (Join-Path $scope 'runtime.json'))){throw 'scope被复用'}
    [IO.File]::WriteAllText((Join-Path $Evidence 'claim-scope.txt'),$scopeId)
}
foreach($stream in $locks){$stream.Dispose()}
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence 'results.json') -Encoding utf8
$failed=@($results | Where-Object { -not $_.pass })
[pscustomobject]@{passed=$results.Count-$failed.Count;failed=$failed.Count;actualUi=$false;actualJob=$false}
if($failed.Count -ne 0){$failed | ForEach-Object{$_.name};exit 1}
