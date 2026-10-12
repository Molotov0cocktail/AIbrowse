import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrayPreferences } from './tray-preferences';

const roots: string[] = [];
function root() {
  const path = fs.mkdtempSync(join(tmpdir(), 'aibrowse-tray-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe('托盘偏好持久化', () => {
  it('缺省关闭，保存后跨实例恢复且仅含闭合非秘密偏好', () => {
    const path = root();
    const store = new TrayPreferences(path);
    expect(store.getEnabled()).toBe(false);
    expect(store.getLoadError()).toBeNull();
    store.saveEnabled(true);
    expect(JSON.parse(fs.readFileSync(join(path, 'app-preferences.json'), 'utf8'))).toEqual({
      version: 1,
      runInTray: true,
    });
    expect(new TrayPreferences(path).getEnabled()).toBe(true);
    store.saveEnabled(false);
    expect(new TrayPreferences(path).getEnabled()).toBe(false);
  });

  it.each([
    '{',
    'null',
    '[]',
    '{"version":2,"runInTray":true}',
    '{"version":1,"runInTray":"true"}',
    '{"version":1,"runInTray":true,"secret":"untouched"}',
    ' '.repeat(1025),
  ])('损坏、未来或过大文件保留原件并拒绝保存（%#）', (raw) => {
    const path = root();
    const file = join(path, 'app-preferences.json');
    fs.writeFileSync(file, raw);
    const store = new TrayPreferences(path);
    expect(store.getEnabled()).toBe(false);
    expect(store.getLoadError()).toBe('应用偏好无法读取，原文件已保留。');
    expect(() => store.saveEnabled(true)).toThrow('应用偏好无法保存');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('原子替换失败保留磁盘与内存的上次状态并清除临时文件', () => {
    const path = root();
    new TrayPreferences(path).saveEnabled(true);
    const before = fs.readFileSync(join(path, 'app-preferences.json'));
    const store = new TrayPreferences(path, {
      ...fs,
      renameSync: () => {
        throw new Error('private path');
      },
    });
    expect(() => store.saveEnabled(false)).toThrow('应用偏好无法保存');
    expect(store.getEnabled()).toBe(true);
    expect(fs.readFileSync(join(path, 'app-preferences.json'))).toEqual(before);
    expect(fs.readdirSync(path)).toEqual(['app-preferences.json']);
  });

  it('初始化后出现未来配置仍拒绝覆盖', () => {
    const path = root();
    const store = new TrayPreferences(path);
    const raw = '{"version":2,"runInTray":true}';
    fs.writeFileSync(join(path, 'app-preferences.json'), raw);
    expect(() => store.saveEnabled(true)).toThrow('应用偏好无法保存');
    expect(store.getEnabled()).toBe(false);
    expect(fs.readFileSync(join(path, 'app-preferences.json'), 'utf8')).toBe(raw);
  });

  it('写入或同步失败均不发布候选值或泄露底层异常', () => {
    for (const operation of ['writeFileSync', 'fsyncSync'] as const) {
      const path = root();
      new TrayPreferences(path).saveEnabled(true);
      const store = new TrayPreferences(path, {
        ...fs,
        [operation]: () => {
          throw new Error('private-disk-location');
        },
      });
      expect(() => store.saveEnabled(false)).toThrow('应用偏好无法保存，原设置保持不变。');
      expect(store.getEnabled()).toBe(true);
      expect(new TrayPreferences(path).getEnabled()).toBe(true);
      expect(fs.readdirSync(path)).toEqual(['app-preferences.json']);
    }
  });

  it('同名目录拒绝读取与覆盖', () => {
    const path = root();
    const file = join(path, 'app-preferences.json');
    fs.mkdirSync(file);
    const store = new TrayPreferences(path);
    expect(store.getEnabled()).toBe(false);
    expect(store.getLoadError()).not.toBeNull();
    expect(() => store.saveEnabled(true)).toThrow('应用偏好无法保存');
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });
});
