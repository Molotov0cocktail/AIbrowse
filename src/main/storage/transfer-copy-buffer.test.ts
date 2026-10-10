import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { BACKUP_LIMITS, TransferInput } from './backup-container';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const root = fs.mkdtempSync(join(tmpdir(), 'transfer-copy-buffer-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it.each([0, 17, BACKUP_LIMITS.chunk, BACKUP_LIMITS.chunk * 16 + 19])(
  '同步流读取%d字节只占一个至多64KiB的可复用缓冲并保持双重摘要',
  (size) => {
    const payload = Buffer.alloc(size);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const path = join(root, crypto.randomUUID());
    fs.writeFileSync(path, payload);
    const expected = digest(payload);
    const input = new TransferInput(path, size, {
      signal: new AbortController().signal,
      deadline: performance.now() + 5000,
    });
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    const observed = createHash('sha256');
    let received = 0;
    try {
      const result = input.copy(size, (chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(BACKUP_LIMITS.chunk);
        expect(chunk.equals(payload.subarray(received, received + chunk.length))).toBe(true);
        observed.update(chunk);
        received += chunk.length;
      });
      expect(result).toEqual({ bytes: size, sha256: expected });
      expect(input.finish()).toEqual(result);
      expect(observed.digest('hex')).toBe(expected);
      expect(received).toBe(size);
      expect(allocate.mock.calls.reduce((bytes, [count]) => bytes + count, 0)).toBeLessThanOrEqual(
        Math.min(size, BACKUP_LIMITS.chunk),
      );
    } finally {
      input.close();
    }
  },
);

it('复用缓冲在短读后不复制旧尾部，分段copy及独立read仍保持准确位置和摘要', () => {
  const payload = Buffer.alloc(BACKUP_LIMITS.chunk * 2 + 31);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 253;
  const path = join(root, crypto.randomUUID());
  fs.writeFileSync(path, payload);
  const nativeRead = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      return nativeRead(fd, value, Number(offset), Math.min(Number(length), 997), Number(position));
    },
  );
  const input = new TransferInput(path, payload.length, {
    signal: new AbortController().signal,
    deadline: performance.now() + 5000,
  });
  try {
    const prefix = input.read(7);
    let cursor = 7;
    for (const bytes of [BACKUP_LIMITS.chunk + 13, payload.length - 7 - BACKUP_LIMITS.chunk - 13]) {
      const start = cursor;
      const copied = input.copy(bytes, (chunk) => {
        expect(chunk.equals(payload.subarray(cursor, cursor + chunk.length))).toBe(true);
        cursor += chunk.length;
      });
      expect(copied).toEqual({ bytes, sha256: digest(payload.subarray(start, cursor)) });
    }
    expect(prefix.equals(payload.subarray(0, 7))).toBe(true);
    expect(input.finish()).toEqual({ bytes: payload.length, sha256: digest(payload) });
  } finally {
    input.close();
  }
});
