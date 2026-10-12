import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConversationStore } from '../../src/main/ai/conversation-store';

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.skipIf(process.platform !== 'win32')(
  'Windows外部锁对照：无锁50次真实发布，禁止共享删除时原件保留并封闭后续写入',
  async () => {
    const evidence = join(process.cwd(), 'log', 'conversation-lock-diagnostic');
    mkdirSync(evidence, { recursive: true });
    const root = mkdtempSync(join(evidence, 'case-'));
    const control = new ConversationStore(join(root, 'control'));
    const session = {
      id: '11111111-1111-4111-8111-000000000001',
      title: '合成测试会话',
      createdAt: 1,
      updatedAt: 1,
      ephemeral: false,
    };
    let controlWrites = 0;
    for (let count = 1; count <= 50; count += 1) {
      expect(control.saveSessions([{ ...session, updatedAt: count }])).toBe(true);
      controlWrites += 1;
    }
    const locked = new ConversationStore(join(root, 'locked'));
    expect(locked.saveSessions([session])).toBe(true);
    const index = join(locked.dirPath, 'index.json');
    const before = readFileSync(index);
    // An external native handle deliberately omits FileShare.Delete. No mock,
    // retry, timer delay or replacement persistence implementation is involved.
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$file = [IO.File]::Open($env:AIBROWSE_CONVERSATION_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }",
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AIBROWSE_CONVERSATION_LOCK_PATH: index },
      },
    );
    // Exit remains the release oracle if the child closes its input early.
    child.stdin.on('error', () => {});
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    // Ready and exit are awaited separately; retain early launch rejection until
    // finally consumes it instead of allowing an unhandled rejection.
    void exited.catch(() => {});
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('locked')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('受控锁进程在就绪前退出')));
    });
    let saved: boolean | null = null;
    let oldIndexPreserved = false;
    let temporaryPreserved = false;
    async function release(): Promise<void> {
      child.stdin.end('\n');
      let exitCode: number | null = null;
      let forcedCleanup = false;
      try {
        exitCode = await within(exited, 1000, '受控锁进程未在限定时间内释放');
      } catch (error) {
        // Only this exact child handle is owned; never enumerate or kill by name.
        if (child.exitCode === null && child.pid !== undefined) {
          forcedCleanup = true;
          child.kill();
          exitCode = await within(exited, 500, '受控锁子进程未确认退出');
        }
        throw error;
      } finally {
        writeFileSync(
          join(root, 'result.json'),
          JSON.stringify({
            controlWrites,
            saved,
            oldIndexPreserved,
            temporaryPreserved,
            exitCode,
            forcedCleanup,
          }),
        );
      }
      expect(exitCode).toBe(0);
    }
    try {
      await within(ready, 1500, '受控锁进程未在限定时间内就绪');
      saved = locked.saveSessions([{ ...session, updatedAt: 2 }]);
      oldIndexPreserved = readFileSync(index).equals(before);
      temporaryPreserved = existsSync(`${index}.tmp`);
      expect(saved).toBe(false);
      expect(oldIndexPreserved).toBe(true);
      expect(temporaryPreserved).toBe(true);
      expect(locked.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
    } finally {
      await release();
    }
    // Releasing the external lock does not silently clear a failed Store's seal.
    expect(locked.saveSessions([{ ...session, updatedAt: 3 }])).toBe(false);
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(`${index}.tmp`)).toBe(true);
    console.info(`受控锁对照原件：${root}`);
  },
);
