import { EventEmitter } from 'node:events';
import type { BrowserWindow, NativeTheme } from 'electron';
import { expect, it, vi } from 'vitest';
import { installWindowAppearance, titlebarColors } from './window-appearance';

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
