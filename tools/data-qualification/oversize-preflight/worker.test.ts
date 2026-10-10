import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acceptedRejection, reachControls } from './worker';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('四个有界合法控制实际到达生产入口且不留下sidecar', async () => {
  const scope = mkdtempSync(join(tmpdir(), 'oversize-preflight-controls-'));
  roots.push(scope);
  await expect(reachControls(scope)).resolves.toBeUndefined();
});

it('拒绝必须同时满足拒绝、同一原件和无sidecar', () => {
  const fact = {
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
    nlink: 1n,
    headerSha256: 'a'.repeat(64),
  };
  expect(acceptedRejection(fact, { ...fact }, true, true)).toBe(true);
  expect(acceptedRejection(fact, { ...fact, ino: 9n }, true, true)).toBe(false);
  expect(acceptedRejection(fact, { ...fact }, false, true)).toBe(false);
  expect(acceptedRejection(fact, { ...fact }, true, false)).toBe(false);
});
