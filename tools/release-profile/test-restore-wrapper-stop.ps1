[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type -Path @((Join-Path $PSScriptRoot 'DisposableProfile.cs'),(Join-Path $PSScriptRoot 'ProfileIsolation.cs'),(Join-Path $PSScriptRoot 'JobProcess.cs'))
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $root ('log/stage7-e2/restore-profile-wrapper-implementation-001/stop-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$method=[AIbrowse.ReleaseProfile.DisposableProfile].GetMethod('RestoreFailureReported',[Reflection.BindingFlags]'NonPublic,Static')
$rows=[Collections.Generic.List[object]]::new()
foreach($case in @('absent','writing','closed-failed','closed-success','malformed','extra','scene')){
    $journal=Join-Path $evidence $case;$directory=Join-Path $journal 'runner-output/restore-campaign';[IO.Directory]::CreateDirectory($directory)|Out-Null
    $path=Join-Path $directory 'report.json';$writer=$null
    $report=@{version=1;scene='R';ok=($case -eq 'closed-success');result=$null;elapsedMs=10;pending=1;children=1;observers=@(1);leases=@();failure='场景未通过，停止并保留原件';outerJobReleaseRequired=$true;productGoneChecks=0}
    if($case -eq 'extra'){$report['unexpected']=1}
    if($case -eq 'scene'){$report.scene='P';$report.ok=$true}
    if($case -ne 'absent'){
        if($case -eq 'malformed'){[IO.File]::WriteAllText($path,'{')}
        elseif($case -eq 'writing'){$writer=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$writer.Write([Text.Encoding]::UTF8.GetBytes('{'))}
        else{[IO.File]::WriteAllText($path,(ConvertTo-Json -InputObject $report -Compress -Depth 8))}
    }
    try{$actual=$method.Invoke($null,@([string]$journal,'R'));$expected=$case -notin @('absent','writing','closed-success');if($actual -ne $expected){throw ('失败收口反例误判：'+$case)}}finally{if($null -ne $writer){$writer.Dispose()}}
    $rows.Add(@{case=$case;stop=$actual})
}
$wrapper=Join-Path $PSScriptRoot 'disposable-profile.ps1'
foreach($case in @('unexpected-preflight','old-runner-extra','restore-missing','restore-binding','duplicate')){
    $denied=$false
    try{
        switch($case){
            'unexpected-preflight' { & $wrapper -Action Preflight -RestoreScopeId ('restore-campaign-'+('a'*32)) -RestoreProofSha256 ('b'*64) | Out-Null }
            'old-runner-extra' { & $wrapper -Action Run -Runner ProductTransfer -RestoreScopeId ('restore-campaign-'+('a'*32)) -RestoreProofSha256 ('b'*64) | Out-Null }
            'restore-missing' { & $wrapper -Action Run -Runner RestoreR | Out-Null }
            'restore-binding' { & $wrapper -Action Run -Runner RestoreP -BindingJournal 'forbidden' -RestoreScopeId ('restore-campaign-'+('a'*32)) -RestoreProofSha256 ('b'*64) | Out-Null }
            'duplicate' { & $wrapper -Action Preflight -RestoreScopeId 'first' -RestoreScopeId 'second' | Out-Null }
        }
    }catch{$denied=$true}
    if(-not $denied){throw ('非法参数未在profile前拒绝：'+$case)}
    $rows.Add(@{case=$case;rejected=$true})
}
[IO.File]::WriteAllText((Join-Path $evidence 'report.json'),(ConvertTo-Json -InputObject @{ok=$true;cases=$rows;jobCreated=$false;productExecuted=$false;profileTouched=$false} -Depth 10))
Write-Output ('固定失败信号与非法参数 '+$rows.Count+' 项通过；未创建Job或触碰profile。原件：'+$evidence)
