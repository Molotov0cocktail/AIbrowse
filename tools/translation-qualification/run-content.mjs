import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import electronPath from 'electron';
import { prepareLocalClient } from './prepare-local-client.mjs';
import { summarizeContent } from './content-result.mjs';

const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('需要用户已安装客户端的绝对程序目录');
const inventoryPath =
  process.argv[3] || 'log/translation-feasibility-20261107/full-static-final/inventory.json';
const mode = 'local-sync';
if (!['original', 'local-sync'].includes(mode)) throw new Error('原UI实验模式无效');
const base = path.resolve('log/translation-integration-20261107');
fs.mkdirSync(base, { recursive: true });
const lock = path.join(base, 'host-probe.lock');
const fd = fs.openSync(lock, 'wx');
const root = path.join(base, `content-${randomUUID()}`);
let timer;
try {
  fs.mkdirSync(root);
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8').replace(/^\uFEFF/, ''));
  const client = prepareLocalClient(source, path.join(root, 'client'), inventory);
  const adaptation = [];
  if (mode === 'local-sync') {
    const { localSyncAdapterSource } = await import('./local-sync-adapter.mjs');
    const clientRoot = path.join(root, 'client');
    const writeAdapted = (name, bytes) => {
      const target = path.join(clientRoot, name);
      const before = fs.existsSync(target)
        ? createHash('sha256').update(fs.readFileSync(target)).digest('hex')
        : null;
      fs.writeFileSync(target, bytes);
      adaptation.push({
        path: name,
        before,
        after: createHash('sha256').update(bytes).digest('hex'),
      });
    };
    writeAdapted(
      'local-sync-adapter.js',
      'globalThis.__AIBROWSE_LOCAL_SYNC_DIAGNOSTIC__={offline:true,freshProfile:true,syntheticDataOnly:true};\n' +
        localSyncAdapterSource,
    );
    writeAdapted(
      'background-local.js',
      'importScripts("local-sync-adapter.js", "background.js");\n',
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(clientRoot, 'manifest.json'), 'utf8'));
    manifest.background.service_worker = 'background-local.js';
    manifest.content_scripts[0].js.unshift('local-sync-adapter.js');
    writeAdapted('manifest.json', JSON.stringify(manifest, null, 2));
    for (const name of ['popup.html', 'options.html', 'side-panel.html']) {
      const html = fs.readFileSync(path.join(clientRoot, name), 'utf8');
      if ((html.match(/<head>/g) || []).length !== 1) throw new Error('原HTML缺少唯一head接点');
      writeAdapted(
        name,
        html.replace('<head>', '<head><script src="local-sync-adapter.js"></script>'),
      );
    }
  }
  fs.writeFileSync(
    path.join(root, 'identity.json'),
    JSON.stringify(
      {
        source,
        mode,
        adaptation,
        inventoryPath,
        inventorySha256: createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex'),
        client,
        baseline: spawnSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).stdout.trim(),
        startedAt: new Date().toISOString(),
        sources: Object.fromEntries(
          [
            'prepare-local-client.mjs',
            'content-probe.ts',
            'run-content.mjs',
            'content-result.mjs',
            ...(mode === 'local-sync' ? ['local-sync-adapter.mjs'] : []),
          ].map((file) => [
            file,
            createHash('sha256')
              .update(fs.readFileSync(path.join('tools/translation-qualification', file)))
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
    entryPoints: ['tools/translation-qualification/content-probe.ts'],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = {
    ...process.env,
    AIBROWSE_LOCAL_CLIENT_ROOT: root,
    AIBROWSE_LOCAL_CLIENT_MODE: mode,
  };
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
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10000,
      });
  }, 180000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  await new Promise((resolve) => log.end(resolve));
  const resultPath = path.join(root, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  const summary = {
    root,
    exitCode,
    forced,
    ...summarizeContent(result, exitCode, forced),
    pages: Object.keys(result?.pages ?? {}),
    deniedRequests: result?.deniedRequests ?? null,
    error: result?.error ?? null,
  };
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = summary.completed ? 0 : 1;
} finally {
  clearTimeout(timer);
  fs.closeSync(fd);
  fs.unlinkSync(lock);
}
