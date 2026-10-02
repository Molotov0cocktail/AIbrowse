import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSafetyDirectories, readDirectoryMetadata } from './safety-preflight';
import type { SafetyDirectories } from './safety-preflight';

const plan: SafetyDirectories = {
  workParent: 'D:\\synthetic-work',
  artifactRoot: 'D:\\repo\\log\\synthetic',
  repository: 'D:\\repo',
  userProfile: 'C:\\Users\\synthetic',
  appData: 'C:\\Users\\synthetic\\AppData\\Roaming',
  localAppData: 'C:\\Users\\synthetic\\AppData\\Local',
};

describe('当前账户合成资源测量的只读安全预检', () => {
  it('只给出原生检查入口，不把当前账户授权、目录元数据或pins等同凭据零访问', () => {
    const metadata = vi.fn(() => 'directory' as const);
    const report = inspectSafetyDirectories(plan, metadata);
    expect(report.status).toBe('ready-for-native-checks');
    expect(report.sameAccountFileSandbox).toBe(false);
    expect(report.earlyNativeCredentialAccess).toBe('not-proven');
    expect(report.nativePinsRequired).toBe(true);
    expect(JSON.stringify(report)).not.toContain('C:');
    expect(JSON.stringify(report)).not.toContain('D:');
  });

  it.each([
    'C:\\Users\\synthetic',
    'c:\\users\\SYNTHETIC\\AppData\\Local\\AIbrowse\\S5',
    'C:\\Users',
    'D:\\repo',
    'D:\\repo\\log\\fake',
    'D:\\repo\\log\\synthetic',
  ])('拒绝与私有目录、仓库或结果目录互相包含：%s', (workParent) => {
    const metadata = vi.fn(() => 'directory' as const);
    expect(inspectSafetyDirectories({ ...plan, workParent }, metadata).status).toBe('blocked');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('不因相同文本前缀错误拒绝不同目录', () => {
    expect(
      inspectSafetyDirectories({ ...plan, workParent: 'D:\\repo-other' }, () => 'directory').status,
    ).toBe('ready-for-native-checks');
  });

  it.each([
    'D:relative',
    '\\\\host\\share',
    '\\\\?\\D:\\work',
    'D:\\a\\..\\work',
    'D:\\work.',
    'D:\\work ',
    'D:\\work:stream',
    'D:\\PROFIL~1',
    'D:\\NUL',
    'D:\\work\\',
    'D:\\a\\\\work',
  ])('拒绝路径别名、设备及不明确解析：%s', (workParent) => {
    const metadata = vi.fn(() => 'directory' as const);
    expect(inspectSafetyDirectories({ ...plan, workParent }, metadata).status).toBe('blocked');
    expect(metadata).not.toHaveBeenCalled();
  });

  it.each(['link', 'other', 'missing', 'unavailable'] as const)(
    '祖先为%s时在进入其后代前拒绝',
    (state) => {
      const visited: string[] = [];
      const report = inspectSafetyDirectories(
        { ...plan, workParent: 'D:\\work\\child' },
        (path) => {
          visited.push(path);
          return path === 'D:\\work' ? state : 'directory';
        },
      );
      expect(report.status).toBe('blocked');
      expect(visited).not.toContain('D:\\work\\child');
    },
  );

  it('拒绝将报告写入原用户凭据域', () => {
    const metadata = vi.fn(() => 'directory' as const);
    expect(
      inspectSafetyDirectories({ ...plan, artifactRoot: plan.localAppData }, metadata).status,
    ).toBe('blocked');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('私有路径缺失只是元数据，不产生无凭据读取的证明', () => {
    const report = inspectSafetyDirectories(plan, (path) =>
      path.startsWith('C:') ? 'missing' : 'directory',
    );
    expect(report.privateRootPresence).toEqual(['missing', 'missing', 'missing']);
    expect(report.earlyNativeCredentialAccess).toBe('not-proven');
  });
});

describe('仅在自建合成目录上的实际元数据反例', () => {
  const owned: string[] = [];
  afterEach(() => {
    for (const path of owned.splice(0)) {
      expect(resolve(path).startsWith(resolve(tmpdir()) + sep + 'aibrowse-safety-')).toBe(true);
      expect(readDirectoryMetadata(path)).toBe('directory');
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('区分目录、合成文件、缺失路径和指向合成目录的junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-safety-'));
    owned.push(root);
    const target = join(root, 'target');
    const link = join(root, 'alias');
    mkdirSync(target);
    writeFileSync(join(root, 'synthetic-file'), 'synthetic-only');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(readDirectoryMetadata(target)).toBe('directory');
    expect(readDirectoryMetadata(join(root, 'synthetic-file'))).toBe('other');
    expect(readDirectoryMetadata(join(root, 'missing'))).toBe('missing');
    expect(readDirectoryMetadata(link)).toBe('link');
  });
});
