import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importInput } from './input';
import { need } from './contract';
// Bundled __dirname is the one-time candidate scope; no external paths are accepted.
const scope = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
need(process.argv.length === 3 && /^v24\./u.test(process.version));
need(scope === resolve(scope, '../../..', 'log/stage7-e2', process.argv[2]));
try {
  importInput(resolve(scope, '../../..'), process.argv[2]);
  process.stdout.write('{"imported":true,"productE2Pass":false}\n');
} catch {
  process.stderr.write('完整Transfer输入导入失败，现场保留\n');
  process.exitCode = 2;
}
