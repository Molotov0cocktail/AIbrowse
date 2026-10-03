import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installSessionSecurity } from './session-security';

interface CapturedHandlers {
  request?: (
    webContents: { getURL(): string },
    permission: string,
    callback: (ok: boolean) => void,
    details: { requestingUrl: string },
  ) => void;
  check?: (
    webContents: object | null,
    permission: string,
    origin: string,
    details: object,
  ) => boolean;
  download?: (event: { preventDefault(): void }, item: object, webContents: object) => void;
  beforeFile?: (details: object, callback: (result: { cancel: boolean }) => void) => void;
}

function fakeSession() {
  const captured: CapturedHandlers = {};
  const target = {
    setPermissionRequestHandler: vi.fn((handler) => {
      captured.request = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler) => {
      captured.check = handler;
    }),
    on: vi.fn((event, listener) => {
      if (event === 'will-download') captured.download = listener;
      return target;
    }),
    webRequest: {
      onBeforeRequest: vi.fn((filter, listener) => {
        expect(filter).toEqual({ urls: ['file://*/*'] });
        captured.beforeFile = listener;
      }),
    },
  };
  return { target: target as unknown as Session, captured, raw: target };
}

describe('Session 安全默认值', () => {
  it('权限 request/check 对 UI、Tab、子帧与未知权限统一拒绝', () => {
    const { target, captured } = fakeSession();
    installSessionSecurity(target);
    const callback = vi.fn();
    captured.request?.({ getURL: () => APP_URL }, 'clipboard-sanitized-write', callback, {
      requestingUrl: APP_URL,
    });
    expect(callback).toHaveBeenCalledWith(false);
    expect(captured.check?.(null, 'unknown-future-permission', '', {})).toBe(false);
    expect(captured.check?.({}, 'media', 'https://example.com', { isMainFrame: false })).toBe(
      false,
    );
  });

  it('will-download 在写盘前取消，且不依赖文件名、URL 或 WebContents', () => {
    const { target, captured } = fakeSession();
    installSessionSecurity(target);
    const event = { preventDefault: vi.fn() };
    captured.download?.(event, {}, {});
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('拦截 Session 内全部 file: 请求，清单资产只能走 aibrowse 协议', () => {
    const { target, captured } = fakeSession();
    installSessionSecurity(target);
    const callback = vi.fn();
    captured.beforeFile?.({}, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it('同一 Session 重复装配保持幂等，不叠加事件监听或覆盖链', () => {
    const { target, raw } = fakeSession();
    installSessionSecurity(target);
    installSessionSecurity(target);
    expect(raw.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(raw.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(raw.on).toHaveBeenCalledOnce();
    expect(raw.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
  });

  it('未打包 production preview 可显式保留 loadFile，且不同策略不能重复装配', () => {
    const { target, raw } = fakeSession();
    installSessionSecurity(target, { blockFileRequests: false });
    expect(raw.webRequest.onBeforeRequest).not.toHaveBeenCalled();
    expect(() => installSessionSecurity(target, { blockFileRequests: true })).toThrow();
  });
});

const APP_URL = 'aibrowse://app/index.html';
