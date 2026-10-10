import { afterEach, expect, it, vi } from 'vitest';
import { UiDocumentAuthorization } from '../../src/preload/ui-document-authorization';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('commit早于open仅提供一次重试机会，不自行发出请求', async () => {
  const request = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('current');
  const auth = new UiDocumentAuthorization(request);
  auth.documentCommitted();
  expect(request).not.toHaveBeenCalled();
  expect(await auth.open()).toBe('current');
  for (let count = 0; count < 10; count++) auth.documentCommitted();
  expect(request).toHaveBeenCalledTimes(2);
  auth.dispose();
  expect(auth.isAuthorized()).toBe(false);
});

it('二次握手单在途，退休先于迟到成功时不能复活', async () => {
  let resolveSecond!: (value: string) => void;
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const request = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
          secondStarted();
        }),
    );
  const auth = new UiDocumentAuthorization(request);
  const result = auth.open();
  auth.documentCommitted();
  await started;
  auth.documentCommitted();
  auth.dispose();
  resolveSecond('late');
  expect(await result).toBeNull();
  expect(auth.isAuthorized()).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(await auth.open()).toBeNull();
});

it('定时回调未运行时，迟到Ready不能消费第二次握手', async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(5);
  const request = vi.fn(async () => null);
  const auth = new UiDocumentAuthorization(request);
  const result = auth.open();
  await Promise.resolve();
  await Promise.resolve();
  clock.mockReturnValue(10_005);
  auth.documentCommitted();
  expect(await result).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(auth.isAuthorized()).toBe(false);
});

it('已调度但尚未开始的握手在退休后零调用', async () => {
  const request = vi.fn(async () => 'unexpected');
  const auth = new UiDocumentAuthorization(request);
  const result = auth.open();
  auth.dispose();
  auth.documentCommitted();
  expect(await result).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(auth.isAuthorized()).toBe(false);
});
