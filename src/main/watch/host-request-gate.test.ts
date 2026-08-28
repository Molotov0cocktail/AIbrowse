// D5 M3: HostRequestGate 时序测试（FakeClock；detailed-design §4.3、FIXED 3/5/8）。
// 红态：模块尚不存在 → 红；绿后全绿。断言同 canonical host:effectivePort 相邻
// start ≥5000ms、abort 零登记、不同 host 独立、共享实例不分模式、deadline/非登记语义。
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { HostRequestGate, deriveHostKey } from './host-request-gate';

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
    expect(deriveHostKey({ scheme: 'http', host: 'example.com', port: 80 })).toBe(
      'example.com:80',
    );
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
});
