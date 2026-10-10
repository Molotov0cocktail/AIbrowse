import { build, type Plugin } from 'vite';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { read, save } from './files.ts';
import { need } from './contract.ts';

const RELEASE_DEFINES = Object.freeze({
  __RELEASE__: 'true',
  __E2_RUNTIME_QUALIFICATION__: 'false',
  __WATCH_QUALIFICATION__: 'false',
  __WATCH_QUALIFICATION_DIAGNOSTIC__: 'false',
  __WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__: 'false',
});
export interface Compiled {
  inputs: string[];
  rendered: string[];
  code: string;
}
export function assertRuntimeGraph(
  rendered: readonly string[],
  imports: readonly string[],
  dynamic: readonly string[],
): void {
  need(
    rendered.length > 0 &&
      rendered.every((path) => !/(?:^|\/)node_modules\/|\/qualification\//u.test(path)) &&
      dynamic.length === 0,
    '恢复bundle仍含发行外运行模块',
  );
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  need(
    imports.every((name) => builtins.has(name)),
    '恢复bundle运行依赖不是固定Node内建模块',
  );
}
/** Freeze every source read by Rollup, including modules removed by the release tree shaker. */
export async function compileBundle(
  entry: string,
  output: string,
  bind: (path: string, bytes: Uint8Array) => Promise<void>,
): Promise<Compiled> {
  const loaded = new Set<string>();
  let result: Compiled | null = null;
  const plugin: Plugin = {
    name: 'restore-campaign-release-source-binding',
    enforce: 'pre',
    async load(id) {
      if (id.startsWith('\0')) return null;
      const path = resolve(id),
        normalized = path.replaceAll('\\', '/');
      need(
        !normalized.includes('/node_modules/') && /\.ts$/u.test(path),
        '恢复编译输入不是固定源码',
      );
      const bytes = await read(path, 8 * 1024 ** 2);
      await bind(path, bytes);
      loaded.add(path);
      return bytes.toString('utf8');
    },
    async generateBundle(_options, bundle) {
      const values = Object.values(bundle);
      need(values.length === 1 && values[0]?.type === 'chunk');
      const chunk = values[0];
      const rendered = Object.entries(chunk.modules)
        .filter(([, value]) => value.renderedLength > 0)
        .map(([path]) => resolve(path))
        .sort();
      await save(output + '.graph.json', {
        inputs: [...loaded].sort(),
        rendered,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
      });
      assertRuntimeGraph(
        rendered.map((path) => path.replaceAll('\\', '/')),
        chunk.imports,
        chunk.dynamicImports,
      );
      need(rendered.every((path) => loaded.has(path)));
      result = { inputs: [...loaded].sort(), rendered, code: chunk.code };
    },
  };
  await build({
    configFile: false,
    envFile: false,
    root: resolve('.'),
    publicDir: false,
    logLevel: 'silent',
    define: RELEASE_DEFINES,
    plugins: [plugin],
    ssr: { noExternal: true },
    build: {
      ssr: resolve(entry),
      target: 'node24',
      outDir: dirname(resolve(output)),
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        external: (name) =>
          name === 'electron' || name.startsWith('node:') || builtinModules.includes(name),
        treeshake: {
          moduleSideEffects: (id) => {
            const path = id.replaceAll('\\', '/');
            return (
              !path.includes('/tools/data-qualification/runtime/') &&
              !path.includes('/src/main/watch/qualification/') &&
              !/\/src\/main\/(?:smoke[^/]*|ai\/provider\/fake-provider)/u.test(path)
            );
          },
        },
        output: {
          format: 'cjs',
          entryFileNames: resolve(output).slice(dirname(resolve(output)).length + 1),
          inlineDynamicImports: true,
        },
      },
    },
  });
  need(result);
  return result;
}
