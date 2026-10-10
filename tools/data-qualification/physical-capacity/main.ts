import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { need, NODE_VERSION, requireScopeId } from './contract';
import { generateResearch } from './generate';
const scope = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
async function main() {
  need(process.argv.length === 3 && process.version === NODE_VERSION);
  requireScopeId(process.argv[2]);
  need(scope === resolve(scope, '../../..', 'log/stage7-e2', process.argv[2]));
  await generateResearch(resolve(scope, '../../..'), process.argv[2]);
  process.stdout.write('{"constructed":true,"productE2Pass":false,"electronQualified":false}\n');
}
void main().catch(() => {
  process.stderr.write('固定物理容量前置失败，现场保留\n');
  process.exitCode = 2;
});
