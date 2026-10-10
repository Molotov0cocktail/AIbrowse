import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  activeOriginals,
  assertOriginalsDrainedBeforeReady,
  type ActiveObservations,
} from './harness';
import { ObservedPromise } from './controls';
import { writeProjectedChunks } from './scan';

vi.mock('electron', () => ({ app: {}, utilityProcess: {} }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const root = fs.mkdtempSync(join(tmpdir(), 'runtime-output-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const chunks = () => [Buffer.from('合成'), Buffer.from('0123456789'), Buffer.from('尾部')];
const originalWrite = fs.writeSync;
function observations(): ActiveObservations {
  const values = {} as ActiveObservations;
  for (const name of [
    'chat',
    'agent',
    'research',
    'watch',
    'watchOrchestration',
    'digest',
    'preview',
    'exporter',
    'usage',
  ] as const) {
    const value = new ObservedPromise();
    value.promise = Promise.resolve();
    value.settledAt = 10;
    values[name] = value;
  }
  return values;
}
it.each(['late', 'pending', 'rejected'] as const)(
  'ready cannot accept %s Watch orchestration',
  (kind) => {
    const values = observations();
    values.watchOrchestration.settledAt = kind === 'pending' ? null : kind === 'late' ? 21 : 10;
    values.watchOrchestration.rejected = kind === 'rejected';
    expect(() => assertOriginalsDrainedBeforeReady(activeOriginals(values), 20)).toThrow(
      '原操作未成功排水',
    );
  },
);
it('includes all nine originals and accepts settlement at the ready boundary', () => {
  const values = observations();
  values.watchOrchestration.settledAt = 20;
  expect(activeOriginals(values)).toHaveLength(9);
  expect(() => assertOriginalsDrainedBeforeReady(activeOriginals(values), 20)).not.toThrow();
});
it('retries partial writes until every projected byte is present', async () => {
  const file = join(root, crypto.randomUUID());
  const all = Buffer.concat(chunks());
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, buffer: unknown, offset?: unknown) => {
    if (!Buffer.isBuffer(buffer)) throw new Error('夹具仅接受Buffer');
    return originalWrite(fd, buffer, typeof offset === 'number' ? offset : 0, 1);
  });
  const result = await writeProjectedChunks(file, chunks(), all.length);
  expect(fs.readFileSync(file)).toEqual(all);
  expect(result).toEqual({
    expectedBytes: all.length,
    actualBytes: all.length,
    sha256: createHash('sha256').update(all).digest('hex'),
  });
});
it('zero-byte writes fail instead of claiming a complete output', async () => {
  vi.spyOn(fs, 'writeSync').mockReturnValue(0);
  const close = vi.spyOn(fs, 'closeSync');
  await expect(
    writeProjectedChunks(join(root, crypto.randomUUID()), chunks(), 22),
  ).rejects.toThrow();
  expect(close).toHaveBeenCalledTimes(1);
});
it('verifies bytes read back instead of trusting successful write counts', async () => {
  const file = join(root, crypto.randomUUID());
  const all = Buffer.concat(chunks());
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, buffer: unknown) => {
    if (!Buffer.isBuffer(buffer)) throw new Error('夹具仅接受Buffer');
    return originalWrite(fd, Buffer.alloc(buffer.byteLength, 120));
  });
  await expect(writeProjectedChunks(file, chunks(), all.length)).rejects.toThrow();
});
it('rejects a projected byte count that differs from emitted chunks', async () => {
  await expect(
    writeProjectedChunks(join(root, crypto.randomUUID()), chunks(), 1),
  ).rejects.toThrow();
});

it('requires EOF rather than stopping after the expected number of bytes', async () => {
  const file = join(root, crypto.randomUUID());
  const originalStat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
    const result = originalStat(...args);
    fs.appendFileSync(file, 'extra');
    return result;
  });
  await expect(
    writeProjectedChunks(file, chunks(), Buffer.concat(chunks()).length),
  ).rejects.toThrow('尾随字节');
});

it('rejects missing emitted bytes and leaves the failed artifact available for inspection', async () => {
  const file = join(root, crypto.randomUUID());
  await expect(
    writeProjectedChunks(file, chunks(), Buffer.concat(chunks()).length + 1),
  ).rejects.toThrow('缺少声明字节');
  expect(fs.readFileSync(file)).toEqual(Buffer.concat(chunks()));
});
