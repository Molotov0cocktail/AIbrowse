import { expect, it } from 'vitest';
import { validateInputProof } from './input';
import { expectedInputMembers, FULL_BYTES, SOURCE_PROOFS, TREE_SHA } from './contract';
function proof() {
  return {
    version: 1,
    scopeId: 'full-transfer-' + 'a'.repeat(32),
    completed: true,
    productE2Pass: false,
    sourceProofs: SOURCE_PROOFS,
    conversations: { bytes: FULL_BYTES, sha256: TREE_SHA },
    allocationUnit: '4096',
    requiredFreeBytes: '34000000000',
    files: expectedInputMembers().map((file, i) => ({
      ...file,
      identity: {
        dev: '1',
        ino: String(i + 1),
        nlink: '1',
        size: String(file.bytes),
        mtimeNs: '1',
        ctimeNs: '1',
      },
    })),
  };
}
it('固定容量元数据拒绝改成较小但相同COUNT的数据库', () => {
  const value = proof();
  expect(validateInputProof(value).files).toHaveLength(54);
  value.files[0].bytes = 4096;
  value.files[0].identity.size = '4096';
  value.files[0].sha256 = 'a'.repeat(64);
  expect(() => validateInputProof(value)).toThrow();
});
it('错来源/缺50th/重复成员/多能力字段均拒绝', () => {
  const a = proof();
  a.files.pop();
  expect(() => validateInputProof(a)).toThrow();
  const b = proof();
  b.files[53] = b.files[52];
  expect(() => validateInputProof(b)).toThrow();
  expect(() =>
    validateInputProof({ ...proof(), sourceProofs: { ...SOURCE_PROOFS, runtime: '0'.repeat(64) } }),
  ).toThrow();
  expect(() => validateInputProof({ ...proof(), externalPath: 'C:\\secret' })).toThrow();
});
