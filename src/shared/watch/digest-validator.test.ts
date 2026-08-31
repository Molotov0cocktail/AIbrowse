import { describe, expect, it } from 'vitest';
import { parseDigestExplanation } from './digest-validator';

describe('Digest explanation canonical validator', () => {
  const visible = ['e1', 'e2', 'e3'];
  const raw = (sections: Array<{ eventIds: string[]; explanation: string }>) =>
    JSON.stringify({ sections });

  it('接受 exact-key/canonical/全局递增引用', () => {
    const raw =
      '{"sections":[{"eventIds":["e1","e2"],"explanation":"变化说明"},{"eventIds":["e3"],"explanation":"补充"}]}';
    expect(parseDigestExplanation(raw, visible)).toEqual(JSON.parse(raw));
  });

  it.each([
    ' {"sections":[{"eventIds":["e1"],"explanation":"x"}]}',
    '{"sections": [{"eventIds":["e1"],"explanation":"x"}]}',
    '{"sections":[{"explanation":"x","eventIds":["e1"]}]}',
    '{"sections":[{"eventIds":["e1"],"eventIds":["e2"],"explanation":"x"}]}',
    '{"sections":[{"eventIds":["missing"],"explanation":"x"}]}',
    '{"sections":[{"eventIds":["e2"],"explanation":"x"},{"eventIds":["e1"],"explanation":"y"}]}',
    '{"sections":[]}',
  ])('整份拒绝 hostile/non-canonical 草案 %#', (raw) => {
    expect(parseDigestExplanation(raw, visible)).toBeNull();
  });

  it('单 section 字符与 UTF-8 字节边界分别执行', () => {
    expect(
      parseDigestExplanation(raw([{ eventIds: ['e1'], explanation: 'a'.repeat(1_000) }]), visible),
    ).not.toBeNull();
    expect(
      parseDigestExplanation(raw([{ eventIds: ['e1'], explanation: 'a'.repeat(1_001) }]), visible),
    ).toBeNull();
    const exactly2048 = `${'界'.repeat(682)}aa`;
    expect(Buffer.byteLength(exactly2048, 'utf8')).toBe(2_048);
    expect(
      parseDigestExplanation(raw([{ eventIds: ['e1'], explanation: exactly2048 }]), visible),
    ).not.toBeNull();
    expect(
      parseDigestExplanation(raw([{ eventIds: ['e1'], explanation: `${exactly2048}b` }]), visible),
    ).toBeNull();
  });

  it('总 explanation 6000/6001 字符与 sections 50/51 边界', () => {
    const sixIds = Array.from({ length: 6 }, (_, index) => `e${String(index).padStart(2, '0')}`);
    const at6000 = sixIds.map((id) => ({ eventIds: [id], explanation: 'a'.repeat(1_000) }));
    expect(parseDigestExplanation(raw(at6000), sixIds)).not.toBeNull();
    const over6000 = [...at6000, { eventIds: ['e99'], explanation: 'a' }];
    expect(parseDigestExplanation(raw(over6000), [...sixIds, 'e99'])).toBeNull();

    const fiftyIds = Array.from({ length: 51 }, (_, index) => `e${String(index).padStart(2, '0')}`);
    const fifty = fiftyIds.slice(0, 50).map((id) => ({ eventIds: [id], explanation: 'x' }));
    expect(parseDigestExplanation(raw(fifty), fiftyIds)).not.toBeNull();
    expect(
      parseDigestExplanation(
        raw([...fifty, { eventIds: [fiftyIds[50]!], explanation: 'x' }]),
        fiftyIds,
      ),
    ).toBeNull();
  });

  it('完整 explanation canonical JSON 超 12288 UTF-8 bytes 整份拒绝', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `e${String(index).padStart(2, '0')}`);
    const oversized = raw([
      { eventIds: ids.slice(0, 45), explanation: '\\'.repeat(1_000) },
      ...ids.slice(45).map((id) => ({ eventIds: [id], explanation: '\\'.repeat(1_000) })),
    ]);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(12_288);
    expect(parseDigestExplanation(oversized, ids)).toBeNull();
  });
});
