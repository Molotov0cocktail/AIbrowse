import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../shared/watch/clock';
import { QualificationPausableClock } from './pausable-clock';

describe('资格真实定时器暂停', () => {
  it('暂停清除真实handle，恢复保留原deadline并分配新登记identity', () => {
    const base = new FakeClock(1_000);
    const events: string[] = [];
    let serial = 0;
    const clock = new QualificationPausableClock(base, {
      register: (owner) => {
        const id = String(++serial);
        events.push(`+${owner}:${id}`);
        return id;
      },
      unregister: (id) => {
        events.push(`-${id}`);
      },
    });
    const fired: string[] = [];
    clock.forOwner('qualification-fixture').setTimeout(() => fired.push('fixture'), 100);
    clock.forOwner('digest-scheduler').setTimeout(() => fired.push('digest'), 100);
    clock.pause();
    expect(base.pendingTimerCount()).toBe(0);
    base.advanceTo(1_200);
    expect(fired).toEqual([]);
    clock.resume();
    expect(fired).toEqual([]);
    base.advanceBy(0);
    expect(fired).toEqual(['digest', 'fixture']);
    expect(events.filter((x) => x.startsWith('+'))).toHaveLength(4);
    expect(events.filter((x) => x.startsWith('-'))).toHaveLength(4);
  });

  it('clear已暂停的logical handle不会恢复，stop不重建业务timer', () => {
    const base = new FakeClock();
    const clock = new QualificationPausableClock(base, {
      register: () => 'x',
      unregister: () => {},
    });
    const scoped = clock.forOwner('watch-scheduler');
    const handle = scoped.setTimeout(() => {
      throw new Error('迟到回调');
    }, 100);
    clock.pause();
    scoped.clearTimeout(handle);
    clock.resume();
    expect(base.pendingTimerCount()).toBe(0);
    scoped.setTimeout(() => {
      throw new Error('退出后回调');
    }, 100);
    clock.pause();
    clock.stop();
    clock.resume();
    expect(base.pendingTimerCount()).toBe(0);
    expect(() => scoped.setTimeout(() => {}, 1)).toThrow('资格时钟已停止');
  });
});
