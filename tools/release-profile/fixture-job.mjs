import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === 'parent') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  }).unref();
} else if (mode === 'child') {
  setTimeout(() => process.exit(0), 1500);
} else if (mode === 'timeout') {
  setTimeout(() => process.exit(0), 5000);
} else {
  process.exitCode = 3;
}
