import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve('.');
const runRoot = resolve('log/browser-settings-20261012', `runtime-${randomUUID()}`);
mkdirSync(join(runRoot, 'profile'), { recursive: true });
mkdirSync(join(runRoot, 'session'), { recursive: true });
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    'src',
    'tools/browser-library-runtime/run.ts',
    'tools/browser-library-runtime/harness.cjs',
    'tools/browser-library-runtime/native-input.ps1',
  ],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => path && !path.endsWith('.test.ts'));
const binding = Object.fromEntries(
  [...files, 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map((path) => [
    path,
    hash(path),
  ]),
);
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    `<title>重启浏览夹具${request.url?.startsWith('/two') ? '二' : '一'}</title><h1>合成网页</h1>`,
  );
});
await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('合成服务器不可用');
writeFileSync(
  join(runRoot, 'input.json'),
  JSON.stringify(
    {
      repository,
      base: `http://127.0.0.1:${address.port}`,
      binding,
      physicalInput: process.argv.includes('--physical-input'),
    },
    null,
    2,
  ),
);
let success = true;
const attemptedPhases: string[] = [];
const completedPhases: string[] = [];
try {
  for (const phase of ['write', 'reopen']) {
    attemptedPhases.push(phase);
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        key.startsWith('AIBROWSE_') ||
        ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
      )
        delete env[key];
    const log = createWriteStream(join(runRoot, `${phase}.log`), { flags: 'wx' });
    const child = spawn(
      resolve('node_modules/electron/dist/electron.exe'),
      [resolve('tools/browser-library-runtime/harness.cjs'), runRoot, phase],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (value) => resolveExit(value ?? -1));
    });
    log.end();
    const result = JSON.parse(readFileSync(join(runRoot, `${phase}.json`), 'utf8')) as {
      passed: boolean;
      willQuit: boolean;
    };
    if (code !== 0 || !result.passed || !result.willQuit) {
      success = false;
      break;
    }
    completedPhases.push(phase);
  }
} finally {
  server.close();
}
const sourceUnchanged = Object.entries(binding).every(([path, value]) => hash(path) === value);
writeFileSync(
  join(runRoot, 'result.json'),
  JSON.stringify(
    {
      passed: success && sourceUnchanged,
      sourceUnchanged,
      plannedPhases: ['write', 'reopen'],
      attemptedPhases,
      completedPhases,
      providerCalls: 0,
    },
    null,
    2,
  ),
);
process.stdout.write(`${runRoot}\npassed=${success && sourceUnchanged}\n`);
process.exitCode = success && sourceUnchanged ? 0 : 1;
