[CmdletBinding()]
param([switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Add-Type -Path @((Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs'))
$evidence = Join-Path $repository ('log/stage7-e2/restore-profile-wrapper-implementation-001/admission-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$type = [AIbrowse.ReleaseProfile.DisposableProfile]
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$admission = $type.GetNestedType('RestoreAdmission', [Reflection.BindingFlags]::NonPublic)
$constructor = $admission.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([string],[string],[string],[string],[Diagnostics.Stopwatch],[long]), $null)
$shared = $type.GetField('RestoreSharedSources',$flags).GetValue($null)
$directories = $type.GetField('RestoreDirectories',$flags).GetValue($null)
$rows = [Collections.Generic.List[object]]::new()
$previous = $env:AIBROWSE_PROFILE_TOOL_REPOSITORY
function Write-Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,(ConvertTo-Json -InputObject $Value -Depth 20 -Compress),[Text.UTF8Encoding]::new($false)) }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Fixture([string]$Fault) {
    $repo = Join-Path $evidence ('r-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $id = 'restore-campaign-' + [Guid]::NewGuid().ToString('N')
    $scope = Join-Path $repo ('log/stage7-e2/' + $id)
    $package = Join-Path $repo 'candidate'
    $node = Join-Path $repo 'node.exe'
    $sources = [ordered]@{}
    foreach ($path in @($shared) + @($directories | ForEach-Object { $_ + '/fixture.ts' }) + @('src/main/fixed.ts','tools/data-qualification/product-restore-campaign/run.ts','tools/data-qualification/product-restore-campaign/offline-entry.ts')) {
        $file = Join-Path $repo $path
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
        [IO.File]::WriteAllText($file,'fixed source ' + $path)
        $sources[$path] = Hash $file
    }
    [IO.Directory]::CreateDirectory($scope) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $package 'resources/lifecycle-guardian')) | Out-Null
    foreach ($file in @($node,(Join-Path $package 'AIbrowse.exe'),(Join-Path $package 'resources/app.asar'),(Join-Path $package 'resources/lifecycle-guardian/guardian.exe'),(Join-Path $scope 'run.cjs'),(Join-Path $scope 'offline.cjs'))) { [IO.File]::WriteAllText($file,'fixed executable fixture') }
    $binding = [ordered]@{ ok=$true; executableSha256=(Hash (Join-Path $package 'AIbrowse.exe')); asarSha256=(Hash (Join-Path $package 'resources/app.asar')); asarHeaderSha256=('a'*64); guardianSha256=(Hash (Join-Path $package 'resources/lifecycle-guardian/guardian.exe')); fuses=@{}; artifacts=@(); modules=@(@{path='src/main/fixed.ts';sha256=$sources['src/main/fixed.ts']}); sourceGraphSha256=('b'*64); references=@(); productExecuted=$false }
    $bindingPath = Join-Path $repo 'static-binding.json'
    Write-Json $bindingPath $binding
    $proof = [ordered]@{ version=1;scopeId=$id;packageRoot=$package;bindingPath=$bindingPath;bindingSha256=(Hash $bindingPath);executableSha256=$binding.executableSha256;asarSha256=$binding.asarSha256;guardianSha256=$binding.guardianSha256;nodeSha256=(Hash $node);sources=$sources;bundles=[ordered]@{'run.cjs'=(Hash (Join-Path $scope 'run.cjs'));'offline.cjs'=(Hash (Join-Path $scope 'offline.cjs'))};inputs=[ordered]@{'run.cjs'=@('src/main/fixed.ts');'offline.cjs'=@('src/main/fixed.ts')} }
    $proof.inputs['run.cjs'] += 'tools/data-qualification/product-restore-campaign/run.ts'
    $proof.inputs['offline.cjs'] += 'tools/data-qualification/product-restore-campaign/offline-entry.ts'
    $proof['rendered']=[ordered]@{'run.cjs'=@($proof.inputs['run.cjs']);'offline.cjs'=@($proof.inputs['offline.cjs'])}
    switch ($Fault) {
        'scope' { $proof.scopeId = 'restore-campaign-' + ('0'*32) }
        'package-path' { $proof.packageRoot = Join-Path $repo 'wrong' }
        'missing-source' { $proof.sources.Remove('src/main/fixed.ts') }
        'extra-source' { $proof.sources['src/main/extra.ts'] = 'a'*64 }
        'source-changed' { [IO.File]::AppendAllText((Join-Path $repo 'src/main/fixed.ts'),'changed') }
        'bundle-changed' { [IO.File]::AppendAllText((Join-Path $scope 'run.cjs'),'changed') }
        'bundle-extra' { $proof.bundles['other.cjs'] = 'a'*64 }
        'package-changed' { [IO.File]::AppendAllText((Join-Path $package 'AIbrowse.exe'),'changed') }
        'node-changed' { [IO.File]::AppendAllText($node,'changed') }
        'inputs-missing' { $proof.inputs.Remove('offline.cjs') }
        'inputs-duplicate' { $proof.inputs['run.cjs'] = @('src/main/fixed.ts','src/main/fixed.ts') }
        'inputs-unknown' { $proof.inputs['run.cjs'] = @('../outside.ts') }
        'rendered-missing' { $proof.rendered.Remove('offline.cjs') }
        'rendered-empty' { $proof.rendered['run.cjs'] = @() }
        'rendered-entry' { $proof.rendered['run.cjs'] = @('src/main/fixed.ts') }
        'rendered-qualification' { $proof.inputs['run.cjs'] += 'src/main/watch/qualification/acquisition.ts';$proof.rendered['run.cjs'] += 'src/main/watch/qualification/acquisition.ts' }
        'rendered-unknown' { $proof.rendered['run.cjs'] += 'node_modules/unknown/index.js' }
        'binding-failed' { $binding.ok=$false;Write-Json $bindingPath $binding;$proof.bindingSha256=Hash $bindingPath }
        'binding-extra' { $binding['unexpected']=1;Write-Json $bindingPath $binding;$proof.bindingSha256=Hash $bindingPath }
        'binding-module' { $binding.modules[0].sha256='c'*64;Write-Json $bindingPath $binding;$proof.bindingSha256=Hash $bindingPath }
        'proof-extra' { $proof['unexpected']=1 }
        'source-link' { New-Item -ItemType HardLink -Path (Join-Path $repo 'source-second-link') -Target (Join-Path $repo 'src/main/fixed.ts') | Out-Null }
    }
    $proofPath=Join-Path $scope 'build-proof.json';Write-Json $proofPath $proof
    if ($Fault -eq 'duplicate') { $raw=[IO.File]::ReadAllText($proofPath);[IO.File]::WriteAllText($proofPath,$raw.Replace('"version":1','"version":1,"versio\u006e":1')) }
    $expected=Hash $proofPath
    if ($Fault -eq 'proof-hash') { $expected='0'*64 }
    return @{Repo=$repo;Id=$id;Scope=$scope;Package=$package;Node=$node;Expected=$expected;Proof=$proofPath}
}
if ($LibraryOnly) { return }
try {
    foreach ($fault in @('normal','proof-hash','scope','package-path','missing-source','extra-source','source-changed','bundle-changed','bundle-extra','package-changed','node-changed','inputs-missing','inputs-duplicate','inputs-unknown','rendered-missing','rendered-empty','rendered-entry','rendered-qualification','rendered-unknown','binding-failed','binding-extra','binding-module','proof-extra','source-link','duplicate','expired-preflight')) {
        $f=Fixture $fault;$env:AIBROWSE_PROFILE_TOOL_REPOSITORY=$f.Repo
        $lease=$null;$errorType='';$accepted=$false
        try {
            $maximum=if($fault -eq 'expired-preflight'){0L}else{180000L}
            $lease=$constructor.Invoke(@([string]$f.Id,[string]$f.Expected,[string]$f.Package,[string]$f.Node,[Diagnostics.Stopwatch]::StartNew(),[long]$maximum));$accepted=$true
            if ($fault -eq 'normal') {
                foreach ($path in @((Join-Path $f.Scope 'run.cjs'),(Join-Path $f.Scope 'offline.cjs'),(Join-Path $f.Repo 'src/main/fixed.ts'),$f.Node,(Join-Path $f.Package 'AIbrowse.exe'))) {
                    $denied=$false;try { $writer=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$writer.Dispose() }catch{$denied=$true}
                    if(-not $denied){throw '准入未持续拒绝writer'}
                }
            }
        } catch { $errorType=$_.Exception.GetType().FullName;if($fault -eq 'normal'){throw} }
        finally { if($null -ne $lease){$lease.Dispose()} }
        if($accepted -ne ($fault -eq 'normal')){throw ('准入反例误判：'+$fault)}
        $rows.Add(@{case=$fault;accepted=$accepted;errorType=$errorType;profileTouched=$false})
    }
    # A deadline already consumed before admission must fail before opening any native Job.
    $clock=[Diagnostics.Stopwatch]::StartNew();[Threading.Thread]::Sleep(2)
    $expired=$false
    try { [AIbrowse.ReleaseProfile.JobProcess]::Execute('never-executed.exe',@(),$repository,('a'*32),1,[Action[uint32,long]]{param($p,$t)},$clock,[Func[bool]]{return $false}) | Out-Null } catch { $expired=$true }
    if(-not $expired){throw '已耗原钟未在Job创建前拒绝'}
    $rows.Add(@{case='job-original-clock-expired';accepted=$false;profileTouched=$false})
    $tokens=$null;$errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'disposable-profile.ps1'),[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0){throw '固定入口语法不通过'}
    Write-Json (Join-Path $evidence 'report.json') @{ok=$true;cases=$rows;productExecuted=$false;jobCreated=$false;profileTouched=$false;scopeBytes='每个夹具只含固定小文本';source=$PSCommandPath}
    Write-Output ('恢复准入 '+$rows.Count+' 项通过；真实profile、产品、Job、UI均未触碰。原件：'+$evidence)
} finally { $env:AIBROWSE_PROFILE_TOOL_REPOSITORY=$previous }
