import type { BrowserWindow, NativeTheme } from 'electron';
import type { Appearance } from '../../shared/types/app';
import {
  createThemePalette,
  isThemeColor,
  normalizeThemeColor,
  type ThemeColor,
} from '../../shared/theme-colors';

export function titlebarColors(
  appearance: Appearance,
  systemDark: boolean,
  themeColor: ThemeColor = null,
) {
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark);
  const palette = createThemePalette(themeColor, dark);
  return {
    color: palette.chrome,
    symbolColor: palette.text,
    height: 36,
  };
}

/** Native caption controls retain the normal window lifecycle and accessibility. */
export function installWindowAppearance(
  win: BrowserWindow,
  theme: NativeTheme,
): (appearance: Appearance, themeColor?: ThemeColor) => boolean {
  let appearance: Appearance = 'system';
  let themeColor: ThemeColor = null;
  let closed = false;
  const update = (): boolean => {
    try {
      if (closed || win.isDestroyed()) return false;
      if (process.platform === 'win32')
        win.setTitleBarOverlay(titlebarColors(appearance, theme.shouldUseDarkColors, themeColor));
      return true;
    } catch {
      return false;
    }
  };
  const onTheme = (): void => {
    if (appearance === 'system') update();
  };
  theme.on('updated', onTheme);
  win.once('closed', () => {
    closed = true;
    theme.removeListener('updated', onTheme);
  });
  return (next, nextThemeColor = null) => {
    if (!['system', 'light', 'dark'].includes(next) || !isThemeColor(nextThemeColor)) return false;
    appearance = next;
    themeColor = normalizeThemeColor(nextThemeColor);
    return update();
  };
}
