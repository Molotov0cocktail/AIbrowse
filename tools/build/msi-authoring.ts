import { createHash, randomUUID } from 'node:crypto';

export const MSI_UPGRADE_CODE = '69F81EEA-69A7-4E92-A794-B882158DE0D9';
export interface MsiIdentity {
  scope: 'product' | 'fixture';
  upgrade: string;
  name: string;
  installLeaf: string;
  appId: string;
}
export const MSI_PRODUCT_IDENTITY: Readonly<MsiIdentity> = Object.freeze({
  scope: 'product',
  upgrade: MSI_UPGRADE_CODE,
  name: 'AIbrowse',
  installLeaf: 'AIbrowse',
  appId: 'com.aibrowse.desktop',
});
export function createMsiFixtureIdentity(): MsiIdentity {
  const upgrade = randomUUID().toUpperCase();
  const suffix = upgrade.slice(0, 8).toLowerCase();
  return {
    scope: 'fixture',
    upgrade,
    name: `AIbrowse MSI Fixture ${suffix}`,
    installLeaf: `AIbrowse 安装 中文 ${suffix}`,
    appId: `com.aibrowse.fixture.${suffix}`,
  };
}
export function checkMsiIdentity(identity: MsiIdentity): void {
  if (identity.scope === 'product') {
    if (JSON.stringify(identity) !== JSON.stringify(MSI_PRODUCT_IDENTITY))
      throw new Error('生产安装身份必须固定');
  } else {
    const suffix = identity.upgrade.slice(0, 8).toLowerCase();
    if (
      identity.scope !== 'fixture' ||
      !/^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/u.test(identity.upgrade) ||
      identity.upgrade === MSI_UPGRADE_CODE ||
      identity.name !== `AIbrowse MSI Fixture ${suffix}` ||
      identity.installLeaf !== `AIbrowse 安装 中文 ${suffix}` ||
      identity.appId !== `com.aibrowse.fixture.${suffix}`
    )
      throw new Error('小样安装身份无效');
  }
}
export interface MsiFile {
  path: string;
  bytes: number;
  sha256: string;
}
export function checkedFiles(files: readonly MsiFile[]): readonly MsiFile[] {
  if (files.length === 0 || files.length > 4096) throw new Error('MSI组件数量无效');
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (
      file.path.length > 220 ||
      /[\\:$<>"|?*]/u.test(file.path) ||
      [...file.path].some((character) => character.charCodeAt(0) < 32) ||
      file.path
        .split('/')
        .some(
          (p) =>
            !p ||
            p === '.' ||
            p === '..' ||
            /[. ]$/u.test(p) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p),
        ) ||
      /(?:^|\/)(?:userData|conversations|sources\.db|research\.db|watch\.db|credentials)(?:\/|$)/iu.test(
        file.path,
      ) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error('MSI组件路径或摘要无效');
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error('MSI组件大小写重复');
    names.add(key);
    total += file.bytes;
  }
  for (const name of names) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join('/'))) throw new Error('MSI文件与目录冲突');
      parts.pop();
    }
  }
  if (total > 1024 ** 3 || !names.has('aibrowse.exe')) throw new Error('MSI组件集合无效');
  return files;
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const identifier = (prefix: string, path: string) =>
  prefix + createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 32);
