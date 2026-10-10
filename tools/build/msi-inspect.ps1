param([Parameter(Mandatory=$true)][string]$Msi, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase([IO.Path]::GetFullPath($Msi), 0)
$queries = [ordered]@{
  Property = 'SELECT `Property`, `Value` FROM `Property`'
  Component = 'SELECT `Component`, `ComponentId`, `Directory_`, `Attributes`, `KeyPath` FROM `Component`'
  File = 'SELECT `File`, `Component_`, `FileName`, `FileSize` FROM `File`'
  Registry = 'SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`'
  AppSearch = 'SELECT `Property`, `Signature_` FROM `AppSearch`'
  RegLocator = 'SELECT `Signature_`, `Root`, `Key`, `Name`, `Type` FROM `RegLocator`'
  Directory = 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`'
  Shortcut = 'SELECT `Shortcut`, `Directory_`, `Name`, `Component_`, `Target` FROM `Shortcut`'
  RemoveFile = 'SELECT `FileKey`, `Component_`, `FileName`, `DirProperty`, `InstallMode` FROM `RemoveFile`'
  CustomAction = 'SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`'
  InstallExecuteSequence = 'SELECT `Action`, `Condition`, `Sequence` FROM `InstallExecuteSequence`'
  AdminExecuteSequence = 'SELECT `Action`, `Condition`, `Sequence` FROM `AdminExecuteSequence`'
  Upgrade = 'SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Attributes`, `ActionProperty` FROM `Upgrade`'
  LaunchCondition = 'SELECT `Condition`, `Description` FROM `LaunchCondition`'
}
$tables = [ordered]@{}
foreach ($name in $queries.Keys) {
  $view = $database.OpenView($queries[$name])
  $view.Execute()
  $rows = [Collections.Generic.List[object]]::new()
  while ($true) {
    $record = $view.Fetch()
    if ($null -eq $record) { break }
    if ($rows.Count -ge 8192) { throw 'MSI表超出检查预算' }
    $row = @()
    for ($i = 1; $i -le $record.FieldCount(); $i++) { $row += $record.StringData($i) }
    $rows.Add($row)
  }
  $view.Close()
  $tables[$name] = $rows.ToArray()
}
$summary = $database.SummaryInformation(0)
$wordCount = [int]$summary.Property(15)
if (($wordCount -band 8) -ne 0) { throw 'MSI未声明全机提升权限' }
if (@($tables.Property | Where-Object { $_[0] -eq 'ALLUSERS' -and $_[1] -eq '1' }).Count -ne 1) { throw 'MSI没有固定全机ALLUSERS' }
if ($tables.Component.Count -ne $tables.File.Count) { throw '不是每文件一个正向组件' }
if ($tables.Registry.Count -ne 1) { throw '不是唯一HKLM目录候选' }
$upgrade = @($tables.Property | Where-Object { $_[0] -eq 'UpgradeCode' })[0][1].Trim('{}')
$locator = @($tables.Registry | Where-Object { $_[0] -eq 'InstallLocationLocator' })
$mainComponent = 'Cc79edd0530246f62a9ce8963304368cf'
$locatorKey = 'Software\AIbrowse\Installer\' + $upgrade + '\Products\[ProductCode]'
if ($locator.Count -ne 1 -or $locator[0][1] -ne '2' -or $locator[0][2] -cne $locatorKey -or $locator[0][3] -ne 'InstallLocation' -or $locator[0][4] -ne '[INSTALLDIR]' -or $locator[0][5] -ne $mainComponent) { throw 'MSI目录候选作者形状不匹配' }
foreach ($component in $tables.Component) {
  $keys = @($tables.File | Where-Object { $_[0] -eq $component[4] -and $_[1] -eq $component[0] })
  if ($component[3] -ne '256' -or $keys.Count -ne 1) { throw 'MSI不是64位file keypath组件' }
}
if (@($tables.Property | Where-Object { $_[0] -eq 'DISABLEADVTSHORTCUTS' -and $_[1] -eq '1' }).Count -ne 1) { throw 'MSI未禁用按需安装shortcut' }
foreach ($row in $tables.RemoveFile) { if ($row[2] -ne '' -or $row[4] -ne '2') { throw 'MSI存在非空目录卸载清理规则' } }
$sequence = @{}
foreach ($row in $tables.InstallExecuteSequence) { $sequence[$row[0]] = [int]$row[2] }
if (!($sequence.CostFinalize -lt $sequence.CheckInstall -and $sequence.CostFinalize -lt $sequence.CheckRemove -and $sequence.CheckInstall -lt $sequence.InstallValidate -and $sequence.CheckRemove -lt $sequence.InstallValidate -and $sequence.InstallValidate -lt $sequence.InstallInitialize -and $sequence.InstallInitialize -lt $sequence.RemoveExistingProducts -and $sequence.RemoveExistingProducts -lt $sequence.InstallExecute -and $sequence.InstallExecute -lt $sequence.RejectInUse -and $sequence.RejectInUse -lt $sequence.InstallFinalize)) { throw 'MSI事务顺序无效' }
if (!($sequence.AppSearch -lt $sequence.LaunchConditions -and $sequence.LaunchConditions -lt $sequence.SetINSTALLDIR -and $sequence.SetINSTALLDIR -lt $sequence.CostFinalize -and $sequence.CostFinalize -lt $sequence.CheckRemove)) { throw 'MSI目录候选验证顺序无效' }
$adminReject = @($tables.CustomAction | Where-Object { $_[0] -eq 'RejectAdministrativeInstall' -and $_[1] -eq '19' })
$adminSequence = @($tables.AdminExecuteSequence | Where-Object { $_[0] -eq 'RejectAdministrativeInstall' })
$adminCost = @($tables.AdminExecuteSequence | Where-Object { $_[0] -eq 'CostInitialize' })
if ($adminReject.Count -ne 1 -or $adminSequence.Count -ne 1 -or $adminSequence[0][1] -ne '1' -or $adminCost.Count -ne 1 -or [int]$adminSequence[0][2] -ge [int]$adminCost[0][2]) { throw 'MSI管理安装Type19拒绝顺序无效' }
$search = @($tables.RegLocator | Where-Object { $_[0] -eq 'RegisteredInstallLocation' })
if ($search.Count -ne 1 -or $search[0][1] -ne '2' -or $search[0][2] -cne $locatorKey -or $search[0][3] -ne 'InstallLocation' -or $search[0][4] -ne '18') { throw 'MSI目录候选查找不匹配' }
$result = [ordered]@{ schema = 1; msiSha256 = (Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLowerInvariant(); template = $summary.Property(7); wordCount = $wordCount; tables = $tables; installExecuted = $false }
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($result | ConvertTo-Json -Depth 8) + "`n")
$stream = [IO.File]::Open([IO.Path]::GetFullPath($Output), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
Write-Output 'MSI只读表检查通过；未执行安装'
