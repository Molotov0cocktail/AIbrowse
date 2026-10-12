import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const runRoot = resolve('log/browser-ux-20261012', `electron-${randomUUID()}`);
mkdirSync(join(runRoot, 'profile'), { recursive: true });
const result = await build({
  entryPoints: ['tools/browser-navigation/smoke.ts'],
  outfile: join(runRoot, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  metafile: true,
});
const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const sources = Object.fromEntries(
  [
    ...Object.keys(result.metafile.inputs),
    'tools/browser-navigation/run.ts',
    'tools/browser-navigation/native-click.ps1',
  ].map((file) => [file, hash(file)]),
);
writeFileSync(
  join(runRoot, 'binding.json'),
  JSON.stringify(
    {
      sources,
      artifact: hash(join(runRoot, 'main.cjs')),
      realBing: process.argv.includes('--real-bing'),
      budgetMs: 90000,
    },
    null,
    2,
  ),
);
const log = createWriteStream(join(runRoot, 'console.log'), { flags: 'wx' });
const launchEnvironment = { ...process.env };
delete launchEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  resolve('node_modules/electron/dist/electron.exe'),
  [
    join(runRoot, 'main.cjs'),
    ...process.argv.filter((argument) =>
      ['--real-bing', '--real-only', '--diagnostic', '--diagnostic-iframe'].includes(argument),
    ),
  ],
  {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: launchEnvironment,
  },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const code = await new Promise<number>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode) => resolveExit(exitCode ?? -1));
});
log.end();
const sourceUnchanged = Object.entries(sources).every(([file, digest]) => hash(file) === digest);
writeFileSync(join(runRoot, 'exit.json'), JSON.stringify({ code, sourceUnchanged }, null, 2));
process.stdout.write(`${runRoot}\nexit=${code}, sourceUnchanged=${sourceUnchanged}\n`);
process.exitCode = code === 0 && sourceUnchanged ? 0 : 1;
