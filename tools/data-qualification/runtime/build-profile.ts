import { transformWithEsbuild, type Plugin } from 'vite';

// Remove the compiler-only entry branches before Rollup discovers their imports.
export function runtimeCompileProfile(enabled: boolean): Plugin {
  return {
    name: 'runtime-qualification-compile-boundary',
    enforce: 'pre',
    async transform(code, id) {
      if (
        !/\/(?:src\/main\/index\.ts|src\/preload\/index\.ts|src\/renderer\/src\/main\.tsx)$/.test(
          id.replaceAll('\\', '/'),
        )
      )
        return null;
      const result = await transformWithEsbuild(code, id, {
        loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
        jsx: 'preserve',
        define: { __E2_RUNTIME_QUALIFICATION__: JSON.stringify(enabled) },
        minifySyntax: true,
        treeShaking: true,
      });
      return { code: result.code, map: JSON.stringify(result.map) };
    },
  };
}
