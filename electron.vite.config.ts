import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { runtimeCompileProfile } from './tools/data-qualification/runtime/build-profile';
import { lifecycleBuild } from './tools/build/lifecycle-build';
import {
  releaseModuleReport,
  releaseAssetManifest,
  releaseCompileProfile,
} from './tools/build/release-plugins';

const buildId = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();
if (!/^[0-9a-f]{40}$/.test(buildId)) throw new Error('构建来源标识无效');

const qualificationModes = new Set([
  'qualification',
  'qualification-diagnostic',
  'qualification-load-diagnostic',
  'runtime-qualification',
]);
const outputDirectory = (mode: string, part: string): string =>
  resolve(
    __dirname,
    'out',
    ...(qualificationModes.has(mode) || mode === 'release' ? [mode] : []),
    part,
  );

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __RELEASE__: JSON.stringify(mode === 'release'),
      __E2_RUNTIME_QUALIFICATION__: JSON.stringify(mode === 'runtime-qualification'),
      __WATCH_QUALIFICATION__: JSON.stringify(
        mode === 'qualification' ||
          mode === 'qualification-diagnostic' ||
          mode === 'qualification-load-diagnostic',
      ),
      __WATCH_QUALIFICATION_DIAGNOSTIC__: JSON.stringify(
        mode === 'qualification-diagnostic' || mode === 'qualification-load-diagnostic',
      ),
      __WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__: JSON.stringify(
        mode === 'qualification-load-diagnostic',
      ),
    },
    plugins: [
      lifecycleBuild(__dirname),
      runtimeCompileProfile(mode === 'runtime-qualification'),
      externalizeDepsPlugin(),
      ...(mode === 'release' ? [releaseCompileProfile(), releaseModuleReport(__dirname)] : []),
    ],
    build: {
      outDir: outputDirectory(mode, 'main'),
      rollupOptions: {
        treeshake: {
          // Main-private qualification modules initialize only pure data or exported factories.
          // Unused fixture validation must not run in the ordinary product build.
          moduleSideEffects: (id) =>
            !id.replaceAll('\\', '/').includes('/tools/data-qualification/runtime/') &&
            !id.replaceAll('\\', '/').includes('/src/main/watch/qualification/') &&
            !(
              mode === 'release' &&
              /\/src\/main\/(?:smoke[^/]*|ai\/provider\/fake-provider)/.test(
                id.replaceAll('\\', '/'),
              )
            ),
        },
        output: { chunkFileNames: '[name]-[hash].js' },
        input: {
          'startup-probe-worker': resolve(__dirname, 'src/main/storage/startup-probe-worker.ts'),
          'transfer-worker': resolve(__dirname, 'src/main/storage/transfer-worker.ts'),
          index: resolve(
            __dirname,
            mode === 'runtime-qualification'
              ? 'tools/data-qualification/runtime/entry.ts'
              : mode === 'qualification' ||
                  mode === 'qualification-diagnostic' ||
                  mode === 'qualification-load-diagnostic'
                ? 'src/main/qualification-entry.ts'
                : 'src/main/index.ts',
          ),
        },
      },
    },
  },
  preload: {
    define: { __E2_RUNTIME_QUALIFICATION__: JSON.stringify(mode === 'runtime-qualification') },
    plugins: [runtimeCompileProfile(mode === 'runtime-qualification'), externalizeDepsPlugin()],
    build: {
      outDir: outputDirectory(mode, 'preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    define: {
      __E2_RUNTIME_QUALIFICATION__: JSON.stringify(mode === 'runtime-qualification'),
      __WATCH_QUALIFICATION__: JSON.stringify(
        mode === 'qualification' ||
          mode === 'qualification-diagnostic' ||
          mode === 'qualification-load-diagnostic',
      ),
    },
    root: 'src/renderer',
    plugins: [
      runtimeCompileProfile(mode === 'runtime-qualification'),
      react(),
      ...(mode === 'release' ? [releaseAssetManifest()] : []),
    ],
    build: {
      outDir: outputDirectory(mode, 'renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
}));
