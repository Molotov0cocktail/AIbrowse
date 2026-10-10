import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { compileBundle, assertRuntimeGraph } from './compile';
import { save } from './files';
import { verifyGraphs } from './binding';

it.each(['run.ts', 'offline-entry.ts'])(
  '%s全部编译输入冻结、运行图无Electron/qualification',
  async (entry) => {
    const parent = resolve('log/stage7-e2/restore-campaign-implementation-001');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'rollup-'));
    const bound = new Set<string>();
    const compiled = await compileBundle(
      resolve('tools/data-qualification/product-restore-campaign', entry),
      join(directory, 'bundle.cjs'),
      async (path) => {
        bound.add(resolve(path));
      },
    );
    await save(join(directory, 'graph.json'), {
      inputs: compiled.inputs,
      rendered: compiled.rendered,
    });
    expect(compiled.inputs.length).toBeGreaterThan(5);
    expect(compiled.inputs.every((path) => bound.has(path))).toBe(true);
    expect(compiled.rendered.every((path) => compiled.inputs.includes(path))).toBe(true);
    expect(
      compiled.rendered.some((path) => /node_modules|[\\/]qualification[\\/]/u.test(path)),
    ).toBe(false);
    expect(compiled.code).not.toMatch(/require\(['"]electron['"]\)/u);
    if (entry === 'offline-entry.ts')
      expect(compiled.inputs.some((path) => /[\\/]qualification[\\/]/u.test(path))).toBe(true);
  },
);
it('编译输入与运行图分开，运行图混入qualification/Electron或未知动态导入均拒绝', () => {
  expect(() =>
    assertRuntimeGraph(['src/main/storage/transfer-pipeline.ts'], ['node:fs'], []),
  ).not.toThrow();
  for (const [rendered, imports, dynamic] of [
    [['src/main/watch/qualification/runtime.ts'], ['node:fs'], []],
    [['node_modules/electron/index.js'], [], []],
    [['src/main/storage/transfer-pipeline.ts'], ['electron'], []],
    [['src/main/storage/transfer-pipeline.ts'], [], ['arbitrary.js']],
  ])
    expect(() => assertRuntimeGraph(rendered!, imports!, dynamic!)).toThrow();
});
it('proof运行图必须闭合、含固定入口且属于绑定输入', () => {
  const run = 'tools/data-qualification/product-restore-campaign/run.ts',
    offline = 'tools/data-qualification/product-restore-campaign/offline-entry.ts',
    qualification = 'src/main/watch/qualification/runtime.ts';
  const sources = Object.fromEntries(
    [run, offline, qualification].map((path) => [path, 'a'.repeat(64)]),
  );
  const inputs = { 'run.cjs': [run], 'offline.cjs': [offline, qualification] },
    rendered = { 'run.cjs': [run], 'offline.cjs': [offline] };
  expect(() => verifyGraphs(sources, inputs, rendered)).not.toThrow();
  for (const invalid of [
    null,
    {},
    { ...rendered, extra: [] },
    { ...rendered, 'run.cjs': [] },
    { ...rendered, 'run.cjs': [run, run] },
    { ...rendered, 'run.cjs': [offline] },
    { ...rendered, 'offline.cjs': [offline, qualification] },
    { ...rendered, 'run.cjs': [run, 'unknown.ts'] },
  ])
    expect(() => verifyGraphs(sources, inputs, invalid)).toThrow();
  expect(() => verifyGraphs(sources, { ...inputs, 'run.cjs': [offline] }, rendered)).toThrow();
});
