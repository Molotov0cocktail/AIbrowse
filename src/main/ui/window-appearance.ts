import type { BrowserWindow, NativeTheme } from 'electron';
import type { Appearance } from '../../shared/types/app';

export function titlebarColors(appearance: Appearance, systemDark: boolean) {
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark);
  return {
    color: dark ? '#171a20' : '#f4f5f8',
    symbolColor: dark ? '#e7ebf2' : '#222b3d',
    height: 36,
  };
}

/** Native caption controls retain the normal window lifecycle and accessibility. */
export function installWindowAppearance(
  win: BrowserWindow,
  theme: NativeTheme,
): (appearance: Appearance) => boolean {
  let appearance: Appearance = 'system';
  const update = (): boolean => {
    if (win.isDestroyed()) return false;
    try {
      if (process.platform === 'win32')
        win.setTitleBarOverlay(titlebarColors(appearance, theme.shouldUseDarkColors));
      return true;
    } catch {
      return false;
    }
  };
  const onTheme = (): void => {
    if (appearance === 'system') update();
  };
  theme.on('updated', onTheme);
  win.once('closed', () => theme.removeListener('updated', onTheme));
  return (next) => {
    appearance = next;
    return update();
  };
}
