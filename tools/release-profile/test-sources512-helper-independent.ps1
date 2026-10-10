[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/sources512-independent-review-001'
$candidate=Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs'
$previous=Join-Path $repository 'log/stage7-e2/native-filename-commit-implementation-001/FixedTransferJob.cs.before'
$expectedBefore='9f5be118581a854c7e4cb955217b7c015c30d033ba8dec99dfbaae5fb4f17e7d'
$expectedAfter='be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167'
if((Get-FileHash -LiteralPath $previous).Hash.ToLowerInvariant() -cne $expectedBefore -or (Get-FileHash -LiteralPath $candidate).Hash.ToLowerInvariant() -cne $expectedAfter){throw '冻结helper摘要不符'}
$before=[IO.File]::ReadAllText($previous).Replace("`r`n","`n")
$after=[IO.File]::ReadAllText($candidate).Replace("`r`n","`n")
$mapping=@'
        private static uint ModeProcesses(string mode) {
            if(mode=="import")return 1;
            if(mode=="transfer")return 24;
            if(mode=="filename")return 4;
            throw new InvalidOperationException("固定Job模式无效");
        }
'@
$reconstructed=$after.Replace($mapping+"`n",'').Replace(
    'if (flags != 0x2308 || processes != ModeProcesses(mode) ||',
    'if ((mode != "import" && mode != "transfer") || flags != 0x2308 || processes != (mode == "import" ? 1u : 24u) ||'
).Replace(
    "            uint modeProcesses=ModeProcesses(mode);`n",''
).Replace(
    'workMs > (mode == "transfer" ? 3060000 : 120000) ||',
    'workMs > (mode == "import" ? 120000 : 3060000) || (mode != "import" && mode != "transfer") ||'
).Replace('ActiveProcessLimit=modeProcesses','ActiveProcessLimit=(mode == "import" ? 1u : 24u)')
if($reconstructed -cne $before){throw '声明之外的helper字节变化'}
# Compile the real helpers. Only pure methods and pre-native invalid calls run.
Add-Type -TypeDefinition $after
Add-Type -TypeDefinition ($before.Replace('namespace AIbrowse.FullTransfer','namespace AIbrowse.BeforeSources512'))
$mappingMethod=[AIbrowse.FullTransfer.FixedTransferJob].GetMethod('ModeProcesses',[Reflection.BindingFlags]'NonPublic,Static')
$outcomes=[Collections.Generic.List[object]]::new()
function Assert-Limits([string]$Mode,[uint32]$Flags,[uint32]$Processes,[uint64]$ProcessBytes,[uint64]$JobBytes,[bool]$Expected) {
    $newAccepted=$false;$oldAccepted=$false
    try{[AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits($Mode,$Flags,$Processes,$ProcessBytes,$JobBytes);$newAccepted=$true}catch{}
    try{[AIbrowse.BeforeSources512.FixedTransferJob]::ValidateLimits($Mode,$Flags,$Processes,$ProcessBytes,$JobBytes);$oldAccepted=$true}catch{}
    if($newAccepted -ne $Expected -or ($Mode -in @('import','transfer') -and $oldAccepted -ne $newAccepted)){throw '新旧限额与独立oracle不符'}
    $outcomes.Add(@{kind='limits';mode=$Mode;flags=$Flags;processes=$Processes;processBytes=$ProcessBytes;jobBytes=$JobBytes;accepted=$newAccepted})
}
foreach($mode in @('import','transfer')) {
    $processes=if($mode -eq 'import'){1}else{24}
    $jobBytes=if($mode -eq 'import'){2147483648L}else{4294967296L}
    Assert-Limits $mode 0x2308 $processes 2147483648 $jobBytes $true
    foreach($flags in @(0,0x2300,0x2309,0x6308)){Assert-Limits $mode $flags $processes 2147483648 $jobBytes $false}
    foreach($members in @(0,2,4,23,25)){Assert-Limits $mode 0x2308 $members 2147483648 $jobBytes $false}
    foreach($bytes in @(0L,2147483647L,2147483649L,4294967296L)){Assert-Limits $mode 0x2308 $processes $bytes $jobBytes $false}
    foreach($bytes in @(0L,($jobBytes-1),($jobBytes+1))){Assert-Limits $mode 0x2308 $processes 2147483648 $bytes $false}
}
foreach($entry in @(@('import',1),@('transfer',24),@('filename',4))) {
    if($mappingMethod.Invoke($null,[object[]]@($entry[0])) -ne $entry[1]){throw '模式成员数不符'}
    $outcomes.Add(@{kind='mapping';mode=$entry[0];members=$entry[1]})
}
foreach($mode in @('', 'Import', 'TRANSFER', 'filename ', '../import', 'unknown')) {
    $rejected=$false
    try{$null=$mappingMethod.Invoke($null,[object[]]@($mode))}catch{$rejected=$_.Exception.InnerException -is [InvalidOperationException]}
    if(-not $rejected){throw '模式未闭合'}
    # Invalid modes must fail before parameter regex and before every native call.
    $message=''
    try{$null=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($mode,$null,$null,$null,$null,$null,1)}catch{$message=$_.Exception.InnerException.Message}
    if($message -cne '固定Job模式无效'){throw '未知模式未在原生入口前拒绝'}
    $outcomes.Add(@{kind='invalid-mode-execute';mode=$mode;nativeCalled=$false})
}
foreach($work in @(-1,0,120001,[int]::MaxValue)) {
    $message=''
    try{$null=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import',$null,$null,$null,$null,('a'*32),$work)}catch{$message=$_.Exception.InnerException.Message}
    if($message -cne '固定Job参数无效'){throw 'import期限错误接受'}
    $outcomes.Add(@{kind='invalid-import-deadline';workMs=$work;nativeCalled=$false})
}
foreach($work in @(1,120000)) {
    $message=''
    try{$null=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import',$null,$null,$null,$null,'INVALID',$work)}catch{$message=$_.Exception.InnerException.Message}
    if($message -cne '固定Job参数无效'){throw 'import运行标识错误接受'}
    $outcomes.Add(@{kind='invalid-import-run-id';workMs=$work;nativeCalled=$false})
}
Assert-Limits 'filename' 0x2308 4 2147483648 4294967296 $true
Assert-Limits 'filename' 0x2308 1 2147483648 4294967296 $false
Assert-Limits 'filename' 0x2308 24 2147483648 4294967296 $false
if((Get-FileHash -LiteralPath $candidate).Hash.ToLowerInvariant() -cne $expectedAfter){throw '审查期间helper改变'}
@{beforeSha256=$expectedBefore;afterSha256=$expectedAfter;reconstructedBeforeMatches=$true;passed=$outcomes.Count;actualJob=$false;actualCapacity=$false;filenameGuiQualified=$false;cases=$outcomes}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $evidence 'helper-import-pure-001.json')
@{passed=$outcomes.Count;actualJob=$false;actualCapacity=$false;helperImportScope=$true;filenameGuiQualified=$false}|ConvertTo-Json
