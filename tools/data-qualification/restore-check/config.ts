import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import productConfig from '../../../electron.vite.config';
import { need, scopeAt, writeNew } from './contract';

export default defineConfig((env) => {
  need(env.mode === 'production' && env.command === 'build');
  const scope = scopeAt(process.env.AIBROWSE_RESTORE_CHECK_BUILD ?? '');
  const product = productConfig(env);
  for (const part of ['main', 'preload', 'renderer'] as const) {
    const config = product[part];
    need(config?.build);
    config.build.outDir = join(scope, 'app/out', part);
    const inputs: Record<string, string> = {};
    const observer: Plugin = {
      name: `restore-check-${part}-module-evidence`,
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
        writeNew(join(scope, `${part}-modules.json`), {
          inputs,
          chunks: Object.values(bundle)
            .filter((value) => value.type === 'chunk')
            .map((value) => ({
              name: value.fileName,
              modules: Object.entries(value.modules)
                .filter(([, v]) => v.renderedLength > 0)
                .map(([id]) => id),
              imports: value.imports,
              dynamicImports: value.dynamicImports,
            })),
        });
      },
    };
    config.plugins = [...(config.plugins ?? []), observer];
  }
  return product;
});
