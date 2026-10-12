import { beforeEach, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY } from './theme';
import { useAppearance } from './useAppearance';

const hooks = vi.hoisted(() => ({
  value: '' as unknown,
  effect: null as (() => void) | null,
  write: vi.fn(),
}));

vi.mock('react', () => ({
  useState: (initial: () => unknown) => {
    hooks.value = initial();
    return [hooks.value, hooks.write];
  },
  useEffect: (effect: () => void) => {
    hooks.effect = effect;
  },
  useCallback: (callback: unknown) => callback,
}));

beforeEach(() => {
  hooks.effect = null;
  hooks.write.mockReset();
});

it('App常驻hook从专用键初始化并同步DOM与原生标题栏', () => {
  const setAppearance = vi.fn(async () => true);
  const setItem = vi.fn();
  vi.stubGlobal('window', {
    localStorage: { getItem: vi.fn(() => 'dark'), setItem },
    aibrowse: { ui: { setAppearance } },
  });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  const controller = useAppearance();
  hooks.effect?.();
  expect(controller.appearance).toBe('dark');
  expect(window.localStorage.getItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY);
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(setAppearance).toHaveBeenCalledExactlyOnceWith('dark');
  controller.setAppearance('light');
  expect(setItem).toHaveBeenCalledExactlyOnceWith(APPEARANCE_STORAGE_KEY, 'light');
  expect(hooks.write).toHaveBeenCalledExactlyOnceWith('light');
});
