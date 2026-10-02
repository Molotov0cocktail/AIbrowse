import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['out', 'dist', 'release', 'node_modules', 'log', 'coverage', '.h3b-workspaces'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Electron startup probes must install synchronous CJS hooks before app code.
  {
    files: [
      'tools/watch-qualification/blank-feasibility.cjs',
      'tools/watch-qualification/startup-check-observer.cjs',
      'tools/watch-qualification/startup-check-positive.cjs',
    ],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // 渲染进程：浏览器环境 + React Hooks 规则
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    ...reactHooks.configs['recommended-latest'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // 主进程 / preload / 配置文件：Node 环境
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts',
      'tools/**/*.ts',
      '*.config.ts',
      '*.config.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
);
