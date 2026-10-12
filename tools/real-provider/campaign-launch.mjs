// Trusted test caller supplies the key in memory. No secret is placed in child arguments/env.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { randomBytes, createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { validCampaignPolicyBinding } from './campaign-policy.ts';
import { finalizeCampaignSecrets, watchCampaignPassed } from './campaign-cleanup.ts';

export async function launchCampaign(root, phase, origin, key, baseEnvironment = process.env) {
  const repository = resolve(import.meta.dirname, '../..');
  root = resolve(root);
  if (
    !root.startsWith(join(repository, 'log/real-provider-20261012') + '\\') ||
    !['probe', 'research', 'conversation', 'watch-repair'].includes(phase)
  )
    throw new Error('验收路径或阶段非法');
  const binding = JSON.parse(readFileSync(join(root, 'binding.json'), 'utf8'));
  if (!validCampaignPolicyBinding(binding, phase)) throw new Error('验收阶段与构建预算绑定不符');
  if (
    phase === 'watch-repair' &&
    (realpathSync(root) !== root ||
      lstatSync(root).isSymbolicLink() ||
      realpathSync(join(root, 'profile')) !== join(root, 'profile') ||
      lstatSync(join(root, 'profile')).isSymbolicLink())
  )
    throw new Error('隔离目录不得重定向');
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  if (
    hash(join(root, 'entry.cjs')) !== binding.bundle ||
    hash(join(repository, 'node_modules/electron/dist/electron.exe')) !== binding.electron
  )
    throw new Error('验收制品改变');
  const token = randomBytes(16).toString('hex');
  const scanSecret = phase === 'watch-repair' ? Buffer.from(key, 'utf8') : null;
  const pipe = '\\\\.\\pipe\\aibrowse-real-' + randomBytes(16).toString('hex');
  let served = false;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (sockets.size > 4) {
      socket.destroy();
      return;
    }
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.length > 256) {
        socket.destroy();
        return;
      }
      if (received.endsWith('\n')) {
        if (received.trim() !== token || served) {
          socket.destroy();
          return;
        }
        served = true;
        socket.end(key);
        key = '';
        server.close();
      }
    });
  });
  let expire = null;
  let launched = false;
  const closePipe = () => {
    key = '';
    if (expire !== null) clearTimeout(expire);
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(pipe, done);
    });
    expire = setTimeout(closePipe, 15000);
    server.on('close', () => clearTimeout(expire));
    const env = {
      ...baseEnvironment,
      AIBROWSE_CAMPAIGN_PHASE: phase,
      AIBROWSE_CAMPAIGN_ORIGIN: origin,
      AIBROWSE_CAMPAIGN_PIPE: pipe,
      AIBROWSE_CAMPAIGN_TOKEN: token,
      ...(phase === 'watch-repair' ? { AIBROWSE_CAMPAIGN_MODEL: 'deepseek-flash' } : {}),
      TEMP: join(repository, '.local-dev/temp'),
      TMP: join(repository, '.local-dev/temp'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const log = openSync(join(root, 'process-output.txt'), 'wx');
    let child;
    try {
      child = spawn(join(repository, 'node_modules/electron/dist/electron.exe'), [root], {
        cwd: repository,
        windowsHide: true,
        env,
        stdio: ['ignore', log, log],
      });
    } finally {
      closeSync(log);
    }
    const result = {
      root,
      phase,
      pid: child.pid,
      callerNodeVersion: process.versions.node,
      started: new Date().toISOString(),
      exitCode: null,
      exited: false,
      ...(phase === 'watch-repair'
        ? {
            childPassed: false,
            passed: false,
            credentialFilesAbsent: false,
            credentialCleanup: 'not-run',
            secretScan: null,
            deadlineExceeded: false,
          }
        : {}),
    };
    const deadline =
      phase === 'watch-repair'
        ? setTimeout(() => {
            result.deadlineExceeded = true;
            closePipe();
            child.kill();
          }, binding.lifetimeMs)
        : null;
    const done = new Promise((finish) => {
      child.once('error', () => {
        result.launchFailed = true;
      });
      // close follows exit/error and closes inherited output handles before scanning.
      child.once('close', (code, signal) => {
        if (deadline !== null) clearTimeout(deadline);
        Object.assign(result, {
          exitCode: code,
          signal,
          exited: true,
          finished: new Date().toISOString(),
        });
        closePipe();
        if (scanSecret !== null) {
          Object.assign(result, finalizeCampaignSecrets(root, scanSecret));
          try {
            const file = join(root, 'result.json');
            const stat = lstatSync(file);
            if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024)
              result.childPassed = JSON.parse(readFileSync(file, 'utf8')).passed === true;
          } catch {
            result.childPassed = false;
          }
          result.passed = watchCampaignPassed(result);
        }
        try {
          writeFileSync(join(root, 'process-result.json'), JSON.stringify(result, null, 2), {
            flag: 'wx',
          });
        } catch {
          result.reportWriteFailed = true;
          if (phase === 'watch-repair') result.passed = false;
        }
        finish(result);
      });
    });
    launched = true;
    return { result, done };
  } finally {
    if (!launched) {
      closePipe();
      scanSecret?.fill(0);
    }
  }
}
