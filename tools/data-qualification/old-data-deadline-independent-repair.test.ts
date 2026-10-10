import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_INITIAL,
  EXPECTED_REOPEN,
  GENERATIONS,
  LIMITS,
  OPERATION_IDS,
  need,
} from './old-data-deadline/contract';
import {
  executeInitialScene,
  inspectCommittedFixture,
  inspectInterruptedFixture,
  readOracle,
  reopenScene,
  type SceneResult,
} from './old-data-deadline/fixture';
import { superviseChild, type ChildLike } from './old-data-deadline/supervisor';

const evidence = resolve('log/stage7-e2/old-data-deadline-independent-repair-001');
const runnerSource = readFileSync(
  resolve('tools/data-qualification/old-data-deadline/runner.ts'),
  'utf8',
);
const runnerAst = ts.createSourceFile('runner.ts', runnerSource, ts.ScriptTarget.Latest, true);
const predicate = runnerAst.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'expectedResult',
);
if (!predicate) throw new Error('实际runner判定函数缺失');
// Evaluate only the unchanged pure predicate; never import or invoke runner main.
const expectedResult = runInNewContext(
  ts.transpileModule(predicate.getText(runnerAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2024 },
  }).outputText + '\nexpectedResult;',
  { need },
) as (actual: SceneResult, expected: object) => void;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  connected = true;
  kills = 0;
  kill(): boolean {
    this.kills++;
    return true;
  }
  finish(code = 0, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function terminal() {
  return {
    kind: 'result',
    result: {
      scene: 'normal',
      action: 'initial',
      state: 'committed',
      code: 'ok',
      journalPhase: 'committed',
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
      selected: 0,
      waitedMs: 0,
      rollbackSpaceCalls: 1,
      rollbackSpaceBytes: 4096,
    },
    runtime: {
      nodePath: 'fixed-node',
      nodeVersion: 'v24.18.0',
      workerPath: 'fixed-worker',
      workerSha256: 'a'.repeat(64),
    },
  };
}

async function newRoot(scene: string): Promise<string> {
  const parent = await mkdtemp(join(evidence, `pure-${scene}-`));
  return join(parent, 'fixture');
}

describe('旧O期限独立审核：真实runner判定与小型文件协议', () => {
  it('正常生产文件流程结果必须被runner接受', async () => {
    const root = await newRoot('normal');
    const result = await executeInitialScene(root, 'normal', {
      wait: () => Promise.reject(new Error('正常控制禁止等待')),
    });
    await inspectCommittedFixture(root);
    await writeFile(join(dirname(root), 'actual.json'), JSON.stringify(result, null, 2));
    expect(() => expectedResult(result, EXPECTED_INITIAL.normal)).not.toThrow();
  });

  it.each(['inventory', 'backing-up'] as const)(
    '%s受控时钟耗尽及重开结果必须被runner接受',
    async (scene) => {
      let time = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => time);
      const root = await newRoot(scene);
      const selected: string[] = [];
      const initial = await executeInitialScene(root, scene, {
        now: () => time,
        selected: (value) => {
          selected.push(value);
        },
        wait: async () => {
          time += LIMITS.realDelayMs;
        },
      });
      expect(selected).toEqual([scene]);
      await inspectInterruptedFixture(root, scene, false);
      const reopened = await reopenScene(root, scene);
      await inspectInterruptedFixture(root, scene, true);
      const oracle = await readOracle(root);
      expect(oracle.operationId).toBe(OPERATION_IDS[scene]);
      expect(oracle.generation).toBe(GENERATIONS[scene]);
      expect(initial.waitedMs).toBe(LIMITS.realDelayMs);
      expect(reopened.rollbackSpaceCalls).toBe(0);
      await writeFile(
        join(dirname(root), 'actual.json'),
        JSON.stringify({ initial, reopened }, null, 2),
      );
      expect.soft(() => expectedResult(initial, EXPECTED_INITIAL[scene])).not.toThrow();
      expect.soft(() => expectedResult(reopened, EXPECTED_REOPEN[scene])).not.toThrow();
    },
  );

  it('哨兵内容漂移会拒绝，即使文件长度保持', async () => {
    let time = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const root = await newRoot('tamper');
    await executeInitialScene(root, 'inventory', {
      now: () => time,
      wait: async () => {
        time += LIMITS.realDelayMs;
      },
    });
    const oracle = await readOracle(root);
    const source = oracle.old[0]!;
    await writeFile(join(root, source.path), Buffer.alloc(source.bytes, 0));
    await expect(inspectInterruptedFixture(root, 'inventory', false)).rejects.toThrow('身份或字节');
  });
});

