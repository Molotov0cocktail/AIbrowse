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
$freezePath=Join-Path $repository 'log/stage7-e2/native-selection-implementation-001/repair-freeze.json'
Require ((Get-FileHash -LiteralPath $freezePath).Hash.ToLowerInvariant() -ceq 'e5a7f88d6b47deede98fd83c24ab6aec2575e89a35f7b2e193f9c186b5530965')
$freeze=Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
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
    $original=Join-Path $repository 'log/stage7-e2/native-selection-independent-review-001/pure-002'
    for($index=1;$index -le 7;$index++){
        $file=Join-Path $original ('ps-json-'+$index+'.json');$before=(Get-FileHash -LiteralPath $file).Hash
        $fields=if($index -eq 2){@('sources')}else{@('version')}
        Test ('原件直接重放-'+$index) {if($index -lt 7){Reject{Read-ClosedJson $file $fields}}else{Require ((Read-ClosedJson $file $fields).version -eq 1)}}
        Require ((Get-FileHash -LiteralPath $file).Hash -ceq $before)
    }
    $jsonCases=@(
        @{name='空白后冒号的转义字段拒绝';text="{`"\u0076ersion`" `t`r`n : 1}";keys=@('version');reject=$true},
        @{name='反斜杠字段拒绝';text='{"a\\b":1}';keys=@('a\b');reject=$true},
        @{name='斜杠字段拒绝';text='{"a\/b":1}';keys=@('a/b');reject=$true},
        @{name='引号字段拒绝';text='{"a\"b":1}';keys=@('a"b');reject=$true},
        @{name='嵌套二层转义字段拒绝';text='{"sources":{"inner":{"\u006b":1}}}';keys=@('sources');reject=$true},
        @{name='值中Unicode转义保留';text='{"value":"\u4e2d\u6587"}';keys=@('value');reject=$false;expected='中文'},
        @{name='值中Windows反斜杠保留';text='{"value":"C:\\own\\file.aibak"}';keys=@('value');reject=$false;expected='C:\own\file.aibak'},
        @{name='值中看似字段的正文保留';text='{"value":"{\"\\u0076ersion\":1}"}';keys=@('value');reject=$false;expected='{"\u0076ersion":1}'},
        @{name='值中转义引号紧随冒号保留';text='{"value":"\":\\"}';keys=@('value');reject=$false;expected='":\'},
        @{name='值中标准转义保留';text='{"value":"a\tb\nc\rd\/e\bf\f"}';keys=@('value');reject=$false;expected="a`tb`nc`rd/e`bf`f"},
        @{name='词法合法但语法错误拒绝';text='{"value" "ok"}';keys=@('value');reject=$true},
        @{name='词法合法多个值拒绝';text='{"value":"ok"}{}';keys=@('value');reject=$true},
        @{name='非法转义拒绝';text='{"value":"\v"}';keys=@('value');reject=$true},
        @{name='非整数保持拒绝';text='{"value":1.0}';keys=@('value');reject=$true},
        @{name='过深对象保持拒绝';text='{"sources":{"a":{"b":{"c":1}}}}';keys=@('sources');reject=$true},
        @{name='对象中重复键保持拒绝';text='{"sources":{"a":1,"a":2}}';keys=@('sources');reject=$true},
        @{name='空值保持拒绝';text='{"value":null}';keys=@('value');reject=$true}
    )
    $index=0
    foreach($case in $jsonCases){$index++;$file=Join-Path $Evidence ('json-'+$index+'.json');[IO.File]::WriteAllText($file,$case.text);Test $case.name {if($case.reject){Reject {Read-ClosedJson $file $case.keys}}else{Require ((Read-ClosedJson $file $case.keys).value -ceq $case.expected)}}}
    Test '非法UTF8保持拒绝' {$p=Join-Path $Evidence 'invalid-utf8.json';[IO.File]::WriteAllBytes($p,[byte[]]@(123,34,118,97,108,117,101,34,58,34,192,175,34,125));Reject{Read-ClosedJson $p @('value')}}
    Test '新冻结build经实际入口读取通过' {$b=Read-ClosedJson (Join-Path $scope 'build.json') @('version','scopeId','purpose','sources','executable','helpers');Require ($b.scopeId -ceq $freeze.scopeId -and $b.sources.Count -eq 6 -and $b.executable -ceq $freeze.fixture -and $b.helpers -ceq $freeze.helpers)}
} finally {foreach($stream in $locks){$stream.Dispose()}}
Add-Type -Path @((Join-Path $candidate '../product-transfer/NativeSaveControl.cs'),(Join-Path $candidate '../product-transfer/NativeSaveButton.cs'),(Join-Path $candidate 'NativeSelectionEdit.cs'),(Join-Path $PSScriptRoot 'HelperReview.cs'))
foreach($entry in [HelperReview]::RunRepair()){$results.Add(@{name=$entry.name;pass=$entry.pass})}
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence 'results.json') -Encoding utf8
$failed=@($results|Where-Object{-not $_.pass})
@{passed=$results.Count-$failed.Count;failed=$failed.Count;actualUi=$false;actualCom=$false;actualJob=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'result.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $Evidence 'result.json') -Raw
$failed|ForEach-Object{$_.name}
if($failed.Count -gt 0){exit 1}
