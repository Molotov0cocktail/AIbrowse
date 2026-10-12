import { useCallback, useEffect, useState } from 'react';
import { readAppearance, saveAppearance, type Appearance } from './theme';

export interface AppearanceController {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
}

/** Keep both renderer colors and the native caption buttons in sync for the whole app lifetime. */
export function useAppearance(): AppearanceController {
  const [appearance, setAppearanceState] = useState<Appearance>(() => readAppearance(window));

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    void window.aibrowse.ui.setAppearance(appearance).catch(() => undefined);
  }, [appearance]);

  const setAppearance = useCallback((next: Appearance): void => {
    setAppearanceState(saveAppearance(window, next));
  }, []);

  return { appearance, setAppearance };
}
