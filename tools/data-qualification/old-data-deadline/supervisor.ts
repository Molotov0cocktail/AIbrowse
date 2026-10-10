import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { LIMITS, need, type Scene, type WorkerAction } from './contract';
import type { SceneResult } from './fixture';

export interface RuntimeProof {
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly workerPath: string;
  readonly workerSha256: string;
}
export interface WorkerTerminal {
  readonly kind: 'result';
  readonly result: SceneResult;
  readonly runtime: RuntimeProof;
}
interface SelectedFrame {
  readonly kind: 'selected';
  readonly phase: 'inventory' | 'backing-up';
}
type WorkerFrame = SelectedFrame | WorkerTerminal;

export interface ChildLike {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface ChildObservation {
  readonly terminal: WorkerTerminal;
  readonly selected: readonly SelectedFrame[];
  readonly exitCode: number;
  readonly outputBytes: number;
  readonly exitObserved: true;
  readonly closeObserved: true;
}

function record(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value), 'worker帧不是闭合对象');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  need(
    Object.keys(value).sort().join('|') === [...expected].sort().join('|'),
    'worker帧字段不闭合',
  );
}
function parseFrame(value: unknown): WorkerFrame {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  need(bytes > 0 && bytes <= LIMITS.frameBytes, 'worker帧超限');
  const frame = record(value);
  if (frame.kind === 'selected') {
    exactKeys(frame, ['kind', 'phase']);
    need(frame.phase === 'inventory' || frame.phase === 'backing-up');
    return frame as unknown as SelectedFrame;
  }
  need(frame.kind === 'result');
  exactKeys(frame, ['kind', 'result', 'runtime']);
  const result = record(frame.result);
  exactKeys(result, [
    'scene',
    'action',
    'state',
    'code',
    'journalPhase',
    'rollbackCopyRemaining',
    'rollbackCopyBudget',
    'selected',
    'waitedMs',
    'rollbackSpaceCalls',
    'rollbackSpaceBytes',
  ]);
  const runtime = record(frame.runtime);
  exactKeys(runtime, ['nodePath', 'nodeVersion', 'workerPath', 'workerSha256']);
  need(
    typeof result.scene === 'string' &&
      typeof result.action === 'string' &&
      typeof result.state === 'string' &&
      typeof result.code === 'string' &&
      typeof result.journalPhase === 'string' &&
      typeof result.rollbackCopyRemaining === 'number' &&
      typeof result.rollbackCopyBudget === 'number' &&
      typeof result.selected === 'number' &&
      typeof result.waitedMs === 'number' &&
      typeof result.rollbackSpaceCalls === 'number' &&
      typeof result.rollbackSpaceBytes === 'number' &&
      typeof runtime.nodePath === 'string' &&
      typeof runtime.nodeVersion === 'string' &&
      typeof runtime.workerPath === 'string' &&
      /^[a-f0-9]{64}$/u.test(String(runtime.workerSha256)),
  );
  return frame as unknown as WorkerTerminal;
}

