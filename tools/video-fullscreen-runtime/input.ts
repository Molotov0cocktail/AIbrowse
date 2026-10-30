import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { BaseWindow } from 'electron';

/** Sends input only after the OS validates the exact test window and process. */
export async function nativeInput(
  owner: BaseWindow,
  action: 'Click' | 'F' | 'Escape',
  x = 0,
  y = 0,
): Promise<void> {
  owner.setAlwaysOnTop(true);
  owner.moveTop();
  owner.focus();
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      join(process.cwd(), 'tools/video-fullscreen-runtime/native-input.ps1'),
      '-TargetWindow',
      owner.getNativeWindowHandle().readBigUInt64LE().toString(),
      '-TargetProcess',
      String(process.pid),
      '-ScreenX',
      String(x),
      '-ScreenY',
      String(y),
      '-Action',
      action,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill(), 8000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
}
