import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createStartupProbeProtocol,
  validateStartupProbeResult,
  STARTUP_PROBE_DOMAINS,
} from './startup-probe-protocol';
it('counts the seventeenth frame and remains failed afterwards', () => {
  const operationId = randomUUID();
  const protocol = createStartupProbeProtocol(operationId);
  const raw = JSON.stringify({ type: 'ready', operationId });
  for (let i = 0; i < 16; i++) protocol.read(raw);
  expect(() => protocol.read(raw)).toThrow();
  expect(() => protocol.read(raw)).toThrow();
});
it.each(['duplicate', 'unknown', 'large', 'non-string', 'depth'] as const)(
  'rejects %s protocol data before trusting it',
  (kind) => {
    const operationId = randomUUID();
    const protocol = createStartupProbeProtocol(operationId);
    const raw =
      kind === 'duplicate'
        ? `{"type":"ready","operationId":"${operationId}","type":"ready"}`
        : kind === 'unknown'
          ? JSON.stringify({ type: 'ready', operationId, path: 'private' })
          : kind === 'large'
            ? ' '.repeat(4097)
            : kind === 'depth'
              ? '['.repeat(20) + '0' + ']'.repeat(20)
              : {};
    expect(() => protocol.read(raw)).toThrow('启动数据预检失败');
  },
);
it('closes the three domains, identities and migrate decision', () => {
  const result = {
    state: 'normal',
    root: { dev: '1', ino: '2' },
    members: STARTUP_PROBE_DOMAINS.map((id) => ({
      id,
      state: 'missing',
      version: null,
      directory: null,
      database: null,
      wal: null,
      journal: null,
    })),
  };
  expect(validateStartupProbeResult(result)).toEqual(result);
  expect(() => validateStartupProbeResult({ ...result, state: 'migrate' })).toThrow();
  expect(() =>
    validateStartupProbeResult({ ...result, members: result.members.slice(1) }),
  ).toThrow();
  expect(() =>
    validateStartupProbeResult({ ...result, root: { ...result.root, path: 'private' } }),
  ).toThrow();
});
