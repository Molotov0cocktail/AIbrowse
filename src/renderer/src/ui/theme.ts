export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'aibrowse.appearance';

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
