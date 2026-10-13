import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import electronPath from 'electron';
import { createPackage } from '@electron/asar';

const kind = process.argv[2];
if (!['document-start', 'runtime', 'actual', 'asar-resource'].includes(kind))
  throw new Error('探针类型无效');
const root = path.resolve(process.argv[3] || '');
const allowed = path.resolve('log/builtin-tools-20261013') + path.sep;
if (!root.startsWith(allowed) || fs.existsSync(root)) throw new Error('需要新的隔离证据目录');
fs.mkdirSync(root, { recursive: true });
if (kind === 'actual')
  fs.cpSync(
    path.resolve('resources/qualified-userscripts'),
    path.join(root, 'resources', 'qualified-userscripts'),
    { recursive: true, errorOnExist: true },
  );
const appRoot = kind === 'asar-resource' ? path.join(root, 'app') : root;
fs.mkdirSync(appRoot, { recursive: true });
if (kind === 'asar-resource') {
  fs.cpSync(
    path.resolve('resources/qualified-userscripts'),
    path.join(appRoot, 'resources', 'qualified-userscripts'),
    { recursive: true, errorOnExist: true },
  );
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ name: 'qualified-asar-resource-probe', version: '1.0.0', main: 'probe.cjs' }),
  );
}
const main = path.join(appRoot, 'probe.cjs');
await build({
  entryPoints: [`tools/qualified-userscripts-runtime/${kind}-probe.ts`],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const preload = path.join(root, 'qualified-preload.cjs');
if (kind !== 'document-start' && kind !== 'asar-resource')
  await build({
    entryPoints: ['src/preload/qualified-userscripts.ts'],
    outfile: preload,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
const env = {
  ...process.env,
  AIBROWSE_QUALIFIED_PROBE_ROOT: root,
  AIBROWSE_QUALIFIED_PRELOAD: preload,
};
delete env.ELECTRON_RUN_AS_NODE;
let launch = main;
if (kind === 'asar-resource') {
  launch = path.join(root, 'app.asar');
  await createPackage(appRoot, launch);
}
const child = spawn(electronPath, [launch], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = fs.createWriteStream(path.join(root, 'process.log'));
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });
const deadline = setTimeout(() => child.kill(), kind === 'actual' ? 185000 : 35000);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(deadline);
output.end();
process.stdout.write(
  JSON.stringify(
    {
      root,
      exitCode: code,
      result: JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')),
    },
    null,
    2,
  ),
);
process.exitCode = code ?? 1;
