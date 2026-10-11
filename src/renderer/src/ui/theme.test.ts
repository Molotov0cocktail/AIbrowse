import { describe, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY, parseAppearance, readAppearance, saveAppearance } from './theme';

describe('界面外观偏好', () => {
  it('只接受三种外观，缺失和非白名单输入均跟随系统', () => {
    expect(parseAppearance('light')).toBe('light');
    expect(parseAppearance('dark')).toBe('dark');
    expect(parseAppearance('system')).toBe('system');
    for (const value of [null, undefined, '', 'LIGHT', 'dark ', {}, false, 1]) {
      expect(parseAppearance(value)).toBe('system');
    }
  });

  it('仅从专用键读取，不把其它本地内容作为外观', () => {
    const getItem = vi.fn(() => 'dark');
    expect(readAppearance({ localStorage: { getItem, setItem: vi.fn() } })).toBe('dark');
    expect(getItem).toHaveBeenCalledExactlyOnceWith(APPEARANCE_STORAGE_KEY);
    expect(
      readAppearance({ localStorage: { getItem: () => 'untrusted-value', setItem: vi.fn() } }),
    ).toBe('system');
  });

  it('存储访问器不可用或读取失败时退回系统外观', () => {
    const unavailable = {
      get localStorage(): Storage {
        throw new Error('存储不可用');
      },
    };
    expect(readAppearance(unavailable)).toBe('system');
    expect(
      readAppearance({
        localStorage: {
          getItem: () => {
            throw new Error('读取失败');
          },
          setItem: vi.fn(),
        },
      }),
    ).toBe('system');
  });

  it('持久化只写专用键与白名单值', () => {
    const setItem = vi.fn();
    const host = { localStorage: { getItem: vi.fn(), setItem } };
    expect(saveAppearance(host, 'light')).toBe('light');
    expect(saveAppearance(host, 'dark')).toBe('dark');
    expect(saveAppearance(host, { value: 'dark' })).toBe('system');
    expect(setItem.mock.calls).toEqual([
      [APPEARANCE_STORAGE_KEY, 'light'],
      [APPEARANCE_STORAGE_KEY, 'dark'],
      [APPEARANCE_STORAGE_KEY, 'system'],
    ]);
  });

  it('存储写入或访问器失败时退回系统外观', () => {
    expect(
      saveAppearance(
        {
          localStorage: {
            getItem: vi.fn(),
            setItem: () => {
              throw new Error('写入失败');
            },
          },
        },
        'dark',
      ),
    ).toBe('system');
    expect(
      saveAppearance(
        {
          get localStorage(): Storage {
            throw new Error('存储不可用');
          },
        },
        'light',
      ),
    ).toBe('system');
  });
});
