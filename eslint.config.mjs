import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['out', 'dist', 'release', 'node_modules', 'log', 'coverage'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
      '*.config.ts',
      '*.config.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
);
