import { transferSpaceAllocation } from '../../../src/main/storage/transfer-space';

export const IMPORT_MS = 120_000;
export const CAMPAIGN_MS = 3_060_000;
export const CONVERSATION_ID = 'full-conversations-29d6709186ef4d179628e94ec8c73663';
export const FULL_BYTES = 3_355_458_876;
export const TREE_SHA = 'cced3aa17d685cc1b119f060e3caf9928f49640195599debf9ab51f007546989';
export const NODE_VERSION = 'v24.18.0';
export const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
export const DB_MEMBERS = ['sources/sources.db', 'research/research.db', 'watch/watch.db'] as const;

export const SOURCE_SCOPES = Object.freeze({
  conversations: {
    scopeId: CONVERSATION_ID,
    proofSha256: 'a1ac75ca459c2342fd572de2a7cd2b73b8adb5f4597c2941dc068dff61a3086a',
  },
  sources: {
    scopeId: 'physical-sources512-2aed3c7406694689baa106edd05d79d1',
    proofSha256: 'b810582243091851553d4eb3120555a24f02dc8e7513d37b42eedb677c07a522',
  },
  research: {
    scopeId: 'physical-capacity-728ac71ab99a41babadd33c7fcc50045',
    proofSha256: 'd5b425624b27926f1f5e5bc1d39db2f61ed5330de919b99df2efc79db95d13d2',
  },
  watch: {
    scopeId: 'physical-watch512-4d1f0347a0924c268f1441f62aeb21e8',
    proofSha256: '6caf47b71b22bc703b7eeaabe0df07d6489e074ea10295946da573b317511f2e',
  },
});

export const SOURCE_PROOFS = Object.freeze({
  conversations: SOURCE_SCOPES.conversations.proofSha256,
  sources: SOURCE_SCOPES.sources.proofSha256,
  research: SOURCE_SCOPES.research.proofSha256,
  watch: SOURCE_SCOPES.watch.proofSha256,
});

export const DATABASE_INPUTS = [
  {
    member: DB_MEMBERS[0],
    sourceKey: 'sources',
    sourceMember: 'sources.db',
    bytes: 536_870_912,
    sha256: '380ef2a7649dd1c8b000a7bd6a6d925c211437289d43bcde60bafe0dcca4e6e4',
  },
  {
    member: DB_MEMBERS[1],
    sourceKey: 'research',
    sourceMember: 'research.db',
    bytes: 67_108_864,
    sha256: '9148fb5b75f3e89d9ff0a7179589428f881824b5b32d350cbbf80a57223ea504',
  },
  {
    member: DB_MEMBERS[2],
    sourceKey: 'watch',
    sourceMember: 'watch.db',
    bytes: 536_870_912,
    sha256: '9c58275fb1e0d5209422c428a234203426468b4942aad5574f63fc2fbc796480',
  },
] as const;

export function sessionNames(): string[] {
  return [
    'index.json',
    ...Array.from(
      { length: 50 },
      (_, n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}.json`,
    ),
  ];
}

export function expectedInputMembers(): { member: string; bytes: number; sha256: string }[] {
  return [
    ...DATABASE_INPUTS.map(({ member, bytes, sha256 }) => ({ member, bytes, sha256 })),
    ...sessionNames().map((name) => ({
      member: 'conversations/' + name,
      bytes: name === 'index.json' ? 15_676 : 67_108_864,
      sha256:
        name === 'index.json'
          ? '1fd977794918a8cedada66e1fdf39a41934f4f0a675f067c79cf2f44d3093884'
          : '7288b0201d2c8d2e351570e682351ef0ae0b6ed5e5d4336bf6766b86071f4b0f',
    })),
  ];
}

export function need(value: unknown): asserts value {
  if (!value) throw new Error('物理三库完整Transfer资格条件不成立，原件保留');
}

export function requireScopeId(id: string): void {
  need(/^physical-full-transfer-[a-f0-9]{32}$/u.test(id));
}

export function campaignSpace(unit: bigint, fileBytes: readonly number[]): bigint {
  need(unit > 0n && unit <= 1_048_576n);
  const round = (bytes: bigint) => ((bytes + unit - 1n) / unit) * unit;
  let imported = 0n;
  for (const bytes of fileBytes) {
    need(Number.isSafeInteger(bytes) && bytes >= 0);
    imported += round(BigInt(bytes));
  }
  const backup = transferSpaceAllocation(unit, 'backup');
  const restore = transferSpaceAllocation(unit, 'restore');
  return (
    imported +
    backup.userData +
    backup.publication +
    restore.userData +
    1_073_741_824n +
    round(16_777_216n)
  );
}
