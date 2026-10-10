param(
  [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Launch')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Scope,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$FinalBindingSha256,
  [Parameter(Mandatory = $true)][string]$ExeSourcePath,
  [Parameter(Mandatory = $true)][string]$MsiSourcePath,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256 = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Require([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Read-BoundJson([string]$Path, [string]$ExpectedHash, [int]$MaximumBytes, [string]$Label) {
  No-Links $Path
  $item = Get-Item -LiteralPath $Path -Force
  Require ($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) ($Label + '必须是普通文件')
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  try {
    Require ($stream.Length -gt 0 -and $stream.Length -le $MaximumBytes) ($Label + '字节超过预算')
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) { $read = $stream.Read($bytes, $offset, $bytes.Length - $offset); Require ($read -gt 0) ($Label + '提前EOF'); $offset += $read }
    Require ($stream.ReadByte() -eq -1 -and (Hash-Bytes $bytes) -ceq $ExpectedHash) ($Label + '字节或摘要不匹配')
  } finally { $stream.Dispose() }
  try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { throw ($Label + '不是严格UTF-8') }
  try { $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop } catch { throw ($Label + '不是有效JSON') }
  [pscustomobject]@{ Bytes = $bytes; Sha256 = (Hash-Bytes $bytes); Value = $value }
}
function Require-Closed($Value, [string[]]$Names, [string]$Label) {
  Require ($Value -is [pscustomobject]) ($Label + '必须是对象')
  $actual = @($Value.PSObject.Properties.Name)
  Require ($actual.Count -eq $Names.Count) ($Label + '字段不闭合')
  foreach ($name in $Names) { Require ($actual -ccontains $name) ($Label + '字段不闭合') }
}
function Require-String($Value, [string]$Label) { Require ($Value -is [string]) ($Label + '必须是JSON字符串') }
function Require-Integer($Value, [string]$Label) { Require ($Value -is [int] -or $Value -is [long]) ($Label + '必须是JSON整数') }
function Require-Bool($Value, [string]$Label) { Require ($Value -is [bool]) ($Label + '必须是JSON boolean') }
function Require-Sha($Value, [string]$Label) { Require ($Value -is [string] -and $Value -cmatch '^[a-f0-9]{64}$') ($Label + '必须是SHA256') }
function Local-Path([string]$Path, [string]$Label) {
  Require ($Path -cmatch '^[A-Za-z]:\\' -and !$Path.Substring(2).Contains(':')) ($Label + '必须是本机驱动器绝对普通路径')
  $full = [IO.Path]::GetFullPath($Path)
  Require ($full -cmatch '^[A-Za-z]:\\' -and !$full.Substring(2).Contains(':') -and [IO.DriveInfo]::new($full.Substring(0,3)).DriveType -eq [IO.DriveType]::Fixed) ($Label + '必须位于本机固定驱动器')
  $full
}
function No-Links([string]$Path) {
  for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    Require (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '路径祖先或成员含重解析点'
  }
}
function Protected([string]$Path) {
  No-Links $Path
  $acl = Get-Acl -LiteralPath $Path
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  Require ($trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) '保护路径owner无效'
  $writes = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    Require (!($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value)) '保护路径可被非管理员改写'
  }
}
function Save-NewJson([string]$Path, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 12) + "`n")
  $stream = [IO.File]::Open($Path, 'CreateNew', 'Write', 'None')
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Measure-Source([string]$Path, $Expected, [string]$Label) {
  $full = Local-Path $Path $Label
  No-Links $full
  $item = Get-Item -LiteralPath $full -Force
  Require ($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) ($Label + '必须是普通文件')
  Require-Closed $Expected @('sha256', 'bytes') ($Label + '清单')
  Require-Sha $Expected.sha256 ($Label + '.sha256')
  Require-Integer $Expected.bytes ($Label + '.bytes')
  Require ($Expected.bytes -gt 0 -and $Expected.bytes -le 536870912) ($Label + '长度超过512MiB预算')
  $stream = [IO.File]::Open($full, 'Open', 'Read', 'Read')
  try {
    Require ($stream.Length -eq $Expected.bytes) ($Label + '长度不匹配')
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    Require ($actual -ceq $Expected.sha256) ($Label + '摘要不匹配')
  } finally { $stream.Dispose() }
  [pscustomobject]@{ path = $full; sha256 = $Expected.sha256; bytes = $Expected.bytes }
}
function Read-FinalBinding([string]$ScopePath) {
  $path = Join-Path $ScopePath 'final-package-binding.json'
  $input = Read-BoundJson $path $FinalBindingSha256 524288 '最终包绑定'
  $binding = $input.Value
  Require-Closed $binding @('schema','scopeId','originalManifestSha256','maximumTransactions','budgetMs','sourceCommit','cleanBuildsVerified','behaviorApplicabilityVerified','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256','package') '最终包绑定'
  Require-Integer $binding.schema 'schema'; Require-Integer $binding.maximumTransactions 'maximumTransactions'; Require-Integer $binding.budgetMs 'budgetMs'
  Require-Bool $binding.cleanBuildsVerified 'cleanBuildsVerified'; Require-Bool $binding.behaviorApplicabilityVerified 'behaviorApplicabilityVerified'
  foreach ($name in @('scopeId','originalManifestSha256','sourceCommit','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256')) { Require-String $binding.$name $name }
  Require ($binding.schema -eq 1 -and $binding.scopeId -ceq $scopeId -and $binding.maximumTransactions -eq 6 -and $binding.budgetMs -eq 180000 -and $binding.cleanBuildsVerified -eq $true -and $binding.behaviorApplicabilityVerified -eq $true) '最终包绑定合同不匹配'
  Require ($binding.sourceCommit -cmatch '^[a-f0-9]{40}$') '最终commit不规范'
  foreach ($name in @('originalManifestSha256','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256')) { Require-Sha $binding.$name $name }
  Require-Closed $binding.package @('name','version','product','artifacts') '最终候选'
  Require-String $binding.package.name 'package.name'; Require-String $binding.package.version 'package.version'; Require-String $binding.package.product 'package.product'
  Require ($binding.package.name -ceq 'final-candidate' -and $binding.package.version -ceq '0.1.1' -and $binding.package.product -cmatch '^\{[A-F0-9]{8}(-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$') '最终候选身份不闭合'
  Require-Closed $binding.package.artifacts @('exe','msi') '最终制品'
  foreach ($kind in @('exe','msi')) {
    Require-Closed $binding.package.artifacts.$kind @('sha256','bytes') ('最终' + $kind)
    Require-Sha $binding.package.artifacts.$kind.sha256 ($kind + '.sha256')
    Require-Integer $binding.package.artifacts.$kind.bytes ($kind + '.bytes')
    Require ($binding.package.artifacts.$kind.bytes -gt 0 -and $binding.package.artifacts.$kind.bytes -le 536870912) ($kind + '长度超预算')
  }
  $binding
}
Require ([Environment]::Is64BitProcess) '需要64位PowerShell'
$scopePath = Local-Path $Scope 'Scope'
$exeSource = Local-Path $ExeSourcePath 'EXE来源'
$msiSource = Local-Path $MsiSourcePath 'MSI来源'
$scopeId = [IO.Path]::GetFileName($scopePath)
Require ($scopeId -cmatch '^product-msi-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $scopePath -PathType Container)) '固定product-msi scope无效'
No-Links $scopePath
$binding = Read-FinalBinding $scopePath
$exe = Measure-Source $exeSource $binding.package.artifacts.exe 'EXE来源'
$msi = Measure-Source $msiSource $binding.package.artifacts.msi 'MSI来源'
Require (![string]::Equals($exe.path, $msi.path, [StringComparison]::OrdinalIgnoreCase)) '两个来源不得是同一文件'
$protectedRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('AIbrowse Product Review ' + $scopeId.Substring(12))
$runnerSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$utf8 = [Text.UTF8Encoding]::new($false)
$bootstrap = @'
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
function Require-StageCondition([bool]$v,[string]$m){if(!$v){throw $m}}
function Get-StageByteHash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($s.ComputeHash($b)).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Resolve-LocalFixedPath([string]$p){Require-StageCondition ($p -cmatch '^[A-Za-z]:\\' -and !$p.Substring(2).Contains(':')) '非本机驱动器绝对普通路径';$f=[IO.Path]::GetFullPath($p);Require-StageCondition ($f -cmatch '^[A-Za-z]:\\' -and !$f.Substring(2).Contains(':') -and [IO.DriveInfo]::new($f.Substring(0,3)).DriveType -eq [IO.DriveType]::Fixed) '非本机固定驱动器';$f}
function Assert-NoStageLinks([string]$p){for($x=$p;$x;$x=[IO.Path]::GetDirectoryName($x)){Require-StageCondition (((Get-Item -LiteralPath $x -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)-eq 0) '路径含链接'}}
function Assert-ProtectedStagePath([string]$p){Assert-NoStageLinks $p;$a=Get-Acl -LiteralPath $p;$t=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');Require-StageCondition ($t -contains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) '保护路径owner无效';$w=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if(($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)-eq 0){Require-StageCondition (!($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $w)-ne 0 -and $t -notcontains $r.IdentityReference.Value)) '保护路径可被非管理员改写'}}}
function Save-NewStageJson([string]$p,$v){$b=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json $v -Depth 8)+"`n");$f=[IO.File]::Open($p,'CreateNew','Write','None');try{$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}}
function Copy-ProtectedStageFile([string]$src,[string]$dst,[string]$hash,[long]$len){$src=Resolve-LocalFixedPath $src;Assert-NoStageLinks $src;$item=Get-Item -LiteralPath $src -Force;Require-StageCondition ($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::Directory)-eq 0 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-eq 0) '来源不是普通文件';$i=[IO.File]::Open($src,'Open','Read','Read');try{Require-StageCondition ($i.Length -eq $len -and $len -gt 0 -and $len -le 536870912) '来源长度无效';$o=[IO.File]::Open($dst,'CreateNew','Write','None');$s=[Security.Cryptography.SHA256]::Create();try{$buf=New-Object byte[] 1048576;$n=0;while(($r=$i.Read($buf,0,$buf.Length))-gt 0){$o.Write($buf,0,$r);[void]$s.TransformBlock($buf,0,$r,$buf,0);$n+=$r};[void]$s.TransformFinalBlock((New-Object byte[] 0),0,0);$o.Flush($true);Require-StageCondition ($n -eq $len -and [BitConverter]::ToString($s.Hash).Replace('-','').ToLowerInvariant() -ceq $hash) '来源字节变化'}finally{$s.Dispose();$o.Dispose()};Assert-ProtectedStagePath $dst;Require-StageCondition ((Get-Item -LiteralPath $dst).Length -eq $len -and (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $hash) '保护副本变化'}finally{$i.Dispose()}}
$scope=Resolve-LocalFixedPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SCOPE__')));$exePath=Resolve-LocalFixedPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXEPATH__')));$msiPath=Resolve-LocalFixedPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__MSIPATH__')));Require-StageCondition (![string]::Equals($exePath,$msiPath,[StringComparison]::OrdinalIgnoreCase)) '两个来源相同';Assert-NoStageLinks $scope;Assert-NoStageLinks $exePath;Assert-NoStageLinks $msiPath;$bindingPath=Join-Path $scope 'final-package-binding.json';Assert-NoStageLinks $bindingPath;$bindingItem=Get-Item -LiteralPath $bindingPath -Force;Require-StageCondition ($bindingItem -is [IO.FileInfo] -and ($bindingItem.Attributes -band [IO.FileAttributes]::Directory)-eq 0 -and ($bindingItem.Attributes -band [IO.FileAttributes]::ReparsePoint)-eq 0) '最终绑定不是普通文件';$bf=[IO.File]::Open($bindingPath,'Open','Read','Read');try{Require-StageCondition ($bf.Length -gt 0 -and $bf.Length -le 524288) '最终绑定超预算';$bb=New-Object byte[] ([int]$bf.Length);$off=0;while($off -lt $bb.Length){$read=$bf.Read($bb,$off,$bb.Length-$off);Require-StageCondition ($read -gt 0) '最终绑定提前EOF';$off+=$read};Require-StageCondition ($bf.ReadByte() -eq -1 -and (Get-StageByteHash $bb) -ceq '__BINDING__') '最终绑定变化'}finally{$bf.Dispose()};$j=[Text.UTF8Encoding]::new($false,$true).GetString($bb)|ConvertFrom-Json;Require-StageCondition ($j.package.name -ceq 'final-candidate' -and $j.package.artifacts.exe.sha256 -ceq '__EXEHASH__' -and $j.package.artifacts.exe.bytes -eq __EXEBYTES__ -and $j.package.artifacts.msi.sha256 -ceq '__MSIHASH__' -and $j.package.artifacts.msi.bytes -eq __MSIBYTES__) '最终绑定候选变化'
$root=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AIbrowse Product Review __ID__';Assert-ProtectedStagePath ([Environment]::GetFolderPath('ProgramFiles'));Assert-ProtectedStagePath $root;Require-StageCondition (!(Test-Path -LiteralPath (Join-Path $root 'final-candidate.exe')) -and !(Test-Path -LiteralPath (Join-Path $root 'final-candidate.msi'))) '最终保护副本已存在'
try{Copy-ProtectedStageFile $exePath (Join-Path $root 'final-candidate.exe') '__EXEHASH__' __EXEBYTES__;Copy-ProtectedStageFile $msiPath (Join-Path $root 'final-candidate.msi') '__MSIHASH__' __MSIBYTES__;Save-NewStageJson (Join-Path $root 'final-package-stage-result.json') ([ordered]@{schema=1;finalBindingSha256='__BINDING__';runnerSha256='__RUNNER__';exe=[ordered]@{sha256='__EXEHASH__';bytes=__EXEBYTES__};msi=[ordered]@{sha256='__MSIHASH__';bytes=__MSIBYTES__};completed=$true;utc=[DateTime]::UtcNow.ToString('O')})}catch{try{Save-NewStageJson (Join-Path $root 'final-package-stage-failure.json') ([ordered]@{schema=1;completed=$false;error=$_.Exception.Message;utc=[DateTime]::UtcNow.ToString('O')})}catch{};throw}
'@
$bootstrap = $bootstrap.Replace('__SCOPE__', [Convert]::ToBase64String($utf8.GetBytes($scopePath))).Replace('__BINDING__', $FinalBindingSha256).Replace('__EXEPATH__', [Convert]::ToBase64String($utf8.GetBytes($exe.path))).Replace('__MSIPATH__', [Convert]::ToBase64String($utf8.GetBytes($msi.path))).Replace('__EXEHASH__', $exe.sha256).Replace('__MSIHASH__', $msi.sha256).Replace('__EXEBYTES__', [string]$exe.bytes).Replace('__MSIBYTES__', [string]$msi.bytes).Replace('__RUNNER__', $runnerSha256).Replace('__ID__', $scopeId.Substring(12))
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
$commandSha256 = Hash-Bytes ([Text.Encoding]::Unicode.GetBytes($bootstrap))
$planPath = Join-Path $scopePath 'final-package-stage-plan.json'
$planValue = [ordered]@{ schema=1; scopeId=$scopeId; finalBindingSha256=$FinalBindingSha256; runnerSha256=$runnerSha256; sources=[ordered]@{exe=$exe;msi=$msi}; protectedRoot=$protectedRoot; commandSha256=$commandSha256; encodedCommand=$encoded }
if ($Action -eq 'Prepare') {
  Require ($PlanSha256 -eq '') 'Prepare不接受PlanSha256'
  Save-NewJson $planPath $planValue
  Write-Output ('已生成不提权审核材料：' + $planPath)
  return
}
Require ($PlanSha256 -cmatch '^[a-f0-9]{64}$') 'Launch必须绑定plan摘要'
$planInput = Read-BoundJson $planPath $PlanSha256 1048576 '保护复制plan'
$expectedPlan = ConvertTo-Json -InputObject $planValue -Depth 12 -Compress
$actualPlan = ConvertTo-Json -InputObject $planInput.Value -Depth 12 -Compress
Require ($actualPlan -ceq $expectedPlan) 'plan与当前固定输入不一致'
$claimPath = Join-Path $scopePath 'final-package-stage-uac-claim.json'
Save-NewJson $claimPath ([ordered]@{schema=1;planSha256=$PlanSha256;finalBindingSha256=$FinalBindingSha256;runnerSha256=$runnerSha256;commandSha256=$commandSha256;utc=[DateTime]::UtcNow.ToString('O')})
$systemPowerShell = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
Protected ([Environment]::GetFolderPath('ProgramFiles'))
Protected $protectedRoot
Protected ([Environment]::GetFolderPath('Windows'))
Protected ([IO.Path]::GetDirectoryName($systemPowerShell))
Protected $systemPowerShell
Require (!(Test-Path -LiteralPath (Join-Path $protectedRoot 'final-candidate.exe')) -and !(Test-Path -LiteralPath (Join-Path $protectedRoot 'final-candidate.msi'))) '最终保护副本已存在'
$child = Start-Process -FilePath $systemPowerShell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -PassThru
Save-NewJson (Join-Path $scopePath 'final-package-stage-uac-process.json') ([ordered]@{schema=1;pid=$child.Id;startTicks=$child.StartTime.ToUniversalTime().Ticks;planSha256=$PlanSha256;commandSha256=$commandSha256;utc=[DateTime]::UtcNow.ToString('O')})
Write-Output ('固定保护复制已启动，PID=' + $child.Id)
