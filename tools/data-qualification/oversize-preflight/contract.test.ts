import { expect, it } from 'vitest';
import {
  CASES,
  FILE_ALLOCATION_LIMIT,
  FREE_RESERVE,
  NODE_VERSION,
  TOOL_ALLOCATION_LIMIT,
  parseReceipt,
  requiredFreeBytes,
  requireScopeId,
  requireSourceCommit,
} from './contract';

const scopeId = 'oversize-preflight-' + 'a'.repeat(32);

function validReceipt() {
  return {
    version: 1,
    scopeId,
    kind: 'oversize-preflight',
    nodeVersion: NODE_VERSION,
    controlsReached: true,
    files: CASES.map((item) => ({
      id: item.id,
      file: item.file,
      control: item.control,
      expectedBytes: item.bytes,
      observedBytes: item.bytes,
      rejected: true,
      preserved: true,
      noSidecars: true,
    })),
    completed: true,
    productE2Pass: false,
    capacityQualified: false,
    enospcQualified: false,
    zeroReadClaimed: false,
  };
}

it('固定四个超限一字节敌手输入及非外推标志', () => {
  expect(CASES.map((item) => [item.id, item.limit, item.bytes])).toEqual([
    ['container', 5 * 1024 ** 3, 5 * 1024 ** 3 + 1],
    ['sources', 512 * 1024 ** 2, 512 * 1024 ** 2 + 1],
    ['research', 64 * 1024 ** 2, 64 * 1024 ** 2 + 1],
    ['watch', 512 * 1024 ** 2, 512 * 1024 ** 2 + 1],
  ]);
  expect(FILE_ALLOCATION_LIMIT).toBe(1024 ** 2);
  expect(TOOL_ALLOCATION_LIMIT).toBe(16 * 1024 ** 2);
  expect(FREE_RESERVE).toBe(1024 ** 3);
  expect(parseReceipt(validReceipt(), scopeId)).toEqual(validReceipt());
});

it('拒绝错scope、缺正控、错误容量、sidecar和任何资格外推', () => {
  for (const value of [
    'oversize-preflight-' + 'A'.repeat(32),
    'oversize-preflight-' + 'a'.repeat(31),
    'oversize-preflight-../escape',
    'physical-sources512-' + 'a'.repeat(32),
  ])
    expect(() => requireScopeId(value)).toThrow();
  for (const change of [
    (value: ReturnType<typeof validReceipt>) => (value.controlsReached = false),
    (value: ReturnType<typeof validReceipt>) => (value.files[0]!.observedBytes -= 1),
    (value: ReturnType<typeof validReceipt>) => (value.files[1]!.noSidecars = false),
    (value: ReturnType<typeof validReceipt>) => (value.capacityQualified = true),
    (value: ReturnType<typeof validReceipt>) => (value.enospcQualified = true),
    (value: ReturnType<typeof validReceipt>) => (value.zeroReadClaimed = true),
  ]) {
    const value = validReceipt();
    change(value);
    expect(() => parseReceipt(value, scopeId)).toThrow();
  }
  expect(() => parseReceipt({ ...validReceipt(), extra: true }, scopeId)).toThrow();
});

it('当前源码提交仅接受固定小写40位十六进制字符串', () => {
  expect(() => requireSourceCommit('a'.repeat(40))).not.toThrow();
  for (const value of ['a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40), 1, true, ['a'.repeat(40)]])
    expect(() => requireSourceCommit(value)).toThrow();
});

it('空间门只预留16MiB工具额和原1GiB余量', () => {
  expect(requiredFreeBytes(4096n)).toBe(1090519040n);
  for (const unit of [1n, 4096n, 65535n, 1048576n]) {
    const rounded = ((16777216n + unit - 1n) / unit) * unit;
    expect(requiredFreeBytes(unit)).toBe(rounded + 1073741824n);
  }
  for (const unit of [0n, -1n, 1048577n]) expect(() => requiredFreeBytes(unit)).toThrow();
});
