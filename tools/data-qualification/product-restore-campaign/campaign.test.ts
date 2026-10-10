import { afterEach, expect, it, vi } from 'vitest';
import { Campaign } from './campaign';
import { LIMITS, type Ports, type Observer } from './contract';
import { verifyConfirmation, verifyUi, verifyQuiescentJob } from './ui';
import { startupBudget } from './start';
import type { Identity, Scene, AcceptedSuccessor } from '../product-restore-process/protocol';

const initial: Identity = {
  pid: 101,
  created: '133000000000000001',
  image: 'C:\\product\\AIbrowse.exe',
};
function setup(scene: Scene): { ports: Ports; events: string[] } {
  const events: string[] = [];
  let generation = 0;
  const observer: Observer = {
    ready: async () => initial,
    arm: async (seq) => {
      events.push(`arm:${seq}`);
    },
    decide: async () => {
      events.push('decide');
    },
    assertCurrent: async () => {
      events.push('current');
    },
    waitSuccessor: async () => {
      events.push('successor');
      generation++;
      return {
        identity: { ...initial, pid: 101 + generation },
        bootDeadline: performance.now() + 60_000,
      } as AcceptedSuccessor;
    },
    finish: async () => {
      events.push('observer-finish');
    },
    pendingOwned: 0,
    closed: Promise.resolve(0),
  };
  const ports: Ports = {
    now: () => performance.now(),
    stop: () => {
      events.push('stop');
    },
    prepare: async () => {
      events.push('prepare');
    },
    launch: async (kind) => {
      events.push(`launch:${kind}`);
      return { identity: initial, bootDeadline: performance.now() + 60_000 };
    },
    holdOrdinary: async () => {
      events.push('hold');
      return {
        ready: async () => {
          events.push('hold-ready');
        },
        retired: async () => {
          events.push('retired');
        },
        closed: Promise.resolve(0),
        pendingOwned: 0,
      };
    },
    assertProductGone: async () => {
      events.push('gone');
    },
    ui: async (request) => {
      events.push(request.action);
      return { mainWindowHandle: '123' };
    },
    confirm: async (request) => {
      events.push(`confirm:${request.purpose}:${request.approved}`);
    },
    observe: async () => {
      events.push('observe');
      return observer;
    },
    installB: async () => {
      events.push('install-b');
    },
    verify: async (variant, cold) => {
      events.push(`verify:${variant}:${cold}`);
    },
    verifyRecoveryEntry: async () => {
      events.push('gate');
    },
    inspectBackup: async () => {
      events.push('backup-wire');
    },
    finalBinding: async () => {
      events.push('binding');
    },
    backupA: 'A.aibak',
    backupH: 'H.aibak',
  };
  expect(['R', 'P']).toContain(scene);
  return { ports, events };
}
afterEach(() => {
  vi.useRealTimers();
});
it('writer退休不能掩盖Chromium残留，未全退出不读oracle或普通冷启', async () => {
  const { ports, events } = setup('P');
  ports.assertProductGone = async () => {
    throw new Error('Chromium仍存活');
  };
  await expect(new Campaign('P', ports).run()).rejects.toThrow();
  expect(events).toContain('observer-finish');
  expect(events).not.toContain('verify:H:false');
  expect(events).not.toContain('launch:cold');
  const good = {
    version: 1,
    hardTotalLimit: 24,
    limitFlags: 0x2008,
    sampledCounts: { main: 0, guardian: 0, chromium: 0, utility: 0, tools: 2 },
    total: 2,
    identities: [{}, {}],
  };
  expect(() => verifyQuiescentJob(Buffer.from(JSON.stringify(good)))).not.toThrow();
  for (const role of ['main', 'guardian', 'chromium', 'utility'])
    expect(() =>
      verifyQuiescentJob(
        Buffer.from(
          JSON.stringify({ ...good, sampledCounts: { ...good.sampledCounts, [role]: 1 } }),
        ),
      ),
    ).toThrow();
});
it('启动握手不续租，拒绝错绑定、预检倒退、累积耗尽及额外字段', () => {
  const expected = {
    runId: 'a'.repeat(32),
    scene: 'R' as const,
    proofSha256: 'b'.repeat(64),
    preflightLowerBound: 100,
    nodeUptimeMs: 10.5,
  };
  const good = {
    version: 1,
    runId: expected.runId,
    scene: 'R',
    proofSha256: expected.proofSha256,
    preflightElapsedMs: 120,
  };
  expect(startupBudget(Buffer.from(JSON.stringify(good)), expected)).toBe(131);
  for (const change of [
    { preflightElapsedMs: 99 },
    { preflightElapsedMs: 179990 },
    { extra: true },
    { proofSha256: 'c'.repeat(64) },
    { scene: 'P' },
  ])
    expect(() =>
      startupBudget(Buffer.from(JSON.stringify({ ...good, ...change })), expected),
    ).toThrow();
});
it.each(['R', 'P'] as const)('%s完整固定序列闭合且UI动作不超32', async (scene) => {
  const { ports, events } = setup(scene);
  const result = await new Campaign(scene, ports).run();
  expect(result.actions).toBe(scene === 'R' ? 28 : 29);
  expect(events.at(-1)).toBe('binding');
  expect(events.filter((event) => event === 'successor')).toHaveLength(scene === 'R' ? 1 : 2);
  expect(events.indexOf('confirm:restore:false')).toBeLessThan(
    events.lastIndexOf('confirm:restore:true'),
  );
  for (let i = 0; i < events.length; i++) {
    if (events[i] === 'confirm:restore:true' || events[i] === 'confirm:partial:true')
      expect(events[i - 1]).toMatch(/^arm:/u);
  }
  if (scene === 'R') expect(events.indexOf('retired')).toBeLessThan(events.indexOf('install-b'));
  else expect(events.indexOf('gate')).toBeLessThan(events.indexOf('confirm:restore:true'));
  expect(events.lastIndexOf('observer-finish')).toBeLessThan(events.indexOf('launch:cold'));
});
it('退休失败不能安装B或发起后继，不能用主进程退出冒充writer已退役', async () => {
  const { ports, events } = setup('R');
  ports.holdOrdinary = async () => ({
    ready: async () => {},
    retired: async () => {
      throw new Error('未知guardian退出');
    },
    closed: Promise.resolve(1),
    pendingOwned: 0,
  });
  await expect(new Campaign('R', ports).run()).rejects.toThrow();
  expect(events).not.toContain('install-b');
  expect(events).not.toContain('observe');
});
it('原生批准回执失败不写decide、不接纳后继、不手工冷启', async () => {
  const { ports, events } = setup('P');
  ports.confirm = async (request) => {
    if (request.approved) throw new Error('原件不符');
  };
  await expect(new Campaign('P', ports).run()).rejects.toThrow();
  expect(events).not.toContain('decide');
  expect(events).not.toContain('launch:cold');
});
it('后继首次UI继承boot绝对期限，迟到不继续读取四域', async () => {
  const { ports, events } = setup('R');
  const original = ports.observe;
  ports.observe = async (...args) => ({
    ...(await original(...args)),
    waitSuccessor: async () =>
      ({ identity: initial, bootDeadline: performance.now() - 1 }) as AcceptedSuccessor,
  });
  await expect(new Campaign('R', ports).run()).rejects.toThrow();
  expect(events).not.toContain('ReadSources');
});
it('离线总180秒不因新命令续租，迟到完成不能成功', async () => {
  const { ports, events } = setup('R');
  let time = 0;
  ports.now = () => time;
  ports.prepare = async () => {
    time += 170_000;
  };
  ports.inspectBackup = async () => {
    time += 10_001;
  };
  await expect(new Campaign('R', ports).run()).rejects.toThrow();
  expect(events).not.toContain('install-b');
});
it('逻辑超时仍持有原Promise直到实际结算', async () => {
  vi.useFakeTimers();
  const { ports } = setup('R');
  let done!: () => void;
  ports.prepare = () =>
    new Promise<void>((resolve) => {
      done = resolve;
    });
  const campaign = new Campaign('R', ports);
  const outcome = campaign.run().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(LIMITS.offline + 1);
  await outcome;
  expect(campaign.pending.size).toBe(1);
  done();
  await Promise.resolve();
  await Promise.resolve();
  expect(campaign.pending.size).toBe(0);
});
it('确认闭合回执拒绝额外字段、错目的、两次动作、迟到与取消冒批准', () => {
  const request = {
    scene: 'R',
    transition: 1,
    sequence: 16,
    purpose: 'restore',
    approved: true,
    identity: initial,
    mainWindowHandle: '123',
    deadline: 100_000,
  } as const;
  const good = {
    version: 1,
    scene: 'R',
    transition: 1,
    actionSequence: 16,
    purpose: 'restore',
    result: 'approved',
    ok: true,
    actionCount: 1,
    elapsedMs: 5,
    failure: 'none',
  };
  expect(() => verifyConfirmation(Buffer.from(JSON.stringify(good)), request)).not.toThrow();
  for (const change of [
    { extra: true },
    { purpose: 'partial' },
    { actionCount: 2 },
    { elapsedMs: 30_000 },
    { result: 'cancelled' },
    { ok: false },
  ])
    expect(() =>
      verifyConfirmation(Buffer.from(JSON.stringify({ ...good, ...change })), request),
    ).toThrow();
  expect(() =>
    verifyConfirmation(
      Buffer.from(JSON.stringify(good).replace('"ok":true', '"ok":true,"ok":true')),
      request,
    ),
  ).toThrow();
});
it('UI不能用同PID异创建或字符串成功越过同身份门', () => {
  const request = {
    scene: 'R',
    sequence: 1,
    action: 'BootHealthy',
    identity: initial,
    deadline: 1000,
  } as const;
  const good = {
    version: 1,
    scene: 'R',
    actionSequence: 1,
    action: 'BootHealthy',
    ok: true,
    identity: initial,
    mainWindowHandle: '123',
    elapsedMs: 10,
    failure: 'none',
  };
  expect(verifyUi(Buffer.from(JSON.stringify(good)), request).mainWindowHandle).toBe('123');
  for (const change of [
    { identity: { ...initial, created: '133000000000000002' } },
    { ok: 'true' },
    { action: 'Close' },
    { mainWindowHandle: '0' },
    { failure: 'unknown' },
  ])
    expect(() => verifyUi(Buffer.from(JSON.stringify({ ...good, ...change })), request)).toThrow();
});
