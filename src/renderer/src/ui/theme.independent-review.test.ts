import { expect, it, vi } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  THEME_COLOR_STORAGE_KEY,
  readAppearance,
  readThemeColor,
  saveAppearance,
  saveThemeColor,
} from './theme';

it('损坏的颜色原文只读降级，不覆盖旧模式或原件；合法写入才替换', () => {
  for (const raw of ['#123456\n', '#123456\u2028', 'url(file:///private)', 'broken']) {
    const values = new Map([
      [THEME_COLOR_STORAGE_KEY, raw],
      [APPEARANCE_STORAGE_KEY, 'dark'],
      ['unrelated', 'preserved'],
    ]);
    const write = vi.fn((key: string, value: string) => values.set(key, value));
    const host = {
      localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: write },
    };
    expect(readThemeColor(host), JSON.stringify(raw)).toBeNull();
    expect(readAppearance(host)).toBe('dark');
    expect(write).not.toHaveBeenCalled();
    expect(values.get(THEME_COLOR_STORAGE_KEY)).toBe(raw);
    expect(saveThemeColor(host, '#AAbbCC')).toEqual({ ok: true, value: '#aabbcc' });
    expect(values.get(THEME_COLOR_STORAGE_KEY)).toBe('#aabbcc');
    expect(values.get(APPEARANCE_STORAGE_KEY)).toBe('dark');
    expect(values.get('unrelated')).toBe('preserved');
  }
});

it('连续保存和失败恢复默认只保留最近持久化颜色；两键和其它数据互不覆盖', () => {
  const values = new Map([
    [THEME_COLOR_STORAGE_KEY, '#123456'],
    [APPEARANCE_STORAGE_KEY, 'system'],
    ['unrelated', 'preserved'],
  ]);
  let writable = true;
  const host = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        if (!writable) throw new Error('quota');
        values.set(key, value);
      },
    },
  };
  expect(saveThemeColor(host, '#FFFFFF')).toEqual({ ok: true, value: '#ffffff' });
  expect(saveAppearance(host, 'light')).toBe('light');
  writable = false;
  expect(saveThemeColor(host, null)).toEqual({ ok: false });
  expect(saveThemeColor(host, '#000000')).toEqual({ ok: false });
  expect(readThemeColor(host)).toBe('#ffffff');
  expect(readAppearance(host)).toBe('light');
  writable = true;
  expect(saveThemeColor(host, null)).toEqual({ ok: true, value: null });
  expect(readThemeColor(host)).toBeNull();
  expect(readAppearance(host)).toBe('light');
  expect(values.get('unrelated')).toBe('preserved');
});
