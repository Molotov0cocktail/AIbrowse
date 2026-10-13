import { useCallback, useEffect, useState } from 'react';
import { createThemeCssVariables, type ThemeColor } from '../../../shared/theme-colors';
import {
  readAppearance,
  readThemeColor,
  saveAppearance,
  saveThemeColor,
  type Appearance,
} from './theme';

export interface AppearanceController {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  themeColor: ThemeColor;
  themeColorError: string | null;
  setThemeColor: (color: ThemeColor) => boolean;
}

/** Keep both renderer colors and the native caption buttons in sync for the whole app lifetime. */
export function useAppearance(): AppearanceController {
  const [appearance, setAppearanceState] = useState<Appearance>(() => readAppearance(window));
  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => readThemeColor(window));
  const [themeColorError, setThemeColorError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    document.documentElement.dataset.themeColor = themeColor ?? 'default';
    for (const [property, value] of Object.entries(createThemeCssVariables(themeColor)))
      document.documentElement.style.setProperty(property, value);
    void window.aibrowse.ui.setAppearance(appearance, themeColor).catch(() => undefined);
  }, [appearance, themeColor]);

  const setAppearance = useCallback((next: Appearance): void => {
    setAppearanceState(saveAppearance(window, next));
  }, []);

  const setThemeColor = useCallback((next: ThemeColor): boolean => {
    const saved = saveThemeColor(window, next);
    if (!saved.ok) {
      setThemeColorError('主题色保存失败，已保留原来的颜色。请重试。');
      return false;
    }
    setThemeColorState(saved.value);
    setThemeColorError(null);
    return true;
  }, []);

  return { appearance, setAppearance, themeColor, setThemeColor, themeColorError };
}
