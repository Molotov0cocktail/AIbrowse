import { describe, expect, it } from 'vitest';
import { Latch, waitForProviderEntry } from './controls';

describe('Research Provider 入口守卫（纯 Promise，不运行产品夹具）', () => {
  it('runtime 先正常结束时立即拒绝等待尚未进入的 Provider', async () => {
    const entered = new Latch();
    await expect(waitForProviderEntry(entered.promise, Promise.resolve())).rejects.toThrow(
      'Research runtime 在 Provider 入口前已结束',
    );
  });

  it('runtime 先拒绝时返回受控错误，不透传任意异常', async () => {
    const entered = new Latch();
    const done = new Latch();
    const rejected = done.promise.then(() => {
      throw new Error('任意底层正文');
    });
    const waiting = waitForProviderEntry(entered.promise, rejected);
    const assertion = expect(waiting).rejects.toThrow('Research runtime 在 Provider 入口前拒绝');
    done.release();
    await assertion;
  });

  it('Provider 先进入且 runtime 在途时准许继续', async () => {
    const entered = new Latch();
    const done = new Latch();
    const waiting = waitForProviderEntry(entered.promise, done.promise);
    entered.release();
    await expect(waiting).resolves.toBeUndefined();
    done.release();
  });
});
