import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { IdmDownloadService, normalizeIdmUrl } from '../../src/main/downloads/idm-service';
import { QualifiedScriptNetwork } from '../../src/main/userscripts-qualified/network';
import { QualifiedScriptStore } from '../../src/main/userscripts-qualified/store';
import { getCatalogEntry } from '../../src/main/userscripts-qualified/catalog';
import { readQualifiedPackage } from '../../src/main/userscripts-qualified/package';

// This executable only uses a fresh evidence root and never opens the user's profile.
const mode = process.argv[2];
const root = resolve(process.argv[3] ?? '');
assert(['idm', 'install', 'local-install'].includes(mode ?? ''));
assert(root.startsWith(resolve('log/idm-tool-20261013') + sep) && !existsSync(root));
mkdirSync(root, { recursive: true });
const evidence: Record<string, unknown> = { mode, passed: false, realIdm: false, requests: 0 };
const bindingPaths = [
  'tools/qualified-userscripts-runtime/host-probe.ts',
  'src/main/downloads/idm-service.ts',
  'src/main/userscripts-qualified/catalog.ts',
  'src/main/userscripts-qualified/package.ts',
  'src/main/userscripts-qualified/store.ts',
  'src/main/userscripts-qualified/network.ts',
];
const binding = Object.fromEntries(
  bindingPaths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
evidence.binding = binding;
const save = () => writeFileSync(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
save();

async function idm(): Promise<void> {
  const capture = join(root, 'argv.json');
  const childFile = join(root, 'capture.mjs');
  writeFileSync(
    childFile,
    "import fs from 'node:fs'; fs.writeFileSync(process.env.AIBROWSE_ARGV_CAPTURE,JSON.stringify(process.argv.slice(2)));",
    { flag: 'wx' },
  );
  let completion: Promise<void> | undefined;
  const service = new IdmDownloadService({
    isExecutableFile: async () => true,
    spawnIdm: (executable, args, options) => {
      assert.equal(executable, 'C:\\Program Files\\Internet Download Manager\\IDMan.exe');
      assert.deepEqual(options, { shell: false, stdio: 'ignore', windowsHide: false });
      const child = spawn(process.execPath, [childFile, ...args], {
        ...options,
        windowsHide: true,
        env: { ...process.env, AIBROWSE_ARGV_CAPTURE: capture },
      });
      completion = new Promise((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('替身子进程超时'));
        }, 5000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else reject(new Error('替身失败'));
        });
      });
      return child;
    },
  });
  // Ampersands, semicolons, percent escapes and Unicode must remain in one argv value.
  const url = 'https://example.invalid/下载.zip?a=1&b=two;echo%20ignored&c=%22quoted%22';
  assert.deepEqual(await service.send(url), { ok: true });
  assert(completion);
  await completion;
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['/d', normalizeIdmUrl(url)]);
  service.dispose();
  evidence.argumentBoundary = true;
  evidence.passed = true;
}

async function install(): Promise<void> {
  const offline = mode === 'local-install';
  const packages = resolve(process.argv[4] ?? '');
  if (offline) assert(packages.startsWith(resolve('log/idm-tool-20261013') + sep));
  const network = new QualifiedScriptNetwork();
  const requests: Array<{ sha256: string; bytes: number }> = [];
  let alive = true;
  const store = new QualifiedScriptStore({
    directory: join(root, 'store'),
    fetchText: async (url, signal) => {
      assert(!offline, '本地安装不得回退网络');
      assert(alive && Number(evidence.requests) < 27);
      evidence.requests = Number(evidence.requests) + 1;
      save();
      const response = await network.request({ url, method: 'GET' }, signal);
      assert.equal(response.status, 200);
      requests.push({
        bytes: Buffer.byteLength(response.responseText),
        sha256: createHash('sha256').update(response.responseText).digest('hex'),
      });
      return response.responseText;
    },
  });
  const timer = setTimeout(() => {
    alive = false;
    store.dispose();
    network.dispose();
  }, 180000);
  try {
    const results = [];
    for (const id of ['ac-baidu', 'github-zh'] as const) {
      const texts = offline
        ? readQualifiedPackage(join(packages, `${id}.aibrowse-script.json`), getCatalogEntry(id))
        : undefined;
      results.push({ id, result: await store.install(id, () => alive, texts) });
    }
    evidence.results = results;
    evidence.downloads = requests;
    evidence.status = store.list();
    assert(results.every((entry) => entry.result.ok && !entry.result.cancelled));
    assert.equal(requests.length, offline ? 0 : 27);
    assert(store.list().every((entry) => entry.installed && entry.enabled));
    const reopened = new QualifiedScriptStore({
      directory: join(root, 'store'),
      fetchText: async () => {
        throw new Error('重开不得联网');
      },
    });
    assert.deepEqual(reopened.list(), store.list());
    evidence.reopened = true;
    reopened.dispose();
    evidence.passed = true;
  } finally {
    clearTimeout(timer);
    store.dispose();
    network.dispose();
  }
}

void (mode === 'idm' ? idm() : install())
  .catch(() => {
    evidence.error = '探针失败，状态与计数见本文件';
    process.exitCode = 1;
  })
  .finally(() => {
    evidence.bindingUnchanged = bindingPaths.every(
      (path) => binding[path] === createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
    if (!evidence.bindingUnchanged) {
      evidence.passed = false;
      process.exitCode = 1;
    }
    save();
  });
