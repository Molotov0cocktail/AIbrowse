import { afterEach, expect, it, vi } from 'vitest';
import { createGuardianSession } from '../../src/main/storage/lifecycle-guardian';

const sessions: Array<ReturnType<typeof createGuardianSession>> = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const nonce = 'f'.repeat(32);
function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const frames: string[] = [];
  const session = createGuardianSession({
    nonce,
    timeoutMs: 100,
    send: (frame) => frames.push(frame),
  });
  sessions.push(session);
  return { session, frames, advanceClock: () => (now = 101) };
}
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

it('ready的单调预算已过即拒绝，不能依赖尚未运行的timer回调', async () => {
  const f = fixture();
  let result = 'pending';
  void f.session.ready.then(
    () => (result = 'fulfilled'),
    () => (result = 'rejected'),
  );
  f.advanceClock();
  f.session.receive(`1|${nonce}|0|ready`);
  await flush();
  expect(result).toBe('rejected');
});

it.each(['authorize', 'retire'] as const)(
  '%s原生ACK不能在timer迟到时越过单调deadline',
  async (kind) => {
    const f = fixture();
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    const pending =
      kind === 'authorize'
        ? f.session.handle.authorizeUtility({ pid: 42, role: 'probe' })
        : f.session.handle.confirmUtilityExit(42);
    let result = 'pending';
    void pending.then(
      () => (result = 'fulfilled'),
      () => (result = 'rejected'),
    );
    expect(f.frames).toHaveLength(1);
    f.advanceClock();
    f.session.receive(`1|${nonce}|1|ok`);
    await flush();
    expect(result).toBe('rejected');
  },
);
