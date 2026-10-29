// Inspect binary SHA-256 tables, not names or error-message strings. No network or mutation.
import fs from 'node:fs';
import process from 'node:process';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export const SOURCE =
  'https://raw.githubusercontent.com/electron/electron/v43.8.4/patches/chromium/add_entries_to_the_spki_blocklist.patch';
export const BLOCKED_SPKIS = Object.freeze([
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f',
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0',
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8',
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30',
  'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105',
  'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6',
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b',
  'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41',
]);
const CHROMIUM_PRECEDING_SPKI = '36ce75edea806f0985145683294e54dbdff02fc821870cf5067a308d1504be3a';

function offsets(bytes, needle) {
  const result = [];
  let offset = bytes.indexOf(needle);
  while (offset >= 0) {
    result.push(offset);
    offset = bytes.indexOf(needle, offset + 1);
  }
  return result;
}
function sections(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('不是PE文件');
  const pe = bytes.readUInt32LE(60);
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw new Error('PE头无效');
  const count = bytes.readUInt16LE(pe + 6);
  const start = pe + 24 + bytes.readUInt16LE(pe + 20);
  if (count > 96 || start + count * 40 > bytes.length) throw new Error('PE节表无效');
  return Array.from({ length: count }, (_, index) => {
    const cursor = start + index * 40;
    return {
      name: bytes.toString('ascii', cursor, cursor + 8).replaceAll('\0', ''),
      size: bytes.readUInt32LE(cursor + 16),
      offset: bytes.readUInt32LE(cursor + 20),
      characteristics: bytes.readUInt32LE(cursor + 36),
    };
  });
}
export function inventory(bytes) {
  const peSections = sections(bytes);
  const locate = (offset, length) => {
    const section = peSections.find(
      (entry) => offset >= entry.offset && offset + length <= entry.offset + entry.size,
    );
    return {
      offset,
      section: section?.name ?? null,
      readonly: !!section && (section.characteristics & 0x80000000) === 0,
    };
  };
  const table = Buffer.concat(BLOCKED_SPKIS.map((hash) => Buffer.from(hash, 'hex')));
  const chromiumTable = Buffer.concat([Buffer.from(CHROMIUM_PRECEDING_SPKI, 'hex'), table]);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: SOURCE,
    tableLength: table.length,
    allEightContiguousTables: offsets(bytes, table).map((offset) => locate(offset, table.length)),
    chromiumPrecedingAndEightTable: offsets(bytes, chromiumTable).map((offset) =>
      locate(offset, chromiumTable.length),
    ),
    hashes: BLOCKED_SPKIS.map((spkiSha256) => ({
      spkiSha256,
      locations: offsets(bytes, Buffer.from(spkiSha256, 'hex')).map((offset) => locate(offset, 32)),
    })),
    limitation:
      '验证编译期只读字节表及Chromium补丁前缀绑定；不冒称独立证明每条执行分支或真实网络拒绝',
  };
}

if (process.argv[2])
  process.stdout.write(`${JSON.stringify(inventory(fs.readFileSync(process.argv[2])), null, 2)}\n`);
