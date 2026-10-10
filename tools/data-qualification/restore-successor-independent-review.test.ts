import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sha256,
  SuccessorClient,
  type Frame,
  type HeldIdentity,
  type Identity,
  type Scope,
  type Transport,
} from './product-restore-process/protocol.ts';

const hash = 'a'.repeat(64);
const image = 'D:\\synthetic\\AIbrowse.exe';
const guardianImage = 'D:\\synthetic\\resources\\lifecycle-guardian\\guardian.exe';
const origin = 133000000000000000n;
const initial: Identity = { pid: 10, created: origin.toString(), image };
const scope: Scope = {
  runId: '1'.repeat(32),
  scene: 'R',
  initial,
  executableSha256: hash,
  guardianSha256: hash,
  bindingSha256: hash,
  manifestSha256: hash,
  markerSha256: hash,
  fileId128: '4'.repeat(32),
  volumeSerial64: '5'.repeat(16),
};
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function held(
  pid: number,
  role: HeldIdentity['role'],
  parentPid: number,
  creation: number,
  exit: number | null,
  session: string | null,
): HeldIdentity {
  return {
    pid,
    role,
    parentPid,
    created: (origin + BigInt(creation)).toString(),
    image: role === 'guardian' ? guardianImage : image,
    imageIdentity: hash,
    session,
    registeredWriter: false,
    signaled: exit !== null,
    exitCode: exit === null ? null : 0,
    exitFileTime: exit === null ? null : (origin + BigInt(exit)).toString(),
  };
}
function proof(approvalSha: string) {
  const oldMain = held(10, 'main', 1, 0, 100, null);
  const oldGuardian = held(11, 'guardian', 10, 10, 200, '2'.repeat(32));
  const newMain = held(20, 'main', 11, 150, null, null);
  const newGuardian = held(21, 'guardian', 20, 160, null, '3'.repeat(32));
  return {
    version: 1,
    runId: scope.runId,
    scene: 'R',
    transition: 1,
    kind: 'transition',
    elapsedMs: 1000,
    budgetMs: 120000,
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
    limits: { flags: 0x2008, total: 24, held: 5, records: 5, bytes: 1000 },
    sample: {
      main: 1,
      guardian: 1,
      chromium: 0,
      utility: 0,
      tools: 1,
      members: [
        { pid: 20, created: newMain.created, role: 'main' },
        { pid: 21, created: newGuardian.created, role: 'guardian' },
        { pid: 1, created: (origin - 100n).toString(), role: 'tool' },
      ],
    },
    facts: {
      oldMain,
      oldGuardian,
      newMain,
      newGuardian,
      heldUtilities: [],
      uncaptured: [],
      utilityCoverage: 'held-observations-plus-guardian-retirement',
      oldSession: oldGuardian.session,
      newSession: newGuardian.session,
      ledger: {
        version: 1,
        root: hash,
        session: newGuardian.session,
        main: { pid: 20, created: newMain.created, image: hash },
        utility: null,
      },
      ledgerSha256: hash,
      approval: { sequence: 1, sha256: approvalSha },
      successorSeenMs: 1000,
    },
  };
}
async function prepared() {
  vi.useFakeTimers();
  let now = 0;
  let listener: ((value: Buffer) => void) | undefined;
  let close!: (code: number) => void;
  const evidence = new Map<string, Buffer>();
  const stop = vi.fn();
  const transport: Transport = {
    send: async () => undefined,
    onFrame(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    closed: new Promise<number>((resolve) => {
      close = resolve;
    }),
  };
  const client = new SuccessorClient(scope, {
    transport,
    readEvidence: async (name) => {
      const value = evidence.get(name);
      if (!value) throw new Error('独立夹具缺少原件');
      return value;
    },
    now: () => now,
    deadline: 120000,
    stop,
  });
  function emit(
    state: Frame['state'],
    sequence: number,
    transition: number,
    current: Identity = initial,
    receiptSha256: string | null = null,
  ): void {
    listener?.(
      encode({
        version: 1,
        runId: scope.runId,
        scene: 'R',
        transition,
        sequence,
        state,
        elapsedMs: sequence,
        receiptSha256,
        current,
        failure: null,
      }),
    );
  }
  emit('ready', 0, 0);
  await client.ready();
  const arm = client.arm(1);
  emit('armed', 1, 1);
  await arm;
  const approval = encode({
    version: 1,
    runId: scope.runId,
    scene: 'R',
    transition: 1,
    actionSequence: 1,
    purpose: 'restore',
    result: 'approved',
    nativeReceiptSha256: hash,
  });
  evidence.set('../restore-native/R-t1-a1.json', approval);
  const deciding = client.decide('approved');
  await flush();
  emit('approved', 2, 1);
  await deciding;
  const value = proof(sha256(approval));
  const raw = encode(value);
  evidence.set('t1-transition.json', raw);
  const next: Identity = { pid: 20, created: value.facts.newMain.created, image };
  return {
    client,
    stop,
    next,
    setNow(value: number) {
      now = value;
    },
    accept() {
      emit('accepted', 2, 1, next, sha256(raw));
    },
    async close() {
      close(2);
      await client.closed;
      await flush();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('后继身份独立截止反例', () => {
  it('及时交付的完整证据返回新身份和原boot期限', async () => {
    const h = await prepared();
    h.setNow(2000);
    const accepted = h.client.waitSuccessor();
    h.accept();
    expect(await accepted).toMatchObject({ identity: h.next, bootDeadline: 61000 });
    expect(h.stop).not.toHaveBeenCalled();
    await h.close();
  });
  it('原场景已截止时保留旧身份', async () => {
    const h = await prepared();
    h.setNow(120001);
    h.accept();
    await flush();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.client.identity).toEqual(initial);
    await h.close();
  });
  it('原场景尚有余额但boot已截止的迟到回执不得收养新身份', async () => {
    const h = await prepared();
    h.setNow(61001);
    h.accept();
    await flush();
    const identityBeforeClose = h.client.identity;
    expect(h.stop).toHaveBeenCalledOnce();
    await h.close();
    expect(identityBeforeClose).toEqual(initial);
    expect(h.client.pendingOwned).toBe(0);
  });
});
