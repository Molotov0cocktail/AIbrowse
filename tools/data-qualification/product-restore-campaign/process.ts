import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { need } from './contract';

export interface OwnedChild {
  child: ChildProcess;
  closed: Promise<number | null>;
  exit: Promise<number | null>;
}
/** Track OS exit and stdio closure separately. Neither an error event nor a timeout retires ownership. */
export class Processes {
  readonly owned = new Set<OwnedChild>();
  readonly diagnostics: Array<{
    pid: number | null;
    exitSeen: boolean;
    exitCode: number | null;
    closeCode: number | null;
    failed: boolean;
    stderrBytes: number;
    stderrBase64: string;
  }> = [];
  private stopped = false;
  constructor(private readonly deadline: () => number) {}
  start(executable: string, args: string[], product = false, cwd = resolve('.')): OwnedChild {
    need(!this.stopped && performance.now() < this.deadline());
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^AIBROWSE_/iu.test(key) ||
        ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(
          key.toUpperCase(),
        )
      )
        delete env[key];
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: !product,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let exitCode: number | null = null,
      sawExit = false,
      failed = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    let resolveExit!: (code: number | null) => void;
    const exit = new Promise<number | null>((done) => {
      resolveExit = done;
    });
    const closed = new Promise<number | null>((done) => {
      child.once('error', () => {
        failed = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const take = Math.min(chunk.length, Math.max(0, 65_536 - bytes));
        if (take > 0) chunks.push(Buffer.from(chunk.subarray(0, take)));
        bytes += chunk.length;
        if (bytes > 65_536) {
          failed = true;
          this.stop();
        }
        // No external exception or user content is copied into the structured report.
      });
      child.stderr?.once('error', () => {
        failed = true;
      });
      child.once('exit', (code) => {
        sawExit = true;
        exitCode = code;
        resolveExit(code);
      });
      child.once('close', (code) => {
        this.diagnostics.push({
          pid: child.pid ?? null,
          exitSeen: sawExit,
          exitCode,
          closeCode: code,
          failed,
          stderrBytes: bytes,
          stderrBase64: Buffer.concat(chunks).toString('base64'),
        });
        this.owned.delete(value);
        if (!sawExit) resolveExit(null);
        done(!failed && sawExit && exitCode === code ? code : null);
      });
    });
    const value: OwnedChild = { child, exit, closed };
    this.owned.add(value);
    return value;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const value of this.owned) {
      try {
        value.child.kill();
      } catch {
        /* The outer native Job retains final ownership. */
      }
    }
  }
  async external(executable: string, args: string[], deadline: number): Promise<void> {
    const until = Math.min(deadline, this.deadline());
    need(performance.now() < until);
    const process = this.start(executable, args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            this.stop();
            reject(new Error('受控helper原期限耗尽'));
          },
          Math.max(0, until - performance.now()),
        );
      });
      const code = await Promise.race([process.closed, expired]);
      need(code === 0 && performance.now() < until, '受控helper未在原期限内真实退出');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
