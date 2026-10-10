[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$candidate=Join-Path $repository 'tools/data-qualification/native-file-selection'
if(Test-Path -LiteralPath $Evidence){throw '独立原件目录必须全新'}
[void][IO.Directory]::CreateDirectory($Evidence)
$results=[Collections.Generic.List[object]]::new()
function Require([bool]$Value){if(-not $Value){throw '独立断言失败'}}
function Reject([scriptblock]$Action){$denied=$false;try{& $Action | Out-Null}catch{$denied=$true};Require $denied}
function Test([string]$Name,[scriptblock]$Action){$pass=$true;try{& $Action | Out-Null}catch{$pass=$false};$results.Add(@{name=$Name;pass=$pass})}
$freeze=Get-Content -LiteralPath (Join-Path $repository 'log/stage7-e2/native-selection-implementation-001/freeze.json') -Raw | ConvertFrom-Json
$scope=Join-Path $repository ('log/stage7-e2/'+$freeze.scopeId)
$manifest=[Collections.Generic.List[object]]::new()
foreach($entry in @($freeze.localSources)+@($freeze.upstreamSources)){
    $actual=(Get-FileHash -LiteralPath $entry.path).Hash.ToLowerInvariant()
    $manifest.Add(@{path=$entry.path;expected=$entry.sha256;actual=$actual;matches=($actual -ceq $entry.sha256)})
}
foreach($entry in $freeze.snapshots){$path=Join-Path $scope ('source/'+$entry.name);$actual=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant();$manifest.Add(@{path=$path;expected=$entry.sha256;actual=$actual;matches=($actual -ceq $entry.sha256)})}
foreach($name in @('fixture','helpers')){$path=Join-Path $scope $(if($name -ceq 'fixture'){'fixture.exe'}else{'helpers.dll'});$actual=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant();$expected=$freeze.$name;$manifest.Add(@{path=$path;expected=$expected;actual=$actual;matches=($actual -ceq $expected)})}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence 'manifest.json') -Encoding utf8
Require (@($manifest | Where-Object{-not $_.matches}).Count -eq 0)
Require (-not (Test-Path -LiteralPath (Join-Path $scope 'claim.json')))
Require (-not (Test-Path -LiteralPath (Join-Path $scope 'runtime.json')))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $candidate 'run.ps1'),[ref]$tokens,[ref]$errors)
Require ($errors.Count -eq 0)
foreach($function in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
    if($function.Parent -is [Management.Automation.Language.NamedBlockAst]){. ([scriptblock]::Create($function.Extent.Text))}
}
$locks=[Collections.Generic.List[IO.FileStream]]::new();$clock=[pscustomobject]@{ElapsedMilliseconds=1};$uiStartedTick=$null
try {
    $jsonCases=@(
        @{name='独立转义顶层键必须拒绝';text='{"\u0076ersion":1}';keys=@('version');reject=$true},
        @{name='独立转义嵌套来源键必须拒绝';text='{"sources":{"\u004eativeSelectionEdit.cs":"fixed"}}';keys=@('sources');reject=$true},
        @{name='转义重复键拒绝';text='{"version":1,"\u0076ersion":2}';keys=@('version');reject=$true},
        @{name='普通重复键拒绝';text='{"version":1,"version":2}';keys=@('version');reject=$true},
        @{name='尾部内容拒绝';text='{"version":1}x';keys=@('version');reject=$true},
        @{name='数组拒绝';text='{"version":[]}';keys=@('version');reject=$true},
        @{name='正常字段通过';text='{"version":1}';keys=@('version');reject=$false}
    )
    $index=0
    foreach($case in $jsonCases){$index++;$file=Join-Path $Evidence ('ps-json-'+$index+'.json');[IO.File]::WriteAllText($file,$case.text);Test $case.name {if($case.reject){Reject {Read-ClosedJson $file $case.keys}}else{Require ((Read-ClosedJson $file $case.keys).version -eq 1)}}}
    Test '最终验证迟到禁止输出' {$clock.ElapsedMilliseconds=1;Reject {Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {$clock.ElapsedMilliseconds=120000} {}}}
    Test '最终关闭迟到禁止输出' {$clock.ElapsedMilliseconds=1;Reject {Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {} {$clock.ElapsedMilliseconds=120000}}}
    Test '最终输出后迟到必须失败' {
        $clock.ElapsedMilliseconds=1
        function Write-Output {param($InputObject)$clock.ElapsedMilliseconds=120000;Microsoft.PowerShell.Utility\Write-Output $InputObject}
        Reject {Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {} {}}
    }
    Test '最终验证失败无成功' {$clock.ElapsedMilliseconds=1;Reject {Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {throw '固定故障'} {}}}
    Test '最终收口正常输出' {$clock.ElapsedMilliseconds=1;$value=Complete-WrapperResult @{qualified=$false;terminal='pending';elapsedMs=0} $true {} {} | ConvertFrom-Json;Require ($value.qualified -and $value.terminal -ceq 'wrapper-complete')}
    Test '小文件claim原件不可覆盖' {$p=Join-Path $Evidence 'direct-claim.json';Write-New $p @{one=1};Reject{Write-New $p @{one=2}};Require ((Read-ClosedJson $p @('one')).one -eq 1)}
    Test '真实Run缺来源失败也消耗claim' {
        $sid='native-file-selection-'+[Guid]::NewGuid().ToString('N');$bad=Join-Path $repository ('log/stage7-e2/'+$sid)
        [void][IO.Directory]::CreateDirectory((Join-Path $bad 'source'))
        $pwsh=(Get-Process -Id $PID).Path
        & $pwsh -NoProfile -File (Join-Path $candidate 'run.ps1') -Mode Run -ScopeId $sid *> (Join-Path $Evidence 'claim-first.txt')
        Require ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath (Join-Path $bad 'claim.json')) -and -not (Test-Path -LiteralPath (Join-Path $bad 'runtime.json')))
        $first=(Get-FileHash -LiteralPath (Join-Path $bad 'claim.json')).Hash
        & $pwsh -NoProfile -File (Join-Path $candidate 'run.ps1') -Mode Run -ScopeId $sid *> (Join-Path $Evidence 'claim-second.txt')
        Require ($LASTEXITCODE -ne 0 -and (Get-FileHash -LiteralPath (Join-Path $bad 'claim.json')).Hash -ceq $first -and -not (Test-Path -LiteralPath (Join-Path $bad 'runtime.json')))
        [IO.File]::WriteAllText((Join-Path $Evidence 'claim-scope.txt'),$sid)
    }
} finally {foreach($stream in $locks){$stream.Dispose()}}
# Compile actual helpers with independent ports. No native constructor is called.
Add-Type -Path @((Join-Path $candidate '../product-transfer/NativeSaveControl.cs'),(Join-Path $candidate '../product-transfer/NativeSaveButton.cs'),(Join-Path $candidate 'NativeSelectionEdit.cs'),(Join-Path $PSScriptRoot 'HelperReview.cs'))
foreach($entry in [HelperReview]::Run()){$results.Add(@{name=$entry.name;pass=$entry.pass})}
# Compile the entire fixture with a pure independent entry point; never call its UI entry.
$exe=Join-Path $Evidence 'fixture-independent.exe'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /main:FixtureReview /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/out:$exe" (Join-Path $candidate 'NativeSelectionFixture.cs') (Join-Path $PSScriptRoot 'FixtureReview.cs') *> (Join-Path $Evidence 'compile.txt')
Require ($LASTEXITCODE -eq 0)
& $exe $Evidence *> (Join-Path $Evidence 'fixture-output.txt')
Require ($LASTEXITCODE -eq 0)
foreach($entry in (Get-Content -LiteralPath (Join-Path $Evidence 'fixture-results.json') -Raw | ConvertFrom-Json)){$results.Add(@{name=$entry.name;pass=$entry.pass})}
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence 'results.json') -Encoding utf8
$failed=@($results|Where-Object{-not $_.pass})
@{passed=$results.Count-$failed.Count;failed=$failed.Count;actualUi=$false;actualCom=$false;actualJob=$false;candidateSourcesUnchanged=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'result.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $Evidence 'result.json') -Raw
$failed|ForEach-Object{$_.name}
if($failed.Count -gt 0){exit 1}
