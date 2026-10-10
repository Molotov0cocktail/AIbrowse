import { describe, expect, it } from 'vitest';
import { campaignSpace, requireScopeId, sessionNames } from './contract';
import { transferSpaceAllocation } from '../../../src/main/storage/transfer-space';

describe('完整Transfer固定范围', () => {
  it('固定50个会话和index闭合且无任意路径', () => {
    const names = sessionNames();
    expect(names).toHaveLength(51);
    expect(new Set(names).size).toBe(51);
    expect(names).toContain('00000000-0000-4000-8000-000000000031.json');
    expect(names).toContain('index.json');
    expect(() => requireScopeId('full-transfer-' + 'a'.repeat(32))).not.toThrow();
    expect(() => requireScopeId('../full-transfer-' + 'a'.repeat(32))).toThrow();
  });
  it('空间逐文件allocation加生产两操作保留成本及工具余量', () => {
    const unit = 4096n;
    const backup = transferSpaceAllocation(unit, 'backup');
    const restore = transferSpaceAllocation(unit, 'restore');
    expect(campaignSpace(unit, [1, 4097])).toBe(
      12288n + backup.userData + backup.publication + restore.userData + 1073741824n + 16777216n,
    );
    expect(() => campaignSpace(0n, [1])).toThrow();
    expect(() => campaignSpace(unit, [NaN])).toThrow();
  });
});
