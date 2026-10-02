import { describe, expect, it } from 'vitest';
import { hasQualificationLaunchArgument } from './launch-mode';

describe('普通构建资格参数拒绝门', () => {
  it.each([
    ['electron.exe', '.', '--aibrowse-watch-resource-qualification'],
    ['electron.exe', 'out/qualification/main/index.js', '--aibrowse-watch-resource-qualification'],
    ['electron.exe', '.', '--aibrowse-watch-resource-qualification=1'],
    ['electron.exe', '.', '--aibrowse-watch-resource-qualification='],
  ])('识别旧启动及显式值参数：%j', (...argv) => {
    expect(hasQualificationLaunchArgument(argv)).toBe(true);
  });
  it.each([
    ['electron.exe', '.'],
    ['electron.exe', '.', '--dev'],
    ['AIbrowse.exe'],
    ['electron.exe', '.', 'https://example.invalid/aibrowse-watch-resource-qualification'],
  ])('保留普通合法启动参数：%j', (...argv) => {
    expect(hasQualificationLaunchArgument(argv)).toBe(false);
  });
});
