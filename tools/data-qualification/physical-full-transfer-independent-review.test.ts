import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  campaignSpace,
  expectedInputMembers,
  FULL_BYTES,
  SOURCE_PROOFS,
  SOURCE_SCOPES,
  TREE_SHA,
} from './physical-full-transfer/contract';
import { validateInputProof } from './physical-full-transfer/input';
import {
  assertExactMappings,
  mapOldDependency,
  type EntryName,
} from './physical-full-transfer/mapping';

function validProof() {
  return {
    version: 1,
    scopeId: 'physical-full-transfer-' + 'a'.repeat(32),
    completed: true,
    productE2Pass: false,
    files: expectedInputMembers().map((entry, index) => ({
      ...entry,
      identity: {
        dev: '1',
        ino: String(index + 1),
        nlink: '1',
        size: String(entry.bytes),
        mtimeNs: '1',
        ctimeNs: '1',
      },
    })),
    conversations: { bytes: FULL_BYTES, sha256: TREE_SHA },
    requiredFreeBytes: String(
      campaignSpace(
        4096n,
        expectedInputMembers().map((f) => f.bytes),
      ),
    ),
    allocationUnit: '4096',
    sourceProofs: { ...SOURCE_PROOFS },
  };
}

it('四份固定小proof原件摘要与候选合同逐项一致', () => {
  for (const value of Object.values(SOURCE_SCOPES)) {
    const bytes = readFileSync(resolve('log/stage7-e2', value.scopeId, 'fixture-proof.json'));
    expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(value.proofSha256);
  }
});

it('全部54成员的内容摘要、长度、身份长度及成员替换均拒绝', () => {
  expect(validateInputProof(validProof()).files).toHaveLength(54);
  for (let index = 0; index < 54; index++) {
    for (const kind of ['digest', 'bytes', 'identity', 'member']) {
      const proof = validProof();
      const target = proof.files[index];
      if (kind === 'digest') target.sha256 = 'f'.repeat(64);
      if (kind === 'bytes') target.bytes--;
      if (kind === 'identity') target.identity.size = String(target.bytes + 1);
      if (kind === 'member') target.member = proof.files[(index + 1) % 54].member;
      expect(() => validateInputProof(proof), `${index}/${kind}`).toThrow();
    }
  }
});

it('来源替换、链接身份、成功标志及结构缺失均安全拒绝', () => {
  const mutations: ((value: ReturnType<typeof validProof>) => void)[] = [
    (value) => {
      value.scopeId = 'full-transfer-' + 'a'.repeat(32);
    },
    (value) => {
      value.completed = false;
    },
    (value) => {
      value.productE2Pass = true;
    },
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.conversations.sha256 = 'e'.repeat(64);
    },
    (value) => {
      value.conversations.bytes--;
    },
    (value) => {
      value.files[0].identity.nlink = '2';
    },
    (value) => {
      value.files[0].identity.ino = '-1';
    },
    (value) => {
      value.files[0].identity.ctimeNs = 'NaN';
    },
    (value) => {
      value.allocationUnit = '0';
    },
    (value) => {
      value.allocationUnit = '1048577';
    },
    (value) => {
      value.files.pop();
    },
    ...Object.keys(SOURCE_PROOFS).map((key) => (value: ReturnType<typeof validProof>) => {
      value.sourceProofs[key as keyof typeof SOURCE_PROOFS] = 'e'.repeat(64);
    }),
  ];
  for (const mutate of mutations) {
    const proof = validProof();
    mutate(proof);
    expect(() => validateInputProof(proof)).toThrow();
  }
  expect(() => validateInputProof({ ...validProof(), unapproved: true })).toThrow();
  const missing = validProof();
  Reflect.deleteProperty(missing, 'sourceProofs');
  expect(() => validateInputProof(missing)).toThrow();
});

it('映射仅命中13条工具边，生产import与新增旧工具import不被悄然替换', () => {
  const edges: Record<EntryName, string[]> = {
    import: ['import-entry.ts|./contract', 'import-entry.ts|./input', 'io.ts|./contract'],
    main: [
      'campaign.ts|./contract',
      'counts-electron.ts|./contract',
      'counts.ts|./contract',
      'io.ts|./contract',
      'main.ts|./contract',
      'main.ts|./input',
      'trace.ts|./contract',
    ],
    counts: ['counts-worker-core.ts|./contract', 'counts.ts|./contract', 'io.ts|./contract'],
    worker: [],
  };
  for (const [entry, values] of Object.entries(edges)) {
    const mapped = values.map((value) => {
      const [name, request] = value.split('|');
      const result = mapOldDependency(
        entry as EntryName,
        resolve('tools/data-qualification/full-transfer', name),
        request,
      );
      expect(result?.target).toBe(
        resolve('tools/data-qualification/physical-full-transfer', request.slice(2) + '.ts'),
      );
      if (!result) throw new Error('固定映射缺失');
      return result;
    });
    expect(() => assertExactMappings(entry as EntryName, mapped)).not.toThrow();
    if (mapped.length)
      expect(() => assertExactMappings(entry as EntryName, [...mapped, mapped[0]])).toThrow();
    expect(() =>
      mapOldDependency(
        entry as EntryName,
        resolve('tools/data-qualification/full-transfer/unapproved.ts'),
        './input',
      ),
    ).toThrow();
    expect(
      mapOldDependency(
        entry as EntryName,
        resolve('src/main/storage/transfer-worker.ts'),
        './input',
      ),
    ).toBeNull();
  }
});

it('空间逐文件取整，拒绝非法分配单元与字节量', () => {
  for (const unit of [1n, 4096n, 65536n, 1048576n]) {
    expect(campaignSpace(unit, [1, 4097]) - campaignSpace(unit, [])).toBe(
      ((1n + unit - 1n) / unit + (4097n + unit - 1n) / unit) * unit,
    );
  }
  for (const unit of [0n, -1n, 1048577n]) expect(() => campaignSpace(unit, [])).toThrow();
  for (const bytes of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => campaignSpace(4096n, [bytes])).toThrow();
  }
});