export function superviseChild(
  factory: () => ChildLike,
  workMs: number,
): Promise<ChildObservation> {
  need(
    workMs === LIMITS.controlOrReopenMs || workMs === LIMITS.exhaustedWorkerMs,
    'worker期限不是固定合同值',
  );
  const started = performance.now();
  need(Number.isFinite(started) && started >= 0, 'worker单调时钟无效');
  const workDeadline = started + workMs;
  const lastExitDeadline = workDeadline + LIMITS.childExitMs;
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildLike;
    let frames = 0;
    let outputBytes = 0;
    let terminal: WorkerTerminal | null = null;
    const selected: SelectedFrame[] = [];
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let close: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let failure: Error | null = null;
    let settled = false;
    let killRequested = false;
    let stopping = false;
    let exitDeadline: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastObserved = started;
    const observeNow = (): number => {
      const value = performance.now();
      if (!Number.isFinite(value) || value < lastObserved) {
        failure ??= new Error('worker单调时钟倒退或无效');
        return Infinity;
      }
      lastObserved = value;
      return value;
    };
    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    };
    const expire = (): void => {
      const ownership = !exit
        ? 'worker实际exit/close未确认'
        : !close
          ? 'worker实际close与输出关闭未确认'
          : 'worker结算超过原单调截止';
      reject(new Error(failure ? `${failure.message}；${ownership}` : ownership));
    };
    const deadline = (): number => exitDeadline ?? workDeadline;
    const armTimer = (): void => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      const remaining = deadline() - observeNow();
      timer = setTimeout(
        () => {
          if (checkDeadline()) armTimer();
        },
        Math.max(1, remaining),
      );
    };
    const requestStop = (error: Error, observedAt = observeNow()): void => {
      failure ??= error;
      if (!stopping) {
        stopping = true;
        exitDeadline = Math.min(
          Math.min(observedAt, workDeadline) + LIMITS.childExitMs,
          lastExitDeadline,
        );
      }
      if (!exit && !killRequested) {
        killRequested = true;
        try {
          if (!child.kill('SIGKILL')) failure ??= new Error('worker强制退出请求失败');
        } catch {
          failure ??= new Error('worker强制退出请求抛错');
        }
      }
      if (observedAt >= deadline()) expire();
      else armTimer();
    };
    const checkDeadline = (): boolean => {
      if (settled) return false;
      const now = observeNow();
      if (now < deadline()) return true;
      if (!stopping && !exit) {
        requestStop(new Error('worker工作期限耗尽'), now);
        return !settled;
      }
      failure ??= new Error('worker工作期限耗尽');
      expire();
      return false;
    };
    const finish = (): void => {
      if (settled || !exit || !close || !checkDeadline()) return;
      if (
        exit.code !== close.code ||
        exit.signal !== close.signal ||
        exit.code !== 0 ||
        exit.signal !== null ||
        failure ||
        !terminal ||
        child.connected
      ) {
        reject(failure ?? new Error('worker退出、IPC或终态不完整'));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        terminal,
        selected,
        exitCode: exit.code,
        outputBytes,
        exitObserved: true,
        closeObserved: true,
      });
    };
    const output = (chunk: unknown): void => {
      if (!checkDeadline()) return;
      outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (outputBytes > LIMITS.outputBytesPerChild) requestStop(new Error('worker输出超限'));
      else checkDeadline();
    };
    try {
      child = factory();
    } catch {
      reject(new Error('固定worker启动失败'));
      return;
    }
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    child.on('message', (raw: unknown) => {
      if (!checkDeadline()) return;
      if (settled || exit || close) {
        requestStop(new Error('worker退出后的迟到帧'));
        return;
      }
      try {
        frames++;
        need(frames <= LIMITS.framesPerChild, 'worker帧数超限');
        const frame = parseFrame(raw);
        if (frame.kind === 'selected') {
          need(terminal === null && selected.length === 0, '选择点帧重复或迟到');
          selected.push(frame);
        } else {
          need(terminal === null, 'worker终态重复');
          terminal = frame;
        }
      } catch {
        requestStop(new Error('worker帧校验失败'));
      }
      checkDeadline();
    });
    child.on('error', () => requestStop(new Error('worker进程错误')));
    child.once('exit', (code: unknown, signal: unknown) => {
      exit = {
        code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? (signal as NodeJS.Signals) : null,
      };
      if (exit.code !== 0 || exit.signal !== null) requestStop(new Error('worker退出码或信号异常'));
      else checkDeadline();
      finish();
    });
    child.once('close', (code: unknown, signal: unknown) => {
      close = {
        code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? (signal as NodeJS.Signals) : null,
      };
      checkDeadline();
      finish();
    });
    if (checkDeadline()) armTimer();
  });
}

export async function runWorker(
  workerPath: string,
  scopeId: string,
  scene: Scene,
  action: WorkerAction,
): Promise<ChildObservation> {
  const entry = resolve(workerPath);
  const timeout =
    action === 'initial' && scene !== 'normal'
      ? LIMITS.exhaustedWorkerMs
      : LIMITS.controlOrReopenMs;
  return superviseChild(
    () =>
      spawn(process.execPath, [entry, scopeId, scene, action], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }) as ChildProcess,
    timeout,
  );
}
