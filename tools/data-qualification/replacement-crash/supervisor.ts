import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import { QUALIFICATION_LIMITS, isCheckpoint, type ReplacementCheckpoint } from './contracts';
import { type DatasetStartupState } from '../../../src/main/storage/dataset-startup';

export interface ChildObservation {
  readonly state: DatasetStartupState | 'worker-failed' | null;
  readonly points: readonly ReplacementCheckpoint[];
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly outputBytes: number;
  readonly frames: number;
}

export type SpawnWorker = () => ChildProcess;

export interface SupervisionTimebox {
  readonly workMs: number;
  readonly exitMs: number;
  readonly deadline?: number;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function superviseProcess(
  spawnWorker: SpawnWorker,
  killAt: ReplacementCheckpoint | null,
  timebox: SupervisionTimebox = {
    workMs: QUALIFICATION_LIMITS.childWorkMs,
    exitMs: QUALIFICATION_LIMITS.childExitMs,
  },
): Promise<ChildObservation> {
  if (
    !Number.isFinite(timebox.workMs) ||
    !Number.isFinite(timebox.exitMs) ||
    timebox.workMs <= 0 ||
    timebox.workMs > QUALIFICATION_LIMITS.childWorkMs ||
    timebox.exitMs <= 0 ||
    timebox.exitMs > QUALIFICATION_LIMITS.childExitMs ||
    (timebox.deadline !== undefined && !Number.isFinite(timebox.deadline))
  )
    throw new Error('child剩余期限耗尽');
  const started = performance.now();
  const lastExitDeadline = Math.min(
    started + timebox.workMs + timebox.exitMs,
    timebox.deadline ?? Infinity,
  );
  const workDeadline = Math.min(started + timebox.workMs, lastExitDeadline - timebox.exitMs);
  if (workDeadline <= started) throw new Error('child剩余期限耗尽');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnWorker();
    const points: ReplacementCheckpoint[] = [];
    let state: ChildObservation['state'] = null;
    let killed = false;
    let stopping = false;
    let killInProgress = false;
    let exited = false;
    let closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let protocolFailure: Error | null = null;
    let outputBytes = 0;
    let frames = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitDeadline: number | null = null;

    const remember = (failure: Error): void => {
      protocolFailure ??= failure;
    };
    const reject = (failure: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(failure);
    };
    const expire = (): void => {
      const ownership = !exited
        ? '子进程退出未确认，原件与进程所有权保持失败态'
        : !closed
          ? '子进程输出关闭未确认，输出所有权保持失败态'
          : '子进程结算超过原单调截止';
      reject(new Error(protocolFailure ? `${protocolFailure.message}；${ownership}` : ownership));
    };

    const checkDeadline = (): boolean => {
      if (settled) return false;
      const now = performance.now();
      if (exitDeadline !== null) {
        if (now >= exitDeadline) {
          expire();
          return false;
        }
      } else if (now >= workDeadline) {
        remember(new Error('子进程工作期限耗尽'));
        if (!exited) requestStop();
        else expire();
        return false;
      }
      return true;
    };

    const armTimer = (): void => {
      clearTimeout(timer);
      if (settled) return;
      timer = setTimeout(
        () => {
          if (checkDeadline()) armTimer();
        },
        Math.max(1, (exitDeadline ?? workDeadline) - performance.now()),
      );
    };

    const finish = (): void => {
      if (settled || !exited || !closed || killInProgress || !checkDeadline()) return;
      if (protocolFailure) {
        reject(protocolFailure);
        return;
      }
      if (killAt !== null) {
        if (!killed || points.at(-1) !== killAt || exitSignal !== 'SIGKILL' || exitCode !== null) {
          reject(new Error('未取得目标边界强杀对应的实际退出证据'));
          return;
        }
      } else if (
        stopping ||
        exitCode !== 0 ||
        exitSignal !== null ||
        state === null ||
        state === 'worker-failed'
      ) {
        reject(new Error('资格子进程未正常完成'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveRun({
        state,
        points: [...points],
        killed,
        exitCode,
        signal: exitSignal,
        outputBytes,
        frames,
      });
    };

    const requestStop = (failure?: Error): void => {
      if (failure) remember(failure);
      if (settled || stopping || exited) return;
      const stoppedAt = performance.now();
      if (stoppedAt >= workDeadline) remember(new Error('子进程工作期限耗尽'));
      stopping = true;
      // A delayed timer cannot extend the exit window beyond workDeadline + exitMs.
      exitDeadline = Math.min(Math.min(stoppedAt, workDeadline) + timebox.exitMs, lastExitDeadline);
      killInProgress = true;
      try {
        killed = child.kill('SIGKILL') === true;
        if (!killed) remember(new Error('子进程强杀请求返回false'));
      } catch {
        remember(new Error('子进程强杀请求抛错'));
      } finally {
        killInProgress = false;
      }
      if (!checkDeadline()) return;
      armTimer();
      finish();
    };
    const observeOutput = (chunk: Buffer | string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > QUALIFICATION_LIMITS.outputBytesPerChild)
        requestStop(new Error('子进程stdout/stderr超过4KiB'));
      checkDeadline();
    };
    child.stdout?.on('data', observeOutput);
    child.stderr?.on('data', observeOutput);
    child.stdout?.once('close', () => checkDeadline());
    child.stderr?.once('close', () => checkDeadline());
    child.on('message', (raw: unknown) => {
      if (!checkDeadline() || exited || stopping) return;
      frames += 1;
      let encoded: string;
      try {
        encoded = JSON.stringify(raw);
      } catch {
        requestStop(new Error('子进程IPC帧不可序列化'));
        return;
      }
      if (!checkDeadline()) return;
      if (
        frames > QUALIFICATION_LIMITS.framesPerChild ||
        typeof encoded !== 'string' ||
        Buffer.byteLength(encoded) > QUALIFICATION_LIMITS.frameBytes ||
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw)
      ) {
        requestStop(new Error('子进程IPC预算或形状非法'));
        return;
      }
      const frame = raw as Record<string, unknown>;
      if (
        frame.kind === 'boundary' &&
        typeof frame.point === 'string' &&
        isCheckpoint(frame.point) &&
        exactKeys(frame, ['kind', 'point'])
      ) {
        points.push(frame.point);
        if (killAt === frame.point) {
          requestStop();
          return;
        }
        try {
          child.send?.('continue', (error) => {
            if (error && !exited && !settled) requestStop(new Error('父进程确认边界失败'));
            checkDeadline();
          });
        } catch {
          requestStop(new Error('父进程确认边界抛错'));
        }
        return;
      }
      if (
        frame.kind === 'result' &&
        typeof frame.state === 'string' &&
        ['normal', 'checking', 'recovery-required', 'worker-failed'].includes(frame.state) &&
        exactKeys(frame, ['kind', 'state']) &&
        state === null
      ) {
        state = frame.state as ChildObservation['state'];
        return;
      }
      requestStop(new Error('子进程IPC帧非法或重复'));
    });
    child.on('error', () => {
      requestStop(new Error('子进程错误事件'));
      checkDeadline();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      checkDeadline();
      finish();
    });
    // ChildProcess close is emitted after process exit and all stdio streams close.
    child.once('close', (code, signal) => {
      closed = true;
      if (exited && (code !== exitCode || signal !== exitSignal))
        remember(new Error('子进程exit与close证据不一致'));
      checkDeadline();
      finish();
    });
    if (checkDeadline()) armTimer();
  });
}

