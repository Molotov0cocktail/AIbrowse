import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 核心业务逻辑为零环境依赖的纯逻辑（分层纪律），统一用 node 环境单测
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
