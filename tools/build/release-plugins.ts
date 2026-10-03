import { relative } from 'node:path';
import { transformWithEsbuild, type Plugin } from 'vite';

/** Remove development branches before Rollup discovers their module graph. */
export function releaseCompileProfile(): Plugin {
  return {
    name: 'release-compile-profile',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/main/index.ts')) return null;
      const transformed = await transformWithEsbuild(code, id, {
        loader: 'ts',
        define: {
          __RELEASE__: 'true',
          __WATCH_QUALIFICATION__: 'false',
          __WATCH_QUALIFICATION_DIAGNOSTIC__: 'false',
          __WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__: 'false',
        },
        minifySyntax: true,
        treeShaking: true,
      });
      return { code: transformed.code, map: JSON.stringify(transformed.map) };
    },
  };
}

export function releaseModuleReport(root: string): Plugin {
  return {
    name: 'release-module-report',
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((item) =>
        item.type === 'chunk'
          ? Object.entries(item.modules)
              .filter(([, value]) => value.renderedLength > 0)
              .map(([id]) => relative(root, id).replaceAll('\\', '/'))
          : [],
      );
      const forbidden = modules.filter((id) =>
        /(?:^|\/)(?:smoke[^/]*|qualification|native)(?:\/|\.)|\.(?:test|spec)\./i.test(id),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'release-modules.json',
        source: JSON.stringify({ modules, forbidden }, null, 2),
      });
      if (forbidden.length > 0) this.error(`发行构建仍包含验收模块：${forbidden.join(', ')}`);
    },
  };
}

export function releaseAssetManifest(): Plugin {
  return {
    name: 'release-asset-manifest',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets: Record<string, { file: string; contentType: string }> = {};
      for (const file of Object.keys(bundle).sort()) {
        const contentType = file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : null;
        if (
          contentType === null ||
          (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file))
        ) {
          this.error('发行 UI 出现未批准的资产类型');
        }
        assets[`/${file}`] = { file, contentType };
      }
      this.emitFile({
        type: 'asset',
        fileName: 'asset-manifest.json',
        source: JSON.stringify({ version: 1, assets }, null, 2),
      });
    },
  };
}
