// Trusted test caller supplies the key in memory. No secret is placed in child arguments/env.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';

export async function launchCampaign(root, phase, origin, key, baseEnvironment) {
  const repository = resolve(import.meta.dirname, '../..');
  root = resolve(root);
  if (
    !root.startsWith(join(repository, 'log/real-provider-20261012') + '\\') ||
    !['probe', 'research', 'conversation'].includes(phase)
  )
    throw new Error('验收路径或阶段非法');
  const binding = JSON.parse(readFileSync(join(root, 'binding.json'), 'utf8'));
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  if (
    hash(join(root, 'entry.cjs')) !== binding.bundle ||
    hash(join(repository, 'node_modules/electron/dist/electron.exe')) !== binding.electron
  )
    throw new Error('验收制品改变');
  const token = randomBytes(16).toString('hex');
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
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(pipe, done);
  });
  const expire = setTimeout(() => {
    key = '';
    for (const socket of sockets) socket.destroy();
    server.close();
  }, 15000);
  server.on('close', () => clearTimeout(expire));
  const env = {
    ...baseEnvironment,
    AIBROWSE_CAMPAIGN_PHASE: phase,
    AIBROWSE_CAMPAIGN_ORIGIN: origin,
    AIBROWSE_CAMPAIGN_PIPE: pipe,
    AIBROWSE_CAMPAIGN_TOKEN: token,
    TEMP: join(repository, '.local-dev/temp'),
    TMP: join(repository, '.local-dev/temp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = openSync(join(root, 'process-output.txt'), 'wx');
  const child = spawn(join(repository, 'node_modules/electron/dist/electron.exe'), [root], {
    cwd: repository,
    windowsHide: true,
    env,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  const result = {
    root,
    phase,
    pid: child.pid,
    started: new Date().toISOString(),
    exitCode: null,
    exited: false,
  };
  const done = new Promise((finish) => {
    child.once('exit', (code, signal) => {
      Object.assign(result, {
        exitCode: code,
        signal,
        exited: true,
        finished: new Date().toISOString(),
      });
      key = '';
      for (const socket of sockets) socket.destroy();
      server.close();
      writeFileSync(join(root, 'process-result.json'), JSON.stringify(result, null, 2), {
        flag: 'wx',
      });
      finish(result);
    });
    child.once('error', () => {
      key = '';
      for (const socket of sockets) socket.destroy();
      server.close();
      finish({ ...result, launchFailed: true });
    });
  });
  return { result, done };
}
