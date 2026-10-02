import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const qualificationModes = new Set([
  'qualification',
  'qualification-diagnostic',
  'qualification-load-diagnostic',
]);
const outputDirectory = (mode: string, part: string): string =>
  resolve(__dirname, 'out', ...(qualificationModes.has(mode) ? [mode] : []), part);

export default defineConfig(({ mode }) => ({
  main: {
    define: {
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
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: outputDirectory(mode, 'main'),
      rollupOptions: {
        treeshake: {
          // Main-private qualification modules initialize only pure data or exported factories.
          // Unused fixture validation must not run in the ordinary product build.
          moduleSideEffects: (id) =>
            !id.replaceAll('\\', '/').includes('/src/main/watch/qualification/'),
        },
        output: { chunkFileNames: '[name]-[hash].js' },
        input: {
          index: resolve(
            __dirname,
            mode === 'qualification' ||
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
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: outputDirectory(mode, 'preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    define: {
      __WATCH_QUALIFICATION__: JSON.stringify(
        mode === 'qualification' ||
          mode === 'qualification-diagnostic' ||
          mode === 'qualification-load-diagnostic',
      ),
    },
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: outputDirectory(mode, 'renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
}));
