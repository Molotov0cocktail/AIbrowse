import { it, vi } from 'vitest';

// Reuse the unchanged native oracles while a concurrent app build owns out/.
const selected = process.env.AIBROWSE_GUARDIAN_REVIEW_HELPER;
if (!selected) {
  it.skip('原生独立资格需要显式绑定本轮隔离制品', () => {});
} else {
  vi.doMock('node:path', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:path')>();
    if (!original.isAbsolute(selected)) throw new Error('资格制品必须是绝对路径');
    return {
      ...original,
      resolve(...paths: string[]) {
        return paths.length === 1 && paths[0] === 'out/lifecycle-guardian/guardian.exe'
          ? selected
          : original.resolve(...paths);
      },
    };
  });
  await import('./guardian/native.test');
}
