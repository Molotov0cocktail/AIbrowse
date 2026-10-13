import { EventEmitter } from 'node:events';
import type { BrowserWindow, NativeTheme } from 'electron';
import { expect, it, vi } from 'vitest';
import { installWindowAppearance, titlebarColors } from './window-appearance';
import type { Appearance } from '../../shared/types/app';

it('系统主题实时同步窗口按钮，固定主题不被系统覆盖，关闭移除监听', () => {
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setTitleBarOverlay: vi.fn(),
  });
  const set = installWindowAppearance(
    win as unknown as BrowserWindow,
    theme as unknown as NativeTheme,
  );
  expect(set('dark')).toBe(true);
  if (process.platform === 'win32')
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith(titlebarColors('dark', false));
  theme.shouldUseDarkColors = true;
  set('system');
  theme.shouldUseDarkColors = false;
  theme.emit('updated');
  if (process.platform === 'win32')
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith(titlebarColors('light', false));
  win.emit('closed');
  expect(theme.listenerCount('updated')).toBe(0);
});

it('未设置主题色保留现有浅深标题栏颜色，自选主题色改变原生背景', () => {
  expect(titlebarColors('light', true)).toEqual({
    color: '#f4f5f8',
    symbolColor: '#222b3d',
    height: 36,
  });
  expect(titlebarColors('dark', false, null)).toEqual({
    color: '#171a20',
    symbolColor: '#e7ebf2',
    height: 36,
  });
  expect(titlebarColors('light', false, '#00AAFF').color).not.toBe('#f4f5f8');
  expect(titlebarColors('dark', false, '#00AAFF').color).not.toBe('#171a20');
});

it('系统切换保留主题色，固定模式不被覆盖，恢复默认不改变模式', () => {
  const theme = Object.assign(new EventEmitter(), {
    shouldUseDarkColors: false,
    themeSource: 'system',
  });
  const overlay = vi.fn();
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setTitleBarOverlay: overlay,
  });
  const set = installWindowAppearance(
    win as unknown as BrowserWindow,
    theme as unknown as NativeTheme,
  );
  expect(set('system', '#00AAFF')).toBe(true);
  theme.shouldUseDarkColors = true;
  theme.emit('updated');
  if (process.platform === 'win32')
    expect(overlay).toHaveBeenLastCalledWith(titlebarColors('dark', false, '#00AAFF'));
  set('light', '#00AAFF');
  overlay.mockClear();
  theme.shouldUseDarkColors = false;
  theme.emit('updated');
  expect(overlay).not.toHaveBeenCalled();
  set('light', null);
  if (process.platform === 'win32')
    expect(overlay).toHaveBeenLastCalledWith(titlebarColors('light', true));
  expect(theme.themeSource).toBe('system');
  win.emit('closed');
});

it('无效模式或颜色不调用原生窗口、不覆盖先前设置，关闭后不能再同步', () => {
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const overlay = vi.fn();
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setTitleBarOverlay: overlay,
  });
  const set = installWindowAppearance(
    win as unknown as BrowserWindow,
    theme as unknown as NativeTheme,
  );
  set('system', '#AA3300');
  overlay.mockClear();
  expect(set('unknown' as Appearance, '#AA3300')).toBe(false);
  expect(set('dark', 'url(file:///private)')).toBe(false);
  expect(overlay).not.toHaveBeenCalled();
  theme.shouldUseDarkColors = true;
  theme.emit('updated');
  if (process.platform === 'win32')
    expect(overlay).toHaveBeenLastCalledWith(titlebarColors('dark', false, '#AA3300'));
  win.emit('closed');
  overlay.mockClear();
  expect(set('light', '#AA3300')).toBe(false);
  expect(overlay).not.toHaveBeenCalled();
  expect(theme.listenerCount('updated')).toBe(0);
});

it('原生窗口销毁或更新异常安全失败', () => {
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    setTitleBarOverlay: vi.fn(() => {
      throw new Error('native unavailable');
    }),
  });
  const set = installWindowAppearance(
    win as unknown as BrowserWindow,
    theme as unknown as NativeTheme,
  );
  expect(set('dark', '#AA3300')).toBe(process.platform !== 'win32');
  win.isDestroyed.mockReturnValue(true);
  expect(set('light')).toBe(false);
  win.isDestroyed.mockImplementation(() => {
    throw new Error('disposed');
  });
  expect(set('dark')).toBe(false);
  win.emit('closed');
});
