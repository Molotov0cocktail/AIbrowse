import { describe, expect, it } from 'vitest';
import { validateCoreIpcPayload } from '../main/security/core-ipc-payload';
import { IPC } from './types/ipc';
import {
  createThemeCssVariables,
  createThemePalette,
  isThemeColor,
  normalizeThemeColor,
} from './theme-colors';

// Independent oracle: decode integer channels and linearize each channel directly.
function contrast(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const packed = Number(`0x${hex.slice(1)}`);
    const component = (shift: number): number => {
      const channel = ((packed >>> shift) & 255) / 255;
      return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    };
    return component(16) * 0.2126 + component(8) * 0.7152 + component(0) * 0.0722;
  };
  const a = luminance(first);
  const b = luminance(second);
  return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

describe('主题色独立边界审核', () => {
  it('尾部换行不是严格六位HEX，也不能通过外观IPC', () => {
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', ' ']) {
      const value = `#123456${suffix}`;
      expect(isThemeColor(value), JSON.stringify(value)).toBe(false);
      expect(normalizeThemeColor(value), JSON.stringify(value)).toBeNull();
      expect(
        validateCoreIpcPayload(IPC.UiAppearance, { appearance: 'dark', themeColor: value }),
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('新旧IPC闭合集合独立；缺省、null与大写HEX有效，额外能力均拒绝', () => {
    for (const appearance of ['light', 'dark', 'system']) {
      expect(validateCoreIpcPayload(IPC.UiAppearance, { appearance })).toBe(true);
      for (const themeColor of [null, '#00FFAA'])
        expect(validateCoreIpcPayload(IPC.UiAppearance, { appearance, themeColor })).toBe(true);
      for (const payload of [
        { appearance, themeColor: undefined },
        { appearance, themeColor: '#00ffaa', color: '#ffffff' },
        { appearance, themeColor: '#00ffaa', height: 90 },
        { appearance, themeColor: '#00ffaa', [Symbol('extra')]: true },
        Object.assign(Object.create({ inherited: true }) as object, {
          appearance,
          themeColor: null,
        }),
      ])
        expect(validateCoreIpcPayload(IPC.UiAppearance, payload)).toBe(false);
    }
  });

  it('729种边界网格颜色的两种模式满足独立对比度oracle', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21);
    const channels = [0, 1, 31, 63, 127, 191, 223, 254, 255];
    let palettes = 0;
    for (const red of channels)
      for (const green of channels)
        for (const blue of channels) {
          const seed = `#${[red, green, blue].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          for (const dark of [false, true]) {
            const p = createThemePalette(seed, dark);
            palettes += 1;
            const backgrounds = [
              p.background,
              p.surface,
              p.surfaceRaised,
              p.surfaceHover,
              p.chrome,
              p.toolbar,
              p.activeTab,
              p.accent,
            ];
            for (const background of backgrounds) {
              for (const foreground of [p.text, p.muted, p.brand, p.primary]) {
                const ratio = contrast(foreground, background);
                if (ratio < 4.5)
                  throw new Error(`${seed}/${dark}/${foreground}/${background}: ${ratio}`);
              }
              if (contrast(p.borderStrong, background) < 3)
                throw new Error(`焦点边界不足: ${seed}/${dark}/${background}`);
            }
            expect(contrast(p.onPrimary, p.primary), `${seed}/${dark}`).toBeGreaterThanOrEqual(4.5);
          }
        }
    expect(palettes).toBe(1458);
  });

  it('默认模式的灰字在悬停和选中背景也保持可读', () => {
    for (const dark of [false, true]) {
      const palette = createThemePalette(null, dark);
      for (const background of [palette.surfaceHover, palette.accent])
        expect(contrast(palette.muted, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('CSS固定闭合色对，无用户表达式或语义颜色写入', () => {
    const css = createThemeCssVariables('#ffff00');
    expect(Object.keys(css)).toHaveLength(15);
    expect(Object.keys(css).some((key) => /danger|warning|success|group/u.test(key))).toBe(false);
    for (const value of Object.values(css))
      expect(value).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/u);
    expect(createThemeCssVariables('#123456; background: url(file:///private)')).toEqual(
      createThemeCssVariables(null),
    );
  });
});
