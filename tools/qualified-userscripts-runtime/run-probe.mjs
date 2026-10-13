import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import electronPath from 'electron';

const kind = process.argv[2];
if (!['document-start', 'runtime', 'actual'].includes(kind)) throw new Error('探针类型无效');
const root = path.resolve(process.argv[3] || '');
const allowed = path.resolve('log/idm-tool-20261013') + path.sep;
if (!root.startsWith(allowed) || fs.existsSync(root)) throw new Error('需要新的隔离证据目录');
fs.mkdirSync(root, { recursive: true });
const main = path.join(root, 'probe.cjs');
await build({
  entryPoints: [`tools/qualified-userscripts-runtime/${kind}-probe.ts`],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const preload = path.join(root, 'qualified-preload.cjs');
if (kind !== 'document-start')
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
const child = spawn(electronPath, [main], {
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
