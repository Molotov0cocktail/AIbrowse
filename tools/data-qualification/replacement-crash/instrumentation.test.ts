import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { afterEach, expect, it } from 'vitest';
import { buildWorker } from './build';
import { REPLACEMENT_CHECKPOINTS } from './contracts';
import { instrumentDatasetActive } from './instrumentation';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

it('固定dataset-active六点插桩可编译且剥离后与原字节逐字相等', async () => {
  const source = await readFile('src/main/storage/dataset-active.ts', 'utf8');
  const result = instrumentDatasetActive(source);
  expect(result.strip()).toBe(source);
  for (const point of REPLACEMENT_CHECKPOINTS.slice(10).filter(
    (point) => point.startsWith('dataset-active') || point.startsWith('before-dataset-active'),
  ))
    expect(result.instrumented.split(`('${point}')`)).toHaveLength(2);
  await expect(
    transform(result.instrumented, { loader: 'ts', target: 'node24' }),
  ).resolves.toBeDefined();
});

it('任一固定I/O锚点缺失或重复都拒绝，不接受近似脚本', async () => {
  const source = await readFile('src/main/storage/dataset-active.ts', 'utf8');
  const anchor = '    await file.sync();\n';
  expect(() => instrumentDatasetActive(source.replace(anchor, ''))).toThrow('缺失或重复');
  expect(() => instrumentDatasetActive(source.replace(anchor, anchor + anchor))).toThrow(
    '缺失或重复',
  );
});

it('worker构建保存完整输入与artifact绑定，active清单使用未插桩原文hash', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-build-'));
  cleanup.push(temp);
  const build = await buildWorker(process.cwd(), join(temp, 'build'));
  const active = build.sources.find(
    (source) =>
      source.path.endsWith('src\\main\\storage\\dataset-active.ts') ||
      source.path.endsWith('src/main/storage/dataset-active.ts'),
  );
  expect(active).toBeDefined();
  expect(active?.sha256).toBe(
    instrumentDatasetActive(await readFile('src/main/storage/dataset-active.ts', 'utf8'))
      .originalSha256,
  );
  expect(build.artifact.bytes).toBeGreaterThan(0);
  expect(build.nodeExecutable.path).toBe(process.execPath);
  expect(build.nodeExecutable.bytes).toBeGreaterThan(0);
  expect(build.nodeVersion).toBe(process.version);
  expect(build.esbuildVersion).toMatch(/^\d+\.\d+\.\d+$/u);
});