describe('旧O期限独立审核：child退出与stdio关闭的独立截止', () => {
  it.each([-1, 0, 1])('正常close相对原工作截止偏移%dms不另领时间', async (offset) => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const caught = observed.then(
      () => 'passed',
      () => 'failed',
    );
    child.emit('message', terminal());
    now = 100 + LIMITS.controlOrReopenMs - 2;
    child.emit('exit', 0, null);
    now = 100 + LIMITS.controlOrReopenMs + offset;
    child.connected = false;
    child.emit('close', 0, null);
    expect(await caught).toBe(offset < 0 ? 'passed' : 'failed');
  });

  it('失败后重复error不续租，原退出门到点时即拒绝', async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const child = new FakeChild();
    let outcome = 'pending';
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs).then(
      () => {
        outcome = 'passed';
      },
      () => {
        outcome = 'failed';
      },
    );
    now = 200;
    child.emit('error', new Error('first'));
    expect(child.kills).toBe(1);
    now = 200 + LIMITS.childExitMs - 1;
    child.emit('error', new Error('second'));
    await Promise.resolve();
    expect(outcome).toBe('pending');
    now = 200 + LIMITS.childExitMs;
    child.emit('error', new Error('third'));
    await observed;
    expect(outcome).toBe('failed');
    expect(child.kills).toBe(1);
  });

  it('timer迟到超过工作加退出总门也不能重新获得退出余额', async () => {
    vi.useFakeTimers();
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const caught = observed.catch((error: unknown) => error);
    now += LIMITS.controlOrReopenMs + LIMITS.childExitMs + 1;
    child.emit('message', terminal());
    expect(child.kills).toBe(1);
    expect(String(await caught)).toContain('exit/close未确认');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 99])(
    '单调时钟异常%s不能授PASS',
    async (invalid) => {
      vi.useFakeTimers();
      let now = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const child = new FakeChild();
      const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
      const caught = observed.catch((error: unknown) => error);
      now = invalid;
      child.emit('message', terminal());
      child.finish();
      expect(String(await caught)).toContain('单调时钟');
    },
  );

  it('字段或持久剩余额度漂移仍拒绝', () => {
    const actual = terminal().result as SceneResult;
    for (const invalid of [
      { state: 'old-restored' },
      { code: 'interrupted' },
      { journalPhase: 'backing-up' },
      { rollbackCopyRemaining: 1 },
      { rollbackCopyBudget: 1 },
    ])
      expect(() =>
        expectedResult({ ...actual, ...invalid } as SceneResult, EXPECTED_INITIAL.normal),
      ).toThrow();
  });

  it.each(['callback', 'factory'] as const)(
    '%s已越单调工作期限而timer未执行时不能授PASS',
    async (delay) => {
      vi.useFakeTimers();
      let now = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const child = new FakeChild();
      const observed = superviseChild(() => {
        if (delay === 'factory') now += LIMITS.controlOrReopenMs + 1;
        return child;
      }, LIMITS.controlOrReopenMs);
      if (delay === 'callback') now += LIMITS.controlOrReopenMs + 1;
      child.emit('message', terminal());
      child.finish();
      await expect(observed).rejects.toBeInstanceOf(Error);
    },
  );

  it.each([0, 2])('已有exit%d但永无close时须在工作+退出余额内拒绝', async (code) => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let outcome = 'pending';
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs).then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );
    child.emit('message', terminal());
    child.emit('exit', code, null);
    await vi.advanceTimersByTimeAsync(LIMITS.controlOrReopenMs + LIMITS.childExitMs + 1);
    try {
      expect(outcome).toBe('rejected');
    } finally {
      child.connected = false;
      child.emit('close', code, null);
      await observed;
    }
  });

  it('alive超时且永无exit/close时会在退出门拒绝', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const caught = observed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LIMITS.controlOrReopenMs + LIMITS.childExitMs + 1);
    expect(child.kills).toBe(1);
    expect(String(await caught)).toContain('实际exit/close未确认');
  });

  it('缺终态不能被exit0和close0授PASS', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.finish();
    await expect(observed).rejects.toThrow('终态不完整');
  });

  it('重复终态会保持失败', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.emit('message', terminal());
    child.emit('message', terminal());
    child.finish();
    await expect(observed).rejects.toThrow('帧校验失败');
  });

  it('输出超限不能被正常exit/close覆盖', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.stdout.write(Buffer.alloc(LIMITS.outputBytesPerChild + 1));
    child.emit('message', terminal());
    child.finish();
    await expect(observed).rejects.toThrow('输出超限');
  });

  it('exit与close退出码不一致必须拒绝', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.emit('message', terminal());
    child.emit('exit', 0, null);
    child.connected = false;
    child.emit('close', 2, null);
    await expect(observed).rejects.toThrow('退出');
  });
});
