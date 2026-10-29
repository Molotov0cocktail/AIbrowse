import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA_TARGETS, classifyObservation, classifyReport, errorCode } from './ca-trust-oracle.mjs';
import { BLOCKED_SPKIS, inventory } from './ca-blocklist-inventory.mjs';
import { Buffer } from 'node:buffer';

function syntheticPe(payload, readonly = true) {
  const bytes = Buffer.alloc(512 + payload.length);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(1, 70);
  bytes.write('.rdata', 88);
  bytes.writeUInt32LE(payload.length, 104);
  bytes.writeUInt32LE(512, 108);
  bytes.writeUInt32LE(readonly ? 0x40000040 : 0xc0000040, 124);
  payload.copy(bytes, 512);
  return bytes;
}

test('PE静态绑定区分真实连续二进制摘要表、文本和乱序，标明可写节', () => {
  assert.equal(BLOCKED_SPKIS.length, 8);
  assert.ok(BLOCKED_SPKIS.every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
  const table = Buffer.concat(BLOCKED_SPKIS.map((hash) => Buffer.from(hash, 'hex')));
  const good = inventory(syntheticPe(table));
  assert.deepEqual(good.allEightContiguousTables, [
    { offset: 512, section: '.rdata', readonly: true },
  ]);
  assert.equal(good.hashes.filter((hash) => hash.locations.length === 1).length, 8);
  assert.equal(
    inventory(syntheticPe(Buffer.from(BLOCKED_SPKIS.join('')))).allEightContiguousTables.length,
    0,
  );
  assert.equal(
    inventory(
      syntheticPe(
        Buffer.concat([...BLOCKED_SPKIS].reverse().map((hash) => Buffer.from(hash, 'hex'))),
      ),
    ).allEightContiguousTables.length,
    0,
  );
  assert.equal(inventory(syntheticPe(table, false)).allEightContiguousTables[0].readonly, false);
  assert.throws(() => inventory(Buffer.alloc(8)), /不是PE文件/u);
});

test('网络失败、超时、普通证书失败都不能冒充受影响公钥拒绝', () => {
  for (const code of [
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNRESET',
    'ERR_CERT_AUTHORITY_INVALID',
    'UNKNOWN_ERROR',
  ]) {
    assert.equal(classifyObservation(CA_TARGETS[1], { outcome: 'error', code }), 'BLOCKED');
  }
  assert.equal(
    classifyObservation(CA_TARGETS[1], { outcome: 'error', code: 'CERT_REVOKED' }),
    'PASS',
  );
  assert.equal(
    classifyObservation(CA_TARGETS[2], { outcome: 'error', code: 'ERR_CERT_REVOKED' }),
    'PASS',
  );
});

test('任意HTTP响应意味着受影响TLS链仍可连接；正常正控须成功', () => {
  assert.equal(classifyObservation(CA_TARGETS[1], { outcome: 'response', status: 503 }), 'REPAIR');
  assert.equal(classifyObservation(CA_TARGETS[0], { outcome: 'response', status: 200 }), 'PASS');
  assert.equal(classifyObservation(CA_TARGETS[0], { outcome: 'response', status: 302 }), 'BLOCKED');
  assert.equal(
    classifyObservation(CA_TARGETS[0], { outcome: 'error', code: 'CERT_REVOKED' }),
    'BLOCKED',
  );
});

test('错误代码取真实cause或原生Chromium错误，不把网页响应当错误', () => {
  assert.equal(errorCode({ cause: { code: 'CERT_REVOKED' } }), 'CERT_REVOKED');
  assert.equal(errorCode(new Error('net::ERR_CERT_REVOKED')), 'ERR_CERT_REVOKED');
  assert.equal(errorCode(new Error('含私有文本')), 'UNKNOWN_ERROR');
});

test('覆盖缺失、重复和伪造判定均不能通过', () => {
  const rows = CA_TARGETS.map((target) => {
    const observation = target.compromised
      ? { outcome: 'error', code: 'CERT_REVOKED' }
      : { outcome: 'response', status: 200 };
    return {
      transport: 'https',
      target: target.id,
      ...observation,
      verdict: classifyObservation(target, observation),
    };
  });
  assert.equal(classifyReport(rows, ['https']), 'PASS');
  assert.equal(classifyReport(rows.slice(1), ['https']), 'BLOCKED');
  assert.equal(classifyReport([rows[0], rows[1], rows[1]], ['https']), 'BLOCKED');
  assert.equal(
    classifyReport([{ ...rows[0], status: 503 }, ...rows.slice(1)], ['https']),
    'BLOCKED',
  );
  assert.equal(
    classifyReport(
      [rows[0], { ...rows[1], outcome: 'response', status: 200, verdict: 'REPAIR' }, rows[2]],
      ['https'],
    ),
    'REPAIR',
  );
});
