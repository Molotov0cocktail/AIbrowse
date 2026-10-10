import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MaintenanceCoordinator,
  type MaintenanceParticipant,
  type MaintenanceTicket,
} from './maintenance-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function participant(overrides: Partial<MaintenanceParticipant> = {}): MaintenanceParticipant {
  return {
    pauseForMaintenance: () => true,
    drainForMaintenance: async () => undefined,
    prepareResumeAfterMaintenance: () => true,
    resumeAfterMaintenance: () => true,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('主进程一致维护屏障', () => {
  it('永久退出仍等待已取消维护的原协调Promise，不能仅等待对外失败回执', async () => {
    const entered = deferred();
    const pending = deferred();
    const coordinator = new MaintenanceCoordinator([], async () => {
      entered.resolve();
      await pending.promise;
    });
    const acquiring = coordinator.acquire(performance.now() + 10_000);
    await entered.promise;
    coordinator.shutdown();
    expect(await acquiring).toEqual({ ok: false, reason: 'shutdown' });
    let idle = false;
    const original = coordinator.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    pending.resolve();
    await original;
    expect(idle).toBe(true);
    expect(coordinator.admission.isOpen()).toBe(false);
  });
  it('全部同步封闭后才取消/排水，真实根调用与叶操作都结束才授予快照', async () => {
    const events: string[] = [];
    const leaf = deferred();
    const verify = vi.fn(async () => {
      events.push('verify');
    });
    const parts = ['a', 'b'].map((id) =>
      participant({
        pauseForMaintenance: () => {
          events.push(`pause:${id}`);
          return true;
        },
        drainForMaintenance: async () => {
          events.push(`drain:${id}`);
          await leaf.promise;
        },
        prepareResumeAfterMaintenance: () => {
          events.push(`prepare:${id}`);
          return true;
        },
        resumeAfterMaintenance: () => {
          events.push(`resume:${id}`);
          return true;
        },
      }),
    );
    const coordinator = new MaintenanceCoordinator(parts, verify);
    const release = coordinator.admission.enter();
    const acquiring = coordinator.acquire(performance.now() + 10_000);
    expect(coordinator.admission.enter()).toBeNull();
    expect(events.slice(0, 2)).toEqual(['pause:a', 'pause:b']);
    leaf.resolve();
    await Promise.resolve();
    expect(verify).not.toHaveBeenCalled();
    release?.();
    const result = await acquiring;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(events).toEqual(['pause:a', 'pause:b', 'drain:a', 'drain:b', 'verify']);
    expect(coordinator.resume(result.ticket)).toBe(true);
    expect(events.slice(-4)).toEqual(['prepare:a', 'prepare:b', 'resume:a', 'resume:b']);
    expect(coordinator.admission.isOpen()).toBe(true);
    expect(coordinator.resume(result.ticket)).toBe(false);
  });

  it('超时后原操作继续受跟踪，迟到成功零协调/零快照/零自动恢复', async () => {
    vi.useFakeTimers();
    let now = 100;
    const leaf = deferred();
    const verify = vi.fn(async () => undefined);
    const coordinator = new MaintenanceCoordinator(
      [participant({ drainForMaintenance: () => leaf.promise })],
      verify,
      () => now,
    );
    const acquired = coordinator.acquire(110);
    now = 110;
    await vi.advanceTimersByTimeAsync(10);
    expect(await acquired).toEqual({ ok: false, reason: 'deadline' });
    expect(coordinator.status()).toMatchObject({ phase: 'failed', pending: true });
    leaf.resolve();
    await vi.runAllTimersAsync();
    expect(coordinator.status()).toMatchObject({ phase: 'failed', pending: false });
    expect(verify).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('即使超时timer尚未被调度，await后也复核单调期限', async () => {
    let now = 0;
    const leaf = deferred();
    const verify = vi.fn(async () => undefined);
    const coordinator = new MaintenanceCoordinator(
      [participant({ drainForMaintenance: () => leaf.promise })],
      verify,
      () => now,
    );
    const acquired = coordinator.acquire(10_000);
    now = 10_001;
    leaf.resolve();
    expect(await acquired).toEqual({ ok: false, reason: 'deadline' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('单域拒绝或异常不跳过其他域取消；仍不允许切换', async () => {
    const second = vi.fn(async () => undefined);
    const verify = vi.fn(async () => undefined);
    const coordinator = new MaintenanceCoordinator(
      [
        participant({
          drainForMaintenance: async () => {
            throw new Error('合成失败');
          },
        }),
        participant({ drainForMaintenance: second }),
      ],
      verify,
    );
    expect(await coordinator.acquire(performance.now() + 10_000)).toEqual({
      ok: false,
      reason: 'participant-failed',
    });
    expect(second).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('协调中跨越期限后不能继续封闭数据库，伪造票据也不能通过中间检查', async () => {
    let now = 0;
    const entered = deferred();
    const work = deferred();
    const seal = vi.fn();
    const coordinator = new MaintenanceCoordinator(
      [],
      async (ticket) => {
        expect(() => coordinator.assertCurrentDraining({ ...ticket })).toThrow();
        coordinator.assertCurrentDraining(ticket);
        entered.resolve();
        await work.promise;
        coordinator.assertCurrentDraining(ticket);
        seal();
      },
      () => now,
    );
    const acquired = coordinator.acquire(10_000);
    await entered.promise;
    now = 10_001;
    work.resolve();
    expect(await acquired).toEqual({ ok: false, reason: 'deadline' });
    expect(seal).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('恢复准备重入退出后不能打开任何参与者，过期票据也不能恢复', async () => {
    const open = vi.fn(() => true);
    const coordinator = new MaintenanceCoordinator(
      [
        participant({
          prepareResumeAfterMaintenance: () => {
            coordinator.shutdown();
            return true;
          },
          resumeAfterMaintenance: open,
        }),
      ],
      async () => undefined,
    );
    const result = await coordinator.acquire(performance.now() + 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coordinator.resume(result.ticket)).toBe(false);
    expect(open).not.toHaveBeenCalled();

    let now = 0;
    const expired = new MaintenanceCoordinator(
      [participant({ resumeAfterMaintenance: open })],
      async () => undefined,
      () => now,
    );
    const second = await expired.acquire(10_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    now = 10_001;
    expect(expired.resume(second.ticket)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('任何resume准备失败时全部入口保持关闭，伪造ticket不得操作当前世代', async () => {
    const open = vi.fn(() => true);
    const coordinator = new MaintenanceCoordinator(
      [
        participant({ resumeAfterMaintenance: open }),
        participant({ prepareResumeAfterMaintenance: () => false }),
      ],
      async () => undefined,
    );
    const result = await coordinator.acquire(performance.now() + 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coordinator.resume({ ...result.ticket })).toBe(false);
    expect(coordinator.resume(result.ticket)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('取消与永久退出都使迟到结果失效，重复请求不创建第二轮', async () => {
    const leaf = deferred();
    const verify = vi.fn(async () => undefined);
    const coordinator = new MaintenanceCoordinator(
      [participant({ drainForMaintenance: () => leaf.promise })],
      verify,
    );
    const acquired = coordinator.acquire(performance.now() + 10_000);
    expect(await coordinator.acquire(performance.now() + 10_000)).toEqual({
      ok: false,
      reason: 'busy',
    });
    const id = coordinator.status().operationId!;
    expect(coordinator.cancel('wrong')).toBe(false);
    expect(coordinator.cancel(id)).toBe(true);
    expect(await acquired).toEqual({ ok: false, reason: 'cancelled' });
    coordinator.shutdown();
    leaf.resolve();
    await Promise.resolve();
    expect(coordinator.admission.isOpen()).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('显式恢复原数据维护世代', () => {
  it('原参与者仍有实际pending时不创建恢复轮，期间迟到失败保留原失败receipt', async () => {
    const late = deferred();
    const drain = vi.fn(async () => {
      await late.promise;
      throw new Error('迟到持久失败');
    });
    const coordinator = new MaintenanceCoordinator(
      [participant({ drainForMaintenance: drain })],
      async () => {},
      () => 0,
    );
    const acquiring = coordinator.acquire(1000);
    const operationId = coordinator.status().operationId!;
    coordinator.cancel(operationId);
    expect(await acquiring).toEqual({ ok: false, reason: 'cancelled' });
    expect(
      (
        await coordinator.recoverOriginal({
          operationId,
          originalAbsoluteDeadline: 1000,
          isCurrent: () => true,
        })
      ).ok,
    ).toBe(false);
    expect(drain).toHaveBeenCalledOnce();
    late.resolve();
    await coordinator.waitForIdle();
    expect(coordinator.status()).toMatchObject({ reason: 'cancelled', pending: false });
    expect(
      await coordinator.recoverOriginal({
        operationId,
        originalAbsoluteDeadline: 1000,
        isCurrent: () => true,
      }),
    ).toEqual({ ok: false, reason: 'participant-failed' });
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('主进程proof抛错或在proof中耗尽原期限都不能重新开门', async () => {
    let now = 0;
    const coordinator = new MaintenanceCoordinator(
      [],
      async () => {
        throw new Error('首次失败');
      },
      () => now,
    );
    await coordinator.acquire(1000);
    const operationId = coordinator.status().operationId!;
    expect(
      (
        await coordinator.recoverOriginal({
          operationId,
          originalAbsoluteDeadline: 1000,
          isCurrent: () => {
            throw new Error('proof不可用');
          },
        })
      ).ok,
    ).toBe(false);
    expect(
      await coordinator.recoverOriginal({
        operationId,
        originalAbsoluteDeadline: 1000,
        isCurrent: () => {
          now = 1000;
          return true;
        },
      }),
    ).toEqual({ ok: false, reason: 'deadline' });
    expect(coordinator.status().operationId).toBe(operationId);
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('ready票据可被失败操作撤销，但历史票据不能因此重新取得权限', async () => {
    const coordinator = new MaintenanceCoordinator(
      [],
      async () => {},
      () => 0,
    );
    const initial = await coordinator.acquire(1000);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(coordinator.cancel(initial.ticket.operationId)).toBe(true);
    expect(coordinator.isQuiescent(initial.ticket)).toBe(false);
    expect(coordinator.resume(initial.ticket)).toBe(false);
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('原reconcile尚未结束时拒绝，结束后新票据同generation重新排水且旧失败保持失败', async () => {
    const entered = deferred();
    const late = deferred();
    const events: string[] = [];
    let old: MaintenanceTicket | null = null;
    const reconcile = vi.fn(async (ticket: MaintenanceTicket) => {
      if (old === null) {
        old = ticket;
        entered.resolve();
        await late.promise;
      }
      events.push(`reconcile:${ticket.operationId}`);
    });
    const coordinator = new MaintenanceCoordinator(
      [
        participant({
          pauseForMaintenance: (g) => {
            events.push(`pause:${g}`);
            return true;
          },
          drainForMaintenance: async (g) => {
            events.push(`drain:${g}`);
          },
          prepareResumeAfterMaintenance: () => {
            events.push('prepare');
            return true;
          },
          resumeAfterMaintenance: () => {
            expect(coordinator.admission.isOpen()).toBe(false);
            events.push('resume');
            return true;
          },
        }),
      ],
      reconcile,
      () => 0,
    );
    const pending = coordinator.acquire(1000);
    await entered.promise;
    const oldId = coordinator.status().operationId!;
    coordinator.cancel(oldId);
    const failedReceipt = await pending;
    expect(failedReceipt).toEqual({ ok: false, reason: 'cancelled' });
    expect(
      (
        await coordinator.recoverOriginal({
          operationId: oldId,
          originalAbsoluteDeadline: 1000,
          isCurrent: () => true,
        })
      ).ok,
    ).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
    late.resolve();
    await coordinator.waitForIdle();
    const recovered = await coordinator.recoverOriginal({
      operationId: oldId,
      originalAbsoluteDeadline: 1000,
      isCurrent: () => true,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok || old === null) return;
    const previous = old as MaintenanceTicket;
    expect(recovered.ticket).not.toBe(previous);
    expect(recovered.ticket.operationId).not.toBe(oldId);
    expect(recovered.ticket.generation).toBe(previous.generation);
    expect(recovered.ticket.deadlineMonoMs).toBe(previous.deadlineMonoMs);
    expect(events.filter((v) => v === `drain:${previous.generation}`)).toHaveLength(2);
    expect(events.slice(-2)).toEqual(['prepare', 'resume']);
    expect(coordinator.resume(previous)).toBe(false);
    expect(coordinator.isQuiescent(previous)).toBe(false);
    expect(failedReceipt).toEqual({ ok: false, reason: 'cancelled' });
    expect(coordinator.admission.isOpen()).toBe(true);
    expect(
      (
        await coordinator.recoverOriginal({
          operationId: oldId,
          originalAbsoluteDeadline: 1000,
          isCurrent: () => true,
        })
      ).ok,
    ).toBe(false);
  });

  it('再次持久失败不能被外部same-data确认覆盖', async () => {
    const drain = vi.fn(async () => {
      throw new Error('持久写入仍失败');
    });
    const resume = vi.fn(() => true);
    const coordinator = new MaintenanceCoordinator(
      [participant({ drainForMaintenance: drain, resumeAfterMaintenance: resume })],
      async () => {},
      () => 0,
    );
    expect(await coordinator.acquire(1000)).toEqual({ ok: false, reason: 'participant-failed' });
    const oldId = coordinator.status().operationId!;
    const recovered = await coordinator.recoverOriginal({
      operationId: oldId,
      originalAbsoluteDeadline: 1000,
      isCurrent: () => true,
    });
    expect(recovered).toEqual({ ok: false, reason: 'participant-failed' });
    await coordinator.waitForIdle();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(coordinator.status().operationId).not.toBe(oldId);
    expect(coordinator.admission.isOpen()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it('错误operation、替换数据代或伪造更晚期限都拒绝', async () => {
    let now = 0;
    const coordinator = new MaintenanceCoordinator(
      [],
      async () => {
        throw new Error('协调失败');
      },
      () => now,
    );
    await coordinator.acquire(1000);
    const operationId = coordinator.status().operationId!;
    for (const options of [
      { operationId: 'other', originalAbsoluteDeadline: 1000, isCurrent: () => true },
      { operationId, originalAbsoluteDeadline: 1001, isCurrent: () => true },
      { operationId, originalAbsoluteDeadline: 1000, isCurrent: () => false },
    ])
      expect((await coordinator.recoverOriginal(options)).ok).toBe(false);
    expect(coordinator.status().operationId).toBe(operationId);
    now = 1001;
    expect(
      await coordinator.recoverOriginal({
        operationId,
        originalAbsoluteDeadline: 1000,
        isCurrent: () => true,
      }),
    ).toEqual({ ok: false, reason: 'deadline' });
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('新恢复的reconcile await后再次复核外部data generation', async () => {
    let sameData = true;
    let attempt = 0;
    const entered = deferred();
    const wait = deferred();
    const resume = vi.fn(() => true);
    const coordinator = new MaintenanceCoordinator(
      [participant({ resumeAfterMaintenance: resume })],
      async () => {
        if (++attempt === 1) throw new Error('首次失败');
        entered.resolve();
        await wait.promise;
      },
      () => 0,
    );
    await coordinator.acquire(1000);
    const recovering = coordinator.recoverOriginal({
      operationId: coordinator.status().operationId!,
      originalAbsoluteDeadline: 1000,
      isCurrent: () => sameData,
    });
    await entered.promise;
    sameData = false;
    wait.resolve();
    expect((await recovering).ok).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('恢复prepare重入shutdown时不得开参与者或总门', async () => {
    let attempt = 0;
    const resume = vi.fn(() => true);
    const coordinator = new MaintenanceCoordinator(
      [
        participant({
          prepareResumeAfterMaintenance: () => {
            coordinator.shutdown();
            return true;
          },
          resumeAfterMaintenance: resume,
        }),
      ],
      async () => {
        if (++attempt === 1) throw new Error('首次失败');
      },
      () => 0,
    );
    await coordinator.acquire(1000);
    expect(
      await coordinator.recoverOriginal({
        operationId: coordinator.status().operationId!,
        originalAbsoluteDeadline: 1000,
        isCurrent: () => true,
      }),
    ).toEqual({ ok: false, reason: 'shutdown' });
    expect(resume).not.toHaveBeenCalled();
    expect(coordinator.admission.isOpen()).toBe(false);
  });

  it('恢复开始的proof guard重入shutdown后不能生成新票据', async () => {
    const coordinator = new MaintenanceCoordinator(
      [],
      async () => {
        throw new Error('首次失败');
      },
      () => 0,
    );
    await coordinator.acquire(1000);
    const operationId = coordinator.status().operationId!;
    expect(
      (
        await coordinator.recoverOriginal({
          operationId,
          originalAbsoluteDeadline: 1000,
          isCurrent: () => {
            coordinator.shutdown();
            return true;
          },
        })
      ).ok,
    ).toBe(false);
    expect(coordinator.status().operationId).toBe(operationId);
    expect(coordinator.admission.isOpen()).toBe(false);
  });
});
