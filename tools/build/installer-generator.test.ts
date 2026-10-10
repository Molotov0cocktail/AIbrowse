import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertSafeInstallerTemplate,
  createInstallerOwnedManifest,
  renderInstallerBinding,
} from './installer-generator';

const hash = (value: string): string => value.repeat(64);

describe('safe installer generator', () => {
  it('生成排序唯一的正向owned payload绑定', () => {
    const manifest = createInstallerOwnedManifest([
      { path: 'AIbrowse.exe', bytes: 10, sha256: hash('a') },
      { path: 'resources/app.asar', bytes: 20, sha256: hash('b') },
    ]);
    expect(manifest.version).toBe(1);
    expect(renderInstallerBinding(manifest)).toMatch(
      /AIBROWSE_OWNED_MANIFEST_SHA256 "[0-9a-f]{64}"/u,
    );
    expect(Object.isFrozen(manifest.files[0])).toBe(true);
  });

  it.each(['../escape', 'C:/outside', '/absolute', 'a\\b', 'a:b', 'a//b'])(
    '拒绝路径注入 %s',
    (path) => {
      expect(() => createInstallerOwnedManifest([{ path, bytes: 1, sha256: hash('a') }])).toThrow();
    },
  );

  it('拒绝重复、乱序、空集、非法长度和摘要', () => {
    expect(() => createInstallerOwnedManifest([])).toThrow();
    expect(() =>
      createInstallerOwnedManifest([
        { path: 'b', bytes: 1, sha256: hash('a') },
        { path: 'a', bytes: 1, sha256: hash('b') },
      ]),
    ).toThrow();
    expect(() =>
      createInstallerOwnedManifest([{ path: 'a', bytes: 0, sha256: hash('a') }]),
    ).toThrow();
    expect(() =>
      createInstallerOwnedManifest([{ path: 'a', bytes: 1, sha256: 'A'.repeat(64) }]),
    ).toThrow();
  });

  it('自有脚本必须具备闭合事务动作且禁止递归删除与通用shell', () => {
    const safe = [
      '!insertmacro AIBROWSE_REJECT_DELETE_APP_DATA',
      ...['recover', 'inspect-new', 'commit', 'finalize'].map(
        (action) => `!insertmacro AIBROWSE_HELPER "${action}"`,
      ),
      'installer-helper.exe" "uninstall"',
    ].join('\n');
    expect(() => assertSafeInstallerTemplate(safe)).not.toThrow();
    expect(() => assertSafeInstallerTemplate(`${safe}\nRMDir /r $INSTDIR`)).toThrow('递归');
    expect(() => assertSafeInstallerTemplate(`${safe}\npowershell.exe`)).toThrow('命令');
    const template = readFileSync('tools/build/installer-template.nsi', 'utf8');
    expect(() => assertSafeInstallerTemplate(template)).not.toThrow();
    expect(template).not.toContain('$APPDATA');
    expect(template).not.toContain('uninstaller.nsh');
    expect(template).not.toContain('installSection.nsh');
    const helper = readFileSync('tools/build/installer-helper.cs', 'utf8');
    expect(helper).toContain('__AIBROWSE_MANIFEST_SHA256__');
    expect(helper).toContain('FileAttributes.ReparsePoint');
    expect(helper).toContain('tree.Files.SetEquals(expected)');
    expect(helper).not.toMatch(/Directory\.Delete\([^\n]+,\s*true\)/u);
    expect(helper).not.toMatch(/Process\.(?:Start|Kill)/u);
    for (const state of ['prepared', 'old-moved', 'new-published', 'finalizing']) {
      expect(helper).toContain(`"${state}"`);
    }
    expect(helper).toContain('RestoreOld(root, old, journal, hadOld)');
  });
});