export function superviseWorker(
  scopeRoot: string,
  artifact: string,
  caseRoot: string,
  mode: 'write' | 'reopen',
  killAt: ReplacementCheckpoint | null,
  deadline: number,
): Promise<ChildObservation> {
  const scope = resolve(scopeRoot);
  const root = resolve(caseRoot);
  if (!isAbsolute(scope) || !isAbsolute(root) || !root.startsWith(scope + sep))
    throw new Error('worker路径越出受控资格根');
  const remaining = deadline - performance.now();
  // Reserve the complete exit-only window before a child starts. This prevents
  // an 8s work timer near the total deadline from borrowing another 2s later.
  if (remaining <= QUALIFICATION_LIMITS.childExitMs) throw new Error('600秒总期限耗尽');
  return superviseProcess(
    () =>
      spawn(process.execPath, [resolve(artifact), root, mode], {
        cwd: process.cwd(),
        env: { ...process.env, AIBROWSE_REPLACEMENT_CRASH_SCOPE: scope },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }),
    killAt,
    {
      workMs: Math.min(
        QUALIFICATION_LIMITS.childWorkMs,
        remaining - QUALIFICATION_LIMITS.childExitMs,
      ),
      exitMs: QUALIFICATION_LIMITS.childExitMs,
      deadline,
    },
  );
}
