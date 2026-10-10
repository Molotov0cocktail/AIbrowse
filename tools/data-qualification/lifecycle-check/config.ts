import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import productConfig from '../../../electron.vite.config';

export default defineConfig((env) => {
  if (env.mode !== 'production' || env.command !== 'build') throw new Error('仅允许普通产品构建');
  const scope = resolve(process.env.AIBROWSE_LIFECYCLE_CHECK_BUILD ?? '');
  if (!/lifecycle-check-[a-f0-9]{32}$/u.test(scope)) throw new Error('检查构建目录无效');
  const product = productConfig(env);
  for (const part of ['main', 'preload', 'renderer'] as const) {
    const config = product[part];
    if (!config?.build) throw new Error('产品构建配置缺失');
    config.build.outDir = join(scope, 'app/out', part);
    const inputs: Record<string, string> = {};
    const observer: Plugin = {
      name: `lifecycle-check-${part}-binding`,
      enforce: 'pre',
      load(id) {
        const path = id.split('?')[0]!;
        if (!path.startsWith('\0') && existsSync(path))
          inputs[relative(resolve('.'), path).replaceAll('\\', '/')] = createHash('sha256')
            .update(readFileSync(path))
            .digest('hex');
        return null;
      },
      generateBundle() {
        writeFileSync(join(scope, `${part}-modules.json`), JSON.stringify(inputs), { flag: 'wx' });
      },
    };
    config.plugins = [...(config.plugins ?? []), observer];
  }
  return product;
});
