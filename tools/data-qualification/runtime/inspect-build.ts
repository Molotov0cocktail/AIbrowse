import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFact } from './contract.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assertFact(process.argv.length === 2, '固定制品检查不接受路径');
const needles = [
  'e2-runtime-qualification',
  'runtime-qualification-synthetic',
  'runtime-qualification-run',
  '固定离线维护研究',
  'snapshot 目标必须全新',
];
const evidence: object[] = [];
for (const mode of ['production', 'release', 'runtime-qualification']) {
  const root = join(repository, 'out', ...(mode === 'production' ? [] : [mode]));
  const files: Record<string, string> = {};
  const matches = new Set<string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      const bytes = readFileSync(path);
      files[relative(root, path).replaceAll('\\', '/')] = createHash('sha256')
        .update(bytes)
        .digest('hex');
      if (name.endsWith('.js'))
        for (const needle of needles) if (bytes.includes(Buffer.from(needle))) matches.add(needle);
    }
  };
  for (const part of ['main', 'preload', 'renderer']) visit(join(root, part));
  assertFact(
    mode === 'runtime-qualification'
      ? matches.has('e2-runtime-qualification') && matches.has('runtime-qualification-run')
      : matches.size === 0,
    '资格代码的编译剥离边界失败',
  );
  evidence.push({ mode, files, matches: [...matches] });
}
const modules = JSON.parse(
  readFileSync(join(repository, 'out/release/main/release-modules.json'), 'utf8'),
) as { modules: string[]; forbidden: string[] };
assertFact(
  modules.forbidden.length === 0 &&
    modules.modules.every((name) => !name.includes('/data-qualification/')),
  'release 模块集合含资格实装',
);
console.log(JSON.stringify({ completed: true, productE2Pass: false, evidence }, null, 2));
