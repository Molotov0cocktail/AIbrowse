import { transferSpaceAllocation } from '../../../src/main/storage/transfer-space';
export const IMPORT_MS = 120_000;
export const CAMPAIGN_MS = 3_060_000;
export const CONVERSATION_ID = 'full-conversations-29d6709186ef4d179628e94ec8c73663';
export const RUNTIME_ID = 'runtime-9399eea0c11d4e6f9cde46ae2369376b';
export const FULL_BYTES = 3_355_458_876;
export const TREE_SHA = 'cced3aa17d685cc1b119f060e3caf9928f49640195599debf9ab51f007546989';
export const DB_MEMBERS = ['sources/sources.db', 'research/research.db', 'watch/watch.db'] as const;
export const DATABASE_INPUTS = [
  {
    member: DB_MEMBERS[0],
    bytes: 151023616,
    sha256: '1e101481eb733ca0a4a6dbde6ffe21b7631cd2a631b1408b9e394b8f2a37a453',
  },
  {
    member: DB_MEMBERS[1],
    bytes: 15015936,
    sha256: 'fa34f3c02b6c815e57100179671339f3dcc73cff4abe19e37a6fe051eb6f82e8',
  },
  {
    member: DB_MEMBERS[2],
    bytes: 110444544,
    sha256: '14dc44a8c38e06e96264681c5cfffa5aeec0c8dfce83be73b9a7d8a92c084c7a',
  },
] as const;
export const SOURCE_PROOFS = Object.freeze({
  conversations: 'a1ac75ca459c2342fd572de2a7cd2b73b8adb5f4597c2941dc068dff61a3086a',
  runtime: 'f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5',
});
export function expectedInputMembers(): { member: string; bytes: number; sha256: string }[] {
  return [
    ...DATABASE_INPUTS,
    ...sessionNames().map((name) => ({
      member: 'conversations/' + name,
      bytes: name === 'index.json' ? 15676 : 67108864,
      sha256:
        name === 'index.json'
          ? '1fd977794918a8cedada66e1fdf39a41934f4f0a675f067c79cf2f44d3093884'
          : '7288b0201d2c8d2e351570e682351ef0ae0b6ed5e5d4336bf6766b86071f4b0f',
    })),
  ];
}
export function sessionNames(): string[] {
  return [
    'index.json',
    ...Array.from(
      { length: 50 },
      (_, n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}.json`,
    ),
  ];
}
export function need(value: unknown): asserts value {
  if (!value) throw new Error('完整Transfer资格条件不成立，原件保留');
}
export function requireScopeId(id: string): void {
  need(/^full-transfer-[a-f0-9]{32}$/u.test(id));
}
export function campaignSpace(unit: bigint, fileBytes: readonly number[]): bigint {
  need(unit > 0n && unit <= 1048576n);
  let imported = 0n;
  for (const bytes of fileBytes) {
    need(Number.isSafeInteger(bytes) && bytes >= 0);
    imported += ((BigInt(bytes) + unit - 1n) / unit) * unit;
  }
  const backup = transferSpaceAllocation(unit, 'backup');
  const restore = transferSpaceAllocation(unit, 'restore');
  // Both scopes and published backup remain. No Switch means no old rollback set.
  return (
    imported +
    backup.userData +
    backup.publication +
    restore.userData +
    1073741824n +
    ((16777216n + unit - 1n) / unit) * unit
  );
}
