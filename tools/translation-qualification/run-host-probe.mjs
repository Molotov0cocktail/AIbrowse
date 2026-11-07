import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import electronPath from 'electron';
import { evaluate } from './evaluate.mjs';

const repository = process.cwd();
const base = path.join(repository, 'log/translation-integration-20261107');
fs.mkdirSync(base, { recursive: true });
const lock = path.join(base, 'host-probe.lock');
const lockFd = fs.openSync(lock, 'wx');
const root = path.join(base, `host-${randomUUID()}`);
let timer;
try {
  fs.mkdirSync(root);
  const sources = ['host-probe.ts', 'evaluate.mjs', 'run-host-probe.mjs'];
  fs.writeFileSync(
    path.join(root, 'identity.json'),
    JSON.stringify(
      {
        baseline: spawnSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).stdout.trim(),
        startedAt: new Date().toISOString(),
        sources: Object.fromEntries(
          sources.map((file) => [
            file,
            createHash('sha256')
              .update(
                fs.readFileSync(path.join(repository, 'tools/translation-qualification', file)),
              )
              .digest('hex'),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  const main = path.join(root, 'probe.cjs');
  await build({
    entryPoints: ['tools/translation-qualification/host-probe.ts'],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = { ...process.env, AIBROWSE_TRANSLATION_PROBE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [main], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(root, 'process.log'));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let forced = false;
  timer = setTimeout(() => {
    forced = true;
    if (child.pid)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }, 180000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  await new Promise((resolve) => log.end(resolve));
  const resultPath = path.join(root, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  const verdict = forced || exitCode !== 0 ? { experiment: 'INCOMPLETE' } : evaluate(result);
  const summary = { root, exitCode, forced, verdict };
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = verdict.experiment === 'COMPLETE' ? 0 : 1;
} finally {
  clearTimeout(timer);
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
}
