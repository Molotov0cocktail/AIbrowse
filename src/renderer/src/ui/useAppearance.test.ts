import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY, THEME_COLOR_STORAGE_KEY } from './theme';
import { useAppearance } from './useAppearance';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effect: null as (() => void) | null,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = next;
      },
    ];
  },
  useEffect: (effect: () => void) => {
    hooks.effect = effect;
  },
  useCallback: (callback: unknown) => callback,
}));
function render() {
  hooks.cursor = 0;
  return useAppearance();
}
function setup(color: string | null = '#336699') {
  const values = new Map<string, string>([[APPEARANCE_STORAGE_KEY, 'dark']]);
  if (color !== null) values.set(THEME_COLOR_STORAGE_KEY, color);
  const setAppearance = vi.fn(async () => true);
  const setItem = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const setProperty = vi.fn();
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem },
    aibrowse: { ui: { setAppearance } },
  });
  vi.stubGlobal('document', { documentElement: { dataset: {}, style: { setProperty } } });
  return { values, setAppearance, setItem, setProperty };
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.effect = null;
});
afterEach(() => vi.unstubAllGlobals());

it('常驻hook独立初始化模式和颜色，并同步CSS与原生标题栏', () => {
  const bridge = setup();
  const controller = render();
  hooks.effect?.();
  expect(controller.appearance).toBe('dark');
  expect(controller.themeColor).toBe('#336699');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.themeColor).toBe('#336699');
  expect(bridge.setProperty).toHaveBeenCalledWith('--chrome-bg', expect.any(String));
  expect(bridge.setAppearance).toHaveBeenCalledExactlyOnceWith('dark', '#336699');
  controller.setAppearance('light');
  const changed = render();
  expect(changed.appearance).toBe('light');
  expect(changed.themeColor).toBe('#336699');
  expect(bridge.setItem).toHaveBeenCalledExactlyOnceWith(APPEARANCE_STORAGE_KEY, 'light');
});

it('成功保存后应用主题色，恢复默认不改变固定深色模式', () => {
  const bridge = setup();
  expect(render().setThemeColor('#ABCDEF')).toBe(true);
  let controller = render();
  expect(controller.themeColor).toBe('#abcdef');
  expect(controller.themeColorError).toBeNull();
  hooks.effect?.();
  expect(bridge.setAppearance).toHaveBeenLastCalledWith('dark', '#abcdef');
  expect(controller.setThemeColor(null)).toBe(true);
  controller = render();
  hooks.effect?.();
  expect(controller.appearance).toBe('dark');
  expect(controller.themeColor).toBeNull();
  expect(bridge.setAppearance).toHaveBeenLastCalledWith('dark', null);
  expect(bridge.values.get(APPEARANCE_STORAGE_KEY)).toBe('dark');
  expect(bridge.values.get(THEME_COLOR_STORAGE_KEY)).toBe('default');
});

it('写入失败保留当前颜色并显示错误，重试成功清除错误', () => {
  const bridge = setup();
  const controller = render();
  bridge.setItem.mockImplementationOnce(() => {
    throw new Error('存储已满');
  });
  expect(controller.setThemeColor('#fedcba')).toBe(false);
  let current = render();
  expect(current.themeColor).toBe('#336699');
  expect(current.themeColorError).toContain('保存');
  expect(bridge.values.get(THEME_COLOR_STORAGE_KEY)).toBe('#336699');
  expect(current.setThemeColor('#fedcba')).toBe(true);
  current = render();
  expect(current.themeColor).toBe('#fedcba');
  expect(current.themeColorError).toBeNull();
});

it('旧偏好没有主题色时显式向原生发送默认颜色', () => {
  const bridge = setup(null);
  expect(render().themeColor).toBeNull();
  hooks.effect?.();
  expect(bridge.setAppearance).toHaveBeenCalledExactlyOnceWith('dark', null);
});
