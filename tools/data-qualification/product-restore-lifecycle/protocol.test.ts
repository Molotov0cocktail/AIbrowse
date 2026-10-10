import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrdinaryLease, verifyRetired } from './protocol.ts';
import type { Held, LeasePorts, Scope } from './protocol.ts';
import { sha256 } from '../product-restore-process/protocol.ts';

const hash = 'a'.repeat(64);
const scope: Scope = {
  runId: 'b'.repeat(32),
  initial: { pid: 10, created: '100', image: 'C:\\package\\AIbrowse.exe' },
  manifestSha256: hash,
  markerSha256: hash,
  bindingSha256: hash,
  executableSha256: hash,
  guardianSha256: hash,
  fileId128: 'c'.repeat(32),
  volumeSerial64: 'd'.repeat(16),
};
const main: Held = {
  ...scope.initial,
  imageIdentity: hash,
  parentPid: 1,
  role: 'main',
  session: null,
  signaled: false,
  exitCode: null,
  exitFileTime: null,
};
const guardian: Held = {
  ...main,
  pid: 11,
  created: '110',
  image: 'C:\\package\\resources\\lifecycle-guardian\\guardian.exe',
  parentPid: 10,
  role: 'guardian',
  session: 'e'.repeat(32),
};
const exited = (p: Held): Held => ({ ...p, signaled: true, exitCode: 0, exitFileTime: '200' });
function receipt() {
  return {
    version: 1,
    runId: scope.runId,
    initial: scope.initial,
    elapsedMs: 100,
    budgetMs: 30000,
    manifestSha256: hash,
    markerSha256: hash,
    bindingSha256: hash,
    executableSha256: hash,
    guardianSha256: hash,
    profile: {
      fileId128: scope.fileId128,
      volumeSerial64: scope.volumeSerial64,
      guardianRootHash: hash,
    },
    limits: { flags: 0x2008, total: 24, held: 4, records: 8, bytes: 2000 },
    main: exited(main),
    guardian: exited(guardian),
    ledger: { version: 1, root: hash, session: guardian.session, main: null, utility: null },
    ledgerSha256: hash,
    members: [{ pid: 20, created: '80', role: 'tool' }],
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function verify(value: unknown) {
  const raw = bytes(value);
  verifyRetired(raw, scope, main, guardian, sha256(raw));
}

describe('普通退出原生证据判定', () => {
  it('只接纳精确句柄退出、退休账本与外层工具成员', () => {
    expect(() => verify(receipt())).not.toThrow();
  });
  it.each([
    [
      'PID复用',
      (r: ReturnType<typeof receipt>) => {
        r.main.created = '101';
      },
    ],
    [
      'image漂移',
      (r: ReturnType<typeof receipt>) => {
        r.main.imageIdentity = 'f'.repeat(64);
      },
    ],
    [
      '未signal',
      (r: ReturnType<typeof receipt>) => {
        r.main.signaled = false;
      },
    ],
    [
      '非零退出',
      (r: ReturnType<typeof receipt>) => {
        r.guardian.exitCode = 1;
      },
    ],
    [
      '未知退出',
      (r: ReturnType<typeof receipt>) => {
        r.main.exitCode = null;
      },
    ],
    [
      '父子错配',
      (r: ReturnType<typeof receipt>) => {
        r.guardian.parentPid = 9;
      },
    ],
    [
      'session漂移',
      (r: ReturnType<typeof receipt>) => {
        r.ledger.session = 'f'.repeat(32);
      },
    ],
    [
      'root漂移',
      (r: ReturnType<typeof receipt>) => {
        r.ledger.root = 'f'.repeat(64);
      },
    ],
    [
      'Job残留Chromium',
      (r: ReturnType<typeof receipt>) => {
        r.members[0]!.role = 'chromium';
      },
    ],
    [
      'Job重复成员',
      (r: ReturnType<typeof receipt>) => {
        r.members.push(r.members[0]!);
      },
    ],
    [
      '外层Job预算漂移',
      (r: ReturnType<typeof receipt>) => {
        r.limits.total = 25;
      },
    ],
    [
      '迟到',
      (r: ReturnType<typeof receipt>) => {
        r.elapsedMs = 30000;
      },
    ],
    [
      '续租',
      (r: ReturnType<typeof receipt>) => {
        r.budgetMs = 30001;
      },
    ],
    [
      '包漂移',
      (r: ReturnType<typeof receipt>) => {
        r.executableSha256 = 'f'.repeat(64);
      },
    ],
  ])('%s拒绝', (_name, change) => {
    const r = receipt();
    change(r);
    expect(() => verify(r)).toThrow();
  });
  it('拒绝未退休writer账本', () => {
    const r = receipt();
    expect(() =>
      verify({ ...r, ledger: { ...r.ledger, main: { pid: 10, created: '100', image: hash } } }),
    ).toThrow();
  });
  it('拒绝重复JSON键及超帧receipt', () => {
    const raw = Buffer.from('{"version":1,"version":1}');
    expect(() => verifyRetired(raw, scope, main, guardian, sha256(raw))).toThrow();
    const large = Buffer.alloc(65537, 32);
    expect(() => verifyRetired(large, scope, main, guardian, sha256(large))).toThrow();
  });
});

function harness() {
  let listener: (frame: Buffer) => void = () => undefined;
  let close!: (value: number | null) => void;
  let receiptDone!: (value: Buffer) => void;
  let now = 0;
  const raw = bytes(receipt());
  let read: () => Promise<Buffer> = () => Promise.resolve(raw);
  const stop = vi.fn();
  const ports: LeasePorts = {
    transport: {
      send: () => Promise.resolve(),
      onFrame(fn) {
        listener = fn;
        return () => undefined;
      },
      closed: new Promise((done) => {
        close = done;
      }),
    },
    readReceipt: () => read(),
    now: () => now,
    deadline: 30000,
    stop,
  };
  const lease = new OrdinaryLease(scope, ports);
  const frame = (state: 'ready' | 'retired') =>
    listener(
      bytes({
        version: 1,
        runId: scope.runId,
        state,
        elapsedMs: 10,
        main: state === 'ready' ? main : exited(main),
        guardian: state === 'ready' ? guardian : exited(guardian),
        receiptSha256: state === 'ready' ? null : sha256(raw),
      }),
    );
  return {
    lease,
    frame,
    close,
    stop,
    time: (value: number) => {
      now = value;
    },
    blockReceipt: () => {
      read = () =>
        new Promise((done) => {
          receiptDone = done;
        });
    },
    finishReceipt: () => receiptDone(raw),
  };
}
afterEach(() => vi.useRealTimers());
describe('普通退出原Promise与child关闭所有权', () => {
  it('ready只授权关闭，retired必须等待实际child close', async () => {
    const h = harness();
    h.frame('ready');
    await h.lease.ready();
    h.frame('retired');
    let done = false;
    const retired = h.lease.retired().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(h.lease.pendingOwned).toBeGreaterThan(0);
    h.close(0);
    await retired;
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.lease.pendingOwned).toBe(0);
  });
  it('helper早退即失败', async () => {
    const h = harness();
    const ready = h.lease.ready();
    h.close(0);
    await expect(ready).rejects.toThrow();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('重复ready停止且不释放原close', async () => {
    const h = harness();
    h.frame('ready');
    await h.lease.ready();
    h.frame('ready');
    await expect.poll(() => h.stop.mock.calls.length).toBe(1);
    expect(h.lease.pendingOwned).toBeGreaterThan(0);
    h.close(2);
    await h.lease.closed;
  });
  it('未知或非零helper退出拒绝成功', async () => {
    const h = harness();
    h.frame('ready');
    await h.lease.ready();
    h.frame('retired');
    const retired = h.lease.retired();
    h.close(null);
    await expect(retired).rejects.toThrow();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('迟到ready不续租', async () => {
    const h = harness();
    const ready = h.lease.ready();
    h.time(30000);
    h.frame('ready');
    await expect(ready).rejects.toThrow();
    h.close(2);
    await h.lease.closed;
  });
  it('超时后原receipt IO和child close仍持有', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.frame('ready');
    await h.lease.ready();
    h.blockReceipt();
    h.frame('retired');
    const retired = h.lease.retired();
    const rejected = expect(retired).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    h.time(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(h.lease.pendingOwned).toBeGreaterThan(1);
    h.finishReceipt();
    h.close(2);
    await h.lease.closed;
    await Promise.resolve();
    expect(h.lease.pendingOwned).toBe(0);
  });
});
