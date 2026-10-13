/** A color seed is data, never a CSS expression or native window option. */
export type ThemeColor = string | null;

export interface ThemePalette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceHover: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly brand: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly chrome: string;
  readonly toolbar: string;
  readonly activeTab: string;
}

export const THEME_COLOR_PRESETS: readonly Readonly<{
  id: string;
  label: string;
  color: ThemeColor;
}>[] = Object.freeze(
  [
    { id: 'default', label: '默认', color: null },
    { id: 'blue', label: '晴空蓝', color: '#1a73e8' },
    { id: 'slate', label: '石墨灰', color: '#5f6368' },
    { id: 'indigo', label: '靛蓝', color: '#3f51b5' },
    { id: 'cyan', label: '湖水青', color: '#00838f' },
    { id: 'teal', label: '松石绿', color: '#00796b' },
    { id: 'green', label: '森林绿', color: '#388e3c' },
    { id: 'olive', label: '橄榄绿', color: '#6b7042' },
    { id: 'gold', label: '麦穗金', color: '#a67c00' },
    { id: 'orange', label: '落日橙', color: '#d56524' },
    { id: 'brown', label: '暖棕', color: '#8d6e63' },
    { id: 'rose', label: '玫瑰红', color: '#c2185b' },
    { id: 'coral', label: '珊瑚红', color: '#c44545' },
    { id: 'plum', label: '梅子紫', color: '#8e4585' },
    { id: 'purple', label: '薰衣草紫', color: '#7e57c2' },
    { id: 'pink', label: '樱花粉', color: '#c66b96' },
  ].map((preset) => Object.freeze(preset)),
);

const LIGHT: ThemePalette = Object.freeze({
  background: '#f4f5f8',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceHover: '#eceef3',
  border: '#e0e4eb',
  borderStrong: '#c6cdd9',
  text: '#222b3d',
  muted: '#5d697e',
  accent: '#eaf0fd',
  brand: '#3d5faa',
  primary: '#3d5faa',
  onPrimary: '#ffffff',
  chrome: '#f4f5f8',
  toolbar: '#f4f5f8',
  activeTab: '#ffffff',
});
const DARK: ThemePalette = Object.freeze({
  background: '#171a20',
  surface: '#20242c',
  surfaceRaised: '#282d37',
  surfaceHover: '#2d3340',
  border: '#353c48',
  borderStrong: '#515e73',
  text: '#e7ebf2',
  muted: '#a4afc2',
  accent: '#2b3854',
  brand: '#a9c1ff',
  primary: '#86a6f1',
  onPrimary: '#111b32',
  chrome: '#171a20',
  toolbar: '#171a20',
  activeTab: '#20242c',
});

export function isThemeColor(value: unknown): value is ThemeColor {
  return value === null || (typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value));
}

export function normalizeThemeColor(value: unknown): ThemeColor {
  return typeof value === 'string' && isThemeColor(value) ? value.toLowerCase() : null;
}

type Rgb = readonly [number, number, number];
function rgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function mix(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  return `#${a
    .map((v, i) =>
      Math.round(v * (1 - amount) + b[i]! * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
function luminance(hex: string): number {
  const linear = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

/** Relative luminance contrast for opaque six-digit sRGB colors. */
export function colorContrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readable(
  seed: string,
  backgrounds: readonly string[],
  target: string,
  minimum: number,
): string {
  // Test the actual rounded RGB bytes used by CSS and the native caption controls.
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(seed, target, step / 100);
    if (backgrounds.every((background) => colorContrast(candidate, background) >= minimum))
      return candidate;
  }
  return target;
}

export function createThemePalette(color: ThemeColor, dark: boolean): ThemePalette {
  const seed = normalizeThemeColor(color);
  const defaults = dark ? DARK : LIGHT;
  if (seed === null) return defaults;
  const background = mix(seed, defaults.background, 0.965);
  const surface = mix(seed, defaults.surface, dark ? 0.965 : 0.992);
  const surfaceRaised = mix(seed, defaults.surfaceRaised, dark ? 0.965 : 0.992);
  const surfaceHover = mix(seed, defaults.surfaceHover, 0.92);
  const chrome = mix(seed, dark ? '#14151b' : '#ffffff', 0.85);
  const toolbar = mix(seed, dark ? '#20242c' : '#ffffff', dark ? 0.9 : 0.94);
  const activeTab = toolbar;
  const accent = mix(seed, dark ? '#20242c' : '#ffffff', dark ? 0.77 : 0.86);
  const backgrounds = [
    background,
    surface,
    surfaceRaised,
    surfaceHover,
    chrome,
    toolbar,
    activeTab,
    accent,
  ];
  const target = dark ? '#ffffff' : '#000000';
  const primary = readable(seed, backgrounds, target, 4.5);
  const text = readable(defaults.text, backgrounds, target, 4.5);
  const muted = readable(defaults.muted, backgrounds, target, 4.5);
  const onPrimary =
    colorContrast(primary, '#ffffff') >= colorContrast(primary, '#000000') ? '#ffffff' : '#000000';
  return {
    background,
    surface,
    surfaceRaised,
    surfaceHover,
    border: mix(seed, defaults.border, 0.9),
    borderStrong: readable(mix(seed, defaults.borderStrong, 0.5), backgrounds, target, 3),
    text,
    muted,
    accent,
    brand: primary,
    primary,
    onPrimary,
    chrome,
    toolbar,
    activeTab,
  };
}

const CSS_TOKENS = {
  background: '--bg',
  surface: '--surface',
  surfaceRaised: '--surface-raised',
  surfaceHover: '--surface-hover',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  muted: '--muted',
  accent: '--accent',
  brand: '--brand',
  primary: '--primary',
  onPrimary: '--on-primary',
  chrome: '--chrome-bg',
  toolbar: '--toolbar-bg',
  activeTab: '--active-tab-bg',
} as const satisfies Record<keyof ThemePalette, string>;

export function createThemeCssVariables(color: ThemeColor): Readonly<Record<string, string>> {
  const light = createThemePalette(color, false);
  const dark = createThemePalette(color, true);
  return Object.fromEntries(
    (Object.keys(CSS_TOKENS) as (keyof ThemePalette)[]).map((key) => [
      CSS_TOKENS[key],
      `light-dark(${light[key]}, ${dark[key]})`,
    ]),
  );
}
