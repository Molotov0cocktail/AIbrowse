param(
  [ValidateSet('Prepare', 'Launch', 'Run', 'Snapshot')][string]$Action = 'Prepare',
  [Parameter(Mandatory = $true)][string]$Scope,
  [string]$ReferenceRoot,
  [string]$CandidateRoot,
  [ValidateSet('cancel', 'install', 'upgrade', 'running-reject', 'uninstall', 'reinstall', 'final-uninstall')][string]$Step = 'cancel',
  [string]$ManifestSha256,
  [string]$RunnerSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This tool never starts the application, opens a profile, cleans files, or kills a process.
# Prepare is unelevated. Launch authenticates bytes before executing a protected copy.
# Each human-paced step has a durable protected claim; a failed or unfinished step cannot replay.
function Require([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Read-BoundJson([string]$Path, [string]$Hash) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  Require ((Hash-Bytes $bytes) -ceq $Hash) '绑定 JSON 摘要不匹配'
  [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}
function Save-Json([string]$Directory, [string]$Name, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20) + "`n")
  $stream = [IO.File]::Open((Join-Path $Directory $Name), 'CreateNew', 'Write', 'None')
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function No-Links([string]$Path) {
  for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    Require (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '路径祖先或成员含重解析点'
  }
}
function Protected([string]$Path) {
  No-Links $Path
  $acl = Get-Acl -LiteralPath $Path
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  Require ($trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) '保护目录所有者无效'
  $rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    Require (!($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $rights) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value)) '保护路径允许非管理员写入'
  }
}
function New-Protected([string]$Path) {
  Require (!(Test-Path -LiteralPath $Path)) '保护目录已存在，禁止覆盖'
  Protected ([IO.Path]::GetDirectoryName($Path))
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  if ($PSVersionTable.PSEdition -eq 'Desktop') { [void][IO.Directory]::CreateDirectory($Path, $acl) }
  else { [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($Path), $acl) | Out-Null }
  Protected $Path
  Require ((Get-Acl -LiteralPath $Path).AreAccessRulesProtected) '实际暂存 ACL 未阻断继承'
}
function Copy-Bound([string]$Source, [string]$Target, [string]$Hash, [long]$Length) {
  No-Links $Source
  $inputStream = [IO.File]::Open($Source, 'Open', 'Read', 'Read')
  try {
    Require ($inputStream.Length -eq $Length -and $Length -gt 0 -and $Length -le 536870912) '包长度不匹配或超过 512MiB'
    $outputStream = [IO.File]::Open($Target, 'CreateNew', 'Write', 'None')
    try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) } finally { $outputStream.Dispose() }
    Require ((Digest $Target) -ceq $Hash) '受保护副本摘要不匹配'
  } finally { $inputStream.Dispose() }
}
function Read-Msi([string]$Path) {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $db = $installer.OpenDatabase($Path, 0)
  try {
    $tables = @{}
    foreach ($query in @(
      @('Property', 'SELECT `Property`, `Value` FROM `Property`'),
      @('Component', 'SELECT `Component`, `ComponentId`, `Directory_`, `Attributes`, `KeyPath` FROM `Component`'),
      @('File', 'SELECT `File`, `Component_`, `FileName`, `FileSize` FROM `File`'),
      @('Directory', 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`')
    )) {
      $rows = [Collections.Generic.List[object]]::new(); $view = $db.OpenView($query[1]); [void]$view.Execute()
      try {
        while ($null -ne ($record = $view.Fetch())) {
          try {
            Require ($rows.Count -lt 4096) 'MSI 表超过预算'
            $row = @(); for ($i = 1; $i -le $record.FieldCount(); $i++) { $row += $record.StringData($i) }; $rows.Add($row)
          } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
      } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
      $tables[$query[0]] = $rows.ToArray()
    }
    $properties = @{}; foreach ($row in $tables.Property) { $properties[$row[0]] = $row[1] }
    Require ($properties.UpgradeCode -ceq '{69F81EEA-69A7-4E92-A794-B882158DE0D9}' -and $properties.ProductName -ceq 'AIbrowse' -and $properties.ALLUSERS -eq '1') 'MSI 不是固定全机 AIbrowse'
    $dirs = @{}; foreach ($row in $tables.Directory) { $dirs[$row[0]] = $row }
    Require ($dirs.INSTALLDIR[1] -ceq 'ProgramFiles64Folder' -and $dirs.INSTALLDIR[2] -ceq 'AIbrowse') 'MSI 安装根不固定'
    $files = @()
    foreach ($row in $tables.File) {
      $components = @($tables.Component | Where-Object { $_[0] -ceq $row[1] })
      Require ($components.Count -eq 1 -and $components[0][3] -eq '256' -and $components[0][4] -ceq $row[0]) 'MSI 文件 keypath 不闭合'
      $component = $components[0]; $parts = @($row[2].Split('|')[-1]); $directory = $component[2]; $depth = 0
      while ($directory -cne 'INSTALLDIR') {
        Require ($dirs.ContainsKey($directory) -and ++$depth -le 12) 'MSI 文件目录越界'
        $entry = $dirs[$directory]; $parts = @($entry[2].Split('|')[-1]) + $parts; $directory = $entry[1]
      }
      $relative = $parts -join '/'
      Require ($relative -notmatch '(^|/)(\.|\.\.)($|/)|[:\\]' -and !$relative.StartsWith('/')) 'MSI 文件路径不规范'
      $files += [ordered]@{ path = $relative; bytes = [long]$row[3]; component = $component[1] }
    }
    Require ($files.Count -eq $tables.Component.Count -and @($files.path | Sort-Object -Unique).Count -eq $files.Count) 'MSI 组件数或路径重复'
    [ordered]@{ product = $properties.ProductCode; version = $properties.ProductVersion; files = @($files | Sort-Object { $_.path }) }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($db); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
}
Require ([Environment]::Is64BitProcess) '必须使用 64 位 PowerShell'
$scopePath = [IO.Path]::GetFullPath($Scope)
Require ([IO.Path]::GetFileName($scopePath) -cmatch '^product-msi-[a-f0-9]{32}$') '证据 scope 名称必须是 product-msi 加唯一 GUID'
$scopeId = [IO.Path]::GetFileName($scopePath)
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$protectedRoot = Join-Path $programFiles ('AIbrowse Product Review ' + $scopeId.Substring(12))
$installRoot = Join-Path $programFiles 'AIbrowse'
$steps = @('cancel', 'install', 'upgrade', 'running-reject', 'uninstall', 'reinstall', 'final-uninstall')
if ($Action -eq 'Prepare') {
  Require (!(Test-Path -LiteralPath $scopePath)) '证据 scope 必须尚不存在'
  $packages = @()
  foreach ($pair in @(@('reference', '0.1.0', $ReferenceRoot), @('candidate', '0.1.1', $CandidateRoot))) {
    $root = [IO.Path]::GetFullPath($pair[2]); No-Links $root
    $manifestPath = Join-Path $root 'installer-build.json'; $manifestHash = Digest $manifestPath
    $build = Read-BoundJson $manifestPath $manifestHash
    Require ($build.schemaVersion -eq 1 -and $build.version -ceq $pair[1] -and $build.identity.appId -ceq 'com.aibrowse.desktop' -and $build.identity.upgrade -ceq '69F81EEA-69A7-4E92-A794-B882158DE0D9' -and $build.identity.installLeaf -ceq 'AIbrowse') '发行清单身份不匹配'
    Require ($build.tools.nsis.sha256 -ceq 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8' -and $build.tools.nsis.executableSha256 -ceq '4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0' -and $build.tools.wix.sha256 -ceq 'fe677fcd837b18c9b912985d91636bbd8a1e800c3b3a6a841b6f96e89624e839') '安装工具 pin 不匹配'
    $artifacts = @{}
    foreach ($kind in @('exe', 'msi')) {
      $entry = $build.artifacts.$kind
      Require ($entry.path -ceq ('AIbrowse-' + $pair[1] + '-win-x64-internal.' + $kind)) '发行产物名称不固定'
      $path = Join-Path $root $entry.path; No-Links $path
      Require ((Get-Item -LiteralPath $path).Length -eq $entry.bytes -and (Digest $path) -ceq $entry.sha256) '发行产物字节不匹配'
      $artifacts[$kind] = [ordered]@{ path = $path; bytes = $entry.bytes; sha256 = $entry.sha256 }
    }
    $provenancePath = Join-Path $root 'build-provenance.json'; $provenanceHash = Digest $provenancePath
    $provenance = Read-BoundJson $provenancePath $provenanceHash
    Require ($provenance.schemaVersion -eq 1 -and $provenance.installer.sha256 -ceq $artifacts.exe.sha256 -and $provenance.msi.sha256 -ceq $artifacts.msi.sha256 -and $provenance.installerBuild.sha256 -ceq $manifestHash) '构建 provenance 与实际两包/安装清单不闭合'
    $msi = Read-Msi $artifacts.msi.path
    Require ($msi.version -ceq $pair[1] -and $msi.files.Count -eq $build.payload.files.Count) 'MSI 版本或完整文件数不匹配'
    foreach ($file in $msi.files) {
      $expected = @($build.payload.files | Where-Object path -CEQ $file.path)
      Require ($expected.Count -eq 1 -and $expected[0].bytes -eq $file.bytes) 'MSI 与 payload 文件不匹配'
      $payloadPath = Join-Path (Join-Path $root 'win-unpacked') $file.path; No-Links $payloadPath
      Require ((Digest $payloadPath) -ceq $expected[0].sha256 -and (Get-Item -LiteralPath $payloadPath).Length -eq $file.bytes) '保全 payload 字节不匹配'
      $file.sha256 = $expected[0].sha256
    }
    Require (@(Get-ChildItem -LiteralPath (Join-Path $root 'win-unpacked') -File -Recurse -Force).Count -eq $msi.files.Count) 'payload 含未绑定额外文件'
    $packages += [ordered]@{ name = $pair[0]; version = $pair[1]; product = $msi.product; installerManifest = [ordered]@{ path = $manifestPath; bytes = (Get-Item -LiteralPath $manifestPath).Length; sha256 = $manifestHash }; provenance = [ordered]@{ path = $provenancePath; bytes = (Get-Item -LiteralPath $provenancePath).Length; sha256 = $provenanceHash; candidateEligible = $provenance.candidateEligible }; artifacts = $artifacts; files = $msi.files; sources = $build.sources; toolPins = [ordered]@{ wix = $build.tools.wix; nsis = $build.tools.nsis } }
  }
  Require ($packages[0].product -cne $packages[1].product) '两个版本必须有不同 ProductCode'
  foreach ($name in @('msi-authoring.ts', 'msi-authoring.test.ts', 'msi-build.ts', 'msi-guard.cs', 'msi-guard-probe.ts', 'msi-inspect.ps1', 'msi-template.nsi')) {
    $left = @($packages[0].sources | Where-Object path -CEQ ('tools/build/' + $name)); $right = @($packages[1].sources | Where-Object path -CEQ ('tools/build/' + $name))
    Require ($left.Count -eq 1 -and $right.Count -eq 1 -and $left[0].sha256 -ceq $right[0].sha256) ('安装机制来源变化需先独审差量：' + $name)
  }
  [void][IO.Directory]::CreateDirectory($scopePath)
  Save-Json $scopePath 'manifest.json' ([ordered]@{ schema = 1; scopeId = $scopeId; createdUtc = [DateTime]::UtcNow.ToString('O'); runnerSha256 = (Digest $PSCommandPath); identity = '69F81EEA-69A7-4E92-A794-B882158DE0D9'; packages = $packages; budget = [ordered]@{ maximumTransactions = 6; secondsPerTransaction = 180; priorMechanismTransactions = 19 }; profileAccess = 'none'; sequence = $steps })
  Write-Output ('准备完成，未提权/安装。Manifest SHA256=' + (Digest (Join-Path $scopePath 'manifest.json')))
  Write-Output ('Runner SHA256=' + (Digest $PSCommandPath))
  return
}
Require ($ManifestSha256 -cmatch '^[a-f0-9]{64}$' -and $RunnerSha256 -cmatch '^[a-f0-9]{64}$') '必须明确绑定两个摘要'
Require ((Digest $PSCommandPath) -ceq $RunnerSha256) 'runner 摘要漂移'
$manifest = Read-BoundJson (Join-Path $scopePath 'manifest.json') $ManifestSha256
Require ($manifest.schema -eq 1 -and $manifest.scopeId -ceq $scopeId -and $manifest.runnerSha256 -ceq $RunnerSha256 -and $manifest.identity -ceq '69F81EEA-69A7-4E92-A794-B882158DE0D9' -and $manifest.budget.maximumTransactions -eq 6 -and $manifest.budget.secondsPerTransaction -eq 180 -and $manifest.packages.Count -eq 2) '矩阵固定合同不匹配'
if ($Action -eq 'Launch') {
  # Only this inline code crosses UAC. Authenticated script bytes are written atomically
  # into a new protected directory; no privileged execution occurs from the workspace.
  $bootstrap = @'
$ErrorActionPreference='Stop'
$bytes=[IO.File]::ReadAllBytes('__SOURCE__')
$sha=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($hash -cne '__RUNNER__'){throw 'runner 摘要漂移'}
$pf=[Environment]::GetFolderPath('ProgramFiles')
$trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
for($p=$pf;$p;$p=[IO.Path]::GetDirectoryName($p)){if(((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ProgramFiles 祖先含链接'}}
$a=Get-Acl -LiteralPath $pf
if($trusted -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'ProgramFiles 所有者无效'}
$rights=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($r.FileSystemRights -band $rights) -ne 0 -and $trusted -notcontains $r.IdentityReference.Value){throw 'ProgramFiles 可被改写'}}
$stage=Join-Path $pf 'AIbrowse Product Bootstrap __ID__ __STEP__'
if(Test-Path -LiteralPath $stage){throw '此场已申请提升，禁止重放'}
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
[void][IO.Directory]::CreateDirectory($stage,$acl)
$actual=Get-Acl -LiteralPath $stage
if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw '暂存实际权限无效'}
foreach($r in $actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne 'Allow' -or (@('S-1-5-18','S-1-5-32-544') -notcontains $r.IdentityReference.Value -and !($r.IdentityReference.Value -eq 'S-1-5-32-545' -and ($r.FileSystemRights -band $rights) -eq 0))){throw '暂存 ACL 不闭合'}}
$target=Join-Path $stage 'product-msi-matrix.ps1';$s=[IO.File]::Open($target,'CreateNew','Write','None');try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}
if((Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -cne '__RUNNER__'){throw '保护副本摘要错误'}
& $target -Action Run -Scope '__SCOPE__' -Step '__STEP__' -ManifestSha256 '__MANIFEST__' -RunnerSha256 '__RUNNER__'
'@
  $bootstrap = $bootstrap.Replace('__SOURCE__', $PSCommandPath.Replace("'", "''")).Replace('__RUNNER__', $RunnerSha256).Replace('__MANIFEST__', $ManifestSha256).Replace('__SCOPE__', $scopePath.Replace("'", "''")).Replace('__ID__', $scopeId.Substring(12)).Replace('__STEP__', $Step)
  Save-Json $scopePath ($Step + '-uac-command.json') ([ordered]@{ command = $bootstrap; runnerSha256 = $RunnerSha256; manifestSha256 = $ManifestSha256; step = $Step })
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  $systemPowerShell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
  Protected $systemPowerShell
  $child = Start-Process -FilePath $systemPowerShell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -Verb RunAs -WindowStyle Hidden -PassThru
  Save-Json $scopePath ($Step + '-uac-process.json') ([ordered]@{ pid = $child.Id; startTicks = $child.StartTime.ToUniversalTime().Ticks; protectedEvidence = $protectedRoot })
  Write-Output ('固定场已启动 UAC，PID=' + $child.Id + '；证据=' + $protectedRoot)
  return
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ProductMsiReviewNative {
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern uint MsiEnumRelatedProducts(string upgrade,uint reserved,uint index,StringBuilder product);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiGetProductInfoEx(string product,string sid,uint context,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern int MsiGetComponentPathEx(string product,string component,string sid,uint context,StringBuilder value,ref uint length);
 [DllImport("msi.dll", CharSet=CharSet.Unicode)] public static extern uint MsiGetShortcutTarget(string path,StringBuilder product,StringBuilder feature,StringBuilder component);
 [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int bytes,out int returned);
 [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
 public static uint Info(string product,string property,StringBuilder value,ref uint length){return MsiGetProductInfoEx(product,null,4,property,value,ref length);}
 public static int Component(string product,string component,StringBuilder value,ref uint length){return MsiGetComponentPathEx(product,component,null,4,value,ref length);}
 public static bool Elevated(IntPtr process){IntPtr t;if(!OpenProcessToken(process,8,out t))throw new System.ComponentModel.Win32Exception();try{int v,n;if(!GetTokenInformation(t,20,out v,4,out n))throw new System.ComponentModel.Win32Exception();return v!=0;}finally{CloseHandle(t);}}
}
'@
function Info([string]$Code, [string]$Property) {
  [uint32]$length = 32767; $value = [Text.StringBuilder]::new(32767)
  $status = [ProductMsiReviewNative]::Info($Code, $Property, $value, [ref]$length)
  [ordered]@{ status = $status; value = $value.ToString() }
}
function Processes {
  $found = @()
  foreach ($process in @(Get-Process AIbrowse, guardian -ErrorAction SilentlyContinue)) {
    $found += [ordered]@{ pid = $process.Id; startTicks = $process.StartTime.ToUniversalTime().Ticks; path = $process.Path; elevated = [ProductMsiReviewNative]::Elevated($process.Handle); visibleWindow = $process.MainWindowHandle -ne [IntPtr]::Zero }
  }
  return ,$found
}
function Snapshot-State {
  $related = @()
  for ([uint32]$i = 0; $i -le 16; $i++) {
    $code = [Text.StringBuilder]::new(39); $status = [ProductMsiReviewNative]::MsiEnumRelatedProducts(('{' + $manifest.identity + '}'), 0, $i, $code)
    if ($status -eq 259) { break }; Require ($status -eq 0 -and $i -lt 16) '相关产品枚举失败或超限'; $related += $code.ToString()
  }
  $products = @()
  foreach ($package in $manifest.packages) {
    $cache = Info $package.product 'LocalPackage'; $components = @()
    foreach ($file in $package.files) {
      [uint32]$length = 32767; $value = [Text.StringBuilder]::new(32767)
      $state = [ProductMsiReviewNative]::Component($package.product, $file.component, $value, [ref]$length)
      $components += [ordered]@{ path = $file.path; component = $file.component; state = $state; actual = $value.ToString() }
    }
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(('Software\AIbrowse\Installer\' + $manifest.identity + '\Products\' + $package.product), $false)
    $locator = if ($null -eq $key) { $null } else { try { $key.GetValue('InstallLocation') } finally { $key.Dispose() } }
    $products += [ordered]@{ name = $package.name; code = $package.product; location = (Info $package.product 'InstallLocation'); version = (Info $package.product 'VersionString'); cache = $cache; cacheHash = $(if ($cache.status -eq 0) { Digest $cache.value } else { $null }); locator = $locator; components = $components }
  }
  $files = @(); $directories = @()
  if (Test-Path -LiteralPath $installRoot) {
    Protected $installRoot; $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($installRoot)
    while ($queue.Count -gt 0) {
      $dir = $queue.Dequeue(); Require ($directories.Count -lt 128) '目录数量超限'; $directories += $(if ($dir -eq $installRoot) { '.' } else { $dir.Substring($installRoot.Length + 1) })
      foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
        Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '安装目录含链接'
        Protected $item.FullName
        if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) } else {
          Require ($files.Count -lt 4096 -and $item.Length -le 536870912) '安装文件读取超限'
          $files += [ordered]@{ path = $item.FullName.Substring($installRoot.Length + 1).Replace('\', '/'); bytes = $item.Length; sha256 = (Digest $item.FullName); sddl = (Get-Acl -LiteralPath $item.FullName).Sddl }
        }
      }
    }
  }
  $links = @(); $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($folder in @('CommonDesktopDirectory', 'CommonPrograms')) {
      $path = Join-Path ([Environment]::GetFolderPath($folder)) 'AIbrowse.lnk'
      if (!(Test-Path -LiteralPath $path)) { continue }; No-Links $path
      $link = $shell.CreateShortcut($path)
      try { $p = [Text.StringBuilder]::new(39); $f = [Text.StringBuilder]::new(39); $c = [Text.StringBuilder]::new(39); $advertised = [ProductMsiReviewNative]::MsiGetShortcutTarget($path, $p, $f, $c); $links += [ordered]@{ path = $path; target = $link.TargetPath; arguments = $link.Arguments; advertisedStatus = $advertised; sddl = (Get-Acl -LiteralPath $path).Sddl } } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  [ordered]@{ related = $related; products = $products; files = @($files | Sort-Object { $_.path }); directories = @($directories | Sort-Object); shortcuts = $links }
}
function Installed($State, [string]$Name) {
  $package = @($manifest.packages | Where-Object name -CEQ $Name)[0]; $product = @($State.products | Where-Object name -CEQ $Name)[0]
  Require ($State.related.Count -eq 1 -and $State.related[0] -ceq $package.product -and $product.location.status -eq 0 -and $product.location.value.TrimEnd('\') -ieq $installRoot -and $product.version.value -ceq $package.version -and $product.cacheHash -ceq $package.artifacts.msi.sha256 -and $product.locator.TrimEnd('\') -ieq $installRoot) '实际 machine 注册/cache/版本/locator 不匹配'
  foreach ($file in $package.files) {
    $actual = @($State.files | Where-Object path -CEQ $file.path); $component = @($product.components | Where-Object path -CEQ $file.path)[0]
    Require ($actual.Count -eq 1 -and $actual[0].sha256 -ceq $file.sha256 -and $actual[0].bytes -eq $file.bytes -and $component.state -eq 3 -and $component.actual -ieq (Join-Path $installRoot $file.path)) ('实际文件/组件不匹配：' + $file.path)
  }
  Require ($State.shortcuts.Count -eq 2) '两个公共快捷方式不完整'
  foreach ($link in $State.shortcuts) { Require ($link.target -ieq (Join-Path $installRoot 'AIbrowse.exe') -and $link.arguments -eq '' -and $link.advertisedStatus -ne 0) '快捷方式目标或普通启动状态错误' }
}
function Uninstalled($State) {
  Require ($State.related.Count -eq 0 -and $State.shortcuts.Count -eq 0) '卸载后相关注册或快捷方式残留'
  foreach ($product in $State.products) { Require ($product.cache.status -eq 1605 -and $product.location.status -eq 1605 -and $null -eq $product.locator) '卸载后产品注册/cache查询未退休' }
}
if ($Action -eq 'Snapshot') {
  $snapshot = Snapshot-State
  Write-Output ($snapshot | ConvertTo-Json -Depth 20)
  return
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
Require ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Run 只允许受保护 UAC 副本'
Protected $PSScriptRoot
Require ($PSScriptRoot -ieq (Join-Path $programFiles ('AIbrowse Product Bootstrap ' + $scopeId.Substring(12) + ' ' + $Step))) '只能从固定本场保护副本运行'
if (!(Test-Path -LiteralPath $protectedRoot)) {
  Require ($Step -eq 'cancel') '首场必须是欢迎页取消'
  New-Protected $protectedRoot
  Save-Json $protectedRoot 'manifest.json' $manifest
  Save-Json $protectedRoot 'binding.json' ([ordered]@{ originalManifestSha256 = $ManifestSha256; protectedManifestSha256 = (Digest (Join-Path $protectedRoot 'manifest.json')); runnerSha256 = $RunnerSha256 })
  foreach ($package in $manifest.packages) {
    foreach ($kind in @('exe', 'msi')) { $entry = $package.artifacts.$kind; Copy-Bound $entry.path (Join-Path $protectedRoot ($package.name + '.' + $kind)) $entry.sha256 $entry.bytes }
    Copy-Bound $package.installerManifest.path (Join-Path $protectedRoot ($package.name + '-installer-build.json')) $package.installerManifest.sha256 $package.installerManifest.bytes
    Copy-Bound $package.provenance.path (Join-Path $protectedRoot ($package.name + '-build-provenance.json')) $package.provenance.sha256 $package.provenance.bytes
  }
}
Protected $protectedRoot
$binding = Get-Content -LiteralPath (Join-Path $protectedRoot 'binding.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Require ($binding.originalManifestSha256 -ceq $ManifestSha256 -and $binding.runnerSha256 -ceq $RunnerSha256) '保护账本绑定不同'
$manifest = Read-BoundJson (Join-Path $protectedRoot 'manifest.json') $binding.protectedManifestSha256
$stepIndex = [Array]::IndexOf($steps, $Step)
Require (!(Test-Path -LiteralPath (Join-Path $protectedRoot ($Step + '-claim.json'))) -and !(Test-Path -LiteralPath (Join-Path $protectedRoot 'failure.json'))) '失败或已认领场禁止重放'
for ($i = 0; $i -lt $stepIndex; $i++) {
  $prior = Get-Content -LiteralPath (Join-Path $protectedRoot ($steps[$i] + '-result.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
  Require ($prior.pass -eq $true -and $prior.step -ceq $steps[$i]) '前一场未通过'
}
$started = [DateTime]::UtcNow; $transaction = $null; $wrapper = $null
$temporaryObservation = [ordered]@{ status = 'NOTOBSERVED'; reason = '尚未进入 NSIS 临时文件观察窗口' }
Save-Json $protectedRoot ($Step + '-claim.json') ([ordered]@{ step = $Step; transactionOrdinal = $stepIndex; startedUtc = $started.ToString('O'); maximumTransactions = 6; priorMechanismTransactions = 19; runnerPid = $PID; runnerStartTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks })
try {
  $before = Snapshot-State; Save-Json $protectedRoot ($Step + '-before.json') $before
  $beforeProcesses = Processes; Save-Json $protectedRoot ($Step + '-processes-before.json') $beforeProcesses
  if ($Step -eq 'running-reject') {
    $main = @($beforeProcesses | Where-Object { $_.path -ieq (Join-Path $installRoot 'AIbrowse.exe') -and $_.visibleWindow -and !$_.elevated })
    Require ($main.Count -eq 1) '必须存在唯一普通用户已安装应用主窗口'
    foreach ($item in $beforeProcesses) { Require ($item.path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and !$item.elevated) '存在其它来源或已提权应用/guardian' }
  } else { Require ($beforeProcesses.Count -eq 0) '应用/guardian 尚未自然退出' }
  if ($Step -eq 'cancel' -or $Step -eq 'install') { Uninstalled $before; Require ($before.files.Count -eq 0 -and !(Test-Path -LiteralPath $installRoot)) '首装根已存在，停止覆盖未知内容' }
  elseif ($Step -eq 'upgrade') { Installed $before 'reference' }
  elseif ($Step -eq 'reinstall') { Uninstalled $before }
  else { Installed $before 'candidate' }
  $packageName = if ($Step -in @('cancel', 'install')) { 'reference' } else { 'candidate' }
  $package = @($manifest.packages | Where-Object name -CEQ $packageName)[0]
  $isNsis = $Step -in @('cancel', 'install', 'upgrade', 'reinstall')
  $path = if ($isNsis) { Join-Path $protectedRoot ($packageName + '.exe') } else { Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe' }
  Protected $path
  if ($isNsis) { Require ((Digest $path) -ceq $package.artifacts.exe.sha256) '受保护 NSIS 字节漂移' }
  $start = [Diagnostics.ProcessStartInfo]::new($path); $start.UseShellExecute = $false; $start.WorkingDirectory = $protectedRoot
  if (!$isNsis) {
    Require ($package.product -cmatch '^\{[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\}$') '注册卸载 ProductCode 不规范'
    $start.Arguments = '/x ' + $package.product + ' /qn /norestart ALLUSERS=1 MSIINSTALLPERUSER="" REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable MSIDISABLERMRESTART=1 /l*vx "' + (Join-Path $protectedRoot ($Step + '-msi.log')) + '"'
  }
  $wrapper = [Diagnostics.Process]::Start($start); [void]$wrapper.Handle
  Save-Json $protectedRoot ($Step + '-process.json') ([ordered]@{ pid = $wrapper.Id; startTicks = $wrapper.StartTime.ToUniversalTime().Ticks; path = $path; args = $start.Arguments; interactive = $isNsis })
  if ($isNsis) {
    # The controlled NSIS ExecWait propagates MSI failure. Child capture supplements
    # wrapper status and complete installed state; missing a short-lived child is not
    # evidence of failure. Wrapper lifetime is a conservative transaction time bound.
    $wait = [Diagnostics.Stopwatch]::StartNew(); $childIds = @(); $observeChildren = $true
    while (!$wrapper.HasExited) {
      $children = @()
      if ($observeChildren) {
        try { $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $wrapper.Id + " AND Name='msiexec.exe'")) }
        catch { $observeChildren = $false; $temporaryObservation = [ordered]@{ status = 'NOTOBSERVED'; reason = '当前系统未提供补充子进程采样，采用受控包装退出及实际安装状态 oracle' } }
      }
      foreach ($child in $children) {
        if ($childIds -contains $child.ProcessId) { continue }
        $childIds += $child.ProcessId
        Require ($Step -ne 'cancel' -and $childIds.Count -eq 1) '欢迎取消启动 MSI 或 NSIS 启动多次事务'
        try { $transaction = [Diagnostics.Process]::GetProcessById($child.ProcessId); [void]$transaction.Handle } catch [ArgumentException] { continue }
        if (!$child.ExecutablePath -or !$child.CommandLine) { continue }
        Require ($child.ExecutablePath -ieq (Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe')) 'NSIS 子进程不是原生 msiexec'
        $command = [string]$child.CommandLine
        Require ($command -match '^"[^"]+\\msiexec\.exe" /i "([^"]+\\AIbrowse\.msi)" /qn /norestart ALLUSERS=1 MSIINSTALLPERUSER="" REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable MSIDISABLERMRESTART=1$') 'NSIS MSI 命令不符合固定模板'
        $embedded = $Matches[1]
        if (Test-Path -LiteralPath $embedded -PathType Leaf) {
          try {
            Protected ([IO.Path]::GetDirectoryName($embedded)); Protected $embedded
            $embeddedHash = Digest $embedded
            Require ($embeddedHash -ceq $package.artifacts.msi.sha256) 'NSIS 实际嵌入 MSI 不匹配'
            $temporaryObservation = [ordered]@{ status = 'OBSERVED'; embeddedMsiSha256 = $embeddedHash; temporarySddl = (Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($embedded))).Sddl; noReparse = $true; restrictedWrite = $true }
          } catch [System.Management.Automation.ItemNotFoundException] { $temporaryObservation = [ordered]@{ status = 'NOTOBSERVED'; reason = 'NSIS 已正常退休临时文件，未取得完整瞬态观察' } }
        }
        Save-Json $protectedRoot ($Step + '-transaction-start.json') ([ordered]@{ pid = $transaction.Id; startTicks = $transaction.StartTime.ToUniversalTime().Ticks; command = $command; temporary = $temporaryObservation })
      }
      if ($null -ne $transaction -and !$transaction.HasExited) { Require (([DateTime]::UtcNow - $transaction.StartTime.ToUniversalTime()).TotalSeconds -le 180) '真实 MSI 超过 180 秒；保留进程，不强杀' }
      Require ($wait.Elapsed.TotalMinutes -lt 15) '人工 NSIS 页面等待超限；保留进程，不强杀'
      Start-Sleep -Milliseconds 150; $wrapper.Refresh()
    }
    Save-Json $protectedRoot ($Step + '-wrapper-exit.json') ([ordered]@{ pid = $wrapper.Id; exit = $wrapper.ExitCode; startTicks = $wrapper.StartTime.ToUniversalTime().Ticks; exitTicks = $wrapper.ExitTime.ToUniversalTime().Ticks; observedMsiChildren = $childIds; temporaryObservation = $temporaryObservation })
    if ($Step -eq 'cancel') { Require ($null -eq $transaction -and $wrapper.ExitCode -eq 1) '欢迎页取消没有取得 NSIS 用户取消退出码 1' }
    else { Require ($wrapper.ExitCode -eq 0) 'NSIS 未正常完成' }
  } else {
    $transaction = $wrapper
    Require ($transaction.WaitForExit(180000)) '真实 MSI 超过 180 秒；保留进程，不强杀'
  }
  $transactionResult = $null
  if ($null -ne $transaction) {
    Require ($transaction.HasExited) 'MSI 尚未退休'
    $elapsed = ($transaction.ExitTime.ToUniversalTime() - $transaction.StartTime.ToUniversalTime()).TotalMilliseconds
    $transactionResult = [ordered]@{ pid = $transaction.Id; exit = $transaction.ExitCode; elapsedMs = $elapsed; startTicks = $transaction.StartTime.ToUniversalTime().Ticks; exitTicks = $transaction.ExitTime.ToUniversalTime().Ticks }
    Save-Json $protectedRoot ($Step + '-transaction-result.json') $transactionResult
    Require ($elapsed -le 180000 -and $transaction.ExitCode -eq $(if ($Step -eq 'running-reject') { 1603 } else { 0 })) 'MSI 退出码或期限不匹配'
  } elseif ($Step -ne 'cancel') {
    $upperBound = ($wrapper.ExitTime.ToUniversalTime() - $wrapper.StartTime.ToUniversalTime()).TotalMilliseconds
    $transactionResult = [ordered]@{ childObservation = 'NOTOBSERVED'; exitFromControlledExecWait = $wrapper.ExitCode; conservativeElapsedUpperBoundMs = $upperBound; timingSource = 'NSIS 完整创建至退出，包含人工页面等待' }
    Save-Json $protectedRoot ($Step + '-transaction-result.json') $transactionResult
    Require ($upperBound -le 180000) '未取得 MSI 独立计时，且包含人工等待的保守上界超过 180 秒；期限未验证，保留现场'
  }
  $after = Snapshot-State; Save-Json $protectedRoot ($Step + '-after.json') $after
  if ($Step -in @('cancel', 'running-reject')) {
    Require (($before | ConvertTo-Json -Depth 20 -Compress) -ceq ($after | ConvertTo-Json -Depth 20 -Compress)) '取消或运行拒绝改变了完整安装状态'
  } elseif ($Step -in @('uninstall', 'final-uninstall')) { Uninstalled $after }
  else { Installed $after $packageName }
  $afterProcesses = Processes; Save-Json $protectedRoot ($Step + '-processes-after.json') $afterProcesses
  if ($Step -eq 'running-reject') { Require (@($afterProcesses | Where-Object { $_.pid -eq $main[0].pid -and $_.startTicks -eq $main[0].startTicks -and !$_.elevated }).Count -eq 1) '运行拒绝没有保留原普通用户主进程' }
  else { Require ($afterProcesses.Count -eq 0) '安装器意外启动应用/guardian' }
  if ($Step -eq 'install') {
    $sentinels = @()
    foreach ($relative in @('e5-review-unknown.txt', 'resources/e5-review-unknown.txt', 'e5-review-unknown/保留.txt')) {
      $target = Join-Path $installRoot $relative; $parent = [IO.Path]::GetDirectoryName($target)
      if (!(Test-Path -LiteralPath $parent)) { [void][IO.Directory]::CreateDirectory($parent) }; Protected $parent
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes('E5 合成未知文件 ' + $scopeId + ' ' + $relative)
      $stream = [IO.File]::Open($target, 'CreateNew', 'Write', 'None'); try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      $sentinels += [ordered]@{ path = $relative; sha256 = (Digest $target); sddl = (Get-Acl -LiteralPath $target).Sddl }
    }
    Save-Json $protectedRoot 'sentinels.json' $sentinels
    Save-Json $protectedRoot 'external-sentinel.json' ([ordered]@{ value = 'E5 安装根外合成哨兵'; scopeId = $scopeId })
    Save-Json $protectedRoot 'external-binding.json' ([ordered]@{ sha256 = (Digest (Join-Path $protectedRoot 'external-sentinel.json')); sddl = (Get-Acl -LiteralPath (Join-Path $protectedRoot 'external-sentinel.json')).Sddl })
  }
  if ($stepIndex -ge 1) {
    $sentinels = @(Get-Content -LiteralPath (Join-Path $protectedRoot 'sentinels.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
    foreach ($sentinel in $sentinels) { $target = Join-Path $installRoot $sentinel.path; No-Links $target; Require ((Digest $target) -ceq $sentinel.sha256 -and (Get-Acl -LiteralPath $target).Sddl -ceq $sentinel.sddl) '未知哨兵内容或 ACL 未保全' }
    $external = Get-Content -LiteralPath (Join-Path $protectedRoot 'external-binding.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Require ((Digest (Join-Path $protectedRoot 'external-sentinel.json')) -ceq $external.sha256 -and (Get-Acl -LiteralPath (Join-Path $protectedRoot 'external-sentinel.json')).Sddl -ceq $external.sddl) '外部哨兵未保全'
    $owned = if ($Step -in @('uninstall', 'final-uninstall')) { @() } else { @($package.files.path) }
    $current = Snapshot-State
    Require ($current.files.Count -eq $owned.Count + 3 -and @($current.files | Where-Object { $owned -cnotcontains $_.path -and $sentinels.path -cnotcontains $_.path }).Count -eq 0) '安装文件完整集合不匹配或卸载残留 owned 文件'
    Save-Json $protectedRoot ($Step + '-final-state.json') $current
  }
  Save-Json $protectedRoot ($Step + '-result.json') ([ordered]@{ pass = $true; step = $Step; transactionOrdinal = $stepIndex; transaction = $transactionResult; temporaryObservation = $temporaryObservation; wrapperExit = $wrapper.ExitCode; finishedUtc = [DateTime]::UtcNow.ToString('O'); profileAccess = 'none'; uiMeaningRequiresHumanEvidence = $true; protectedEvidence = $protectedRoot })
} catch {
  Save-Json $protectedRoot 'failure.json' ([ordered]@{ pass = $false; step = $Step; message = $_.Exception.Message; utc = [DateTime]::UtcNow.ToString('O'); wrapperPid = $(if ($null -ne $wrapper) { $wrapper.Id } else { $null }); transactionPid = $(if ($null -ne $transaction) { $transaction.Id } else { $null }); forcedTermination = $false })
  throw
} finally {
  if ($null -ne $transaction -and $transaction -ne $wrapper) { $transaction.Dispose() }
  if ($null -ne $wrapper) { $wrapper.Dispose() }
}
