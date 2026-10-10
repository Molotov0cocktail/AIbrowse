[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('success','timeout','child')][string]$Case)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$base=Join-Path $repository 'log\stage7-e2'
for($path=$base;;$path=[IO.Path]::GetDirectoryName($path)) {
    $item=Get-Item -LiteralPath $path
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '资格目录无效'}
    if([string]::IsNullOrEmpty([IO.Path]::GetDirectoryName($path))){break}
}
$id=[Guid]::NewGuid().ToString('N')
$scope=Join-Path $base "full-conversations-native-$id"
[IO.Directory]::CreateDirectory($scope)|Out-Null
function Write-Fixed([string]$Path,[string]$Text) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    if($bytes.Length -gt 65536){throw '小夹具回执超限'}
    $file=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
$source=@'
const fs=require('node:fs');
const mode=process.argv[2];
const buffer=Buffer.alloc(1024*1024,1);
if(mode==='timeout'){setInterval(()=>buffer[0],1000);}
else {
  let childDenied=null;
  if(mode==='child') {
    const result=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{timeout:1000,windowsHide:true});
    childDenied=Boolean(result.error)||result.status!==0;
    if(!childDenied)process.exitCode=3;
  }
  const stat=fs.statSync(__filename,{bigint:true});
  fs.writeFileSync('case-result.json',JSON.stringify({version:process.version,mode,allocatedBytes:buffer.length,childDenied,
    dev:String(stat.dev),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)}),{flag:'wx'});
}
'@
$entry=Join-Path $scope 'fixture.cjs'
Write-Fixed $entry $source
$node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
$helper=Join-Path $PSScriptRoot 'FixedPrepareJob.cs'
Add-Type -Path $helper
$workMs=if($Case -eq 'timeout'){1500}else{5000}
Write-Fixed (Join-Path $scope 'intent.json') (([ordered]@{case=$Case;workMs=$workMs;terminationOnlyMs=30000;maxAllocationBytes=67108864;maxDiskBytes=1048576;
    helperSha256=(Get-FileHash -LiteralPath $helper).Hash;nodeSha256=(Get-FileHash -LiteralPath $node).Hash;fixtureSha256=(Get-FileHash -LiteralPath $entry).Hash;productE2Pass=$false})|ConvertTo-Json)
$saved=@{}
foreach($entryEnv in [Environment]::GetEnvironmentVariables().GetEnumerator()){
    if([string]$entryEnv.Key -match '^(NODE_|ELECTRON_|AIBROWSE_|VITE_)'){
        $saved[[string]$entryEnv.Key]=[string]$entryEnv.Value
        [Environment]::SetEnvironmentVariable([string]$entryEnv.Key,[NullString]::Value,'Process')
    }
}
$ok=$false;$result=$null
try {
    $result=[AIbrowse.FullConversations.FixedPrepareJob]::Execute($node,$entry,$Case,$scope,$id,$workMs)
    if(-not $result.ActualZero -or $result.OwnershipRetained -or -not $result.LimitsVerified){throw '原Job未确认归零或原生限额未确认'}
    [AIbrowse.FullConversations.FixedPrepareJob]::ValidateLimits($result.LimitFlags,$result.ProcessLimit,$result.ProcessCommitLimit,$result.JobCommitLimit)
    if($Case -eq 'timeout') {
        if($result.Succeeded -or $result.Failure -cne 'deadline' -or $result.ExitCode -ne 92){throw '超时未受控终止'}
    } else {
        if(-not $result.Succeeded){throw '固定小夹具未成功'}
        $report=Get-Content -LiteralPath (Join-Path $scope 'case-result.json') -Raw|ConvertFrom-Json
        if($report.allocatedBytes -ne 1048576 -or ($Case -eq 'child' -and $report.childDenied -ne $true)){throw '小夹具结果不符'}
        $held=[IO.File]::OpenRead($entry)
        try {
            $fact=[AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($held)
            if($fact.Dev -cne $report.dev -or $fact.Ino -cne $report.ino -or $fact.MtimeNs -cne $report.mtimeNs -or $fact.CtimeNs -cne $report.ctimeNs){throw '原生文件身份与Node不一致'}
        }finally{$held.Dispose()}
    }
    $total=0L;foreach($file in Get-ChildItem -LiteralPath $scope -File){$total+=$file.Length}
    if($total -gt 1048576){throw '小夹具落盘超限'}
    $ok=$true
}finally{
    foreach($item in $saved.GetEnumerator()){[Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process')}
    Write-Fixed (Join-Path $scope 'result.json') (([ordered]@{ok=$ok;case=$Case;job=$result;productE2Pass=$false})|ConvertTo-Json -Depth 8)
    [pscustomobject]@{scopeId="full-conversations-native-$id";ok=$ok;case=$Case;job=$result}|ConvertTo-Json -Depth 8
}
if(-not $ok){exit 1}
