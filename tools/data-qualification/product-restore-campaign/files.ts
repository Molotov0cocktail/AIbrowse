import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json.ts';
import { need } from './contract.ts';

export const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function fileHash(path: string, maximum = 512 * 1024 ** 2): Promise<string> {
  await parents(dirname(path));
  const before = await lstat(path, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
  );
  const file = await open(path, 'r'),
    digest = createHash('sha256'),
    buffer = Buffer.alloc(65_536);
  const equal = (v: typeof before) =>
    v.dev === before.dev &&
    v.ino === before.ino &&
    v.size === before.size &&
    v.mtimeNs === before.mtimeNs &&
    v.ctimeNs === before.ctimeNs &&
    v.nlink === 1n;
  try {
    need(equal(await file.stat({ bigint: true })));
    let offset = 0;
    for (;;) {
      const part = await file.read(buffer, 0, buffer.length, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
      need(offset <= Number(before.size));
      digest.update(buffer.subarray(0, part.bytesRead));
    }
    need(
      offset === Number(before.size) &&
        equal(await file.stat({ bigint: true })) &&
        equal(await lstat(path, { bigint: true })),
    );
    return digest.digest('hex');
  } finally {
    await file.close();
  }
}
export async function parents(path: string): Promise<void> {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    const stat = await lstat(cursor);
    need(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await realpath(cursor)).toLowerCase() === cursor.toLowerCase(),
    );
    if (dirname(cursor) === cursor) break;
  }
}
export async function read(path: string, maximum = 65_536): Promise<Buffer> {
  await parents(dirname(path));
  const before = await lstat(path, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
  );
  const file = await open(path, 'r');
  const equal = (v: typeof before) =>
    v.dev === before.dev &&
    v.ino === before.ino &&
    v.size === before.size &&
    v.mtimeNs === before.mtimeNs &&
    v.ctimeNs === before.ctimeNs &&
    v.nlink === 1n;
  try {
    need(equal(await file.stat({ bigint: true })));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset);
      need(part.bytesRead > 0);
      offset += part.bytesRead;
    }
    need(
      (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead === 0 &&
        equal(await file.stat({ bigint: true })) &&
        equal(await lstat(path, { bigint: true })),
    );
    return bytes;
  } finally {
    await file.close();
  }
}
export function object(bytes: Buffer, fields?: string[]): Record<string, unknown> {
  const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
    bytes: 8 * 1024 ** 2,
    depth: 16,
    nodes: 100_000,
  });
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  if (fields)
    need(
      Object.keys(result).length === fields.length &&
        fields.every((key) => Object.hasOwn(result, key)),
    );
  return result;
}
export async function save(path: string, value: unknown): Promise<void> {
  await parents(dirname(path));
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  need(bytes.length <= 8 * 1024 ** 2);
  const file = await open(path, 'wx');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
