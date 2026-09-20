import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

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
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
}));
