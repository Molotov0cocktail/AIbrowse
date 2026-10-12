import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type RecordValue = Record<string, unknown>;
const root = resolve('log/browser-ux-20261012');
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
function record(value: unknown): RecordValue {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
function read(path: string): RecordValue {
  return record(JSON.parse(readFileSync(path, 'utf8')));
}
const selected = [
  {
    id: 'electron-4c81d039-07f5-41ba-80f1-207da47b9bd3',
    names: ['normal', 'blank', 'ctrl', 'script', 'dangerous', 'post', 'task', 'ai'],
  },
  { id: 'electron-6ef4b668-277c-4d2d-b5fd-5daa72449062', names: ['真实Bing到bilibili'] },
];
let expectedProductSources: RecordValue | undefined;
const sources = selected.map(({ id, names }) => {
  const directory = join(root, id);
  const result = read(join(directory, 'result.json'));
  const exit = read(join(directory, 'exit.json'));
  const binding = read(join(directory, 'binding.json'));
  assert.equal(result.passed, false);
  assert.equal(exit.code, 1);
  assert.equal(exit.sourceUnchanged, true);
  assert.equal(binding.artifact, hash(join(directory, 'main.cjs')));
  assert.equal(result.nativeWindows, 0);
  assert(Array.isArray(result.results));
  const cases = result.results.map(record);
  assert.equal(cases.length, names.length + 1);
  const failures = cases.filter((entry) => entry.passed !== true);
  assert.deepEqual(
    failures.map((entry) => entry.name),
    ['iframe'],
  );
  const reusedCases = names.map((name) => {
    const matching = cases.filter((entry) => entry.name === name);
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.passed, true);
    return matching[0]!;
  });
  const sourceHashes = record(binding.sources);
  const productSourceHashes = Object.fromEntries(
    Object.entries(sourceHashes).filter(([path]) => path.startsWith('src/')),
  );
  assert.equal(Object.keys(productSourceHashes).length, 13);
  for (const [path, digest] of Object.entries(productSourceHashes))
    assert.equal(hash(resolve(path)), digest);
  if (expectedProductSources === undefined) expectedProductSources = productSourceHashes;
  else assert.deepEqual(productSourceHashes, expectedProductSources);
  return {
    path: directory,
    files: Object.fromEntries(
      ['result.json', 'exit.json', 'binding.json', 'main.cjs'].map((file) => [
        file,
        hash(join(directory, file)),
      ]),
    ),
    sourceHashes,
    originalPassed: result.passed,
    originalExitCode: exit.code,
    reusedCases,
    excludedOriginalFailures: failures,
  };
});
const bing = record(sources[1]!.reusedCases[0]!.detail);
assert.deepEqual(bing, {
  queries: 1,
  resultClicks: 1,
  providerCalls: 0,
  target: '_blank',
  resultHost: 'www.bing.com',
  destinationHost: 'www.bilibili.com',
  newTab: true,
  tabCount: 2,
});
const aggregate = {
  passed: true,
  scope:
    '仅列明的八个本地场景与一次真实Bing到bilibili导航；不是原始整场通过，也不授iframe物理输入通过',
  cases: sources.flatMap((source) =>
    source.reusedCases.map((entry) => ({ name: entry.name, passed: entry.passed })),
  ),
  excluded: [
    {
      name: 'iframe-input-not-delivered',
      status: 'NOTRUN',
      reason:
        'WebContents.sendInputEvent没有触达子frame DOM；原生补验在编码/目标归属预检失败，实际鼠标下上零执行。原failed保留，停止此路线。',
      evidence: [
        'electron-6ef4b668-277c-4d2d-b5fd-5daa72449062/fixture.json',
        'electron-6074e635-5c82-4ec6-9321-87bbd10a068c/result.json',
        'electron-602a190d-7bc1-4fa9-973c-bb761628a1b0/result.json',
      ].map((file) => ({ path: join(root, file), sha256: hash(join(root, file)) })),
    },
  ],
  sourceReuse:
    '两来源13个产品构建输入逐字节一致且与当前源码一致；工具后继只改变输入诊断/原生助手/证据汇总，旧工具源码哈希与实际bundle均保留。未再次执行公网。',
  productSourceHashes: expectedProductSources,
  sources,
  aggregatorSha256: hash(resolve('tools/browser-navigation/aggregate.ts')),
};
writeFileSync(join(root, 'aggregate.json'), JSON.stringify(aggregate, null, 2) + '\n');
process.stdout.write(
  `聚合九个已验证子场：PASS；iframe物理输入排除，原整场FAIL保留。\n${join(root, 'aggregate.json')}\n`,
);
