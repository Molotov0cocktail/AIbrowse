// Build only diagnostic bundles, preserving the exact old implementation for comparison.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
const root = resolve(process.argv[2]);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
mkdirSync(root, { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  logLevel: 'silent',
};
await build({
  ...common,
  entryPoints: ['tools/legacy-diagnostics/models-live.ts'],
  outfile: resolve(root, 'entry.cjs'),
});
const source = execFileSync('git', ['show', 'cd6c9ae^:src/main/watch/digest-service.ts'], {
  encoding: 'utf8',
});
await build({
  ...common,
  stdin: { contents: source, loader: 'ts', resolveDir: resolve('src/main/watch') },
  outfile: resolve(root, 'old-digest.cjs'),
});
writeFileSync(
  resolve(root, 'build-identity.json'),
  JSON.stringify(
    {
      baseline: 'dedbfdcbdcea2723eb09c4f73c0f1b5810cbe9e8',
      oldDigest: 'cd6c9ae^:src/main/watch/digest-service.ts',
      currentHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      oldDigestCommit: execFileSync('git', ['rev-parse', 'cd6c9ae^'], { encoding: 'utf8' }).trim(),
      entrySha256: digest(resolve(root, 'entry.cjs')),
      oldDigestSha256: digest(resolve(root, 'old-digest.cjs')),
      sourceSha256: Object.fromEntries(
        [
          'src/main/research/research-runtime.ts',
          'src/main/ai/provider/openai-compatible.ts',
          'src/main/ai/agent/agent-history.ts',
          'src/main/watch/digest-service.ts',
          'src/main/watch/digest-prompt.ts',
          'src/shared/watch/digest-validator.ts',
          'tools/legacy-diagnostics/models-live.ts',
          'tools/legacy-diagnostics/models-fixtures.ts',
          'tools/legacy-diagnostics/models-classify.ts',
        ].map((path) => [path, digest(path)]),
      ),
      purpose: '真实流事件形状下旧实现与当前实现成对对照',
      requestBudget: 'full≤6；digest-only≤1；digest-pair≤2且第二次须内部标记',
    },
    null,
    2,
  ),
);
