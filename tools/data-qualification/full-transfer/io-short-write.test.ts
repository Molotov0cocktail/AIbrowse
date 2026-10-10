import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const mode = vi.hoisted(() => ({ zero: false, calls: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      mode.calls++;
      if (mode.zero) return 0;
      return actual.writeSync(fd, buffer, offset, Math.min(7, length), position);
    },
  };
});
import { copyBound } from './io';
const roots: string[] = [];
afterEach(() => {
  mode.zero = false;
  mode.calls = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-short-'));
  roots.push(root);
  const source = join(root, 'source'),
    target = join(root, 'target'),
    bytes = Buffer.alloc(91, 'x');
  writeFileSync(source, bytes);
  return { source, target, bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}
it('实际copyBound循环处理short write并真实读回', () => {
  const f = fixture();
  copyBound(f.source, f.target, f.bytes.length, f.sha, () => {});
  expect(mode.calls).toBe(13);
  expect(readFileSync(f.target)).toEqual(f.bytes);
});
it('zero write立即失败保留原件与目标', () => {
  const f = fixture();
  mode.zero = true;
  expect(() => copyBound(f.source, f.target, f.bytes.length, f.sha, () => {})).toThrow();
  expect(readFileSync(f.source)).toEqual(f.bytes);
  expect(mode.calls).toBe(1);
});
