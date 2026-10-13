import { isThemeColor, normalizeThemeColor, type ThemeColor } from '../../../shared/theme-colors';

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'aibrowse.appearance';
export const THEME_COLOR_STORAGE_KEY = 'aibrowse.themeColor';

interface AppearanceStorageHost {
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

export function parseAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readAppearance(host: AppearanceStorageHost): Appearance {
  try {
    return parseAppearance(host.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveAppearance(host: AppearanceStorageHost, value: unknown): Appearance {
  const appearance = parseAppearance(value);
  try {
    host.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
    return appearance;
  } catch {
    return 'system';
  }
}

export function readThemeColor(host: AppearanceStorageHost): ThemeColor {
  try {
    return normalizeThemeColor(host.localStorage.getItem(THEME_COLOR_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveThemeColor(
  host: AppearanceStorageHost,
  value: unknown,
): { ok: true; value: ThemeColor } | { ok: false } {
  if (!isThemeColor(value)) return { ok: false };
  const color = normalizeThemeColor(value);
  try {
    host.localStorage.setItem(THEME_COLOR_STORAGE_KEY, color ?? 'default');
    return { ok: true, value: color };
  } catch {
    return { ok: false };
  }
}
