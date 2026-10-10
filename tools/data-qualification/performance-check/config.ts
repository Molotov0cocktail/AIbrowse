import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import productConfig from '../../../electron.vite.config';

export default defineConfig((env) => {
  if (env.mode !== 'production' || env.command !== 'build') throw new Error('性能构建模式无效');
  const scope = process.env['AIBROWSE_PERFORMANCE_BUILD'];
  if (
    scope === undefined ||
    !/^performance-check-[a-f0-9]{32}$/u.test(scope.split(/[\\/]/u).at(-1)!)
  ) {
    throw new Error('性能构建scope无效');
  }
  const product = productConfig(env);
  for (const part of ['main', 'preload', 'renderer'] as const) {
    const config = product[part];
    if (config?.build === undefined) throw new Error('产品构建配置缺失');
    config.build.outDir = join(scope, 'app/out', part);
    const inputs: Record<string, string> = {};
    const observer: Plugin = {
      name: `performance-check-${part}-modules`,
      enforce: 'pre',
      load(id) {
        const path = id.split('?')[0]!;
        if (!path.startsWith('\0') && existsSync(path)) {
          inputs[relative(resolve('.'), path).replaceAll('\\', '/')] = createHash('sha256')
            .update(readFileSync(path))
            .digest('hex');
        }
        return null;
      },
      generateBundle(_options, bundle) {
        writeFileSync(
          join(scope, `${part}-modules.json`),
          JSON.stringify({
            inputs,
            chunks: Object.values(bundle)
              .filter((item) => item.type === 'chunk')
              .map((item) => ({ fileName: item.fileName, imports: item.imports })),
          }),
          { flag: 'wx' },
        );
      },
    };
    config.plugins = [...(config.plugins ?? []), observer];
  }
  return product;
});
