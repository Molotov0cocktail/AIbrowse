import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Replace only the two historical modules in memory; keep the checkout untouched.
const historical = process.env.AIBROWSE_DIAGNOSTIC_WATCH_BASELINE === '1';
const baseline = '207cdde3cb05550679c612e6e3561aac7a2bf248';
const modulePaths = [
  'src/main/watch/watch-preview-service.ts',
  'src/main/watch/watch-command-service.ts',
];
const replacements = new Map<string, string>();
if (historical) {
  for (const path of modulePaths) {
    const source = execFileSync('git', ['show', `${baseline}:${path}`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    replacements.set(resolve(path).replaceAll('\\', '/'), source);
    console.log(
      `历史模块 ${path} ${baseline} SHA256=${createHash('sha256').update(source).digest('hex')}`,
    );
  }
}

export default defineConfig({
  plugins: [
    {
      name: 'watch-historical-module-counterfactual',
      enforce: 'pre',
      load(id) {
        const source = replacements.get(id.split('?')[0].replaceAll('\\', '/'));
        return source === undefined ? null : { code: source, map: null };
      },
    },
  ],
  test: {
    environment: 'node',
    maxWorkers: 1,
    include: [
      'src/main/watch/watch-preview-service.test.ts',
      'src/main/watch/watch-command-service.test.ts',
    ],
  },
});
