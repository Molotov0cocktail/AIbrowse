import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import electronPath from 'electron';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || '');
if (!root.startsWith(path.resolve('log/builtin-tools-20261013') + path.sep) || fs.existsSync(root))
  throw new Error('需要新的隔离证据目录');
fs.mkdirSync(root, { recursive: true });
const main = path.join(root, 'probe.cjs');
const kind = process.argv[3] ?? 'native-events';
if (!['native-events', 'product', 'cdp-headers', 'request-order', 'cookie-scope'].includes(kind))
  throw new Error('探针类型无效');
const built = await build({
  entryPoints: [`tools/builtin-download-runtime/${kind}.ts`],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  metafile: true,
});
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = Object.keys(built.metafile.inputs).map((file) => ({ file, sha256: sha256(file) }));
fs.writeFileSync(
  path.join(root, 'identity.json'),
  JSON.stringify(
    {
      sources,
      tool: sha256('tools/builtin-download-runtime/run-probe.mjs'),
      bundle: sha256(main),
      electron: sha256(electronPath),
      inputMode: process.env.AIBROWSE_DOWNLOAD_INPUT ?? 'electron',
    },
    null,
    2,
  ),
);
const env = { ...process.env, AIBROWSE_DOWNLOAD_PROBE_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [main], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = fs.createWriteStream(path.join(root, 'process.log'));
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });
const timer = setTimeout(() => child.kill(), 55000);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timer);
output.end();
process.stdout.write(
  JSON.stringify(
    {
      root,
      exitCode: code,
      result: fs.existsSync(path.join(root, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))
        : null,
    },
    null,
    2,
  ),
);
process.exitCode = code ?? 1;
