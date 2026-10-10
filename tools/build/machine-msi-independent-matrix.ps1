param(
  [ValidateSet('Prepare', 'PrepareRetirement', 'Launch', 'Run')][string]$Action = 'Prepare',
  [Parameter(Mandatory = $true)][string]$Scope,
  [string]$AuthorBuild,
  [string]$ManifestSha256,
  [string]$RunnerSha256,
  [string]$RepositoryRoot,
  [string]$ContinueFromScope,
  [string]$ParentManifestSha256,
  [switch]$ResumeAfterFirstInstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$matrixRoot = if ($RepositoryRoot) { [IO.Path]::GetFullPath($RepositoryRoot) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')) }
$matrixScope = [IO.Path]::GetFullPath($Scope)
$matrixLogRoot = [IO.Path]::GetFullPath((Join-Path $matrixRoot 'log/stage7-e5/'))
if (!$matrixScope.StartsWith($matrixLogRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '证据根必须在E5受控目录内' }
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-BoundJson([string]$Path, [string]$ExpectedSha256) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  if ($actual -cne $ExpectedSha256) { throw '绑定JSON来源已漂移' }
  # Decode exactly the bytes that were authenticated, never reread a writable path.
  [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}
function Save-Json([string]$Name, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 16) + "`n")
  $stream = [IO.File]::Open((Join-Path $matrixScope $Name), 'CreateNew', 'Write', 'None')
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
function Require([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Require-Protected([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $trusted = @('S-1-5-18', 'S-1-5-32-544')
  Require ($trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) '审核暂存目录所有者无效'
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $dangerous = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    Require (!($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $dangerous) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value)) '审核暂存允许普通用户改写'
  }
  for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) { Require (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '审核暂存祖先含链接' }
}
function Tool([string]$Name, [string]$File, [string[]]$Arguments, [string]$Directory) {
  $start = [Diagnostics.ProcessStartInfo]::new($File)
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.WorkingDirectory = $Directory
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($start)
  $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
  Require ($process.WaitForExit(60000)) ('编译超时：' + $Name)
  $result = [ordered]@{ file = $File; hash = (Digest $File); args = $Arguments; exit = $process.ExitCode; stdout = $out.Result; stderr = $err.Result }
  Save-Json ($Name + '.json') $result
  Require ($process.ExitCode -eq 0) ('编译失败：' + $Name)
  $process.Dispose()
}
if ($Action -eq 'Prepare' -or $Action -eq 'PrepareRetirement') {
  Require (!(Test-Path -LiteralPath $matrixScope)) '小样证据目录必须尚不存在'
  [IO.Directory]::CreateDirectory($matrixScope) | Out-Null
  $author = Get-Content -LiteralPath (Join-Path $AuthorBuild 'build.json') -Raw | ConvertFrom-Json
  Require ($author.fixture -and $author.identity.scope -eq 'fixture') '只允许已审小样构建来源'
  $sourceNames = @('msi-authoring.ts', 'msi-authoring.test.ts', 'msi-build.ts', 'msi-guard.cs', 'msi-guard-probe.ts', 'msi-inspect.ps1', 'msi-template.nsi')
  $sourceHashes = @()
  foreach ($name in $sourceNames) {
    $relative = 'tools/build/' + $name
    $expected = @($author.sources | Where-Object path -EQ $relative)
    Require ($expected.Count -eq 1 -and (Digest (Join-Path $matrixRoot $relative)) -eq $expected[0].sha256) ('来源漂移：' + $relative)
    $sourceHashes += [ordered]@{ path = $relative; sha256 = $expected[0].sha256 }
  }
  if ($Action -eq 'PrepareRetirement') {
    $originalScope = Join-Path $matrixLogRoot 'machine-msi-independent-review-001/native-002'
    $original = Read-BoundJson (Join-Path $originalScope 'manifest.json') 'c2102d7bfdf0ab55c10a85857133f6b8bda207de6517d9c2eb3d89a10d1c4622'
    Require ($original.identity.upgrade -eq '1753CE16-16BB-414C-B631-3B32C72F92CC' -and @($original.variants | Where-Object name -EQ 'old')[0].product -eq '{BC5D0DEB-9C1A-4C22-8F89-FDEEFA3C9A8D}') '只能正常卸载原已授权native-002小样'
    $stateHash = '1a08cb7bb1f38d8f7471c853fcb9e9b37330b16ad58323b474b8735fe4e6d4e1'
    [void](Read-BoundJson (Join-Path $originalScope '02-late-state.json') $stateHash)
    Save-Json 'manifest.json' ([ordered]@{ schema = 3; head = (& git -C $matrixRoot rev-parse HEAD); identity = $original.identity; variants = $original.variants; packages = $original.packages; sources = $sourceHashes; continuation = $null; retirement = [ordered]@{ scope = $originalScope; manifestSha256 = 'c2102d7bfdf0ab55c10a85857133f6b8bda207de6517d9c2eb3d89a10d1c4622'; stateSha256 = $stateHash; externalSha256 = (Digest (Join-Path $originalScope 'external-sentinel.txt')) }; budget = [ordered]@{ calls = 1; priorCalls = 18; cumulativeMaximum = 19; eachSeconds = 60 }; createdUtc = [DateTime]::UtcNow.ToString('O'); installed = $true })
    Write-Output ('原小样正常卸载准备完成，未执行。Manifest SHA256=' + (Digest (Join-Path $matrixScope 'manifest.json')))
    Write-Output ('Runner SHA256=' + (Digest $PSCommandPath))
    return
  }
  $toolPaths = @{}
  foreach ($name in @('csc', 'candle', 'light', 'makensis')) {
    $item = @($author.commands | Where-Object name -EQ $name)[0]
    Require ((Digest $item.command) -eq $item.sha256) ('工具摘要漂移：' + $name)
    $toolPaths[$name] = $item.command
  }
  Require ((Digest $toolPaths.makensis) -eq '4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0') '必须使用官方NSIS3.13'
  function Check-CompilerInputs([string]$Record) {
    $verify = @'
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {collectToolFiles,WIX_TOOL,NSIS_TOOL} from './tools/build/msi-build.ts';
const authorScope=resolve(process.argv[2]), output=process.argv[3];
const author=JSON.parse(readFileSync(join(authorScope,'build.json'),'utf8'));
const results=[];
for(const [name,command,extraction,pin,expectedRoot] of [
 ['wix','candle','extract-wix',WIX_TOOL,join(authorScope,'wix-tool')],
 ['nsis','makensis','extract-nsis',NSIS_TOOL,join(authorScope,'nsis-tool',NSIS_TOOL.release)]
]) {
 const root=dirname(author.commands.find(c=>c.name===command).command);
 if(resolve(root).toLowerCase()!==resolve(expectedRoot).toLowerCase()) throw new Error('必须使用作者本scope独占解包工具');
 const archive=author.commands.find(c=>c.name===extraction).args[1];
 const archiveSha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
 if(archiveSha256!==pin.sha256) throw new Error('实际工具归档摘要不符');
 const actual=collectToolFiles(root);
 if(JSON.stringify(actual)!==JSON.stringify(author.toolFiles?.[name])) throw new Error('实际工具全文件集合与新解包来源不一致');
 results.push({name,root,archive,archiveSha256,files:actual});
}
writeFileSync(output,JSON.stringify({results},null,2)+'\n',{flag:'wx'});
'@
    Push-Location $matrixRoot
    try { $verify | & node --experimental-strip-types --input-type=module - $AuthorBuild (Join-Path $matrixScope $Record); Require ($LASTEXITCODE -eq 0) '实际编译工具来源不一致' } finally { Pop-Location }
  }
  Check-CompilerInputs 'tool-input-before.json'
  $continuation = $null
  if ($ContinueFromScope) {
    $parentScope = [IO.Path]::GetFullPath($ContinueFromScope)
    Require ($parentScope.StartsWith($matrixLogRoot, [StringComparison]::OrdinalIgnoreCase) -and $ParentManifestSha256 -match '^[a-f0-9]{64}$') '接续父来源必须绑定E5证据'
    $parentManifest = Read-BoundJson (Join-Path $parentScope 'manifest.json') $ParentManifestSha256
    $parentStateFile = Join-Path $parentScope '03-late-readonly-state.json'
    $parentState = Get-Content -LiteralPath $parentStateFile -Raw | ConvertFrom-Json
    $parentFailure = Get-Content -LiteralPath (Join-Path $parentScope 'failure.json') -Raw | ConvertFrom-Json
    Require ($parentManifest.schema -eq 2 -and $parentFailure.calls -eq 4 -and $parentManifest.budget.priorCalls -eq 10 -and $parentState.ownedProcessesAlive.Count -eq 0) '接续只针对原7次场第4次失败且资源退休'
    $current = @($parentState.state.products | Where-Object name -EQ 'next')[0]
    $parentPackage = @($parentManifest.packages | Where-Object name -EQ 'next')[0]
    Require ($current.state -eq 5 -and $current.cacheHash -eq $parentPackage.sha256 -and $current.version.value -eq '0.2.0') '接续父现场不是已核0.2安装'
    $continuation = [ordered]@{ scope = $parentScope; manifestSha256 = $ParentManifestSha256; stateSha256 = (Digest $parentStateFile); currentProduct = $current.code; currentCacheSha256 = $current.cacheHash; baselineGuardSha256 = $parentPackage.guardHash; externalSha256 = (Digest (Join-Path $parentScope 'external-sentinel.txt')); parentSources = $parentManifest.sources }
    Save-Json 'parent-binding.json' $continuation
  }
  $variantsToBuild = if ($continuation) { @('next') } else { @('old', 'next', 'forced') }
  foreach ($variant in $variantsToBuild) {
    $directory = Join-Path $matrixScope $variant
    [IO.Directory]::CreateDirectory((Join-Path $directory 'payload/resources')) | Out-Null
    $version = if ($continuation) { '0.3.0.0' } elseif ($variant -eq 'old') { '0.1.0.0' } else { '0.2.0.0' }
    $fixtureSource = @'
using System;
using System.Reflection;
using System.Threading;
[assembly: AssemblyVersion("VERSION")]
internal static class Fixture {
  private static int Main(string[] args) {
    if (args.Length != 1 || !args[0].StartsWith("Local\\AIbrowseMsiReview-", StringComparison.Ordinal)) return 2;
    using (EventWaitHandle release = EventWaitHandle.OpenExisting(args[0])) return release.WaitOne(45000) ? 0 : 3;
  }
}
'@
    [IO.File]::WriteAllText((Join-Path $directory 'fixture.cs'), $fixtureSource.Replace('VERSION', $version), [Text.UTF8Encoding]::new($false))
    Tool ($variant + '-fixture-csc') $toolPaths.csc @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+', ('/out:' + (Join-Path $directory 'payload/AIbrowse.exe')), (Join-Path $directory 'fixture.cs')) $directory
    [IO.File]::WriteAllText((Join-Path $directory 'payload/resources/shared.txt'), ('共享文件 ' + $variant), [Text.UTF8Encoding]::new($false))
    $leaf = if ($continuation) { 'upgrade-only.txt' } elseif ($variant -eq 'old') { 'retired-only.txt' } else { 'new-only.txt' }
    [IO.File]::WriteAllText((Join-Path $directory ('payload/resources/' + $leaf)), ('独有文件 ' + $variant), [Text.UTF8Encoding]::new($false))
  }
  $render = @'
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createMsiFixtureIdentity,renderMsi,componentGuid} from './tools/build/msi-authoring.ts';
const scope=resolve(process.argv[2]);
const parent=process.argv[3] ? JSON.parse(readFileSync(join(process.argv[3],'manifest.json'),'utf8')) : null;
const identity=parent?.identity ?? createMsiFixtureIdentity(), variants=parent ? [{...parent.variants.find(v=>v.name==='next'),name:'old'}] : [];
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
for(const name of parent ? ['next'] : ['old','next','forced']) {
 const dir=join(scope,name), payload=join(dir,'payload'), files=[];
 const visit=(rel)=>{for(const entry of readdirSync(join(payload,rel),{withFileTypes:true})) {const member=(rel?rel+'/':'')+entry.name;if(entry.isDirectory()) visit(member); else {const data=readFileSync(join(payload,member));files.push({path:member,bytes:data.length,sha256:hash(data)});}}};visit('');
 const version=parent?'0.3.0':name==='old'?'0.1.0':'0.2.0';
 let xml=renderMsi(files,version,identity);
 if(name==='forced') xml=xml.replace('<InstallExecuteSequence>','<CustomAction Id="IndependentFailure" Error="独立审核事务后失败夹具"/><InstallExecuteSequence>').replace('</InstallExecuteSequence>','<Custom Action="IndependentFailure" After="RejectInUse">1</Custom></InstallExecuteSequence>');
 writeFileSync(join(dir,'project.wxs'),xml,{flag:'wx'});
 const guard=readFileSync('tools/build/msi-guard.cs','utf8').replace('__UPGRADE_CODE__','{'+identity.upgrade+'}').replace('__SHORTCUT_NAME__',identity.name).replace('__INSTALL_LEAF__',identity.installLeaf).replace('__INCOMING_FILES__',files.map(f=>JSON.stringify(f.path)).join(', '));
 writeFileSync(join(dir,'guard.cs'),guard,{flag:'wx'});
 variants.push({name,version,product:'{'+xml.match(/<Product Id="([^"]+)"/)[1]+'}',files:files.map(f=>({...f,component:'{'+componentGuid(identity.upgrade,f.path)+'}'}))});
}
writeFileSync(join(scope,'input.json'),JSON.stringify({identity,variants},null,2)+'\n',{flag:'wx'});
'@
  Push-Location $matrixRoot
  try { $render | & node --experimental-strip-types --input-type=module - $matrixScope $ContinueFromScope; Require ($LASTEXITCODE -eq 0) '生成小样失败' } finally { Pop-Location }
  $inputManifest = Get-Content -LiteralPath (Join-Path $matrixScope 'input.json') -Raw | ConvertFrom-Json
  $packageHashes = @()
  foreach ($variant in @($inputManifest.variants | Where-Object { $variantsToBuild -contains $_.name })) {
    $directory = Join-Path $matrixScope $variant.name
    Tool ($variant.name + '-guard-csc') $toolPaths.csc @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+', ('/out:' + (Join-Path $directory 'guard.exe')), (Join-Path $directory 'guard.cs')) $directory
    $guardBytes = [IO.File]::ReadAllBytes((Join-Path $directory 'guard.exe'))
    $peOffset = [BitConverter]::ToInt32($guardBytes, 0x3c)
    Require ([BitConverter]::ToUInt16($guardBytes, $peOffset + 24 + 68) -eq 2) 'guard必须是无控制台Windows GUI程序'
    $defines = @(('-dPayload=' + (Join-Path $directory 'payload')), ('-dGuard=' + (Join-Path $directory 'guard.exe')), ('-dIcon=' + (Join-Path $matrixRoot 'resources/aibrowse.ico')))
    Tool ($variant.name + '-candle') $toolPaths.candle (@('-arch', 'x64', '-pedantic', '-wx') + $defines + @('project.wxs')) $directory
    Tool ($variant.name + '-light') $toolPaths.light (@('-out', 'AIbrowse.msi', '-spdb', '-sw1076', '-pedantic', '-wx') + $defines + @('project.wixobj')) $directory
    $msi = Join-Path $directory 'AIbrowse.msi'
    Require ((Get-Item -LiteralPath $msi).Length -le 1MB) '小样MSI超出1MiB'
    & (Join-Path $matrixRoot 'tools/build/msi-inspect.ps1') -Msi $msi -Output (Join-Path $directory 'tables.json')
    $packageHashes += [ordered]@{ name = $variant.name; path = ($variant.name + '/AIbrowse.msi'); sha256 = (Digest $msi); bytes = (Get-Item -LiteralPath $msi).Length; guardHash = (Digest (Join-Path $directory 'guard.exe')) }
  }
  $wrapperVariant = if ($continuation) { 'next' } else { 'old' }
  $oldDirectory = Join-Path $matrixScope $wrapperVariant
  $nsisArgs = @('-NOCONFIG', '-INPUTCHARSET', 'UTF8', '-V3', ('-DINPUT_MSI=' + (Join-Path $oldDirectory 'AIbrowse.msi')), ('-DOUTPUT_EXE=' + (Join-Path $oldDirectory 'AIbrowse-setup.exe')), ('-DAPP_ICON=' + (Join-Path $matrixRoot 'resources/aibrowse.ico')), ('-DAPP_NAME=' + $inputManifest.identity.name), (Join-Path $matrixRoot 'tools/build/msi-template.nsi'))
  Tool 'old-makensis' $toolPaths.makensis $nsisArgs $oldDirectory
  Check-CompilerInputs 'tool-input-after.json'
  Require ((Digest (Join-Path $matrixScope 'tool-input-before.json')) -eq (Digest (Join-Path $matrixScope 'tool-input-after.json'))) '构建期间实际编译工具来源改变'
  $budget = if ($continuation) { [ordered]@{ calls = 4; eachSeconds = 60; eachMsiBytes = 1048576; priorCalls = 14; cumulativeMaximum = 18; separatelyAuthorizedOldUninstall = 1 } } else { [ordered]@{ calls = 7; eachSeconds = 60; eachMsiBytes = 1048576; priorCalls = 10; cumulativeMaximum = 17; separatelyAuthorizedOldUninstall = 1 } }
  Save-Json 'manifest.json' ([ordered]@{ schema = 3; head = (& git -C $matrixRoot rev-parse HEAD); identity = $inputManifest.identity; variants = $inputManifest.variants; packages = $packageHashes; sources = $sourceHashes; compilerInputs = [ordered]@{ authorScope = [IO.Path]::GetFullPath($AuthorBuild); beforeSha256 = (Digest (Join-Path $matrixScope 'tool-input-before.json')); afterSha256 = (Digest (Join-Path $matrixScope 'tool-input-after.json')) }; continuation = $continuation; wrapper = [ordered]@{ path = ($wrapperVariant + '/AIbrowse-setup.exe'); sha256 = (Digest (Join-Path $oldDirectory 'AIbrowse-setup.exe')) }; budget = $budget; createdUtc = [DateTime]::UtcNow.ToString('O'); installed = [bool]$continuation })
  Write-Output ('准备完成；未安装。Manifest SHA256=' + (Digest (Join-Path $matrixScope 'manifest.json')))
  Write-Output ('Runner SHA256=' + (Digest $PSCommandPath))
  return
}

Require ($ManifestSha256 -match '^[a-f0-9]{64}$' -and $RunnerSha256 -match '^[a-f0-9]{64}$') '运行必须显式绑定已审manifest和runner摘要'
Require ((Digest $PSCommandPath) -eq $RunnerSha256) '审核runner已漂移'
$manifest = Read-BoundJson (Join-Path $matrixScope 'manifest.json') $ManifestSha256
Require ($manifest.schema -eq 3 -and $manifest.identity.scope -eq 'fixture' -and !$ResumeAfterFirstInstall) '本轮只接受已绑定独立矩阵，不复用历史scope'
$isRemaining = $null -ne $manifest.continuation
$isRetirement = $manifest.PSObject.Properties.Name -contains 'retirement' -and $null -ne $manifest.retirement
Require (($isRemaining -and $manifest.budget.calls -eq 4 -and $manifest.budget.priorCalls -eq 14) -or ($isRetirement -and $manifest.budget.calls -eq 1 -and $manifest.budget.priorCalls -eq 18 -and $manifest.identity.upgrade -eq '1753CE16-16BB-414C-B631-3B32C72F92CC') -or (!$isRemaining -and !$isRetirement -and $manifest.budget.calls -eq 7 -and $manifest.budget.priorCalls -eq 10)) '调用预算无效'
if ($Action -eq 'Launch') {
  Require ($manifest.identity.upgrade -match '^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$') '小样身份无效'
  # The elevated entry point is inline, not a script loaded from a writable directory.
  # It hashes the exact bytes it stages before running the protected copy.
  $bootstrap = @'
$ErrorActionPreference='Stop'
$source='__SOURCE__'; $expected='__HASH__'
$bytes=[IO.File]::ReadAllBytes($source)
$actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
if($actual -cne $expected){throw '审核runner来源已漂移'}
$parent=[Environment]::GetFolderPath('ProgramFiles')
for($p=$parent;$p;$p=[IO.Path]::GetDirectoryName($p)){if(((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ProgramFiles祖先含链接'}}
$parentAcl=Get-Acl -LiteralPath $parent
$trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
if($trusted -notcontains $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'ProgramFiles所有者无效'}
foreach($r in $parentAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0 -and $trusted -notcontains $r.IdentityReference.Value){throw 'ProgramFiles允许普通用户写入'}}
$stage=Join-Path $parent 'AIbrowse MSI Review Runner __SUFFIX__'
if(Test-Path -LiteralPath $stage){throw '受保护runner目录已存在，不复用'}
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($stage),$acl)
$actualAcl=Get-Acl -LiteralPath $stage
if(!$actualAcl.AreAccessRulesProtected -or $actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw '暂存实际ACL或身份无效'}
foreach($r in $actualAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne 'Allow' -or @('S-1-5-18','S-1-5-32-544') -notcontains $r.IdentityReference.Value){throw '暂存实际ACL不闭合'}}
$target=Join-Path $stage 'matrix.ps1'
$stream=[IO.File]::Open($target,'CreateNew','Write','None');try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected){throw '受保护runner摘要错误'}
& $target -Action Run -RepositoryRoot '__REPO__' -Scope '__SCOPE__' -ManifestSha256 '__MANIFEST__' -RunnerSha256 $expected __RESUME__
'@
  $resumeArgument = if ($ResumeAfterFirstInstall) { '-ResumeAfterFirstInstall' } else { '' }
  $resumeSuffix = if ($isRetirement) { '-retirement1' } elseif ($isRemaining) { '-remaining1' } elseif ($ResumeAfterFirstInstall) { '-resume1' } else { '' }
  $bootstrap = $bootstrap.Replace('__SOURCE__', $PSCommandPath.Replace("'", "''")).Replace('__HASH__', $RunnerSha256).Replace('__SUFFIX__', ($manifest.identity.upgrade.Substring(0, 8).ToLowerInvariant() + $resumeSuffix)).Replace('__REPO__', $matrixRoot.Replace("'", "''")).Replace('__SCOPE__', $matrixScope.Replace("'", "''")).Replace('__MANIFEST__', $ManifestSha256).Replace('__RESUME__', $resumeArgument)
  Save-Json ('uac-command' + $resumeSuffix + '.json') ([ordered]@{ command = $bootstrap; runnerSha256 = $RunnerSha256; manifestSha256 = $ManifestSha256; operation = '绑定全机小样有界MSI；每次60秒；不强杀'; calls = $manifest.budget.calls; priorCalls = $manifest.budget.priorCalls; cumulativeMaximum = $manifest.budget.cumulativeMaximum; resumeAfterFirstInstall = [bool]$ResumeAfterFirstInstall })
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  $elevated = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -Verb RunAs -WindowStyle Hidden -PassThru
  Save-Json ('uac-process' + $resumeSuffix + '.json') ([ordered]@{ pid = $elevated.Id; startTicks = $elevated.StartTime.ToUniversalTime().Ticks; runnerSha256 = $RunnerSha256 })
  Write-Output ('已启动固定审核UAC进程：' + $elevated.Id)
  return
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
Require ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) '此固定全机矩阵需用户批准UAC'
Require-Protected $PSScriptRoot
if ($ResumeAfterFirstInstall) {
  $priorResult = Get-Content -LiteralPath (Join-Path $matrixScope '01-install-result.json') -Raw | ConvertFrom-Json
  $priorFailure = Get-Content -LiteralPath (Join-Path $matrixScope 'failure.json') -Raw | ConvertFrom-Json
  Require ($priorResult.call -eq 1 -and $priorResult.completed -and $priorResult.exit -eq 0 -and $priorFailure.calls -eq 1 -and $priorFailure.message -eq 'machine产品注册根无效') '只允许修正原生NULL查询后的第一次首装接续'
  Require (!(Test-Path -LiteralPath (Join-Path $matrixScope 'resume-admission.json')) -and !(Test-Path -LiteralPath (Join-Path $matrixScope '02-forced-upgrade-start.json'))) '接续已执行，禁止重置调用账本'
} else { Require (!(Test-Path -LiteralPath (Join-Path $matrixScope 'admission.json'))) '每个小样只能执行一次有界矩阵' }
foreach ($source in $manifest.sources) { Require ((Digest (Join-Path $matrixRoot $source.path)) -eq $source.sha256) ('作者源码已漂移：' + $source.path) }
Require (@(Get-Process AIbrowse, guardian -ErrorAction SilentlyContinue).Count -eq 0) '实际应用/守护进程尚未退出，停止安装窗口'
$suffix = $manifest.identity.upgrade.Substring(0, 8).ToLowerInvariant()
Require ($manifest.identity.installLeaf -eq ('AIbrowse 安装 中文 ' + $suffix) -and $manifest.identity.name -eq ('AIbrowse MSI Fixture ' + $suffix)) '小样身份无效'
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$installRoot = Join-Path $programFiles $manifest.identity.installLeaf
$protectedInputs = Join-Path $programFiles ('AIbrowse MSI Review Inputs ' + $suffix + $(if ($isRetirement) { '-retirement1' } elseif ($isRemaining) { '-remaining1' } else { '' }))
if ($ResumeAfterFirstInstall) {
  Require ((Test-Path -LiteralPath $installRoot -PathType Container) -and (Test-Path -LiteralPath $protectedInputs -PathType Container)) '接续原安装或受保护输入缺失'
  Require-Protected $protectedInputs
} elseif ($isRemaining -or $isRetirement) {
  Require ((Test-Path -LiteralPath $installRoot -PathType Container) -and !(Test-Path -LiteralPath $protectedInputs)) '接续必须保留原安装并使用新保护输入'
} else { Require (!(Test-Path -LiteralPath $installRoot) -and !(Test-Path -LiteralPath $protectedInputs)) '小样安装/输入目录必须不存在' }
$shortcuts = @((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) ($manifest.identity.name + '.lnk')), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) ($manifest.identity.name + '.lnk')))
if (!$ResumeAfterFirstInstall -and !$isRemaining -and !$isRetirement) { foreach ($shortcut in $shortcuts) { Require (!(Test-Path -LiteralPath $shortcut)) '小样快捷方式已存在' } }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MachineMsiReviewNative {
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, StringBuilder product);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern uint MsiGetProductInfoEx(string product, string sid, uint context, string property, StringBuilder value, ref uint length);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern int MsiGetComponentPathEx(string product, string component, string sid, uint context, StringBuilder value, ref uint length);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern int MsiQueryProductState(string product);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern uint MsiGetShortcutTarget(string path, StringBuilder product, StringBuilder feature, StringBuilder component);
 public static uint ProductInfo(string product, string property, StringBuilder value, ref uint length) { return MsiGetProductInfoEx(product, null, 4, property, value, ref length); }
 public static int ComponentPath(string product, string component, StringBuilder value, ref uint length) { return MsiGetComponentPathEx(product, component, null, 4, value, ref length); }
}
'@
function Product-Info([string]$Code, [string]$Property) {
  [uint32]$length = 32767; $value = [Text.StringBuilder]::new(32767)
  $status = [MachineMsiReviewNative]::ProductInfo($Code, $Property, $value, [ref]$length)
  [ordered]@{ status = $status; value = $value.ToString() }
}
function Snapshot {
  $related = @()
  for ([uint32]$i = 0; $i -lt 16; $i++) {
    $code = [Text.StringBuilder]::new(39)
    $status = [MachineMsiReviewNative]::MsiEnumRelatedProducts(('{' + $manifest.identity.upgrade + '}'), 0, $i, $code)
    if ($status -eq 259) { break }
    Require ($status -eq 0) '枚举实际注册失败'
    $related += $code.ToString()
  }
  $products = @()
  foreach ($variant in $manifest.variants) {
    $location = Product-Info $variant.product 'InstallLocation'; $cache = Product-Info $variant.product 'LocalPackage'
    $components = @()
    foreach ($file in $variant.files) {
      [uint32]$length = 32767; $value = [Text.StringBuilder]::new(32767)
      $state = [MachineMsiReviewNative]::ComponentPath($variant.product, $file.component, $value, [ref]$length)
      $components += [ordered]@{ path = $file.path; state = $state; actual = $value.ToString() }
    }
    $cacheHash = if ($cache.status -eq 0 -and (Test-Path -LiteralPath $cache.value -PathType Leaf)) { Digest $cache.value } else { $null }
    $registry = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(('Software\AIbrowse\Installer\' + $manifest.identity.upgrade + '\Products\' + $variant.product), $false)
    $locator = if ($null -ne $registry) { try { $registry.GetValue('InstallLocation') } finally { $registry.Dispose() } } else { $null }
    $products += [ordered]@{ name = $variant.name; code = $variant.product; state = [MachineMsiReviewNative]::MsiQueryProductState($variant.product); location = $location; version = (Product-Info $variant.product 'VersionString'); cache = $cache; cacheHash = $cacheHash; locator = $locator; components = $components }
  }
  $files = @()
  if (Test-Path -LiteralPath $installRoot) {
    foreach ($file in (Get-ChildItem -LiteralPath $installRoot -File -Recurse | Sort-Object FullName)) { $files += [ordered]@{ path = [IO.Path]::GetRelativePath($installRoot, $file.FullName); hash = (Digest $file.FullName); sddl = (Get-Acl -LiteralPath $file.FullName).Sddl } }
  }
  $links = @()
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($path in $shortcuts) {
      if (Test-Path -LiteralPath $path) {
        $p = [Text.StringBuilder]::new(39); $f = [Text.StringBuilder]::new(39); $c = [Text.StringBuilder]::new(39)
        $advertised = [MachineMsiReviewNative]::MsiGetShortcutTarget($path, $p, $f, $c)
        $link = $shell.CreateShortcut($path)
        $links += [ordered]@{ path = $path; hash = (Digest $path); target = $link.TargetPath; advertisedStatus = $advertised; sddl = (Get-Acl -LiteralPath $path).Sddl }
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null
      }
    }
  } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
  [ordered]@{ related = $related; products = $products; files = $files; shortcuts = $links }
}
function Assert-Installed($State, [string]$VariantName) {
  $variant = @($manifest.variants | Where-Object name -EQ $VariantName)[0]
  Require ($State.related.Count -eq 1 -and $State.related[0] -eq $variant.product) '相关产品集合不是唯一正确产品'
  $product = @($State.products | Where-Object { $_.name -eq $VariantName })[0]
  Require ($product.state -eq 5 -and $product.location.status -eq 0 -and $product.location.value.TrimEnd('\') -eq $installRoot) 'machine产品注册根无效'
  Require ($product.cache.status -eq 0 -and $product.cacheHash -match '^[a-f0-9]{64}$') 'machine缓存包缺失'
  $package = @($manifest.packages | Where-Object name -EQ $VariantName)
  $expectedCache = if ($package.Count -eq 1) { $package[0].sha256 } elseif ($isRemaining -and $VariantName -eq 'old') { $manifest.continuation.currentCacheSha256 } else { '' }
  Require ($product.cacheHash -eq $expectedCache) 'machine实际缓存与绑定原包不一致'
  Require ($product.version.status -eq 0 -and $product.version.value -eq $variant.version -and $product.locator.TrimEnd('\') -eq $installRoot) '版本或HKLM定位不一致'
  foreach ($file in $variant.files) {
    $path = Join-Path $installRoot $file.path
    Require ((Test-Path -LiteralPath $path -PathType Leaf) -and (Digest $path) -eq $file.sha256) ('安装文件不匹配：' + $file.path)
    $component = @($product.components | Where-Object { $_.path -eq $file.path })[0]
    Require ($component.state -eq 3 -and $component.actual -eq $path) ('实际组件注册不匹配：' + $file.path)
  }
  Require ($State.shortcuts.Count -eq 2) '快捷方式不完整'
  foreach ($link in $State.shortcuts) { Require ($link.target -eq (Join-Path $installRoot 'AIbrowse.exe') -and $link.advertisedStatus -ne 0) '快捷方式不是绑定目标的普通shortcut' }
}
function Stable-State($State) {
  # The Installer may legitimately choose a different cache filename during rollback.
  # Registration identity, component paths, payload and shortcut behavior remain invariant.
  [ordered]@{
    related = $State.related
    registered = @($State.products | Where-Object { $_.state -eq 5 } | ForEach-Object {
      [ordered]@{ code = $_.code; location = $_.location; version = $_.version; locator = $_.locator; components = $_.components }
    })
    files = $State.files
    shortcuts = @($State.shortcuts | ForEach-Object { [ordered]@{ path = $_.path; target = $_.target; advertisedStatus = $_.advertisedStatus; sddl = $_.sddl } })
  } | ConvertTo-Json -Depth 16 -Compress
}
$before = Snapshot
if ($ResumeAfterFirstInstall) {
  Assert-Installed $before 'old'
  Save-Json '01-corrected-state.json' $before
} else {
if ($isRetirement) {
  [void](Read-BoundJson (Join-Path $manifest.retirement.scope 'manifest.json') $manifest.retirement.manifestSha256)
  $parentState = Read-BoundJson (Join-Path $manifest.retirement.scope '02-late-state.json') $manifest.retirement.stateSha256
  Assert-Installed $before 'old'
  Require ((Stable-State $before) -ceq (Stable-State $parentState)) '原小样健康注册现场已变化，停止正式卸载'
} elseif ($isRemaining) {
  $parentScope = $manifest.continuation.scope
  [void](Read-BoundJson (Join-Path $parentScope 'manifest.json') $manifest.continuation.manifestSha256)
  $parentState = Read-BoundJson (Join-Path $parentScope '03-late-readonly-state.json') $manifest.continuation.stateSha256
  Assert-Installed $before 'old'
  Require ((Stable-State $before) -ceq (Stable-State $parentState.state)) '接续原安装现场已变化'
  $current = @($before.products | Where-Object name -EQ 'old')[0]
  Require ($current.code -eq $manifest.continuation.currentProduct -and $current.cacheHash -eq $manifest.continuation.currentCacheSha256) '接续原产品或实际cache已变化'
} else { Require ($before.related.Count -eq 0) '小样UpgradeCode已注册' }
$protectedAcl = [Security.AccessControl.DirectorySecurity]::new()
$protectedAcl.SetAccessRuleProtection($true, $false)
$protectedAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $protectedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
[IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($protectedInputs), $protectedAcl)
}
Require-Protected $protectedInputs
if (!$isRetirement) {
foreach ($package in $manifest.packages) {
  $origin = Join-Path $matrixScope $package.path
  Require ((Digest $origin) -eq $package.sha256 -and (Get-Item -LiteralPath $origin).Length -le 1MB) 'MSI输入已漂移'
  if (!$ResumeAfterFirstInstall) { Copy-Item -LiteralPath $origin -Destination (Join-Path $protectedInputs ($package.name + '.msi')) }
  Require ((Digest (Join-Path $protectedInputs ($package.name + '.msi'))) -eq $package.sha256) '受保护MSI副本摘要失败'
  $originGuard = Join-Path $matrixScope ($package.name + '/guard.exe')
  Require ((Digest $originGuard) -eq $package.guardHash) '只读guard输入漂移'
  if (!$ResumeAfterFirstInstall) { Copy-Item -LiteralPath $originGuard -Destination (Join-Path $protectedInputs ($package.name + '-guard.exe')) }
  Require ((Digest (Join-Path $protectedInputs ($package.name + '-guard.exe'))) -eq $package.guardHash) '受保护guard副本摘要失败'
}
Require ((Digest (Join-Path $matrixScope $manifest.wrapper.path)) -eq $manifest.wrapper.sha256) 'NSIS包输入漂移'
if (!$ResumeAfterFirstInstall) { Copy-Item -LiteralPath (Join-Path $matrixScope $manifest.wrapper.path) -Destination (Join-Path $protectedInputs 'setup.exe') }
Require ((Digest (Join-Path $protectedInputs 'setup.exe')) -eq $manifest.wrapper.sha256) '受保护NSIS副本摘要失败'
if ($isRemaining) {
  $baselineGuard = Join-Path $manifest.continuation.scope 'next/guard.exe'
  Require ((Digest $baselineGuard) -eq $manifest.continuation.baselineGuardSha256) '父已安装旧guard摘要改变'
  Copy-Item -LiteralPath $baselineGuard -Destination (Join-Path $protectedInputs 'baseline-guard.exe')
  Require ((Digest (Join-Path $protectedInputs 'baseline-guard.exe')) -eq $manifest.continuation.baselineGuardSha256) '保护暂存旧guard摘要改变'
}
}
$admissionName = if ($ResumeAfterFirstInstall) { 'resume-admission.json' } else { 'admission.json' }
Save-Json $admissionName ([ordered]@{ startedUtc = [DateTime]::UtcNow.ToString('O'); elevated = $true; root = $installRoot; protectedInputs = $protectedInputs; inputAcl = (Get-Acl -LiteralPath $protectedInputs).Sddl; sourceSha256 = $RunnerSha256; manifestSha256 = $ManifestSha256; before = $before; priorCalls = 'per-user native-001:5; per-user native-002:3; machine native-002:2; machine native-003:4(仅接续场); 历史失败保留'; priorTotal = $manifest.budget.priorCalls; currentMaximum = $manifest.budget.calls; cumulativeMaximum = $manifest.budget.cumulativeMaximum; continuation = $manifest.continuation })
$script:callCount = if ($ResumeAfterFirstInstall) { 1 } else { 0 }
function Invoke-Msi([string]$Name, [string]$Operation, [string]$Target) {
  Require ($script:callCount -lt $manifest.budget.calls) '本轮已绑定安装调用预算已满'
  $script:callCount++
  $log = Join-Path $matrixScope ($Name + '.log')
  $arguments = $Operation + ' "' + $Target + '" /qn /norestart ALLUSERS=1 MSIINSTALLPERUSER="" REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable MSIDISABLERMRESTART=1 /l*vx "' + $log + '"'
  if ($Operation -eq '/a') { $arguments += ' TARGETDIR="' + (Join-Path $protectedInputs 'admin-image') + '"' }
  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path ([Environment]::SystemDirectory) 'msiexec.exe'), $arguments)
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WorkingDirectory = $protectedInputs
  $clock = [Diagnostics.Stopwatch]::StartNew(); $process = [Diagnostics.Process]::Start($start)
  Save-Json ($Name + '-start.json') ([ordered]@{ call = $script:callCount; pid = $process.Id; startTicks = $process.StartTime.ToUniversalTime().Ticks; arguments = $arguments })
  $finished = $process.WaitForExit(60000)
  $exitCode = if ($finished) { $process.ExitCode } else { $null }
  Save-Json ($Name + '-result.json') ([ordered]@{ call = $script:callCount; completed = $finished; exit = $exitCode; elapsedMs = $clock.ElapsedMilliseconds; pid = $process.Id; stillRunning = !$finished })
  Require $finished '实际MSI超过60秒；不强杀，停止矩阵并保留现场'
  $process.Dispose()
  return $exitCode
}
function Readonly-Guard([string]$Name, [string]$Guard, [string]$Product, [int]$ExpectedExit) {
  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $protectedInputs $Guard))
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  foreach ($arg in @('remove', ($installRoot + '\.'), $Product, ([Environment]::GetFolderPath('CommonDesktopDirectory') + '\.'), ([Environment]::GetFolderPath('CommonPrograms') + '\.'))) { $start.ArgumentList.Add($arg) }
  $clock = [Diagnostics.Stopwatch]::StartNew(); $process = [Diagnostics.Process]::Start($start)
  $finished = $process.WaitForExit(10000)
  $exitCode = if ($finished) { $process.ExitCode } else { $null }
  Save-Json ($Name + '.json') ([ordered]@{ readonly = $true; file = $start.FileName; sha256 = (Digest $start.FileName); pid = $process.Id; completed = $finished; exit = $exitCode; expected = $ExpectedExit; elapsedMs = $clock.ElapsedMilliseconds; msiCalls = $script:callCount })
  Require ($finished -and $exitCode -eq $ExpectedExit) '实际注册旧文件只读guard反例不满足；不启动MSI'
  $process.Dispose()
}
$heldFile = $null; $running = $null; $releaseEvent = $null
try {
  if ($isRetirement) {
    $oldProduct = '{BC5D0DEB-9C1A-4C22-8F89-FDEEFA3C9A8D}'
    $external = Join-Path $manifest.retirement.scope 'external-sentinel.txt'
    Require ((Digest $external) -eq $manifest.retirement.externalSha256) '原外部哨兵已变化'
    $unknownBefore = @($before.files | Where-Object { $_.path -eq 'unknown.txt' -or $_.path -eq '.aibrowse-owned-v1.json' -or $_.path -eq 'unknown-dir\保留.txt' })
    Require ($unknownBefore.Count -eq 3) '原未知哨兵不完整'
    $code = Invoke-Msi '01-old-normal-uninstall' '/x' $oldProduct
    $removed = Snapshot; Save-Json '01-old-removed-state.json' $removed
    Require ($code -eq 0 -and $removed.related.Count -eq 0 -and $removed.shortcuts.Count -eq 0 -and $removed.files.Count -eq 3) '原已注册小样正式卸载失败'
    foreach ($file in $unknownBefore) {
      $same = @($removed.files | Where-Object path -EQ $file.path)
      Require ($same.Count -eq 1 -and $same[0].hash -eq $file.hash -and $same[0].sddl -eq $file.sddl) '原未知文件hash或ACL改变'
    }
    foreach ($variant in $manifest.variants) { Require ((Product-Info $variant.product 'LocalPackage').status -eq 1605) '原小样产品仍注册' }
    Require ((Digest $external) -eq $manifest.retirement.externalSha256) '原外部哨兵改变'
    Save-Json 'verdict.json' ([ordered]@{ verdict = 'PASS'; calls = 1; priorCalls = 18; cumulativeCalls = 19; normalRegisteredUninstall = $oldProduct; unknownPreserved = 3; externalPreserved = $true; privateCleanup = $false })
    return
  }
  if (!$ResumeAfterFirstInstall -and !$isRemaining) {
  $adminTarget = Join-Path $protectedInputs 'admin-image'
  [IO.Directory]::CreateDirectory($adminTarget) | Out-Null
  $adminSentinel = Join-Path $adminTarget '保留.txt'
  [IO.File]::WriteAllText($adminSentinel, '管理安装拒绝哨兵', [Text.UTF8Encoding]::new($false))
  $adminHash = Digest $adminSentinel; $adminAcl = (Get-Acl -LiteralPath $adminSentinel).Sddl
  $code = Invoke-Msi '00-administrative-rejection' '/a' (Join-Path $protectedInputs 'old.msi')
  $adminAfter = Snapshot; Save-Json '00-state.json' $adminAfter
  $adminLog = Get-Content -LiteralPath (Join-Path $matrixScope '00-administrative-rejection.log') -Raw
  Require ($code -eq 1603 -and $adminLog -match 'Doing action: RejectAdministrativeInstall') '管理安装没有真实触达Type19拒绝'
  Require ($adminLog -notmatch 'Doing action: (CostInitialize|InstallFiles|InstallAdminPackage)') '管理安装拒绝晚于预定写入边界'
  Require ((Stable-State $before) -ceq (Stable-State $adminAfter) -and !(Test-Path -LiteralPath $installRoot)) '管理安装改变安装或注册状态'
  Require (@(Get-ChildItem -LiteralPath $adminTarget -Force -Recurse).Count -eq 1 -and (Digest $adminSentinel) -eq $adminHash -and (Get-Acl -LiteralPath $adminSentinel).Sddl -ceq $adminAcl) '管理安装改变目标哨兵或提取了文件'
  Save-Json '00-verdict.json' ([ordered]@{ verdict = 'PASS'; adminType19 = $true; targetSentinelPreserved = $true; targetPayloadFiles = 0; cumulativeCalls = 11 })
  $code = Invoke-Msi '01-install' '/i' (Join-Path $protectedInputs 'old.msi')
  $installed = Snapshot; Save-Json '01-state.json' $installed
  Require ($code -eq 0) '首装失败'; Assert-Installed $installed 'old'
  }
  if (!$isRemaining) { foreach ($relative in @('unknown.txt', '.aibrowse-owned-v1.json', 'unknown-dir/保留.txt')) {
    $path = Join-Path $installRoot $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.File]::WriteAllText($path, ('未知合成哨兵 ' + $relative), [Text.UTF8Encoding]::new($false))
  } }
  $external = if ($isRemaining) { Join-Path $manifest.continuation.scope 'external-sentinel.txt' } else { Join-Path $matrixScope 'external-sentinel.txt' }
  if (!$isRemaining) { [IO.File]::WriteAllText($external, '外部合成哨兵', [Text.UTF8Encoding]::new($false)) }
  $externalHash = Digest $external
  if ($isRemaining) { Require ($externalHash -eq $manifest.continuation.externalSha256) '接续外部哨兵已改变' }
  $rollbackBefore = Snapshot; Save-Json '02-before.json' $rollbackBefore
  $oldProduct = @($manifest.variants | Where-Object name -EQ 'old')[0].product
  if (!$isRemaining) {
  $code = Invoke-Msi '02-forced-upgrade' '/i' (Join-Path $protectedInputs 'forced.msi')
  $rollbackAfter = Snapshot; Save-Json '02-after.json' $rollbackAfter
  Require ($code -eq 1603) '强制失败升级没有返回1603'
  $rollbackLog = Get-Content -LiteralPath (Join-Path $matrixScope '02-forced-upgrade.log') -Raw
  Require ($rollbackLog -match 'Doing action: IndependentFailure' -and $rollbackLog -match 'Doing action: InstallExecute') '未真实触达事务后Type19失败点'
  Assert-Installed $rollbackAfter 'old'
  Require ((Stable-State $rollbackBefore) -ceq (Stable-State $rollbackAfter)) '回滚前后文件、快捷方式或实际machine注册不同'
  Tool '02-registered-cache-guard' (Join-Path $protectedInputs 'old-guard.exe') @('remove', ($installRoot + '\.'), $oldProduct, ([Environment]::GetFolderPath('CommonDesktopDirectory') + '\.'), ([Environment]::GetFolderPath('CommonPrograms') + '\.')) $protectedInputs
  Require ((Digest $external) -eq $externalHash) '外部哨兵改变'
  }
  $lockedRelative = if ($isRemaining) { 'resources/new-only.txt' } else { 'resources/retired-only.txt' }
  if ($isRemaining) { Readonly-Guard '00-owned-unlocked-new-green' 'next-guard.exe' $oldProduct 0 }
  $heldFile = [IO.File]::Open((Join-Path $installRoot $lockedRelative), 'Open', 'Read', 'Read')
  if ($isRemaining) {
    Readonly-Guard '00-owned-lock-old-red' 'baseline-guard.exe' $oldProduct 0
    Readonly-Guard '00-owned-lock-new-green' 'next-guard.exe' $oldProduct 2
    Require ((Stable-State $rollbackBefore) -ceq (Stable-State (Snapshot))) '只读guard探测修改了状态'
  }
  $code = Invoke-Msi '03-old-only-locked' '/i' (Join-Path $protectedInputs 'next.msi')
  $heldFile.Dispose(); $heldFile = $null
  $lockedAfter = Snapshot; Save-Json '03-after.json' $lockedAfter
  Require ($code -eq 1603) '旧版独有文件占用没有拒绝升级'
  Assert-Installed $lockedAfter 'old'
  Require ((Stable-State $rollbackBefore) -ceq (Stable-State $lockedAfter)) '占用升级没有完整回滚'
  $cacheGuard = if ($isRemaining) { 'next-guard.exe' } else { 'old-guard.exe' }
  Tool '03-registered-cache-guard' (Join-Path $protectedInputs $cacheGuard) @('remove', ($installRoot + '\.'), $oldProduct, ([Environment]::GetFolderPath('CommonDesktopDirectory') + '\.'), ([Environment]::GetFolderPath('CommonPrograms') + '\.')) $protectedInputs
  $code = Invoke-Msi '04-normal-upgrade' '/i' (Join-Path $protectedInputs 'next.msi')
  $upgraded = Snapshot; Save-Json '04-state.json' $upgraded
  Require ($code -eq 0) '正常升级失败'; Assert-Installed $upgraded 'next'
  Require (!(Test-Path -LiteralPath (Join-Path $installRoot $lockedRelative))) '旧版独有已注册文件未删除'
  $eventName = 'Local\AIbrowseMsiReview-' + [Guid]::NewGuid().ToString('N')
  $releaseEvent = [Threading.EventWaitHandle]::new($false, 'ManualReset', $eventName)
  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $installRoot 'AIbrowse.exe'))
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.ArgumentList.Add($eventName)
  $running = [Diagnostics.Process]::Start($start)
  Require (!$running.WaitForExit(300)) '运行拒绝小PE没有保持运行'
  $nextProduct = @($manifest.variants | Where-Object name -EQ 'next')[0].product
  $code = Invoke-Msi '05-running-rejection' '/x' $nextProduct
  $runningAfter = Snapshot; Save-Json '05-state.json' $runningAfter
  Require ($code -eq 1603 -and !$running.HasExited) '运行时没有安全拒绝或应用被强停'
  Require ((Stable-State $upgraded) -ceq (Stable-State $runningAfter)) '运行拒绝修改了安装状态'
  $releaseEvent.Set() | Out-Null; Require ($running.WaitForExit(10000) -and $running.ExitCode -eq 0) '小PE未正常退出'
  $running.Dispose(); $running = $null; $releaseEvent.Dispose(); $releaseEvent = $null
  $code = Invoke-Msi '06-uninstall' '/x' $nextProduct
  $removed = Snapshot; Save-Json '06-state.json' $removed
  Require ($code -eq 0 -and $removed.related.Count -eq 0 -and $removed.shortcuts.Count -eq 0) '正式卸载未完成'
  $unknownBefore = @($rollbackBefore.files | Where-Object { $_.path -eq 'unknown.txt' -or $_.path -eq '.aibrowse-owned-v1.json' -or $_.path -eq 'unknown-dir\保留.txt' })
  Require ($unknownBefore.Count -eq 3 -and $removed.files.Count -eq 3) '卸载未知文件集合不完整'
  foreach ($file in $unknownBefore) { Require ((Digest (Join-Path $installRoot $file.path)) -eq $file.hash) '卸载丢失未知文件' }
  Require ((Digest $external) -eq $externalHash) '卸载改变外部哨兵'
  foreach ($variant in $manifest.variants) { Require ((Product-Info $variant.product 'LocalPackage').status -ne 0) '卸载后产品仍注册' }
  Save-Json 'verdict.json' ([ordered]@{ verdict = 'PASS'; calls = $script:callCount; priorCalls = $manifest.budget.priorCalls; cumulativeCalls = ($manifest.budget.priorCalls + $script:callCount); scope = '同机独立全机小MSI矩阵；接续场的先前拒绝和回滚按父证据复用，非最终产品包或NSIS实际运行PASS'; unknownPreserved = 3; externalPreserved = $true; resources = 'released' })
} catch {
  $failureName = if ($ResumeAfterFirstInstall) { 'failure-resume1.json' } else { 'failure.json' }
  Save-Json $failureName ([ordered]@{ verdict = 'REPAIR'; calls = $script:callCount; message = $_.Exception.Message; detail = $_.ScriptStackTrace; utc = [DateTime]::UtcNow.ToString('O'); preserve = $true })
  throw
} finally {
  if ($null -ne $heldFile) { $heldFile.Dispose() }
  if ($null -ne $releaseEvent) { $releaseEvent.Set() | Out-Null }
  if ($null -ne $running) { $exited = $running.WaitForExit(10000); Save-Json 'fixture-release.json' ([ordered]@{ exited = $exited; pid = $running.Id }); $running.Dispose() }
  if ($null -ne $releaseEvent) { $releaseEvent.Dispose() }
}
