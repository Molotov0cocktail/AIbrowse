// D5 M3: HostRequestGate 时序测试（FakeClock；detailed-design §4.3、FIXED 3/5/8）。
// 红态：模块尚不存在 → 红；绿后全绿。断言同 canonical host:effectivePort 相邻
// start ≥5000ms、abort 零登记、不同 host 独立、共享实例不分模式、deadline/非登记语义。
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { HostRequestGate, deriveHostKey, type HostGateResult } from './host-request-gate';

function gateAt(nowMs: number, gapMs = 5_000) {
  const clock = new FakeClock(nowMs);
  const gate = new HostRequestGate({ clock, gapMs });
  return { clock, gate };
}

describe('deriveHostKey（canonical host:effectivePort，80/443 显式单一事实源）', () => {
  it('scheme+host+port → host:port；80/443 显式不省略', () => {
    expect(deriveHostKey({ scheme: 'https', host: 'example.com', port: 443 })).toBe(
      'example.com:443',
    );
    expect(deriveHostKey({ scheme: 'http', host: 'example.com', port: 80 })).toBe('example.com:80');
    expect(deriveHostKey({ scheme: 'http', host: 'example.com', port: 443 })).toBe(
      'example.com:443',
    );
  });
});

describe('HostRequestGate 时序（FIXED 3/5：同 host 相邻 start ≥5000ms）', () => {
  it('M3① 边界：恰好 5000ms 放行、小于则等待', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    expect((await gate.acquire(key)).ok).toBe(true);
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z'));
    // 恰好 5000ms → 立即放行（== 边界）
    clock.advanceTo(Date.parse('2026-08-28T10:00:05.000Z'));
    const p2 = gate.acquire(key);
    let resolved2 = false;
    void p2.then(() => (resolved2 = true));
    await Promise.resolve();
    expect(resolved2).toBe(true); // 同步立即放行
    // 小于 5000ms → 等待补齐
    clock.advanceTo(Date.parse('2026-08-28T10:00:06.000Z'));
    const p3 = gate.acquire(key); // 距 last(10:00:05) 仅 1s → 需等 4s
    let resolved3 = false;
    void p3.then(() => (resolved3 = true));
    await Promise.resolve();
    expect(resolved3).toBe(false);
    clock.advanceBy(4_000);
    expect(await p3).toEqual({ ok: true });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:10.000Z'));
  });

  it('M3② 重试/手动/槽释放不缩短间隔：每次 acquire 都按 lastStartedAt 重新计时', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0，last=t0
    // 模拟 retry：间隔 1s 再 acquire → 仍等满 5s（t0+5000 才放行）
    clock.advanceBy(1_000);
    let done = false;
    void gate.acquire(key).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advanceBy(4_000); // → t0+5000，首个 pending 放行并登记 last=t0+5000
    await Promise.resolve(); // 冲刷 resolve 微任务
    expect(done).toBe(true);
    // 手动运行同样走 gate：不因“手动”缩短——现在距 last(t0+5000) 仅 1s → 需再等 4s
    clock.advanceBy(1_000); // t0+6000
    let done2 = false;
    void gate.acquire(key).then(() => (done2 = true));
    await Promise.resolve();
    expect(done2).toBe(false);
    clock.advanceBy(4_000); // → t0+10000
    await Promise.resolve();
    expect(done2).toBe(true);
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:10.000Z'));
  });

  it('M3③ 等待中 abort → 零登记 start（调用方不会发起 createTab/socket）', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key);
    const controller = new AbortController();
    clock.advanceBy(1_000);
    const p = gate.acquire(key, { signal: controller.signal });
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
    // 未登记新 start：lastStartedAt 保持原值
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z'));
  });

  it('M3④ 不同 host 互不阻塞', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    await gate.acquire('a.com:443');
    clock.advanceBy(1_000);
    const b = await gate.acquire('b.com:443'); // 不同 host 立即放行
    expect(b).toEqual({ ok: true });
    expect(gate.lastStartedAt('b.com:443')).toBe(Date.parse('2026-08-28T10:00:01.000Z'));
  });

  it('M3⑥ Public 与 Session 共享同一实例：交叉序列仍 ≥5000ms（不分模式各自计时）', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    // Public 模式首次 start
    expect((await gate.acquire(key)).ok).toBe(true);
    // Session 模式（createTab 前）同 host：距上次仅 2s → 等满 5s（t0+5000）
    clock.advanceBy(2_000);
    let done = false;
    void gate.acquire(key).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advanceBy(3_000); // → t0+5000
    await Promise.resolve(); // 冲刷 resolve 微任务
    expect(done).toBe(true);
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:05.000Z'));
  });

  it('M3 deadline：等待超截止 → deadline 失败且零登记（截止 timer 先于 gap 触发）', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000，距 gap 满还需 4s
    const p = gate.acquire(key, { deadlineMs: Date.parse('2026-08-28T10:00:03.000Z') });
    // 截止 t0+3000 先到 → deadline 失败（无需等满 gap）
    clock.advanceTo(Date.parse('2026-08-28T10:00:03.000Z'));
    expect(await p).toEqual({ ok: false, reason: 'deadline' });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z'));
  });

  it('M3⑦ waitUntilAvailable 非登记：不改变 lastStartedAt；配合 jitter 后 acquire 仍立即放行', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    expect((await gate.acquire(key)).ok).toBe(true);
    clock.advanceBy(5_000);
    // Coordinator 语义：waitUntilAvailable（非登记）→ jitter 延迟 → 首个 socket acquire
    expect(await gate.waitUntilAvailable(key)).toEqual({ ok: true });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z')); // 未登记
    clock.advanceBy(200); // jitter 延迟
    expect(await gate.acquire(key)).toEqual({ ok: true }); // gap 仍满足 → 立即
  });

  it('clear() 幂等：清空注册表后可重复调用', async () => {
    const { gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    await gate.acquire('a.com:443');
    expect(gate.size).toBe(1);
    gate.clear();
    gate.clear();
    expect(gate.size).toBe(0);
    expect(await gate.acquire('a.com:443')).toEqual({ ok: true }); // 清空后立即放行
  });

  it('M3⑧ R1 并发同 host 等待者串行排队：相邻 start ≥5000ms（修复前同时获准）', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0：已启动一次，last=t0
    clock.advanceBy(1_000); // t0+1000：同时发起两个（及以上）同 host acquire
    const grants: number[] = [];
    const promises = [1, 2, 3].map(() =>
      gate.acquire(key).then((r) => {
        expect(r).toEqual({ ok: true });
        grants.push(clock.currentTimeMs());
      }),
    );
    await Promise.resolve(); // 三个等待者都进入队列
    expect(grants.length).toBe(0); // 未到 gap，均未获准
    clock.advanceBy(4_000); // → t0+5000：第一个获准并登记
    await Promise.resolve();
    expect(grants.length).toBe(1); // 修复前此刻三个同时获准 → 红
    clock.advanceBy(5_000); // → t0+10000：第二个获准
    await Promise.resolve();
    expect(grants.length).toBe(2);
    clock.advanceBy(5_000); // → t0+15000：第三个获准
    await Promise.resolve();
    expect(grants.length).toBe(3);
    await Promise.all(promises);
    // 记录所有 grant/socket-start 时间并逐对断言 >=5000ms
    for (let i = 1; i < grants.length; i += 1) {
      expect(grants[i]! - grants[i - 1]!).toBeGreaterThanOrEqual(5_000);
    }
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:15.000Z'));
  });

  it('M3⑨ R1 队列中 abort：不阻塞后续等待者、零登记 start', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000
    const c1 = new AbortController();
    const p1 = gate.acquire(key, { signal: c1.signal }); // 排第一
    const p2 = gate.acquire(key); // 排第二
    await Promise.resolve();
    c1.abort(); // 队列中第一个被 abort
    expect(await p1).toEqual({ ok: false, reason: 'aborted' });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z')); // 零登记
    // p2 不受 p1 阻塞：p1 移除后 p2 成为头，最早 t0+5000 获准
    let g2: number | null = null;
    void p2.then(() => (g2 = clock.currentTimeMs()));
    clock.advanceBy(4_000); // → t0+5000
    await Promise.resolve();
    expect(g2).toBe(Date.parse('2026-08-28T10:00:05.000Z'));
  });

  it('M3⑩ R1 队列中 deadline：不越过外部截止、零登记', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000
    const p1 = gate.acquire(key, { deadlineMs: Date.parse('2026-08-28T10:00:03.000Z') }); // 排第一
    const p2 = gate.acquire(key); // 排第二
    await Promise.resolve();
    clock.advanceTo(Date.parse('2026-08-28T10:00:03.000Z')); // p1 截止先到
    expect(await p1).toEqual({ ok: false, reason: 'deadline' });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z')); // 零登记
    // p2 成为头：在 t0+3000 计算 gap（距 last=t0 已 3000）→ 等 2000 → t0+5000 获准
    let g2: number | null = null;
    void p2.then(() => (g2 = clock.currentTimeMs()));
    clock.advanceBy(2_000); // → t0+5000
    await Promise.resolve();
    expect(g2).toBe(Date.parse('2026-08-28T10:00:05.000Z'));
  });

  it('M3⑪ R1 clear 后无迟到 grant：pending 全取消、清空后新 acquire 立即放行', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000
    const p1 = gate.acquire(key); // gap 等待中
    const p2 = gate.acquire(key); // 排队
    await Promise.resolve();
    const results: Array<'granted' | string> = [];
    void p1.then((r) => results.push(r.ok ? 'granted' : r.reason));
    void p2.then((r) => results.push(r.ok ? 'granted' : r.reason));
    gate.clear(); // 清空注册表并取消全部 pending
    clock.advanceBy(10_000); // 若 pending 未取消会迟到 grant（红）
    await Promise.all([p1, p2]);
    expect(results).toEqual(['aborted', 'aborted']); // 零迟到 grant
    expect(gate.size).toBe(0);
    expect(gate.lastStartedAt(key)).toBeNull(); // 注册表已清空（pending 零登记）
    expect((await gate.acquire(key)).ok).toBe(true); // 清空后立即放行
  });

  it('M3⑫ R5 非队首 waiter 自身 deadline 即结算：零登记、不阻塞队首、零迟到 grant、timer 归零', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0：登记一次 start，last=t0
    clock.advanceBy(1_000); // t0+1000
    const head = gate.acquire(key); // 队首：可用时刻 t0+5000
    const tail = gate.acquire(key, {
      deadlineMs: Date.parse('2026-08-28T10:00:03.000Z'),
    }); // 队尾：deadline t0+3000
    let headSettled = false;
    void head.then(() => (headSettled = true));
    let tailResult: HostGateResult | null = null;
    void tail.then((r) => (tailResult = r));
    await Promise.resolve();
    expect(tailResult).toBeNull(); // 未到 deadline，队尾未结算
    // 推进至 t0+3000：队尾自身 deadline 先到，必须立即、恰一次返回 deadline
    clock.advanceTo(Date.parse('2026-08-28T10:00:03.000Z'));
    await Promise.resolve();
    expect(tailResult).toEqual({ ok: false, reason: 'deadline' });
    expect(await tail).toEqual({ ok: false, reason: 'deadline' });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:00.000Z')); // 零登记
    expect(headSettled).toBe(false); // 队首仍未结算
    // 推进至 t0+5000：队首正常获准；已 deadline 的队尾不得迟到 grant
    clock.advanceTo(Date.parse('2026-08-28T10:00:05.000Z'));
    await Promise.resolve();
    expect(headSettled).toBe(true);
    expect(await head).toEqual({ ok: true });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:05.000Z'));
    expect(tailResult).toEqual({ ok: false, reason: 'deadline' }); // 零迟到 grant
    expect(clock.pendingTimerCount()).toBe(0); // 全部 timer 已清理归零
  });

  it('M3⑬ R5 多个非队首 waiter deadline 顺序结算 + abort 交错：互不阻塞、timer 逐减归零', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000
    const head = gate.acquire(key); // 队首：可用 t0+5000（无 deadline）
    const t1 = gate.acquire(key, {
      deadlineMs: Date.parse('2026-08-28T10:00:02.000Z'),
    }); // deadline t0+2000
    const t2 = gate.acquire(key, {
      deadlineMs: Date.parse('2026-08-28T10:00:04.000Z'),
    }); // deadline t0+4000
    const c3 = new AbortController();
    const t3 = gate.acquire(key, {
      signal: c3.signal,
      deadlineMs: Date.parse('2026-08-28T10:00:04.500Z'),
    }); // 队尾：稍后被 abort
    await Promise.resolve();
    expect(clock.pendingTimerCount()).toBe(4); // head gap + 三个 deadline
    // t0+2000：t1 自身 deadline 结算，队首未动
    clock.advanceTo(Date.parse('2026-08-28T10:00:02.000Z'));
    expect(await t1).toEqual({ ok: false, reason: 'deadline' });
    expect(clock.pendingTimerCount()).toBe(3); // head gap + t2 + t3 deadline
    // t0+3000：abort 仍在队中的 t3（deadline 未到）→ aborted，t3 deadline timer 清理
    clock.advanceTo(Date.parse('2026-08-28T10:00:03.000Z'));
    c3.abort();
    expect(await t3).toEqual({ ok: false, reason: 'aborted' });
    expect(clock.pendingTimerCount()).toBe(2); // head gap + t2 deadline
    // t0+4000：t2 自身 deadline 结算
    clock.advanceTo(Date.parse('2026-08-28T10:00:04.000Z'));
    expect(await t2).toEqual({ ok: false, reason: 'deadline' });
    expect(clock.pendingTimerCount()).toBe(1); // head gap
    // t0+5000：队首正常获准，timer 全部归零
    clock.advanceTo(Date.parse('2026-08-28T10:00:05.000Z'));
    expect(await head).toEqual({ ok: true });
    expect(gate.lastStartedAt(key)).toBe(Date.parse('2026-08-28T10:00:05.000Z'));
    expect(clock.pendingTimerCount()).toBe(0);
    expect(gate.size).toBe(1); // 仅一次登记 start
  });

  it('M3⑭ R5 非队首 deadline 后 clear：pending 全取消、零迟到 grant、timer 归零', async () => {
    const { clock, gate } = gateAt(Date.parse('2026-08-28T10:00:00.000Z'));
    const key = 'example.com:443';
    await gate.acquire(key); // t0
    clock.advanceBy(1_000); // t0+1000
    const head = gate.acquire(key); // 队首：可用 t0+5000
    const tail = gate.acquire(key, {
      deadlineMs: Date.parse('2026-08-28T10:00:03.000Z'),
    }); // 队尾：deadline t0+3000
    await Promise.resolve();
    expect(clock.pendingTimerCount()).toBe(2); // head gap + tail deadline
    const results: Array<string> = [];
    void head.then((r) => results.push(r.ok ? 'granted' : r.reason));
    void tail.then((r) => results.push(r.ok ? 'granted' : r.reason));
    gate.clear(); // 在 deadline 前 clear：全部 pending 受控取消
    clock.advanceTo(Date.parse('2026-08-28T10:00:05.000Z')); // 若未取消会迟到 grant/timer
    await Promise.resolve();
    expect(results).toEqual(['aborted', 'aborted']); // 零迟到 grant
    expect(clock.pendingTimerCount()).toBe(0); // timer 全部清理
    expect(gate.size).toBe(0);
  });
});
