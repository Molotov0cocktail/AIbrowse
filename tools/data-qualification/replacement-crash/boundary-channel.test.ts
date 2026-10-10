import { expect, it } from 'vitest';
import { BoundaryChannel } from './boundary-channel';

it('发送期间同步到达的continue不会丢失', async () => {
  const channel = new BoundaryChannel();
  await expect(
    channel.pause(async () => {
      channel.accept('continue');
    }),
  ).resolves.toBeUndefined();
});

it('send失败会清除旧等待者，后继边界不能被过期continue确认', async () => {
  const channel = new BoundaryChannel();
  await expect(
    channel.pause(async () => {
      throw new Error('send失败');
    }),
  ).rejects.toThrow('send失败');
  channel.accept('continue');
  let completed = false;
  const second = channel
    .pause(async () => {})
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  expect(completed).toBe(false);
  channel.accept('continue');
  await second;
  expect(completed).toBe(true);
});
