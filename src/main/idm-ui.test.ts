import { EventEmitter } from 'node:events';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import type { IdmDownloadInterceptor } from './downloads/idm-download-interceptor';

const calls = vi.hoisted(() => ({
  manualSend: vi.fn(),
  manualDispose: vi.fn(),
  nativeDispose: vi.fn(),
  nativeStatus: vi.fn(),
  interceptorDispose: vi.fn(),
  identity: vi.fn(),
  interceptor: vi.fn(),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
}));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    app: Object.assign(new Emitter(), { isPackaged: false, getAppPath: () => 'D:/AIbrowse' }),
    dialog: { showMessageBox: calls.showMessageBox },
  };
});
vi.mock('./downloads/idm-service', () => ({
  IdmDownloadService: class {
    send = calls.manualSend;
    dispose = calls.manualDispose;
  },
}));
vi.mock('./downloads/idm-native-service', () => ({
  IdmNativeDownloadService: class {
    constructor(identity: unknown) {
      calls.identity(identity);
    }
    dispose = calls.nativeDispose;
    getStatus = calls.nativeStatus;
  },
}));
vi.mock('./downloads/idm-download-interceptor', () => ({
  IdmDownloadInterceptor: class {
    constructor(options: unknown) {
      calls.interceptor(options);
    }
    dispose = calls.interceptorDispose;
  },
}));

import { createIdmFeature } from './idm-ui';
const features: ReturnType<typeof createIdmFeature>[] = [];
afterEach(() => {
  for (const feature of features.splice(0)) feature.dispose();
  vi.clearAllMocks();
});

function fixture() {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let open = true;
  let valid = true;
  const lease = { token: 'trusted-once', isCurrent: () => valid };
  const capture = vi.fn(() => lease);
  const consume = vi.fn(() => lease);
  const feature = createIdmFeature({
    win: win as unknown as BrowserWindow,
    session: {} as Session,
    isOpen: () => open,
    isUserDownloadFrame: () => true,
    getCaptureContext: capture,
    consumeDownloadLease: consume,
  });
  features.push(feature);
  const options = calls.interceptor.mock.calls.at(-1)![0] as ConstructorParameters<
    typeof IdmDownloadInterceptor
  >[0];
  return {
    feature,
    win,
    options,
    capture,
    consume,
    closeAdmission: () => {
      open = false;
    },
    revoke: () => {
      valid = false;
    },
  };
}
const snapshot = {
  url: 'https://example.com/file.zip',
  urlChain: ['https://example.com/file.zip'],
  filename: 'file.zip',
  hasUserGesture: true,
  initiatorOrigin: 'https://example.com',
};

it('业务准入关闭后不采集请求头、不消费下载许可，并撤销异步交接', () => {
  const f = fixture();
  const lease = f.options.consumeDownloadLease({} as WebContents, null, snapshot);
  expect(lease?.isCurrent()).toBe(true);
  f.closeAdmission();
  expect(lease?.isCurrent()).toBe(false);
  expect(f.options.getCaptureContext(1, null)).toBeNull();
  expect(f.options.consumeDownloadLease({} as WebContents, null, snapshot)).toBeNull();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.consume).toHaveBeenCalledOnce();
});

it('文档许可失效不会被工厂的包装恢复', () => {
  const f = fixture();
  const lease = f.options.consumeDownloadLease({} as WebContents, null, snapshot);
  f.revoke();
  expect(lease?.isCurrent()).toBe(false);
});

it('窗口关闭幂等释放两种IDM服务与观察器，停止新的下载', () => {
  const f = fixture();
  f.win.emit('closed');
  f.feature.dispose();
  expect(calls.manualDispose).toHaveBeenCalledOnce();
  expect(calls.nativeDispose).toHaveBeenCalledOnce();
  expect(calls.interceptorDispose).toHaveBeenCalledOnce();
  expect(f.options.getCaptureContext(1, null)).toBeNull();
});

it('手动输入只经原地址交接，自动路径的可用状态取自校验后的组件', async () => {
  const f = fixture();
  const isCurrent = () => true;
  calls.nativeStatus.mockResolvedValueOnce({ available: true });
  await expect(f.feature.getStatus()).resolves.toEqual({ available: true });
  f.feature.send(snapshot.url, isCurrent);
  expect(calls.manualSend).toHaveBeenCalledExactlyOnceWith(snapshot.url, isCurrent);
});

it('成功和已撤销操作不增加弹窗，失败提示同时只显示一次', async () => {
  const f = fixture();
  f.options.onResult?.({ ok: true });
  f.options.onResult?.({ ok: false, code: 'closed', message: '关闭' });
  expect(calls.showMessageBox).not.toHaveBeenCalled();
  f.options.onResult?.({ ok: false, code: 'unavailable', message: '未检测到 IDM' });
  f.options.onResult?.({ ok: false, code: 'busy', message: '忙碌' });
  expect(calls.showMessageBox).toHaveBeenCalledOnce();
  await Promise.resolve();
});
