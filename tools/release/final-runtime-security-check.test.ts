import { describe, expect, it } from 'vitest';
import { parseFirstEmpty, whitespaceMutation } from './final-runtime-security-check';

const root = 'D:\\synthetic\\aibrowse';
const original = {
  ok: true,
  empty: true,
  declaredProfile: 'C:\\Users\\synthetic\\AppData\\Roaming\\aibrowse',
  resolvedProfile: root,
  identity: { FileId128: '1'.repeat(32), VolumeSerial64: '2'.repeat(16), Sddl: 'fixed-fixture' },
};
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe('最终包窄场边界', () => {
  it('绑定历史首次空根，不要求当前根为空，也不生成marker', () => {
    expect(parseFirstEmpty(bytes(original), root)).toEqual(original);
  });
  it.each([false, 'true', 1, null])('拒绝未经真实空根证明的empty=%s', (empty) => {
    expect(() => parseFirstEmpty(bytes({ ...original, empty }), root)).toThrow();
  });
  it('拒绝把另一个非空根借作同一合成现场', () => {
    expect(() => parseFirstEmpty(bytes(original), 'D:\\other\\aibrowse')).toThrow();
  });
  it('拒绝截短的128位原生身份', () => {
    expect(() =>
      parseFirstEmpty(
        bytes({ ...original, identity: { ...original.identity, FileId128: '1'.repeat(16) } }),
        root,
      ),
    ).toThrow();
  });
  it('等价空白只改一个字节且不修改原Buffer', () => {
    const before = Buffer.from('x\n  y');
    const after = whitespaceMutation(before, 2);
    expect(before.toString()).toBe('x\n  y');
    expect(after.toString()).toBe('x\n\t y');
    expect([...after].filter((value, index) => value !== before[index])).toHaveLength(1);
  });
  it.each([-1, 0, 1.5, 100])('拒绝不成立的等价替换offset=%s', (offset) => {
    expect(() => whitespaceMutation(Buffer.from('x '), offset)).toThrow();
  });
});
