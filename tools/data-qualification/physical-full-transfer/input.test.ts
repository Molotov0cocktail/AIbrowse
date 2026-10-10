import { expect, it } from 'vitest';
import { expectedInputMembers, FULL_BYTES, SOURCE_PROOFS, TREE_SHA } from './contract';
import { validateInputProof } from './input';

function proof() {
  return {
    version: 1,
    scopeId: 'physical-full-transfer-' + 'a'.repeat(32),
    completed: true,
    productE2Pass: false,
    files: expectedInputMembers().map((item, index) => ({
      ...item,
      identity: {
        dev: '1',
        ino: String(index + 1),
        nlink: '1',
        size: String(item.bytes),
        mtimeNs: '1',
        ctimeNs: '1',
      },
    })),
    conversations: { bytes: FULL_BYTES, sha256: TREE_SHA },
    requiredFreeBytes: '1',
    allocationUnit: '4096',
    sourceProofs: { ...SOURCE_PROOFS },
  };
}

it('接受固定54成员证明并拒绝来源、成员、物理长度篡改', () => {
  expect(validateInputProof(proof()).files).toHaveLength(54);
  const mutations: ((value: ReturnType<typeof proof>) => void)[] = [
    (value) => {
      value.sourceProofs.sources = '0'.repeat(64);
    },
    (value) => {
      value.files[0].sha256 = '0'.repeat(64);
    },
    (value) => {
      value.files[1].member = value.files[0].member;
    },
    (value) => {
      value.files[2].identity.size = String(value.files[2].bytes - 1);
    },
  ];
  for (const mutate of mutations) {
    const value = proof();
    mutate(value);
    expect(() => validateInputProof(value)).toThrow();
  }
});
