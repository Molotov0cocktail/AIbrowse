import { expect, it, vi } from 'vitest';
import {
  DataTransferService,
  type DataTransferPorts,
  type TransferOperationContext,
} from './data-transfer-service';
import { MaintenanceCoordinator, type MaintenanceParticipant } from './maintenance-coordinator';
import type { TransferResult } from './transfer-protocol';

const document = { isCurrent: () => true };
const snapshotId = '11111111-1111-4111-8111-111111111111';
const sha256 = 'a'.repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture(participants: MaintenanceParticipant[] = []) {
  let clock = 0;
  const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = [];
  const maintenance = new MaintenanceCoordinator(
    participants,
    async () => {},
    () => clock,
  );
  const result = (c: TransferOperationContext): TransferResult => ({
    manifest: {
      formatVersion: 1,
      productVersion: 'test',
      snapshotId: c.job.snapshotId,
      members: ['sources', 'research', 'watch', 'conversations'].map((id) => ({
        id,
        present: true,
        schemaVersion: id === 'watch' ? 5 : 1,
        bytes: 100,
        sha256,
      })) as TransferResult['manifest']['members'],
    },
    backup: c.job.action === 'backup' ? { bytes: 100, sha256 } : null,
  });
  const ports: DataTransferPorts = {
    now: () => clock,
    timers: {
      set(ms, callback) {
        const timer = { ms, callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    maintenance,
    chooseNative: vi.fn<DataTransferPorts['chooseNative']>(async (action) =>
      action === 'backup'
        ? { action, destination: 'D:\\private\\backup.aibak' }
        : {
            action,
            snapshotId,
            input: {
              path: 'D:\\private\\input.aibak',
              dev: '1',
              ino: '2',
              size: '100',
              mtimeNs: '3',
              ctimeNs: '4',
            },
          },
    ),
    confirmRestore: vi.fn<DataTransferPorts['confirmRestore']>(async () => true),
    createScope: vi.fn<DataTransferPorts['createScope']>(async (c) => ({
      userDataRoot: 'D:\\private',
      operationRoot: 'D:\\private\\operation',
      operationId: c.job.operationId.replaceAll('-', ''),
      generation: c.generation,
      purpose: c.job.action as 'backup' | 'restore',
      identities: [],
    })),
    requireSpace: vi.fn<DataTransferPorts['requireSpace']>(async () => {}),
    run: vi.fn<DataTransferPorts['run']>(async (c) => ({
      state: 'succeeded',
      result: result(c),
      exitCode: 0,
    })),
    verify: vi.fn<DataTransferPorts['verify']>(async (c) =>
      c.job.action === 'backup'
        ? { action: 'backup', snapshotId: c.job.snapshotId, backup: { bytes: 100, sha256 } }
        : {
            action: 'restore',
            snapshotId: c.job.snapshotId,
            expected: Object.fromEntries(
              ['sources', 'research', 'watch', 'conversations'].map((id) => [
                id,
                { bytes: 100, sha256 },
              ]),
            ) as Extract<
              Awaited<ReturnType<DataTransferPorts['verify']>>,
              { action: 'restore' }
            >['expected'],
          },
    ),
    publishBackup: vi.fn<DataTransferPorts['publishBackup']>(async () => true),
    registerHandoff: vi.fn<DataTransferPorts['registerHandoff']>(async () => true),
    requestRelaunch: vi.fn<DataTransferPorts['requestRelaunch']>(async () => true),
    originalState: vi.fn<DataTransferPorts['originalState']>(() => ({
      childrenExited: true,
      originalDrainsSettled: !maintenance.status().pending,
      beforeSwitch: true,
    })),
    verifyOriginal: vi.fn<DataTransferPorts['verifyOriginal']>(async (c) => ({
      operationId: c.job.operationId,
      childrenExited: true,
      originalDrainsSettled: !maintenance.status().pending,
      beforeSwitch: true,
      sameData: true,
    })),
    recoverOriginal: vi.fn<DataTransferPorts['recoverOriginal']>(async () => true),
  };
  return {
    ports,
    service: new DataTransferService(ports),
    advance(ms: number) {
      clock += ms;
    },
    fire(ms: number) {
      for (const timer of timers)
        if (!timer.cancelled && timer.ms === ms) {
          timer.cancelled = true;
          timer.callback();
        }
    },
    timers,
  };
}

it('恢复按钮仅依据原件物理状态，新文档可接管失败操作而不复活旧文档权限', async () => {
  const f = fixture();
  let oldCurrent = true;
  f.ports.run = vi.fn<DataTransferPorts['run']>(async () => ({
    state: 'failed',
    code: 'worker',
    exitCode: 2,
  }));
  f.ports.originalState = (context) => {
    context.assertCurrent();
    return { childrenExited: true, originalDrainsSettled: true, beforeSwitch: true };
  };
  const failed = await f.service.start('backup', { isCurrent: () => oldCurrent });
  oldCurrent = false;
  expect(f.service.getStatus().canRecoverOriginal).toBe(true);
  const verify = f.ports.verifyOriginal;
  f.ports.verifyOriginal = async (context) => {
    context.assertCurrent();
    return verify(context);
  };
  expect(
    (await f.service.recoverOriginal(failed.operationId, { isCurrent: () => false })).code,
  ).toBe('stale-document');
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
  expect(
    (await f.service.recoverOriginal(failed.operationId, { isCurrent: () => true })).state,
  ).toBe('original-restored');
  expect(f.ports.run).toHaveBeenCalledTimes(1);
});

it('拒绝renderer路径对象与未知动作，零原生对话框', async () => {
  const { service, ports } = fixture();
  expect((await service.start({ action: 'restore', path: 'D:\\payload' }, document)).code).toBe(
    'invalid-request',
  );
  expect((await service.start('migrate', document)).code).toBe('invalid-request');
  expect(ports.chooseNative).not.toHaveBeenCalled();
});

it('原生picker互斥，期间取消保持占有直到原promise完成', async () => {
  const { service, ports } = fixture();
  const choice = deferred<null>();
  ports.chooseNative = vi.fn<DataTransferPorts['chooseNative']>(() => choice.promise);
  const first = service.start('backup', document);
  expect((await service.start('restore', document)).code).toBe('busy');
  const id = service.getStatus().operationId;
  expect(service.cancel(id, document).code).toBe('cancelled');
  expect((await service.start('backup', document)).code).toBe('busy');
  choice.resolve(null);
  expect((await first).state).toBe('cancelled');
  expect(ports.createScope).not.toHaveBeenCalled();
});

it('restore native确认取消零维护/worker/handoff，选取时间不消耗工作账本', async () => {
  const f = fixture();
  f.ports.confirmRestore = vi.fn<DataTransferPorts['confirmRestore']>(async () => {
    f.advance(2_000_000);
    return false;
  });
  expect((await f.service.start('restore', document)).state).toBe('cancelled');
  expect(f.ports.createScope).not.toHaveBeenCalled();
  expect(f.ports.run).not.toHaveBeenCalled();
  expect(f.ports.registerHandoff).not.toHaveBeenCalled();
  expect(f.ports.maintenance.status().phase).toBe('idle');
});

it('backup仅发布+同数据代复核+resume完成后报告成功，端口共用同一预算', async () => {
  const f = fixture();
  expect((await f.service.start('backup', document)).state).toBe('completed');
  expect(f.ports.publishBackup).toHaveBeenCalledTimes(1);
  expect(f.ports.verifyOriginal).toHaveBeenCalledTimes(1);
  expect(f.ports.maintenance.status().phase).toBe('idle');
  const create = vi.mocked(f.ports.createScope).mock.calls[0]![0];
  const run = vi.mocked(f.ports.run).mock.calls[0]![0];
  expect(create.budget).toBe(run.budget);
  expect(run.ticket?.deadlineMonoMs).toBe(1_500_000);
  expect(JSON.stringify(f.service.getStatus())).not.toContain('D:');
});

it('restore绑定预读snapshot而数据generation独立，handoff后只报告待重启', async () => {
  const f = fixture();
  expect((await f.service.start('restore', document)).state).toBe('awaiting-restart');
  const c = vi.mocked(f.ports.run).mock.calls[0]![0];
  expect(c.job.snapshotId).toBe(snapshotId);
  expect(c.generation).not.toBe(snapshotId.replaceAll('-', ''));
  expect(f.ports.registerHandoff).toHaveBeenCalledTimes(1);
  expect(f.ports.requestRelaunch).toHaveBeenCalledTimes(1);
  expect(f.service.getStatus().canCancel).toBe(false);
  expect(f.service.getStatus().canRecoverOriginal).toBe(false);
});

it('doc在picker await后失效阻止后续动作', async () => {
  const f = fixture();
  let current = true;
  const choose = f.ports.chooseNative;
  f.ports.chooseNative = async (action) => {
    const selected = await choose(action);
    current = false;
    return selected;
  };
  expect((await f.service.start('restore', { isCurrent: () => current })).code).toBe(
    'stale-document',
  );
  expect(f.ports.confirmRestore).not.toHaveBeenCalled();
  expect(f.ports.createScope).not.toHaveBeenCalled();
});

it('worker取消后的迟到成功不得发布或重开操作；显式原件恢复不重跑worker', async () => {
  const f = fixture();
  const wait = deferred<void>();
  const original = f.ports.run;
  f.ports.run = vi.fn<DataTransferPorts['run']>(async (c) => {
    await wait.promise;
    return original(c);
  });
  const pending = f.service.start('backup', document);
  await flush();
  const id = f.service.getStatus().operationId;
  f.service.cancel(id, document);
  wait.resolve();
  expect((await pending).code).toBe('cancelled');
  expect(f.ports.publishBackup).not.toHaveBeenCalled();
  expect((await f.service.start('backup', document)).code).toBe('busy');
  const recovered = await f.service.recoverOriginal(id, document);
  expect(recovered.state).toBe('original-restored');
  expect(recovered.canRecoverOriginal).toBe(false);
  expect(f.ports.run).toHaveBeenCalledTimes(1);
});

it('Maintenance已有其他操作时不能取消其票据或领取恢复权限', async () => {
  const draining = deferred<void>();
  const f = fixture([
    {
      pauseForMaintenance: () => true,
      drainForMaintenance: () => draining.promise,
      prepareResumeAfterMaintenance: () => true,
      resumeAfterMaintenance: () => true,
    },
  ]);
  const other = f.ports.maintenance.acquire(100_000);
  const otherId = f.ports.maintenance.status().operationId;
  try {
    const result = await f.service.start('backup', document);
    expect(result.state).toBe('failed');
    expect(result.canRecoverOriginal).toBe(false);
    expect(f.ports.maintenance.status().operationId).toBe(otherId);
    expect(f.ports.maintenance.status().phase).toBe('draining');
    expect(f.ports.run).not.toHaveBeenCalled();
  } finally {
    draining.resolve();
    const result = await other;
    if (result.ok) f.ports.maintenance.resume(result.ticket);
  }
});

it('发布后原数据一致性失败不报告备份全链成功', async () => {
  const f = fixture();
  const verify = f.ports.verifyOriginal;
  f.ports.verifyOriginal = async (c) => ({ ...(await verify(c)), sameData: false });
  expect((await f.service.start('backup', document)).state).toBe('recovery-required');
  expect(f.ports.publishBackup).toHaveBeenCalledTimes(1);
  expect(f.ports.maintenance.status().phase).toBe('failed');
});

it('显式原件复核在等待期间到原总期限时立即保留恢复态，迟到结果不续租', async () => {
  const f = fixture();
  f.ports.verify = vi.fn<DataTransferPorts['verify']>(async () => null);
  const initial = await f.service.start('backup', document);
  const wait = deferred<void>();
  const verify = f.ports.verifyOriginal;
  f.ports.verifyOriginal = async (c) => {
    await wait.promise;
    return verify(c);
  };
  const pending = f.service.recoverOriginal(initial.operationId, document);
  await flush();
  f.advance(1_500_000);
  f.fire(1_500_000);
  expect(f.service.getStatus().state).toBe('recovery-required');
  wait.resolve();
  expect((await pending).state).toBe('recovery-required');
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it.each(['handoff', 'relaunch'] as const)(
  '%s失败保留恢复态且禁止直接恢复旧operation',
  async (stage) => {
    const f = fixture();
    if (stage === 'handoff')
      f.ports.registerHandoff = vi.fn<DataTransferPorts['registerHandoff']>(async () => {
        throw new Error('D:\\private\\failure');
      });
    else f.ports.requestRelaunch = vi.fn<DataTransferPorts['requestRelaunch']>(async () => false);
    const status = await f.service.start('restore', document);
    expect(status.state).toBe('recovery-required');
    expect(status.code).toBe(stage);
    expect(status.canRecoverOriginal).toBe(false);
    expect((await f.service.recoverOriginal(status.operationId, document)).code).toBe(stage);
    expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain('D:');
  },
);

it('20秒drain撤销不等于原始排水完成，禁止scope运行和原件恢复', async () => {
  const draining = deferred<void>();
  const f = fixture([
    {
      pauseForMaintenance: () => true,
      drainForMaintenance: () => draining.promise,
      prepareResumeAfterMaintenance: () => true,
      resumeAfterMaintenance: () => true,
    },
  ]);
  const pending = f.service.start('backup', document);
  await flush();
  f.advance(20_000);
  f.fire(20_000);
  const status = await pending;
  expect(status.code).toBe('deadline');
  expect(status.canRecoverOriginal).toBe(false);
  expect(f.ports.run).not.toHaveBeenCalled();
  expect((await f.service.recoverOriginal(status.operationId, document)).code).toBe('deadline');
  draining.resolve();
  await flush();
});

it('未确认child退出即使原始drain已完成也不能恢复旧业务', async () => {
  const f = fixture();
  f.ports.run = vi.fn<DataTransferPorts['run']>(async () => ({
    state: 'recovery-required',
    code: 'deadline',
    exitCode: null,
  }));
  f.ports.originalState = () => ({
    childrenExited: false,
    originalDrainsSettled: true,
    beforeSwitch: true,
  });
  const status = await f.service.start('backup', document);
  expect(status.state).toBe('recovery-required');
  expect(status.canRecoverOriginal).toBe(false);
  expect((await f.service.recoverOriginal(status.operationId, document)).state).toBe(
    'recovery-required',
  );
  expect(f.ports.verifyOriginal).not.toHaveBeenCalled();
});

it('跨verify await的document更换禁止发布', async () => {
  const f = fixture();
  let current = true;
  const original = f.ports.verify;
  f.ports.verify = async (c, result) => {
    const proof = await original(c, result);
    current = false;
    return proof;
  };
  expect((await f.service.start('backup', { isCurrent: () => current })).code).toBe(
    'stale-document',
  );
  expect(f.ports.publishBackup).not.toHaveBeenCalled();
});

it('取消或失败后恢复仍使用原截止时间，不能通过新请求续租', async () => {
  const f = fixture();
  f.ports.verify = vi.fn<DataTransferPorts['verify']>(async () => null);
  const status = await f.service.start('backup', document);
  f.advance(1_500_001);
  expect((await f.service.recoverOriginal(status.operationId, document)).state).toBe(
    'recovery-required',
  );
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
  expect((await f.service.start('restore', document)).code).toBe('busy');
});

it('worker结果不能借用另一个snapshot，独立文件校验不得替错误世代背书', async () => {
  const f = fixture();
  const run = f.ports.run;
  f.ports.run = async (c) => {
    const result = await run(c);
    if (result.state === 'succeeded')
      result.result.manifest.snapshotId = '22222222-2222-4222-8222-222222222222';
    return result;
  };
  expect((await f.service.start('backup', document)).state).toBe('recovery-required');
  expect(f.ports.verify).not.toHaveBeenCalled();
  expect(f.ports.publishBackup).not.toHaveBeenCalled();
});

it('handoff已开始后取消不撤回登记或触发旧代恢复', async () => {
  const f = fixture();
  const registration = deferred<boolean>();
  f.ports.registerHandoff = vi.fn<DataTransferPorts['registerHandoff']>(() => registration.promise);
  const pending = f.service.start('restore', document);
  await flush();
  const status = f.service.getStatus();
  expect(status.state).toBe('handoff');
  expect(f.service.cancel(status.operationId, document).code).toBe('none');
  expect(vi.mocked(f.ports.registerHandoff).mock.calls[0]![0].signal.aborted).toBe(false);
  registration.resolve(true);
  expect((await pending).state).toBe('awaiting-restart');
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it('shutdown永久封闭入口且等待真实picker，重复drain同一promise', async () => {
  const f = fixture();
  const choice = deferred<null>();
  f.ports.chooseNative = vi.fn(() => choice.promise);
  const start = f.service.start('backup', document);
  f.service.beginShutdown();
  const drain = f.service.drainBeforeClose();
  expect(f.service.drainBeforeClose()).toBe(drain);
  let done = false;
  void drain.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  expect((await f.service.start('backup', document)).canCancel).toBe(false);
  expect(
    (await f.service.recoverOriginal(f.service.getStatus().operationId, document))
      .canRecoverOriginal,
  ).toBe(false);
  expect(f.service.cancel(f.service.getStatus().operationId, document).canCancel).toBe(false);
  expect(f.ports.chooseNative).toHaveBeenCalledTimes(1);
  choice.resolve(null);
  await start;
  await drain;
  expect(f.ports.createScope).not.toHaveBeenCalled();
});

it('picker同步重入shutdown也已经拥有完整start promise', async () => {
  const f = fixture();
  const choice = deferred<null>();
  let drain: Promise<void> | null = null;
  f.ports.chooseNative = vi.fn(() => {
    f.service.beginShutdown();
    drain = f.service.drainBeforeClose();
    return choice.promise;
  });
  const start = f.service.start('backup', document);
  let done = false;
  void drain!.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  choice.resolve(null);
  await start;
  await drain;
  expect(f.ports.run).not.toHaveBeenCalled();
});

it('worker收到shutdown取消仍要等待原promise，迟到成功零发布', async () => {
  const f = fixture();
  const worker = deferred<void>();
  const run = f.ports.run;
  let context: TransferOperationContext | null = null;
  f.ports.run = vi.fn(async (c) => {
    context = c;
    await worker.promise;
    return run(c);
  });
  const start = f.service.start('backup', document);
  await flush();
  f.service.beginShutdown();
  expect(context!.signal.aborted).toBe(true);
  const drain = f.service.drainBeforeClose();
  let done = false;
  void drain.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  worker.resolve();
  await start;
  await drain;
  expect(f.ports.publishBackup).not.toHaveBeenCalled();
  expect(f.ports.maintenance.status().phase).toBe('failed');
});

it.each(['children', 'maintenance'] as const)(
  'shutdown原工作返回后%s未退出仍拒绝close',
  async (kind) => {
    const f = fixture();
    f.ports.run = vi.fn<DataTransferPorts['run']>(async () => ({
      state: 'failed',
      code: 'worker',
      exitCode: null,
    }));
    await f.service.start('backup', document);
    if (kind === 'children')
      f.ports.originalState = () => ({
        childrenExited: false,
        originalDrainsSettled: true,
        beforeSwitch: true,
      });
    else
      vi.spyOn(f.ports.maintenance, 'status').mockReturnValue({
        phase: 'failed',
        operationId: 'synthetic',
        pending: true,
        reason: 'cancelled',
      });
    f.service.beginShutdown();
    await expect(f.service.drainBeforeClose()).rejects.toThrow('数据维护退出未完成');
    expect(f.service.getStatus().canRecoverOriginal).toBe(false);
  },
);

it('shutdown等待显式恢复的原proof promise且禁止迟到开门', async () => {
  const f = fixture();
  const proofWait = deferred<void>();
  f.ports.run = vi.fn<DataTransferPorts['run']>(async () => ({
    state: 'failed',
    code: 'worker',
    exitCode: 2,
  }));
  const failed = await f.service.start('backup', document);
  const verify = f.ports.verifyOriginal;
  f.ports.verifyOriginal = async (c) => {
    await proofWait.promise;
    return verify(c);
  };
  const recovery = f.service.recoverOriginal(failed.operationId, document);
  f.service.beginShutdown();
  const drain = f.service.drainBeforeClose();
  let done = false;
  void drain.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  proofWait.resolve();
  await recovery;
  await drain;
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it('awaiting-restart成功handoff退出不abort且不撤回登记', async () => {
  const f = fixture();
  expect((await f.service.start('restore', document)).state).toBe('awaiting-restart');
  const context = vi.mocked(f.ports.run).mock.calls[0]![0];
  f.service.beginShutdown();
  await f.service.drainBeforeClose();
  expect(context.signal.aborted).toBe(false);
  expect(f.service.getStatus().state).toBe('awaiting-restart');
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it('原维护取消receipt先到也必须等实际participant drain，过期不延长工作账本', async () => {
  const pending = deferred<void>();
  const f = fixture([
    {
      pauseForMaintenance: () => true,
      drainForMaintenance: () => pending.promise,
      prepareResumeAfterMaintenance: () => true,
      resumeAfterMaintenance: () => true,
    },
  ]);
  const start = f.service.start('backup', document);
  await flush();
  f.service.beginShutdown();
  await start;
  const drain = f.service.drainBeforeClose();
  let done = false;
  void drain.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  f.advance(1_500_001);
  f.ports.originalState = (context) => {
    context.assertCurrent();
    return { childrenExited: true, originalDrainsSettled: true, beforeSwitch: true };
  };
  pending.resolve();
  await drain;
  expect(f.ports.run).not.toHaveBeenCalled();
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it('文档验证同步重入shutdown不能在封门后再启动原生picker', async () => {
  const f = fixture();
  const start = f.service.start('backup', {
    isCurrent: () => {
      f.service.beginShutdown();
      return true;
    },
  });
  await start;
  await f.service.drainBeforeClose();
  expect(f.ports.chooseNative).not.toHaveBeenCalled();
});

it('native恢复确认pending跨shutdown保持拥有，迟到批准不能创建scope', async () => {
  const f = fixture();
  const confirmation = deferred<boolean>();
  f.ports.confirmRestore = () => confirmation.promise;
  const start = f.service.start('restore', document);
  await flush();
  f.service.beginShutdown();
  const drain = f.service.drainBeforeClose();
  let done = false;
  void drain.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  confirmation.resolve(true);
  await start;
  await drain;
  expect(f.ports.createScope).not.toHaveBeenCalled();
});
