import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { inspectProductBackup } from './product-transfer/backup-evidence.ts';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || process.argv.length !== 4)
  throw new Error('需要备份原件和新证据目录的绝对路径');
if (!isAbsolute(sourceArgument) || !isAbsolute(outputArgument)) throw new Error('仅接受绝对路径');
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
if (existsSync(output)) throw new Error('输出目录必须尚不存在');
const identity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
const same = (left, right) => JSON.stringify(identity(left)) === JSON.stringify(identity(right));
const before = lstatSync(source, { bigint: true });
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.nlink !== 1n ||
  before.size > 16n * 1024n ** 2n
)
  throw new Error('备份原件资格或预算失败');
const wire = await inspectProductBackup(source, performance.now() + 10_000);
const expected = [
  ['sources', 'sources.db'],
  ['research', 'research.db'],
  ['watch', 'watch.db'],
];
if (
  expected.some(([id], index) => wire.members[index]?.id !== id || !wire.members[index]?.present) ||
  wire.members[3]?.id !== 'conversations' ||
  wire.members[3]?.present
)
  throw new Error('仅准入三库存在且会话缺席的合成备份');
const fd = openSync(source, 'r');
let bytes;
try {
  if (!same(before, fstatSync(fd, { bigint: true }))) throw new Error('备份身份已变化');
  bytes = readFileSync(fd);
  if (!same(before, fstatSync(fd, { bigint: true }))) throw new Error('备份读取期间发生变化');
} finally {
  closeSync(fd);
}
if (bytes.length !== wire.bytes || createHash('sha256').update(bytes).digest('hex') !== wire.sha256)
  throw new Error('备份整体摘要不一致');
mkdirSync(output);
let offset = 16 + bytes.readUInt32BE(12);
const extracted = [];
for (const [index, [id, filename]] of expected.entries()) {
  offset += 58;
  const member = wire.members[index];
  const content = bytes.subarray(offset, offset + member.bytes);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (content.length !== member.bytes || sha256 !== member.sha256)
    throw new Error('备份成员摘要不一致');
  writeFileSync(join(output, filename), content, { flag: 'wx' });
  extracted.push({ member: id, file: filename, bytes: content.length, sha256 });
  offset += content.length;
}
offset += 58;
if (offset !== bytes.length || !same(before, lstatSync(source, { bigint: true })))
  throw new Error('备份边界或身份在提取期间变化');
writeFileSync(
  join(output, 'extract-evidence.json'),
  JSON.stringify(
    { schema: 1, source, originalIdentity: identity(before), wire, extracted },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
process.stdout.write(JSON.stringify({ output, bytes: wire.bytes, sha256: wire.sha256 }) + '\n');
