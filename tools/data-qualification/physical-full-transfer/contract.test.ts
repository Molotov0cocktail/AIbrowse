import { describe, expect, it } from 'vitest';
import {
  campaignSpace,
  DATABASE_INPUTS,
  expectedInputMembers,
  requireScopeId,
  SOURCE_SCOPES,
} from './contract';

describe('物理三库与full50固定合同', () => {
  it('闭合54成员、三个物理库长度和四个固定来源', () => {
    const members = expectedInputMembers();
    expect(members).toHaveLength(54);
    expect(new Set(members.map((item) => item.member)).size).toBe(54);
    expect(DATABASE_INPUTS.map((item) => item.bytes)).toEqual([
      512 * 1024 ** 2,
      64 * 1024 ** 2,
      512 * 1024 ** 2,
    ]);
    expect(Object.keys(SOURCE_SCOPES).sort()).toEqual([
      'conversations',
      'research',
      'sources',
      'watch',
    ]);
  });

  it('只接受新物理组合scope并按全额输入计空间', () => {
    expect(() => requireScopeId('physical-full-transfer-' + 'a'.repeat(32))).not.toThrow();
    for (const invalid of [
      'full-transfer-' + 'a'.repeat(32),
      'physical-full-transfer-' + 'A'.repeat(32),
      'physical-full-transfer-' + 'a'.repeat(31),
    ])
      expect(() => requireScopeId(invalid)).toThrow();
    const unit = 4096n;
    const withoutInputs = campaignSpace(unit, []);
    const withInputs = campaignSpace(
      unit,
      expectedInputMembers().map((item) => item.bytes),
    );
    expect(withInputs - withoutInputs).toBe(
      expectedInputMembers().reduce(
        (sum, item) => sum + ((BigInt(item.bytes) + unit - 1n) / unit) * unit,
        0n,
      ),
    );
  });
});
