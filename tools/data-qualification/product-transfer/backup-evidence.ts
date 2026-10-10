import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';

const ids = ['sources', 'research', 'watch', 'conversations'] as const;
const limits = [512, 64, 512, 3201].map((value) => value * 1048576);
export interface BackupEvidence {
  bytes: number;
  sha256: string;
  snapshotId: string;
  productVersion: string;
  members: Array<{
    id: string;
    present: boolean;
    schemaVersion: number;
    bytes: number;
    sha256: string | null;
  }>;
}
function fail(): never {
  throw new Error('产品备份读回校验失败，原件保留');
}
const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
function regular(s: BigIntStats): void {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > 5n * 1024n ** 3n) fail();
}
/** Independent read-only wire oracle for product WRITER output, not an importer.
 * Canonical JSON equality also rejects duplicate keys without accepting arbitrary input syntax.
 * This verifies physical framing and every digest; it does not claim SQLite semantics.
 */
export async function inspectProductBackup(
  path: string,
  deadline: number,
): Promise<BackupEvidence> {
  if (!Number.isFinite(deadline)) fail();
  const check = () => {
    if (performance.now() >= deadline) fail();
  };
  check();
  const before = await lstat(path, { bigint: true });
  regular(before);
  const fd = await open(path, 'r');
  try {
    if (!same(before, await fd.stat({ bigint: true }))) fail();
    let offset = 0;
    const whole = createHash('sha256');
    const read = async (bytes: number): Promise<Buffer> => {
      check();
      const buffer = Buffer.alloc(bytes);
      let got = 0;
      while (got < bytes) {
        check();
        const part = await fd.read(buffer, got, bytes - got, offset + got);
        check();
        if (part.bytesRead === 0) fail();
        got += part.bytesRead;
      }
      offset += bytes;
      whole.update(buffer);
      return buffer;
    };
    const header = await read(16);
    if (header.subarray(0, 8).toString('ascii') !== 'AIBAK001' || header.readUInt32BE(8) !== 1)
      fail();
    const length = header.readUInt32BE(12);
    if (length < 1 || length > 4096) fail();
    const encoded = await read(length);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail();
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).join(',') !== 'formatVersion,productVersion,snapshotId,members' ||
      value.formatVersion !== 1 ||
      typeof value.productVersion !== 'string' ||
      !/^[\x20-\x7e]{1,64}$/.test(value.productVersion) ||
      typeof value.snapshotId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.snapshotId) ||
      !Array.isArray(value.members) ||
      value.members.length !== 4 ||
      JSON.stringify(value) !== text
    )
      fail();
    const members: BackupEvidence['members'] = [];
    for (let i = 0; i < 4; i++) {
      const entry: unknown = value.members[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail();
      const row = entry as Record<string, unknown>;
      if (
        Object.keys(row).join(',') !== 'id,present,schemaVersion,bytes,sha256' ||
        row.id !== ids[i] ||
        typeof row.present !== 'boolean' ||
        row.schemaVersion !== [1, 1, 5, 1][i] ||
        typeof row.bytes !== 'number' ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        row.bytes > limits[i]! ||
        (row.present
          ? typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
          : row.bytes !== 0 || row.sha256 !== null)
      )
        fail();
      const member = {
        id: ids[i]!,
        present: row.present,
        schemaVersion: row.schemaVersion,
        bytes: row.bytes,
        sha256: row.sha256 as string | null,
      };
      members.push(member);
    }
    if (
      BigInt(16 + length + 4 * 58 + members.reduce((sum, row) => sum + row.bytes, 0)) !==
      before.size
    )
      fail();
    for (const [i, row] of members.entries()) {
      const frame = await read(58);
      const expected = Buffer.alloc(58);
      expected[0] = i + 1;
      expected[1] = row.present ? 1 : 0;
      Buffer.from(value.snapshotId.replaceAll('-', ''), 'hex').copy(expected, 2);
      expected.writeBigUInt64BE(BigInt(row.bytes), 18);
      if (row.sha256) Buffer.from(row.sha256, 'hex').copy(expected, 26);
      if (!frame.equals(expected)) fail();
      const hash = createHash('sha256');
      let left = row.bytes;
      while (left > 0) {
        const chunk = await read(Math.min(65536, left));
        hash.update(chunk);
        left -= chunk.length;
      }
      if (row.present && hash.digest('hex') !== row.sha256) fail();
    }
    if ((await fd.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail();
    const after = await lstat(path, { bigint: true });
    regular(after);
    if (!same(before, after) || !same(before, await fd.stat({ bigint: true }))) fail();
    check();
    return {
      bytes: offset,
      sha256: whole.digest('hex'),
      snapshotId: value.snapshotId,
      productVersion: value.productVersion,
      members,
    };
  } finally {
    await fd.close();
  }
}
