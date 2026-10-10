import { expect, it } from 'vitest';
import { createTransferProtocol, type TransferJobRecord } from './transfer-protocol';
import { BACKUP_IDS } from './backup-container';
const job: TransferJobRecord = {
  operationId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '22222222-2222-4222-8222-222222222222',
  action: 'backup',
};
const ready = JSON.stringify({ type: 'ready', operationId: job.operationId });
it('creates an operation-bound bounded protocol', () => {
  const protocol = createTransferProtocol(job);
  expect(JSON.parse(protocol.send({ type: 'init', ...job }))).toEqual({ type: 'init', ...job });
  expect(protocol.receive(ready)).toEqual({ type: 'ready', operationId: job.operationId });
  expect(protocol.counts().frames).toBe(2);
});
it.each([
  null,
  {},
  [],
  Buffer.from(ready),
  '',
  '{',
  JSON.stringify({ type: 'ready', operationId: job.operationId, path: 'private' }),
  JSON.stringify({ type: 'ready', operationId: job.snapshotId }),
  JSON.stringify({ type: 'phase', operationId: job.operationId, phase: ['sqlite'] }),
  JSON.stringify({ type: 'failed', operationId: job.operationId, code: ['io'] }),
  `{"type":"ready","operationId":"${job.operationId}","operation\\u0049d":"${job.operationId}"}`,
  JSON.stringify({ type: 'ready', operationId: job.operationId }) + ' '.repeat(4096),
  JSON.stringify({ type: 'unknown', operationId: job.operationId }),
  JSON.stringify({ type: 'init', ...job }),
])('rejects malformed or over-budget frame %j and keeps the failure sticky', (value) => {
  const protocol = createTransferProtocol(job);
  expect(() => protocol.receive(value)).toThrow('数据校验通信无效');
  expect(() => protocol.receive(ready)).toThrow('数据校验通信无效');
});
it('counts both directions and rejects the seventeenth frame', () => {
  const protocol = createTransferProtocol(job);
  for (let i = 0; i < 8; i++) {
    protocol.send({ type: 'cancel', operationId: job.operationId });
    protocol.receive(ready);
  }
  expect(protocol.counts().frames).toBe(16);
  expect(() => protocol.receive(ready)).toThrow();
});
it('checks actual UTF8 bytes before parsing', () => {
  const protocol = createTransferProtocol(job);
  const frame = JSON.stringify({
    type: 'ready',
    operationId: job.operationId,
    unknown: '界'.repeat(1500),
  });
  expect(frame.length).toBeLessThan(4096);
  expect(() => protocol.receive(frame)).toThrow();
});
it('rejects unknown registration metadata and does not serialize it', () => {
  expect(() => createTransferProtocol({ ...job, path: 'private' } as TransferJobRecord)).toThrow();
});
it('accepts the exact byte boundary and rejects one extra byte', () => {
  const exact = ready + ' '.repeat(4096 - Buffer.byteLength(ready));
  const protocol = createTransferProtocol(job);
  for (let i = 0; i < 16; i++) protocol.receive(exact);
  expect(protocol.counts()).toEqual({ frames: 16, bytes: 65536 });
  expect(() => createTransferProtocol(job).receive(exact + ' ')).toThrow();
});
it.each(['snapshot', 'unknown', 'duplicate', 'schema', 'hash', 'oversize'] as const)(
  'rejects invalid closed result metadata: %s',
  (change) => {
    const result: Record<string, unknown> = {
      formatVersion: 1,
      productVersion: '0.1.0',
      snapshotId: job.snapshotId,
      members: BACKUP_IDS.map((id) => ({
        id,
        present: true,
        schemaVersion: id === 'watch' ? 5 : 1,
        bytes: 0,
        sha256: 'a'.repeat(64),
      })),
    };
    const members = result.members as Array<Record<string, unknown>>;
    if (change === 'snapshot') result.snapshotId = job.operationId;
    if (change === 'unknown') result.path = 'private';
    if (change === 'duplicate') members[1].id = 'sources';
    if (change === 'schema') members[0].schemaVersion = 999;
    if (change === 'hash') {
      members[0].present = true;
      members[0].sha256 = 'not-a-hash';
    }
    if (change === 'oversize') members[0].bytes = 512 * 1024 ** 2 + 1;
    expect(() =>
      createTransferProtocol(job).receive(
        JSON.stringify({
          type: 'result',
          operationId: job.operationId,
          result: { manifest: result, backup: { bytes: 1, sha256: 'a'.repeat(64) } },
        }),
      ),
    ).toThrow('数据校验通信无效');
  },
);
it.each(['backup', 'restore', 'migrate'] as const)(
  'binds output proof presence to %s and requires a complete current work set',
  (action) => {
    const result = {
      manifest: {
        formatVersion: 1,
        productVersion: '0.1.0',
        snapshotId: job.snapshotId,
        members: BACKUP_IDS.map((id) => ({
          id,
          present: true,
          schemaVersion: id === 'watch' ? 5 : 1,
          bytes: 0,
          sha256: 'a'.repeat(64),
        })),
      },
      backup: action === 'backup' ? { bytes: 1, sha256: 'b'.repeat(64) } : null,
    };
    const frame = () => JSON.stringify({ type: 'result', operationId: job.operationId, result });
    expect(createTransferProtocol({ ...job, action }).receive(frame()).type).toBe('result');
    result.backup = action === 'backup' ? null : { bytes: 1, sha256: 'b'.repeat(64) };
    expect(() => createTransferProtocol({ ...job, action }).receive(frame())).toThrow();
  },
);
it.each(['missing-member', 'old-schema', 'output-path', 'output-limit', 'output-hash'] as const)(
  'rejects invalid work/output proof: %s',
  (change) => {
    const result: {
      manifest: {
        formatVersion: number;
        productVersion: string;
        snapshotId: string;
        members: Array<Record<string, unknown>>;
      };
      backup: Record<string, unknown>;
    } = {
      manifest: {
        formatVersion: 1,
        productVersion: '0.1.0',
        snapshotId: job.snapshotId,
        members: BACKUP_IDS.map((id) => ({
          id,
          present: true,
          schemaVersion: id === 'watch' ? 5 : 1,
          bytes: 0,
          sha256: 'a'.repeat(64),
        })),
      },
      backup: { bytes: 1, sha256: 'b'.repeat(64) },
    };
    if (change === 'missing-member') {
      result.manifest.members[0].present = false;
      result.manifest.members[0].sha256 = null;
    }
    if (change === 'old-schema') result.manifest.members[0].schemaVersion = 0;
    if (change === 'output-path') result.backup.path = 'private';
    if (change === 'output-limit') result.backup.bytes = 5 * 1024 ** 3 + 1;
    if (change === 'output-hash') result.backup.sha256 = 'bad';
    expect(() =>
      createTransferProtocol(job).receive(
        JSON.stringify({ type: 'result', operationId: job.operationId, result }),
      ),
    ).toThrow();
  },
);
