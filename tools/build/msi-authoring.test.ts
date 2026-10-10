import { describe, expect, it } from 'vitest';
import {
  checkedFiles,
  componentGuid,
  MSI_UPGRADE_CODE,
  MSI_PRODUCT_IDENTITY,
  createMsiFixtureIdentity,
  renderMsi,
} from './msi-authoring.ts';
import type { MsiFile } from './msi-authoring.ts';
const entry = (path: string): MsiFile => ({ path, bytes: 12, sha256: 'a'.repeat(64) });
describe('Windows Installer正向组件归属', () => {
  it('小样身份独立且生产目标/shortcut身份不可改为任意管理员目标', () => {
    const identity = createMsiFixtureIdentity();
    const xml = renderMsi([entry('AIbrowse.exe')], '0.1.0', identity);
    expect(identity.upgrade).not.toBe(MSI_UPGRADE_CODE);
    expect(xml).toContain(`Name="${identity.installLeaf}"`);
    expect(xml).toContain(`Value="${identity.appId}"`);
    expect(() =>
      renderMsi([entry('AIbrowse.exe')], '0.1.0', {
        ...MSI_PRODUCT_IDENTITY,
        installLeaf: '../Windows',
      }),
    ).toThrow();
    expect(() =>
      renderMsi([entry('AIbrowse.exe')], '0.1.0', { ...identity, installLeaf: 'AIbrowse' }),
    ).toThrow();
    expect(() =>
      renderMsi([entry('AIbrowse.exe')], '0.1.0', { ...identity, name: 'AIbrowse' }),
    ).toThrow();
    expect(() =>
      renderMsi([entry('AIbrowse.exe')], '0.1.0', { ...identity, appId: 'com.aibrowse.desktop' }),
    ).toThrow();
  });
  it('当前全机方案固定受保护ProgramFiles目录及machine scope', () => {
    const xml = renderMsi([entry('AIbrowse.exe')], '0.1.0');
    expect(xml).toContain('InstallScope="perMachine"');
    expect(xml).toContain('Id="ProgramFiles64Folder"');
    expect(xml).not.toContain('LocalAppDataFolder');
    expect(xml).toContain('ALLUSERS = 1 AND NOT MSIINSTALLPERUSER');
    expect(xml).toContain('Root="HKLM"');
    expect(xml).not.toContain('Root="HKCU"');
    expect(xml).not.toContain('Id="RProgramsDir"');
    expect(xml).toContain('NOT TRANSFORMS AND NOT PATCH');
    expect(xml).toContain('&quot;[DesktopFolder].&quot; &quot;[ProgramMenuFolder].&quot;');
    expect(xml).toContain('<Property Id="DISABLEADVTSHORTCUTS" Value="1"/>');
    expect(xml).toMatch(/<File[^>]+KeyPath="yes"/u);
    expect(xml).toContain(
      '<CustomAction Id="RejectAdministrativeInstall" Error="不支持管理安装。"/>',
    );
    expect(xml).toContain(
      '<AdminExecuteSequence><Custom Action="RejectAdministrativeInstall" Before="CostInitialize">1</Custom></AdminExecuteSequence>',
    );
    expect(xml.match(/<AdminExecuteSequence>/gu)).toHaveLength(1);
  });

  it('管理安装在任何目标目录计算或写入前经Type19无条件拒绝', () => {
    const xml = renderMsi([entry('AIbrowse.exe')], '0.1.0');
    const action = xml.indexOf('Id="RejectAdministrativeInstall" Error=');
    const sequence = xml.indexOf('<AdminExecuteSequence>');
    const cost = xml.indexOf('Before="CostInitialize">1</Custom>');
    expect(action).toBeGreaterThan(0);
    expect(sequence).toBeGreaterThan(action);
    expect(cost).toBeGreaterThan(sequence);
    expect(xml).not.toContain('<AdminExecuteSequence><Custom Action="CheckInstall"');
    expect(xml).not.toContain('<AdminExecuteSequence><Custom Action="CheckRemove"');
  });
  it('安装和卸载准入先于平台文件占用检查且保留事务边界', () => {
    const xml = renderMsi([entry('AIbrowse.exe')], '0.1.0');
    expect(xml).toContain(
      '<Custom Action="CheckInstall" Before="InstallValidate">NOT REMOVE</Custom>',
    );
    expect(xml).toContain('<Custom Action="CheckRemove" Before="InstallValidate">REMOVE</Custom>');
    expect(xml).toContain('Schedule="afterInstallInitialize"');
  });
  it.each([
    '../escape',
    'C:/escape',
    'foo\\bar',
    'foo/../AIbrowse.exe',
    'sources.db',
    'safe/watch.db',
    'userData/session.json',
    'foo/NUL.txt',
    'foo./a',
    'foo/a ',
    'x:stream',
    'x\u0000y',
  ])('拒绝不安全组件 %s', (path) => {
    expect(() => checkedFiles([entry('AIbrowse.exe'), entry(path)])).toThrow();
  });
  it('拒绝大小写别名和文件/目录前缀碰撞', () => {
    expect(() => checkedFiles([entry('AIbrowse.exe'), entry('AIBROWSE.exe')])).toThrow();
    expect(() =>
      checkedFiles([entry('AIbrowse.exe'), entry('resources'), entry('resources/a')]),
    ).toThrow();
  });
  it('组件标识跨版本稳定且不能跨产品混用', () => {
    expect(componentGuid(MSI_UPGRADE_CODE, 'AIbrowse.exe')).toBe(
      componentGuid(MSI_UPGRADE_CODE, 'aibrowse.EXE'),
    );
    expect(componentGuid(MSI_UPGRADE_CODE, 'AIbrowse.exe')).not.toBe(
      componentGuid('C38BE091-2BBD-4CB1-BEF2-11328955141B', 'AIbrowse.exe'),
    );
    const first = renderMsi([entry('AIbrowse.exe')], '0.1.0'),
      next = renderMsi([entry('AIbrowse.exe')], '0.1.0');
    expect(first.match(/<Product Id="([^"]+)"/u)?.[1]).not.toBe(
      next.match(/<Product Id="([^"]+)"/u)?.[1],
    );
    expect(first.match(/<Component[^>]+Guid="([^"]+)"/u)?.[1]).toBe(
      next.match(/<Component[^>]+Guid="([^"]+)"/u)?.[1],
    );
  });
  it('拒绝超出Windows Installer版本范围', () => {
    for (const version of ['256.0.0', '0.256.0', '0.0.65536', '0.1.0-beta'])
      expect(() => renderMsi([entry('AIbrowse.exe')], version)).toThrow();
  });
  it('由主文件组件管理每产品目录候选并保留稳定注册keypath', () => {
    const xml = renderMsi([entry('AIbrowse.exe'), entry('resources/a.txt')], '0.1.0');
    const locator = `<RegistryValue Id="InstallLocationLocator" Root="HKLM" Key="Software\\AIbrowse\\Installer\\${MSI_UPGRADE_CODE}\\Products\\[ProductCode]" Name="InstallLocation" Type="string" Value="[INSTALLDIR]"/>`;
    const mainComponent = [...xml.matchAll(/<Component\b[^>]*>[^]*?<\/Component>/gu)]
      .map((match) => match[0])
      .find((component) => component.includes('\\AIbrowse.exe"'));
    expect(mainComponent).toContain(locator);
    expect(mainComponent?.match(/KeyPath="yes"/gu)).toHaveLength(1);
    expect(xml.match(/Id="InstallLocationLocator"/gu)).toHaveLength(1);
    expect(xml.match(/<RegistryValue\b/gu)).toHaveLength(1);
  });
  it('注册卸载从MSI自有候选定位并拒绝缺失，不假定系统ARP键存在', () => {
    const xml = renderMsi([entry('AIbrowse.exe')], '0.1.0');
    expect(xml).toContain(
      `<RegistrySearch Id="RegisteredInstallLocation" Root="HKLM" Key="Software\\AIbrowse\\Installer\\${MSI_UPGRADE_CODE}\\Products\\[ProductCode]" Name="InstallLocation" Type="raw" Win64="yes"/>`,
    );
    expect(xml).not.toContain('CurrentVersion\\Uninstall');
    expect(xml).toContain(
      'Before="CostFinalize" Sequence="execute">Installed AND REMOVE AND REGISTEREDINSTALLDIR</SetProperty>',
    );
    expect(xml).toContain('NOT (Installed AND REMOVE) OR REGISTEREDINSTALLDIR</Condition>');
  });
  it('XML字符转义且删除表仅有空目录规则', () => {
    const xml = renderMsi([entry('AIbrowse.exe'), entry('中文 & 空格/file.txt')], '0.1.0');
    expect(xml).toContain('中文 &amp; 空格');
    expect(xml).not.toMatch(/<RemoveFile\b|<RemoveFolder[^>]+On="install"/u);
    expect(xml.match(/<File[^>]+KeyPath="yes"/gu)).toHaveLength(2);
    expect(xml).toContain('Schedule="afterInstallInitialize"');
    expect(xml).toContain(
      '<Custom Action="RejectInUse" After="InstallExecute">ReplacedInUseFiles</Custom>',
    );
  });
});