export function componentGuid(upgrade: string, path: string): string {
  const h = createHash('sha256')
    .update(`${upgrade.toUpperCase()}\0${path.toLowerCase()}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}
export function renderMsi(
  files: readonly MsiFile[],
  version: string,
  identity: MsiIdentity = MSI_PRODUCT_IDENTITY,
): string {
  checkedFiles(files);
  checkMsiIdentity(identity);
  const { name, upgrade, installLeaf, appId } = identity;
  if (
    !/^\d{1,3}\.\d{1,3}\.\d{1,5}$/u.test(version) ||
    version.split('.').some((n, i) => Number(n) > (i === 2 ? 65535 : 255)) ||
    !/^[A-F0-9-]{36}$/u.test(upgrade)
  )
    throw new Error('MSI版本无效');
  const dirs = new Map<string, string>();
  dirs.set('', 'INSTALLDIR');
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.set(current, identifier('D', current));
    }
  }
  const directoryXml = [...dirs]
    .filter(([p]) => p)
    .map(([p, id]) => {
      const parts = p.split('/'),
        name = parts.pop()!,
        parent = parts.join('/');
      return `<DirectoryRef Id="${dirs.get(parent)}"><Directory Id="${id}" Name="${xml(name)}"/></DirectoryRef>`;
    })
    .join('\n');
  const components = files
    .map((file) => {
      const parent = file.path.split('/').slice(0, -1).join('/');
      const shortcut =
        file.path === 'AIbrowse.exe'
          ? `<Shortcut Id="StartShortcut" Directory="ProgramMenuFolder" Name="${name}" Advertise="yes" WorkingDirectory="INSTALLDIR" Icon="AppIcon.exe"><ShortcutProperty Key="System.AppUserModel.ID" Value="${appId}"/></Shortcut><Shortcut Id="DesktopShortcut" Directory="DesktopFolder" Name="${name}" Advertise="yes" WorkingDirectory="INSTALLDIR" Icon="AppIcon.exe"><ShortcutProperty Key="System.AppUserModel.ID" Value="${appId}"/></Shortcut>`
          : '';
      const folders =
        file.path === 'AIbrowse.exe'
          ? [...dirs.values()]
              .map((id) => `<RemoveFolder Id="R${id}" Directory="${id}" On="uninstall"/>`)
              .join('')
          : '';
      const component = identifier('C', file.path);
      const locator =
        file.path === 'AIbrowse.exe'
          ? `<RegistryValue Id="InstallLocationLocator" Root="HKLM" Key="Software\\AIbrowse\\Installer\\${upgrade}\\Products\\[ProductCode]" Name="InstallLocation" Type="string" Value="[INSTALLDIR]"/>`
          : '';
      return `<DirectoryRef Id="${dirs.get(parent)}"><Component Id="${component}" Guid="${componentGuid(upgrade, file.path)}" Win64="yes"><File Id="${identifier('F', file.path)}" Source="$(var.Payload)\\${xml(file.path.replaceAll('/', '\\'))}" KeyPath="yes">${shortcut}</File>${locator}${folders}</Component></DirectoryRef>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
<Product Id="${randomUUID().toUpperCase()}" Name="${name}" Manufacturer="AIbrowse" Version="${version}" Language="2052" Codepage="65001" UpgradeCode="${upgrade}">
<Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"/>
<MediaTemplate EmbedCab="yes"/>
<Icon Id="AppIcon.exe" SourceFile="$(var.Icon)"/>
<Property Id="ARPPRODUCTICON" Value="AppIcon.exe"/>
<MajorUpgrade Schedule="afterInstallInitialize" AllowSameVersionUpgrades="yes" DowngradeErrorMessage="已安装较新版本，请保留当前程序。"/>
<Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable"/>
<Property Id="MSIDISABLERMRESTART" Value="1"/>
<Property Id="REBOOT" Value="ReallySuppress"/>
<Property Id="ARPNOMODIFY" Value="1"/>
<Property Id="ARPNOREPAIR" Value="1"/>
<Property Id="DISABLEADVTSHORTCUTS" Value="1"/>
<Property Id="REGISTEREDINSTALLDIR"><RegistrySearch Id="RegisteredInstallLocation" Root="HKLM" Key="Software\\AIbrowse\\Installer\\${upgrade}\\Products\\[ProductCode]" Name="InstallLocation" Type="raw" Win64="yes"/></Property>
<SetProperty Id="INSTALLDIR" Value="[REGISTEREDINSTALLDIR]" Before="CostFinalize" Sequence="execute">Installed AND REMOVE AND REGISTEREDINSTALLDIR</SetProperty>
<SetProperty Id="ARPINSTALLLOCATION" Value="[INSTALLDIR]" After="CostFinalize" Sequence="execute">NOT REMOVE</SetProperty>
<Condition Message="需要64位Windows。">VersionNT64</Condition>
<Condition Message="安装、升级和卸载需要管理员批准全机安装。">ALLUSERS = 1 AND NOT MSIINSTALLPERUSER AND Privileged</Condition>
<Condition Message="不支持安装转换或补丁。">NOT TRANSFORMS AND NOT PATCH</Condition>
<Condition Message="快捷方式必须保持普通启动，不执行按需安装。">DISABLEADVTSHORTCUTS = 1</Condition>
<Condition Message="系统禁用回滚，不能安全安装。">NOT RollbackDisabled AND NOT DISABLEROLLBACK</Condition>
<Condition Message="安装目录定位信息缺失，未修改文件。">NOT (Installed AND REMOVE) OR REGISTEREDINSTALLDIR</Condition>
<Binary Id="AdmissionGuard" SourceFile="$(var.Guard)"/>
<CustomAction Id="CheckInstall" BinaryKey="AdmissionGuard" ExeCommand="install &quot;[INSTALLDIR].&quot; &quot;[ProductCode]&quot; &quot;[DesktopFolder].&quot; &quot;[ProgramMenuFolder].&quot;" Execute="immediate" Return="check" Impersonate="yes"/>
<CustomAction Id="CheckRemove" BinaryKey="AdmissionGuard" ExeCommand="remove &quot;[INSTALLDIR].&quot; &quot;[ProductCode]&quot; &quot;[DesktopFolder].&quot; &quot;[ProgramMenuFolder].&quot;" Execute="immediate" Return="check" Impersonate="yes"/>
<CustomAction Id="RejectInUse" Error="文件正被使用，安装事务已取消。请正常退出应用后重试。"/>
<CustomAction Id="RejectAdministrativeInstall" Error="不支持管理安装。"/>
<AdminExecuteSequence><Custom Action="RejectAdministrativeInstall" Before="CostInitialize">1</Custom></AdminExecuteSequence>
<InstallExecuteSequence>
<Custom Action="CheckInstall" Before="InstallValidate">NOT REMOVE</Custom>
<Custom Action="CheckRemove" Before="InstallValidate">REMOVE</Custom>
<InstallExecute After="PublishProduct"/>
<Custom Action="RejectInUse" After="InstallExecute">ReplacedInUseFiles</Custom>
</InstallExecuteSequence>
<Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="ProgramFiles64Folder"><Directory Id="INSTALLDIR" Name="${installLeaf}"/></Directory><Directory Id="DesktopFolder"/><Directory Id="ProgramMenuFolder"/></Directory>
<Feature Id="ProductFeature" Title="AIbrowse" Level="1" Absent="disallow">${files.map((f) => `<ComponentRef Id="${identifier('C', f.path)}"/>`).join('')}</Feature>
${directoryXml}
${components}
</Product></Wix>\n`;
}
