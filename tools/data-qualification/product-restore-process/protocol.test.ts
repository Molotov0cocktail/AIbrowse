import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeApproval,
  decodeFrame,
  decodeLedger,
  sha256,
  SuccessorClient,
  verifyFinal,
  verifyTransition,
  type Frame,
  type HeldIdentity,
  type Identity,
  type Scope,
  type Transport,
} from './protocol.ts';

const hash = 'a'.repeat(64),
  newHash = 'b'.repeat(64),
  run = '1'.repeat(32),
  oldSession = '2'.repeat(32),
  newSession = '3'.repeat(32);
const exe = 'D:\\package\\AIbrowse.exe',
  guardianExe = 'D:\\package\\resources\\lifecycle-guardian\\guardian.exe';
const t = 133000000000000001n;
function held(
  pid: number,
  role: HeldIdentity['role'],
  parentPid: number,
  offset: number,
  exit: number | null,
  session: string | null = null,
): HeldIdentity {
  return {
    pid,
    role,
    parentPid,
    created: (t + BigInt(offset)).toString(),
    image: role === 'guardian' ? guardianExe : exe,
    imageIdentity: role === 'guardian' ? newHash : hash,
    session,
    registeredWriter: role === 'utility',
    signaled: exit !== null,
    exitCode: exit === null ? null : 0,
    exitFileTime: exit === null ? null : (t + BigInt(exit)).toString(),
  };
}
const first = held(10, 'main', 1, 0, 100);
const scope: Scope = {
  runId: run,
  scene: 'R',
  initial: { pid: first.pid, created: first.created, image: first.image },
  executableSha256: hash,
  guardianSha256: newHash,
  bindingSha256: hash,
  manifestSha256: hash,
  markerSha256: hash,
  fileId128: '4'.repeat(32),
  volumeSerial64: '5'.repeat(16),
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(scene: 'R' | 'P' = 'R', transition = 1) {
  const oldMain = structuredClone(first),
    oldGuardian = held(11, 'guardian', 10, 10, 200, oldSession),
    newMain = held(20, 'main', 11, 150, null),
    newGuardian = held(21, 'guardian', 20, 160, null, newSession);
  return {
    version: 1,
    runId: run,
    scene,
    transition,
    kind: 'transition',
    elapsedMs: 100,
    budgetMs: 1000,
    manifestSha256: hash,
    markerSha256: hash,
    bindingSha256: hash,
    executableSha256: hash,
    guardianSha256: newHash,
    profile: {
      fileId128: scope.fileId128,
      volumeSerial64: scope.volumeSerial64,
      guardianRootHash: hash,
    },
    limits: { flags: 0x2008, total: 24, held: 8, records: 12, bytes: 2000 },
    sample: {
      main: 1,
      guardian: 1,
      chromium: 0,
      utility: 0,
      tools: 1,
      members: [
        { pid: 20, created: newMain.created, role: 'main' },
        { pid: 21, created: newGuardian.created, role: 'guardian' },
        { pid: 1, created: (t - 100n).toString(), role: 'tool' },
      ],
    },
    facts: {
      oldMain,
      oldGuardian,
      newMain,
      newGuardian,
      heldUtilities: [held(12, 'utility', 10, 20, 90)],
      uncaptured: [] as Array<{
        pid: number;
        created: string;
        role: string;
        classification: string;
        exitCode: null;
      }>,
      utilityCoverage: 'held-observations-plus-guardian-retirement',
      oldSession,
      newSession,
      ledger: {
        version: 1,
        root: hash,
        session: newSession,
        main: { pid: 20, created: newMain.created, image: hash },
        utility: null,
      },
      ledgerSha256: hash,
      approval: { sequence: 1, sha256: hash },
      successorSeenMs: 50,
    },
  };
}
function validate(proof = fixture()) {
  const raw = bytes(proof);
  return verifyTransition(
    raw,
    { ...scope, scene: proof.scene },
    proof.transition,
    scope.initial,
    1,
    hash,
    sha256(raw),
  );
}
function frame(
  state: Frame['state'],
  sequence = 0,
  transition = 0,
  current: Identity = scope.initial,
): Frame {
  return {
    version: 1,
    runId: run,
    scene: 'R',
    transition,
    sequence,
    state,
    elapsedMs: sequence,
    receiptSha256: null,
    current: { pid: current.pid, created: current.created, image: current.image },
    failure: null,
  };
}

describe('恢复后继独立证据判定', () => {
  it('接受完整组合证据；新guardian早于旧guardian退出是合法重叠', () => {
    const proof = fixture();
    expect(BigInt(proof.facts.newGuardian.created)).toBeLessThan(
      BigInt(proof.facts.oldGuardian.exitFileTime!),
    );
    expect(validate(proof).identity.pid).toBe(20);
  });
  it('短命utility未采到时保持间接覆盖和unknown退出', () => {
    const proof = fixture();
    proof.facts.heldUtilities = [];
    proof.facts.uncaptured.push({
      pid: 12,
      created: (t + 20n).toString(),
      role: 'transfer',
      classification: 'not-held',
      exitCode: null,
    });
    expect(validate(proof).utilityCoverage).toBe('held-observations-plus-guardian-retirement');
    proof.facts.oldGuardian.exitCode = 2;
    expect(() => validate(proof)).toThrow();
  });
  const changes: Array<[string, (proof: ReturnType<typeof fixture>) => void]> = [
    [
      'PID复用不同FILETIME',
      (p) => {
        p.facts.oldMain.created = (t + 1n).toString();
      },
    ],
    [
      '新main错误父系',
      (p) => {
        p.facts.newMain.parentPid = 999;
      },
    ],
    [
      '新guardian错误父系',
      (p) => {
        p.facts.newGuardian.parentPid = 999;
      },
    ],
    [
      '错root',
      (p) => {
        p.facts.ledger.root = newHash;
      },
    ],
    [
      '错nonce',
      (p) => {
        p.facts.newGuardian.session = oldSession;
      },
    ],
    [
      '账本复用旧nonce',
      (p) => {
        p.facts.ledger.session = oldSession;
      },
    ],
    [
      '映像路径替换',
      (p) => {
        p.facts.newMain.image = 'D:\\other\\AIbrowse.exe';
      },
    ],
    [
      '将内容SHA当image身份',
      (p) => {
        p.facts.ledger.main.image = newHash;
      },
    ],
    [
      '旧main未signal',
      (p) => {
        p.facts.oldMain.signaled = false;
        p.facts.oldMain.exitCode = null;
        p.facts.oldMain.exitFileTime = null;
      },
    ],
    [
      '旧guardian未signal',
      (p) => {
        p.facts.oldGuardian.signaled = false;
        p.facts.oldGuardian.exitCode = null;
        p.facts.oldGuardian.exitFileTime = null;
      },
    ],
    [
      '已持utility未signal',
      (p) => {
        p.facts.heldUtilities[0]!.signaled = false;
        p.facts.heldUtilities[0]!.exitCode = null;
        p.facts.heldUtilities[0]!.exitFileTime = null;
      },
    ],
    [
      'guardian非0',
      (p) => {
        p.facts.oldGuardian.exitCode = 2;
      },
    ],
    [
      'main非0',
      (p) => {
        p.facts.oldMain.exitCode = 2;
      },
    ],
    [
      'utility非0',
      (p) => {
        p.facts.heldUtilities[0]!.exitCode = 2;
      },
    ],
    [
      '旧main未退出就创建新main',
      (p) => {
        p.facts.oldMain.exitFileTime = p.facts.newMain.created;
      },
    ],
    [
      '超出精确父生命周期',
      (p) => {
        p.facts.oldGuardian.exitFileTime = (t + 149n).toString();
      },
    ],
    [
      'utility晚于新main退出',
      (p) => {
        p.facts.heldUtilities[0]!.exitFileTime = (t + 151n).toString();
      },
    ],
    [
      'newguardian先于newmain',
      (p) => {
        p.facts.newGuardian.created = (t + 149n).toString();
      },
    ],
    [
      '原生限额被放大',
      (p) => {
        p.limits.total = 25;
      },
    ],
    [
      '持有身份超过预算',
      (p) => {
        p.limits.held = 129;
      },
    ],
    [
      '状态记录超过预算',
      (p) => {
        p.limits.records = 513;
      },
    ],
    [
      '状态字节超过预算',
      (p) => {
        p.limits.bytes = 2097153;
      },
    ],
    [
      '错动作序号',
      (p) => {
        p.facts.approval.sequence = 2;
      },
    ],
    [
      '错批准原件',
      (p) => {
        p.facts.approval.sha256 = newHash;
      },
    ],
    [
      '超出boot60秒',
      (p) => {
        p.elapsedMs = 60100;
        p.budgetMs = 100000;
      },
    ],
    [
      '累计期限过期',
      (p) => {
        p.elapsedMs = 1000;
      },
    ],
  ];
  it.each(changes)('拒绝%s', (_name, change) => {
    const p = fixture();
    change(p);
    expect(() => validate(p)).toThrow();
  });
  it('完整FILETIME使用BigInt；一单位边界可甄别', () => {
    const p = fixture();
    p.facts.oldMain.exitFileTime = (BigInt(p.facts.newMain.created) - 1n).toString();
    expect(() => validate(p)).not.toThrow();
    p.facts.oldMain.exitFileTime = p.facts.newMain.created;
    expect(() => validate(p)).toThrow();
  });
  it('Chromium utility保留非0退出码；未知signal仍拒绝', () => {
    const p = fixture();
    const utility = p.facts.heldUtilities[0]!;
    utility.registeredWriter = false;
    utility.exitCode = 91;
    expect(() => validate(p)).not.toThrow();
    utility.signaled = false;
    utility.exitCode = null;
    utility.exitFileTime = null;
    expect(() => validate(p)).toThrow();
  });
  it('拒绝第三guardian和其它未知证明字段', () => {
    const p = { ...fixture(), thirdGuardian: held(22, 'guardian', 20, 170, null, newSession) };
    const raw = bytes(p);
    expect(() => verifyTransition(raw, scope, 1, scope.initial, 1, hash, sha256(raw))).toThrow();
  });
  it('拒绝ledger残缺、未知字段、混合代', () => {
    const p = fixture();
    expect(() => decodeLedger({ ...p.facts.ledger, unknown: true })).toThrow();
    expect(() =>
      decodeLedger({
        version: 1,
        root: hash,
        session: newSession,
        main: null,
        utility: { role: 'transfer', pid: 12, created: (t + 20n).toString(), image: hash },
      }),
    ).toThrow();
    expect(() =>
      decodeLedger({ version: 1, root: hash, session: newSession, main: p.facts.ledger.main }),
    ).toThrow();
  });
  it('拒绝截断、重复字段、无损精度转number、超过4KiB帧', () => {
    expect(() => decodeFrame(Buffer.from('{"version":1'))).toThrow();
    const raw = JSON.stringify(frame('ready')).replace('"version":1', '"version":1,"version":1');
    expect(() => decodeFrame(Buffer.from(raw))).toThrow();
    expect(() =>
      decodeFrame(
        bytes({
          ...frame('ready'),
          current: { ...scope.initial, created: Number(scope.initial.created) },
        }),
      ),
    ).toThrow();
    expect(() => decodeFrame(bytes({ ...frame('ready'), extra: 'x'.repeat(4096) }))).toThrow();
  });
  it('原件hash不同即拒绝', () => {
    expect(() =>
      verifyTransition(bytes(fixture()), scope, 1, scope.initial, 1, hash, newHash),
    ).toThrow();
  });
  it('P首次partial与第二次restore的批准不可互换', () => {
    const approval = {
      version: 1,
      runId: run,
      scene: 'P',
      transition: 1,
      actionSequence: 7,
      purpose: 'partial',
      result: 'approved',
      nativeReceiptSha256: hash,
    };
    expect(() =>
      decodeApproval(bytes(approval), { ...scope, scene: 'P' }, 1, 7, 'approved'),
    ).not.toThrow();
    expect(() =>
      decodeApproval(bytes(approval), { ...scope, scene: 'P' }, 2, 7, 'approved'),
    ).toThrow();
    expect(() =>
      decodeApproval(
        bytes({ ...approval, transition: 2 }),
        { ...scope, scene: 'P' },
        2,
        7,
        'approved',
      ),
    ).toThrow();
  });
  it('最终关闭必须有最后一代持久null/null及全部已持writer退出', () => {
    const p = fixture();
    const main = {
      ...p.facts.newMain,
      signaled: true,
      exitCode: 0,
      exitFileTime: (t + 300n).toString(),
    };
    const guardian = {
      ...p.facts.newGuardian,
      signaled: true,
      exitCode: 0,
      exitFileTime: (t + 310n).toString(),
    };
    const final = {
      ...p,
      kind: 'final',
      sample: { main: 0, guardian: 0, chromium: 0, utility: 0, tools: 0, members: [] },
      facts: {
        currentMain: main,
        currentGuardian: guardian,
        ledger: { ...p.facts.ledger, main: null },
        ledgerSha256: hash,
        held: [main, guardian] as HeldIdentity[],
        utilityCoverage: 'held-observations-plus-guardian-retirement',
      },
    };
    let raw = bytes(final);
    expect(() => verifyFinal(raw, scope, 1, main, guardian, sha256(raw))).not.toThrow();
    final.facts.held.push({ ...held(30, 'utility', 20, 200, null) });
    raw = bytes(final);
    expect(() => verifyFinal(raw, scope, 1, main, guardian, sha256(raw))).toThrow();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness(scene: 'R' | 'P' = 'R') {
  vi.useFakeTimers();
  let listener: ((bytes: Buffer) => void) | null = null;
  const closed = deferred<number | null>();
  const sent: Array<Record<string, unknown>> = [];
  const stop = vi.fn(),
    detach = vi.fn();
  const evidence = new Map<string, Buffer>();
  const transport: Transport = {
    closed: closed.promise,
    onFrame(value) {
      listener = value;
      return () => {
        listener = null;
        detach();
      };
    },
    send: vi.fn(async (text) => {
      sent.push(JSON.parse(text) as Record<string, unknown>);
    }),
  };
  const read = vi.fn(async (name: string) => {
    const value = evidence.get(name);
    if (!value) throw new Error('原件缺失');
    return value;
  });
  const client = new SuccessorClient(
    { ...scope, scene },
    { transport, readEvidence: read, now: () => Date.now(), deadline: Date.now() + 1000, stop },
  );
  return {
    client,
    closed,
    sent,
    stop,
    detach,
    evidence,
    read,
    transport,
    emit(value: Frame) {
      listener?.(bytes({ ...value, scene }));
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('闭合协议与原Promise归属', () => {
  it('准入超时不释放helper原始所有权；关闭才归零', async () => {
    const h = harness();
    const ready = h.client.ready();
    const rejection = expect(ready).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(h.client.pendingOwned).toBe(2);
    h.closed.resolve(2);
    await h.client.closed;
    await flush();
    expect(h.client.pendingOwned).toBe(0);
    expect(h.detach).toHaveBeenCalledTimes(1);
  });
  it('晚到批准不收养；关闭前仍持有原命令和helper Promise', async () => {
    const h = harness();
    h.emit(frame('ready'));
    await h.client.ready();
    const arm = h.client.arm(1);
    h.emit(frame('armed', 1, 1));
    await arm;
    const approval = {
      version: 1,
      runId: run,
      scene: 'R',
      transition: 1,
      actionSequence: 1,
      purpose: 'restore',
      result: 'approved',
      nativeReceiptSha256: hash,
    };
    h.evidence.set('../restore-native/R-t1-a1.json', bytes(approval));
    const pending = h.client.decide('approved');
    const result = expect(pending).rejects.toThrow();
    await flush();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.client.pendingOwned).toBeGreaterThanOrEqual(2);
    h.emit(frame('approved', 2, 1));
    await flush();
    expect(h.client.identity).toEqual(scope.initial);
    h.closed.resolve(0);
    await h.client.closed;
    await flush();
    expect(h.client.pendingOwned).toBe(0);
    expect(h.detach).toHaveBeenCalledTimes(1);
  });
  it('超时中的原件读取保持owned直到真实settle', async () => {
    const h = harness();
    h.emit(frame('ready'));
    await h.client.ready();
    const arm = h.client.arm(1);
    h.emit(frame('armed', 1, 1));
    await arm;
    const read = deferred<Buffer>();
    h.read.mockImplementationOnce(() => read.promise);
    const work = h.client.decide('approved');
    const rejection = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(h.client.pendingOwned).toBeGreaterThanOrEqual(2);
    h.closed.resolve(2);
    await h.client.closed;
    expect(h.client.pendingOwned).toBe(1);
    read.resolve(Buffer.from('{}'));
    await flush();
    expect(h.client.pendingOwned).toBe(0);
  });
  it('取消后出现后继拒绝，不把另一PID设为当前', async () => {
    const h = harness();
    h.emit(frame('ready'));
    await h.client.ready();
    const arm = h.client.arm(1);
    h.emit(frame('armed', 1, 1));
    await arm;
    h.evidence.set(
      '../restore-native/R-t1-a1.json',
      bytes({
        version: 1,
        runId: run,
        scene: 'R',
        transition: 1,
        actionSequence: 1,
        purpose: 'restore',
        result: 'cancelled',
        nativeReceiptSha256: hash,
      }),
    );
    const cancelled = h.client.decide('cancelled');
    await flush();
    h.emit(frame('cancelled', 2, 1));
    await cancelled;
    h.emit({
      ...frame('accepted', 2, 1, { pid: 20, created: (t + 150n).toString(), image: exe }),
      receiptSha256: hash,
    });
    await flush();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.client.identity).toEqual(scope.initial);
    h.closed.resolve(2);
    await h.client.closed;
  });
  it.each(['runId', 'sequence', 'transition'] as const)('拒绝错误%s', async (key) => {
    const h = harness();
    const f = frame('ready');
    const bad = { ...f, [key]: key === 'runId' ? '9'.repeat(32) : 5 };
    h.emit(bad);
    await flush();
    expect(h.stop).toHaveBeenCalled();
    h.closed.resolve(2);
    await h.client.closed;
  });
  it('R禁止第二次交接；原件已验证后才公布新identity', async () => {
    const h = harness();
    h.emit(frame('ready'));
    await h.client.ready();
    const arm = h.client.arm(1);
    expect(() => h.client.arm(2)).toThrow();
    h.emit(frame('armed', 1, 1));
    await arm;
    const a = bytes({
      version: 1,
      runId: run,
      scene: 'R',
      transition: 1,
      actionSequence: 1,
      purpose: 'restore',
      result: 'approved',
      nativeReceiptSha256: hash,
    });
    h.evidence.set('../restore-native/R-t1-a1.json', a);
    const approved = h.client.decide('approved');
    await flush();
    h.emit(frame('approved', 2, 1));
    await approved;
    const p = fixture();
    p.facts.approval.sha256 = sha256(a);
    const raw = bytes(p);
    h.evidence.set('t1-transition.json', raw);
    const waiting = h.client.waitSuccessor();
    h.emit({ ...frame('accepted', 2, 1, p.facts.newMain), receiptSha256: sha256(raw) });
    expect(h.client.identity).toEqual(scope.initial);
    expect((await waiting).identity.pid).toBe(20);
    expect(() => h.client.arm(2)).toThrow();
    h.closed.resolve(2);
    await h.client.closed;
  });
  it('P两次交接连续绑定上一身份，最终close后归零且禁止第三次', async () => {
    const h = harness('P');
    h.emit(frame('ready'));
    await h.client.ready();
    let previous: Identity = scope.initial;
    let last = fixture('P', 1);
    for (const transition of [1, 2]) {
      const arm = h.client.arm(transition);
      h.emit(frame('armed', transition * 2 - 1, transition, previous));
      await arm;
      const approval = bytes({
        version: 1,
        runId: run,
        scene: 'P',
        transition,
        actionSequence: transition,
        purpose: transition === 1 ? 'partial' : 'restore',
        result: 'approved',
        nativeReceiptSha256: hash,
      });
      h.evidence.set(`../restore-native/P-t${transition}-a${transition}.json`, approval);
      const approved = h.client.decide('approved');
      await flush();
      h.emit(frame('approved', transition * 2, transition, previous));
      await approved;
      const proof = fixture('P', transition);
      if (transition === 2) {
        proof.facts.oldMain = {
          ...last.facts.newMain,
          signaled: true,
          exitCode: 0,
          exitFileTime: (t + 300n).toString(),
        };
        proof.facts.oldGuardian = {
          ...last.facts.newGuardian,
          signaled: true,
          exitCode: 0,
          exitFileTime: (t + 400n).toString(),
        };
        proof.facts.newMain = held(30, 'main', 21, 350, null);
        proof.facts.newGuardian = held(31, 'guardian', 30, 360, null, '6'.repeat(32));
        proof.facts.heldUtilities = [held(22, 'utility', 20, 200, 290)];
        proof.facts.oldSession = newSession;
        proof.facts.newSession = '6'.repeat(32);
        proof.facts.ledger = {
          version: 1,
          root: hash,
          session: '6'.repeat(32),
          main: { pid: 30, created: (t + 350n).toString(), image: hash },
          utility: null,
        };
        proof.sample.members = [
          { pid: 30, created: proof.facts.newMain.created, role: 'main' },
          { pid: 31, created: proof.facts.newGuardian.created, role: 'guardian' },
          { pid: 1, created: (t - 100n).toString(), role: 'tool' },
        ];
      }
      proof.facts.approval = { sequence: transition, sha256: sha256(approval) };
      const raw = bytes(proof);
      h.evidence.set(`t${transition}-transition.json`, raw);
      const waiting = h.client.waitSuccessor();
      h.emit({
        ...frame('accepted', transition * 2, transition, proof.facts.newMain),
        receiptSha256: sha256(raw),
      });
      const accepted = await waiting;
      expect(accepted.bootDeadline).toBeLessThanOrEqual(Date.now() + 1000);
      previous = accepted.identity;
      last = proof;
    }
    expect(() => h.client.arm(3)).toThrow();
    const main = {
      ...last.facts.newMain,
      signaled: true,
      exitCode: 0,
      exitFileTime: (t + 500n).toString(),
    };
    const guardian = {
      ...last.facts.newGuardian,
      signaled: true,
      exitCode: 0,
      exitFileTime: (t + 510n).toString(),
    };
    const final = {
      ...last,
      kind: 'final',
      sample: { main: 0, guardian: 0, chromium: 0, utility: 0, tools: 0, members: [] },
      facts: {
        currentMain: main,
        currentGuardian: guardian,
        ledger: { ...last.facts.ledger, main: null },
        ledgerSha256: hash,
        held: [main, guardian],
        utilityCoverage: 'held-observations-plus-guardian-retirement',
      },
    };
    const raw = bytes(final);
    h.evidence.set('t2-final.json', raw);
    const finished = h.client.finish();
    h.emit({ ...frame('finished', 5, 2, previous), receiptSha256: sha256(raw) });
    await flush();
    expect(h.client.pendingOwned).toBeGreaterThan(0);
    h.closed.resolve(0);
    await finished;
    await flush();
    expect(h.client.pendingOwned).toBe(0);
    expect(h.stop).not.toHaveBeenCalled();
  });
});
