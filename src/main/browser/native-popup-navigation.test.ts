import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePopupNavigation } from './native-popup-navigation';

const originalVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');
beforeEach(() => {
  Object.defineProperty(process.versions, 'electron', { value: '43.8.4', configurable: true });
});
afterEach(() => {
  if (originalVersion) Object.defineProperty(process.versions, 'electron', originalVersion);
  else Reflect.deleteProperty(process.versions, 'electron');
});

function fixture() {
  const source = new EventEmitter();
  const adapter = new NativePopupNavigation(source as WebContents);
  const navigate = vi.fn<(contents: WebContents) => void>();
  const details: Electron.HandlerDetails = {
    url: 'https://target.example/',
    frameName: '_blank',
    disposition: 'background-tab',
    features: '',
    referrer: { url: 'https://source.example/', policy: 'strict-origin-when-cross-origin' },
    postBody: {
      data: [{ type: 'rawData', bytes: Buffer.from('fixture=value') }],
      contentType: 'application/x-www-form-urlencoded',
    },
  };
  const args: unknown[] = [
    { preventDefault: vi.fn() },
    details.url,
    details.frameName,
    details.disposition,
    details.features,
    details.referrer,
    details.postBody?.data,
    123,
    navigate,
  ];
  const target = { isDestroyed: () => false } as WebContents;
  return { source, adapter, navigate, details, args, target };
}

describe('固定 Electron 原生弹窗导航适配', () => {
  it('同次同步事件准确绑定并只调用一次原生闭包，不读取 POST 正文', () => {
    const f = fixture();
    f.source.emit('-new-window', ...f.args);
    const lease = f.adapter.take(f.details)!;
    expect(lease.sandboxFlags).toBe(123);
    expect(lease.navigate(f.target)).toBe(true);
    expect(lease.navigate(f.target)).toBe(false);
    expect(f.adapter.take(f.details)).toBeNull();
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith(f.target);
    f.adapter.dispose();
  });

  it.each(['url', 'frameName', 'disposition', 'referrer', 'body'] as const)(
    '%s 不匹配消耗当前事件，不能用于后续请求',
    (field) => {
      const f = fixture();
      f.source.emit('-new-window', ...f.args);
      const wrong = { ...f.details };
      if (field === 'url') wrong.url = 'https://other.example/';
      if (field === 'frameName') wrong.frameName = 'other';
      if (field === 'disposition') wrong.disposition = 'foreground-tab';
      if (field === 'referrer')
        wrong.referrer = { url: 'https://other.example/', policy: 'default' };
      if (field === 'body') wrong.postBody = { ...f.details.postBody!, data: [] };
      expect(f.adapter.take(wrong)).toBeNull();
      expect(f.adapter.take(f.details)).toBeNull();
      expect(f.navigate).not.toHaveBeenCalled();
      f.adapter.dispose();
    },
  );

  it('微任务边界使尚未消费事件和已经领取的闭包同时失效', async () => {
    const f = fixture();
    f.source.emit('-new-window', ...f.args);
    const lease = f.adapter.take(f.details)!;
    await Promise.resolve();
    expect(lease.navigate(f.target)).toBe(false);
    f.source.emit('-new-window', ...f.args);
    await Promise.resolve();
    expect(f.adapter.take(f.details)).toBeNull();
    expect(f.navigate).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it('关闭适配器撤销已领取闭包并移除监听，重复dispose幂等', () => {
    const f = fixture();
    f.source.emit('-new-window', ...f.args);
    const lease = f.adapter.take(f.details)!;
    f.adapter.dispose();
    f.adapter.dispose();
    expect(lease.navigate(f.target)).toBe(false);
    expect(f.source.listenerCount('-new-window')).toBe(0);
    expect(f.navigate).not.toHaveBeenCalled();
  });

  it.each(['43.7.7', '43.8.3', '43.8.5', '44.0.0', undefined])(
    '未资格化的 Electron 版本 %s 拒绝捕获，不以手工导航降级',
    (version) => {
      const f = fixture();
      Object.defineProperty(process.versions, 'electron', { value: version, configurable: true });
      f.source.emit('-new-window', ...f.args);
      expect(f.adapter.take(f.details)).toBeNull();
      expect(f.navigate).not.toHaveBeenCalled();
      f.adapter.dispose();
    },
  );

  it.each([undefined, null, -1, 1.5, 0x100000000, '123'])(
    '非法原生沙箱标记 %s 拒绝捕获',
    (sandboxFlags) => {
      const f = fixture();
      f.args[7] = sandboxFlags;
      f.source.emit('-new-window', ...f.args);
      expect(f.adapter.take(f.details)).toBeNull();
      f.adapter.dispose();
    },
  );

  it('缺失参数、假回调或伪原生事件不提供导航闭包', () => {
    const f = fixture();
    f.source.emit('-new-window', ...f.args.slice(0, -1));
    expect(f.adapter.take(f.details)).toBeNull();
    f.args[8] = {};
    f.source.emit('-new-window', ...f.args);
    expect(f.adapter.take(f.details)).toBeNull();
    f.args[8] = f.navigate;
    f.args[0] = {};
    f.source.emit('-new-window', ...f.args);
    expect(f.adapter.take(f.details)).toBeNull();
    f.adapter.dispose();
  });
});
