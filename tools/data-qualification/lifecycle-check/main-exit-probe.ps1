[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scope=Join-Path $repository ('log/stage7-e3/main-exit-probe-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scope)
$electron=Join-Path $repository 'node_modules/electron/dist/electron.exe'
Add-Type -Path (Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs')
$saved=[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE')
[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',[NullString]::Value,'Process')
try {
  foreach($phase in @('open-dialog','aborted-dialog')) {
    $appRoot=Join-Path $scope $phase
    [void][IO.Directory]::CreateDirectory($appRoot)
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'),'{"name":"aibrowse-main-exit-probe","version":"0.1.0","main":"entry.cjs"}')
    [IO.File]::WriteAllText((Join-Path $appRoot 'guardian-path.json'),((Join-Path $repository 'out/lifecycle-guardian/guardian.exe')|ConvertTo-Json -Compress))
    $entry=@'
const {app,BrowserWindow,dialog}=require('electron');
const {join}=require('node:path');
const {writeFileSync,mkdirSync,readFileSync}=require('node:fs');
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
mkdirSync(join(__dirname,'profile'));
writeFileSync(join(__dirname,'started.json'),JSON.stringify({pid:process.pid}));
app.setPath('userData',join(__dirname,'profile'));
app.setPath('sessionData',join(__dirname,'profile'));
app.whenReady().then(async()=>{
  writeFileSync(join(__dirname,'ready.json'),JSON.stringify({pid:process.pid}));
  new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',(event)=>event.preventDefault());
  const nonce=randomBytes(16).toString('hex');
  const guardian=spawn(JSON.parse(readFileSync(join(__dirname,'guardian-path.json'),'utf8')),[join(__dirname,'profile'),String(process.pid),nonce,process.execPath,__dirname],{windowsHide:true,detached:true,shell:false,stdio:['pipe','pipe','pipe']});
  guardian.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{guardian.stdout.once('data',(data)=>data.toString().trim()==='1|'+nonce+'|0|ready'?resolve():reject(new Error('guardian-ready')));guardian.once('error',reject);});
  guardian.stdin.write('1|'+nonce+'|1|finish\n');
  await new Promise((resolve,reject)=>guardian.stdout.once('data',(data)=>data.toString().trim()==='1|'+nonce+'|1|ok'?resolve():reject(new Error('guardian-finish'))));
  const aborted=process.argv[2]==='aborted-dialog';
  const options={type:'error',title:'AIbrowse 合成退出检查',message:'固定错误提示将自动关闭，无需操作。',buttons:['知道了']};
  if(aborted) options.signal=AbortSignal.timeout(9000);
  dialog.showMessageBox(options).then(()=>{if(aborted) app.exit(1);});
  app.on('quit',(_event,code)=>writeFileSync(join(__dirname,'quit.json'),JSON.stringify({code}),{flag:'wx'}));
  setTimeout(()=>app.exit(1),10000);
});
'@
    [IO.File]::WriteAllText((Join-Path $appRoot 'entry.cjs'),$entry,[Text.UTF8Encoding]::new($false))
    $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('transfer',$electron,$appRoot,$phase,$scope,[guid]::NewGuid().ToString('N'),15000)
    [IO.File]::WriteAllText((Join-Path $scope ($phase+'.json')),($job|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    [pscustomobject]@{scope=$scope;phase=$phase;exitCode=$job.ExitCode;jobZero=$job.ActualZero;durationMs=$job.DurationMs;failure=$job.Failure}|ConvertTo-Json -Compress
    if(-not $job.ActualZero -or -not $job.LimitsVerified -or $job.OwnershipRetained -or $job.ExitFailure){throw '原生退出检查未释放资源'}
    if(-not (Test-Path -LiteralPath (Join-Path $appRoot 'quit.json'))){throw '未到原生退出检查点，不能用于对话框判断'}
    $writers=Get-Content -Raw -LiteralPath (Join-Path $appRoot 'profile/lifecycle-guardian/writers.json')|ConvertFrom-Json
    [pscustomobject]@{phase=$phase;writerRetired=($null -eq $writers.main -and $null -eq $writers.utility)}|ConvertTo-Json -Compress
  }
} finally {
  if($null -eq $saved){[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',[NullString]::Value,'Process')}
  else{[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$saved,'Process')}
}
