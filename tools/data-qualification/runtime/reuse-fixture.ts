import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BUDGET, FIXTURE, assertFact, isBuildId } from './contract.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [sourceId, targetId] = process.argv.slice(2);
assertFact(
  process.argv.length === 4 &&
    /^v24\./.test(process.version) &&
    isBuildId(sourceId) &&
    isBuildId(targetId) &&
    sourceId !== targetId,
  '复用只接受两个不同的固定 BuildId，且需要 Node 24',
);
const source = join(repository, 'log', 'stage7-e2', sourceId);
const target = join(repository, 'log', 'stage7-e2', targetId);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
for (const path of [repository, join(repository, 'log'), dirname(source), source, target]) {
  const stat = lstatSync(path);
  assertFact(stat.isDirectory() && !stat.isSymbolicLink(), '复用目录身份无效');
}
for (const root of [source, target]) {
  const file = join(root, 'build-proof.json');
  assertFact(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), '构建证明身份无效');
  const proof = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assertFact(
    proof.version === 1 &&
      proof.buildId === (root === source ? sourceId : targetId) &&
      proof.packaged === false &&
      proof.smokeMode === false,
    '复用构建证明无效',
  );
}
for (const name of ['runtime', 'fixtures', 'fixture-proof.json', 'fixture-origin-proof.json'])
  assertFact(!existsSync(join(target, name)), '目标已准备或运行，禁止覆盖');

const expected: string[] = [];
for (let index = 0; index < FIXTURE.conversationSessions; index++)
  expected.push(
    `fixtures/conversations/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.json`,
  );
expected.push('fixtures/conversations/index.json');
for (const domain of ['sources', 'research', 'watch']) {
  expected.push(`fixtures/${domain}/${domain}.db`);
  for (let version = 0; version <= (domain === 'watch' ? 5 : 1); version++)
    expected.push(`fixtures/history/${domain}-current-${version}.db`);
}
for (let version = 3; version <= 5; version++)
  expected.push(`fixtures/history/watch-historical-${version}.db`);
expected.sort();

const originalProofFile = join(source, 'fixture-proof.json');
const originalProofStat = lstatSync(originalProofFile);
assertFact(
  originalProofStat.isFile() &&
    !originalProofStat.isSymbolicLink() &&
    originalProofStat.size <= 65536,
  '原夹具证明身份或大小无效',
);
const originalProofBytes = readFileSync(originalProofFile);
const originalProofSha256 = hash(originalProofBytes);
const originalProof = JSON.parse(originalProofBytes.toString('utf8')) as Record<string, unknown>;
assertFact(
  originalProof.completed === true &&
    originalProof.productE2Pass === false &&
    typeof originalProof.durationMs === 'number' &&
    originalProof.durationMs >= 0 &&
    originalProof.durationMs <= 30000 &&
    typeof originalProof.diskBytes === 'number' &&
    originalProof.diskBytes <= BUDGET.diskBytes &&
    originalProof.hashes !== null &&
    typeof originalProof.hashes === 'object' &&
    isDeepStrictEqual(Object.keys(originalProof.hashes).sort(), expected),
  '原夹具未完成固定资格或成员集合改变',
);
const originalHashes = originalProof.hashes as Record<string, unknown>;
const verify = (root: string): void => {
  const members: string[] = [];
  let bytes = 0;
  const walk = (directory: string, depth: number): void => {
    assertFact(depth <= 2, '夹具目录层级改变');
    const stat = lstatSync(directory);
    assertFact(stat.isDirectory() && !stat.isSymbolicLink(), '夹具目录身份改变');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      assertFact(!entry.isSymbolicLink(), '夹具成员含链接');
      if (entry.isDirectory()) walk(path, depth + 1);
      else {
        assertFact(entry.isFile() && entry.nlink === 1, '夹具不是独立普通文件');
        const relative = path.slice(root.length + 1).replaceAll('\\', '/');
        assertFact(expected.includes(relative), '夹具出现未知成员');
        members.push(relative);
        bytes += entry.size;
        assertFact(bytes <= BUDGET.diskBytes, '复用夹具超过磁盘预算');
        assertFact(hash(readFileSync(path)) === originalHashes[relative], '夹具摘要改变');
      }
    }
  };
  walk(join(root, 'fixtures'), 0);
  assertFact(isDeepStrictEqual(members.sort(), expected), '夹具成员未闭合');
  assertFact(bytes === originalProof.diskBytes, '夹具字节总量改变');
};
verify(source);
mkdirSync(join(target, 'fixtures'));
for (const directory of ['conversations', 'sources', 'research', 'watch', 'history'])
  mkdirSync(join(target, 'fixtures', directory));
for (const name of expected) copyFileSync(join(source, name), join(target, name));
verify(source);
verify(target);
assertFact(hash(readFileSync(originalProofFile)) === originalProofSha256, '原夹具证明被改变');
const durationMs = performance.now() - started;
assertFact(durationMs <= 30000, '复用固定时限超限，现场已保留');
writeFileSync(join(target, 'fixture-origin-proof.json'), originalProofBytes, { flag: 'wx' });
writeFileSync(
  join(target, 'fixture-proof.json'),
  JSON.stringify(
    {
      ...originalProof,
      reusedFrom: { buildId: sourceId, fixtureProofSha256: originalProofSha256 },
      reuse: {
        durationMs,
        hashVerifiedFiles: expected.length,
        semanticValidation: '原准备版本；最终 utility 必须以当前编译源码重新扫描',
      },
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  JSON.stringify({ completed: true, sourceId, targetId, durationMs, members: expected.length }),
);
