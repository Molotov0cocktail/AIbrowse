// A trusted terminal caller supplies one key through non-echoing raw stdin.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { launchCampaign } from './campaign-launch.mjs';

function readSecret() {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(256);
    let length = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('error', onError);
      process.stdin.off('end', onError);
      process.stdin.pause();
      bytes.fill(0);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('input-rejected'));
    };
    const onError = () => fail();
    const onData = (chunk) => {
      try {
        if (!Buffer.isBuffer(chunk)) {
          fail();
          return;
        }
        for (const byte of chunk) {
          if (settled) break;
          if (byte === 10 || byte === 13) {
            if (length === 0) {
              fail();
              break;
            }
            const secret = Buffer.from(bytes.subarray(0, length));
            settled = true;
            cleanup();
            resolve(secret);
            break;
          }
          if (byte < 33 || byte > 126 || length >= bytes.length) {
            fail();
            break;
          }
          bytes[length++] = byte;
        }
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    };
    const timer = setTimeout(fail, 120000);
    process.stdin.on('data', onData);
    process.stdin.once('error', onError);
    process.stdin.once('end', onError);
    process.stdin.resume();
  });
}

let rawChanged = false;
const initialRawMode = process.stdin.isRaw === true;
const credential = { key: '' };
let category = 'input-rejected';
try {
  if (
    process.argv.length !== 3 ||
    !process.stdin.isTTY ||
    typeof process.stdin.setRawMode !== 'function'
  )
    throw new Error('tty-required');
  process.stdin.setRawMode(true);
  rawChanged = true;
  const pendingInput = readSecret();
  process.stdout.write('无回显凭据输入已就绪：READY\n');
  const bytes = await pendingInput;
  try {
    credential.key = bytes.toString('ascii');
  } finally {
    bytes.fill(0);
  }
  if (!/^sk-[a-zA-Z0-9_-]{16,200}$/.test(credential.key)) throw new Error('input-rejected');
  category = 'launch-failed';
  const pendingCampaign = launchCampaign(process.argv[2], 'watch-repair', '', credential.key);
  credential.key = '';
  const campaign = await pendingCampaign;
  category = 'campaign-failed';
  const result = await campaign.done;
  process.stdout.write(
    JSON.stringify({
      passed: result.passed === true,
      category: result.passed === true ? 'passed' : category,
      exitCode: result.exitCode,
      credentialFilesAbsent: result.credentialFilesAbsent === true,
      credentialFilesRemoved: result.credentialFilesRemoved ?? 0,
      secretScanPassed: result.secretScan?.passed === true,
      secretMatches: result.secretScan?.matches ?? null,
    }) + '\n',
  );
  process.exitCode = result.passed === true ? 0 : 2;
} catch {
  process.stdout.write(JSON.stringify({ passed: false, category }) + '\n');
  process.exitCode = 2;
} finally {
  credential.key = '';
  process.stdin.pause();
  if (rawChanged) process.stdin.setRawMode(initialRawMode);
}
