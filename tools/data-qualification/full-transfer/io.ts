import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { need } from './contract';

export type Check = () => void;
export interface Fact {
  dev: string;
  ino: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}
type Stat = BigIntStats;
export function fact(stat: Stat): Fact {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}
export function same(a: Fact, b: Fact): boolean {
  return (Object.keys(a) as (keyof Fact)[]).every((key) => a[key] === b[key]);
}
export function fileFact(path: string): Fact {
  const s = lstatSync(path, { bigint: true });
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1n &&
      realpathSync(path).toLowerCase() === resolve(path).toLowerCase(),
  );
  return fact(s);
}
export function parents(path: string): Check {
  const items: { path: string; dev: bigint; ino: bigint }[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    const s = lstatSync(current, { bigint: true });
    need(
      s.isDirectory() &&
        !s.isSymbolicLink() &&
        realpathSync(current).toLowerCase() === current.toLowerCase(),
    );
    items.push({ path: current, dev: s.dev, ino: s.ino });
    if (dirname(current) === current) break;
  }
  return () => {
    for (const item of items) {
      const s = lstatSync(item.path, { bigint: true });
      need(s.isDirectory() && !s.isSymbolicLink() && s.dev === item.dev && s.ino === item.ino);
    }
  };
}
export function writeAll(fd: number, bytes: Uint8Array, position: number, check: Check): void {
  for (let offset = 0; offset < bytes.byteLength;) {
    check();
    const n = writeSync(fd, bytes, offset, bytes.byteLength - offset, position + offset);
    check();
    need(n > 0 && n <= bytes.byteLength - offset);
    offset += n;
  }
}
function hashFd(fd: number, bytes: number, check: Check): string {
  const buffer = Buffer.alloc(65536),
    hash = createHash('sha256');
  for (let offset = 0; offset < bytes;) {
    check();
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    check();
    need(n > 0);
    hash.update(buffer.subarray(0, n));
    offset += n;
  }
  check();
  need(readSync(fd, buffer, 0, 1, bytes) === 0);
  check();
  return hash.digest('hex');
}
export function readSmall(
  path: string,
  check: Check,
): { value: unknown; sha256: string; verify: Check } {
  check();
  const parent = parents(dirname(path)),
    before = fileFact(path);
  need(Number(before.size) <= 65536);
  const fd = openSync(path, 'r');
  let bytes: Buffer;
  try {
    need(same(before, fact(fstatSync(fd, { bigint: true }))));
    bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      check();
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      check();
      need(n > 0);
      offset += n;
    }
    need(readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0);
    need(same(before, fact(fstatSync(fd, { bigint: true }))));
  } finally {
    closeSync(fd);
    check();
  }
  const verify = () => {
    check();
    parent();
    need(same(before, fileFact(path)));
    check();
  };
  verify();
  return {
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    verify,
  };
}
export function writeReceipt(
  path: string,
  value: unknown,
  check: Check,
): (verifyCheck?: Check) => void {
  check();
  const buffer = Buffer.from(JSON.stringify(value));
  need(buffer.length <= 65536);
  const fd = openSync(path, 'wx+');
  let captured: Fact;
  try {
    writeAll(fd, buffer, 0, check);
    fsyncSync(fd);
    check();
    need(hashFd(fd, buffer.length, check) === createHash('sha256').update(buffer).digest('hex'));
    captured = fact(fstatSync(fd, { bigint: true }));
  } finally {
    closeSync(fd);
    check();
  }
  const verify = (verifyCheck = check) => {
    verifyCheck();
    need(same(captured, fileFact(path)));
    verifyCheck();
  };
  verify();
  return verify;
}
export function copyBound(
  source: string,
  target: string,
  bytes: number,
  sha256: string,
  check: Check,
  expected?: Fact,
): { fact: Fact; verify: Check } {
  check();
  need(Number.isSafeInteger(bytes) && bytes >= 0 && /^[a-f0-9]{64}$/u.test(sha256));
  const sourceParents = parents(dirname(source)),
    targetParents = parents(dirname(target));
  const original = fileFact(source);
  need(Number(original.size) === bytes && (!expected || same(original, expected)));
  const input = openSync(source, 'r');
  let output: number | undefined;
  let completed: Fact;
  try {
    need(same(original, fact(fstatSync(input, { bigint: true }))));
    output = openSync(target, 'wx+');
    const buffer = Buffer.alloc(65536),
      hash = createHash('sha256');
    for (let offset = 0; offset < bytes;) {
      check();
      const n = readSync(input, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
      check();
      need(n > 0);
      hash.update(buffer.subarray(0, n));
      writeAll(output, buffer.subarray(0, n), offset, check);
      offset += n;
    }
    need(readSync(input, buffer, 0, 1, bytes) === 0 && hash.digest('hex') === sha256);
    fsyncSync(output);
    check();
    need(hashFd(output, bytes, check) === sha256);
    need(same(original, fact(fstatSync(input, { bigint: true }))));
    completed = fact(fstatSync(output, { bigint: true }));
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
    check();
  }
  const verify = () => {
    check();
    sourceParents();
    targetParents();
    need(same(original, fileFact(source)));
    need(same(completed, fileFact(target)));
    check();
  };
  verify();
  return { fact: completed, verify };
}
