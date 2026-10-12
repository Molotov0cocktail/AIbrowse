import { beforeEach, expect, it, vi } from 'vitest';
import type { TraySettings } from '../../../shared/types/app';
import { useTraySettings } from './useTraySettings';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  stateIndex: 0,
  effect: null as (() => void | (() => void)) | null,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    hooks.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const setter = vi.fn((next: unknown) => {
      hooks.states[index] =
        typeof next === 'function'
          ? (next as (current: unknown) => unknown)(hooks.states[index])
          : next;
    });
    hooks.setters[index] = setter;
    return [hooks.states[index], setter];
  },
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effect = effect;
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (callback: unknown) => callback,
}));

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

beforeEach(() => {
  hooks.states = [];
  hooks.setters = [];
  hooks.stateIndex = 0;
  hooks.effect = null;
});

it('加载主进程状态且不使用localStorage', async () => {
  const current: TraySettings = { runInTray: true, available: true, error: null };
  const get = vi.fn(async () => current);
  const localStorage = { getItem: vi.fn(), setItem: vi.fn() };
  vi.stubGlobal('window', {
    localStorage,
    aibrowse: { appPreferences: { get, setRunInTray: vi.fn() } },
  });

  useTraySettings();
  hooks.effect?.();
  await flush();

  expect(get).toHaveBeenCalledOnce();
  expect(hooks.setters[0]).toHaveBeenCalledWith(current);
  expect(hooks.setters[1]).toHaveBeenLastCalledWith(false);
  expect(localStorage.getItem).not.toHaveBeenCalled();
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it('保存拒绝后重新读取真实状态并只显示固定中文错误', async () => {
  const actual: TraySettings = { runInTray: false, available: true, error: 'private detail' };
  const get = vi.fn(async () => actual);
  const setRunInTray = vi.fn(async () => {
    throw new Error('sensitive main error');
  });
  vi.stubGlobal('window', { aibrowse: { appPreferences: { get, setRunInTray } } });

  const controller = useTraySettings();
  controller.setRunInTray(true);
  await flush();

  expect(setRunInTray).toHaveBeenCalledExactlyOnceWith(true);
  expect(get).toHaveBeenCalledOnce();
  expect(hooks.setters[0]).toHaveBeenCalledWith(actual);
  expect(hooks.setters[3]).toHaveBeenLastCalledWith('托盘设置保存失败，请稍后重试');
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('private'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('sensitive'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('error'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('Error'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('detail'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('main'));
  expect(hooks.setters[3]).not.toHaveBeenCalledWith(expect.stringContaining('true'));
  expect(hooks.setters[2]).toHaveBeenNthCalledWith(1, true);
  expect(hooks.setters[2]).toHaveBeenLastCalledWith(false);
});

it('主进程回执未实现请求值时保留真实状态并判定保存失败', async () => {
  const actual: TraySettings = { runInTray: false, available: true, error: null };
  const setRunInTray = vi.fn(async () => actual);
  vi.stubGlobal('window', {
    aibrowse: { appPreferences: { get: vi.fn(), setRunInTray } },
  });

  const controller = useTraySettings();
  controller.setRunInTray(true);
  await flush();

  expect(hooks.setters[0]).toHaveBeenCalledWith(actual);
  expect(hooks.setters[3]).toHaveBeenLastCalledWith('托盘设置保存失败，请稍后重试');
});
