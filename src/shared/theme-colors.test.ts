import { describe, expect, it } from 'vitest';
import {
  THEME_COLOR_PRESETS,
  colorContrast,
  createThemeCssVariables,
  createThemePalette,
  isThemeColor,
  normalizeThemeColor,
} from './theme-colors';

it('主题色仅接受默认或完整六位HEX，不执行对象转换或接纳CSS', () => {
  expect(isThemeColor(null)).toBe(true);
  expect(normalizeThemeColor('#AbC123')).toBe('#abc123');
  for (const value of [
    undefined,
    '',
    '#abc',
    '#12345678',
    'red',
    ' #123456',
    '#123456 ',
    'url(https://example.com)',
    '#123456;--text:white',
    false,
    1,
    {
      toString: () => {
        throw new Error('不得转换对象');
      },
    },
  ]) {
    expect(isThemeColor(value)).toBe(false);
    expect(normalizeThemeColor(value)).toBeNull();
  }
});

it('默认色保留既有标题栏和强调色，色卡标识与基色唯一', () => {
  expect(createThemePalette(null, false)).toMatchObject({
    background: '#f4f5f8',
    chrome: '#f4f5f8',
    text: '#222b3d',
    primary: '#3d5faa',
  });
  expect(createThemePalette(null, true)).toMatchObject({
    background: '#171a20',
    chrome: '#171a20',
    text: '#e7ebf2',
    primary: '#86a6f1',
  });
  expect(THEME_COLOR_PRESETS).toHaveLength(16);
  expect(new Set(THEME_COLOR_PRESETS.map((p) => p.id)).size).toBe(16);
  expect(new Set(THEME_COLOR_PRESETS.map((p) => p.color)).size).toBe(16);
  expect(THEME_COLOR_PRESETS.every((p) => isThemeColor(p.color))).toBe(true);
});

it('对比度计算以标准黑白端点和已知中灰为锚点', () => {
  expect(colorContrast('#000000', '#ffffff')).toBeCloseTo(21, 10);
  expect(colorContrast('#ffffff', '#ffffff')).toBe(1);
  expect(colorContrast('#777777', '#ffffff')).toBeCloseTo(4.478, 3);
  expect(colorContrast('#777777', '#000000')).toBeCloseTo(4.689, 3);
});

it('默认浅色次级说明在悬停和选中背景上保持可读', () => {
  const palette = createThemePalette(null, false);
  expect(colorContrast(palette.muted, palette.surfaceHover)).toBeGreaterThanOrEqual(4.5);
  expect(colorContrast(palette.muted, palette.accent)).toBeGreaterThanOrEqual(4.5);
});

describe('任意基色在两种模式下仍生成可读的文字与选择标记', () => {
  const seeds = [
    ...THEME_COLOR_PRESETS.flatMap((p) => (p.color === null ? [] : [p.color])),
    '#000000',
    '#ffffff',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ffff00',
    '#00ffff',
    '#ff00ff',
    '#fefefe',
    '#010101',
    '#123456',
  ];
  for (const seed of seeds)
    for (const dark of [false, true]) {
      it(`${seed} / ${dark ? '深' : '浅'}`, () => {
        const p = createThemePalette(seed, dark);
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
        for (const color of Object.values(p)) expect(color).toMatch(/^#[0-9a-f]{6}$/u);
        for (const background of backgrounds) {
          expect(colorContrast(p.text, background)).toBeGreaterThanOrEqual(4.5);
          expect(colorContrast(p.muted, background)).toBeGreaterThanOrEqual(4.5);
          expect(colorContrast(p.brand, background)).toBeGreaterThanOrEqual(4.5);
          expect(colorContrast(p.primary, background)).toBeGreaterThanOrEqual(4.5);
          expect(colorContrast(p.borderStrong, background)).toBeGreaterThanOrEqual(3);
        }
        expect(colorContrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
      });
    }
});

it('CSS只输出固定变量与合法浅深色对，无语义色覆盖', () => {
  const vars = createThemeCssVariables('#7e57c2');
  expect(Object.keys(vars).sort()).toEqual(
    [
      '--accent',
      '--active-tab-bg',
      '--bg',
      '--border',
      '--border-strong',
      '--brand',
      '--chrome-bg',
      '--muted',
      '--on-primary',
      '--primary',
      '--surface',
      '--surface-hover',
      '--surface-raised',
      '--text',
      '--toolbar-bg',
    ].sort(),
  );
  for (const value of Object.values(vars))
    expect(value).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/u);
  expect(createThemeCssVariables('#abc; color:red')).toEqual(createThemeCssVariables(null));
});
