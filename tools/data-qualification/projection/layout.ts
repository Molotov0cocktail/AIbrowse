// Proposed framing and metadata for fixed synthetic members; no untrusted decoder exists here.
import { createHash } from 'node:crypto';
import { LIMITS, UUID, checkBytes, requireFact } from './projection';

export const LOGICAL_IDS = ['sources', 'research', 'watch', 'conversations'] as const;
export const LAYOUT = Object.freeze({
  containerHeaderBytes: 32,
  memberHeaderBytes: 48,
  conversationHeaderBytes: 24,
  submemberHeaderBytes: 64,
});
export interface Submember {
  id: 'index' | string;
  length: number;
  sha256: string;
}
const SHA256 = /^[a-f0-9]{64}$/;

export function conversationPlan(indexIds: readonly string[], members: readonly Submember[]) {
  requireFact(
    indexIds.length <= LIMITS.sessions &&
      new Set(indexIds.map((id) => id.toLowerCase())).size === indexIds.length &&
      indexIds.every((id) => UUID.test(id)),
    'id',
  );
  requireFact(members.length === indexIds.length + 1 && members[0]?.id === 'index', 'count');
  let length = LAYOUT.conversationHeaderBytes;
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    requireFact(
      member.id === (i === 0 ? 'index' : indexIds[i - 1]) && SHA256.test(member.sha256),
      'id',
    );
    checkBytes(member.length, i === 0 ? LIMITS.indexBytes : LIMITS.sessionBytes);
    length += LAYOUT.submemberHeaderBytes + member.length;
  }
  checkBytes(length, LIMITS.conversationsBytes);
  return { count: members.length, length };
}

export function conversationHeader(count: number, length: number): Buffer {
  requireFact(Number.isSafeInteger(count) && count >= 1 && count <= LIMITS.sessions + 1, 'count');
  checkBytes(length, LIMITS.conversationsBytes);
  const result = Buffer.alloc(LAYOUT.conversationHeaderBytes);
  result.write('AIBCV001', 0, 'ascii');
  result.writeUInt32LE(1, 8);
  result.writeUInt32LE(count, 12);
  result.writeBigUInt64LE(BigInt(length), 16);
  return result;
}

export function submemberHeader(member: Submember): Buffer {
  requireFact(member.id === 'index' || UUID.test(member.id), 'id');
  requireFact(SHA256.test(member.sha256), 'shape');
  checkBytes(member.length, member.id === 'index' ? LIMITS.indexBytes : LIMITS.sessionBytes);
  const result = Buffer.alloc(LAYOUT.submemberHeaderBytes);
  result.writeUInt8(member.id === 'index' ? 0 : 1, 0);
  result.writeUInt8(member.id === 'index' ? 1 : 2, 1);
  if (member.id !== 'index') Buffer.from(member.id.replaceAll('-', ''), 'hex').copy(result, 4);
  result.writeBigUInt64LE(BigInt(member.length), 20);
  Buffer.from(member.sha256, 'hex').copy(result, 28);
  return result;
}

export class FixedFrameWriter {
  private index = 0;
  private consumed = 0;
  private active = false;
  private digest = createHash('sha256');
  constructor(
    private readonly plan: readonly Submember[],
    private readonly sink: (chunk: Buffer) => void,
  ) {}

  begin(member: Submember): void {
    const expected = this.plan[this.index];
    requireFact(
      !this.active &&
        expected !== undefined &&
        this.consumed === 0 &&
        expected.id === member.id &&
        expected.length === member.length &&
        expected.sha256 === member.sha256,
      'id',
    );
    this.active = true;
    this.sink(submemberHeader(member));
  }

  chunk(bytes: Buffer): void {
    const expected = this.plan[this.index];
    requireFact(this.active && expected !== undefined, 'count');
    checkBytes(this.consumed + bytes.length, expected.length);
    this.digest.update(bytes);
    this.sink(bytes);
    this.consumed += bytes.length;
  }

  end(): void {
    const expected = this.plan[this.index];
    requireFact(
      this.active &&
        expected !== undefined &&
        this.consumed === expected.length &&
        this.digest.digest('hex') === expected.sha256,
      'bytes',
    );
    this.active = false;
    this.index++;
    this.consumed = 0;
    this.digest = createHash('sha256');
  }

  finish(): void {
    requireFact(!this.active && this.index === this.plan.length && this.consumed === 0, 'count');
  }
}

export function maximumMetadata() {
  const lengths = [
    LIMITS.sourcesBytes,
    LIMITS.researchBytes,
    LIMITS.watchBytes,
    LIMITS.conversationsBytes,
  ];
  const members = LOGICAL_IDS.map((id, i) => ({
    id,
    present: true,
    schemaVersion: 4_294_967_295,
    length: lengths[i]!,
    sha256: 'f'.repeat(64),
  }));
  const manifest = {
    formatVersion: 1,
    productVersion: '9'.repeat(64),
    snapshotId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    members,
  };
  const result = {
    operationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    phase: 'validated',
    members: members.map(({ id, length, sha256 }) => ({
      id,
      length,
      sha256,
      rows: Number.MAX_SAFE_INTEGER,
    })),
    errorCode: 'cross-reference-invalid',
  };
  checkBytes(Buffer.byteLength(JSON.stringify(manifest)), LIMITS.manifestBytes);
  checkBytes(Buffer.byteLength(JSON.stringify(result)), LIMITS.resultBytes);
  return { manifest, result };
}

export function capacityArithmetic() {
  const conversationMaximum =
    LAYOUT.conversationHeaderBytes +
    (LIMITS.sessions + 1) * LAYOUT.submemberHeaderBytes +
    LIMITS.indexBytes +
    LIMITS.sessions * LIMITS.sessionBytes;
  const containerMaximum =
    LAYOUT.containerHeaderBytes +
    LIMITS.manifestBytes +
    LOGICAL_IDS.length * LAYOUT.memberHeaderBytes +
    LIMITS.sourcesBytes +
    LIMITS.researchBytes +
    LIMITS.watchBytes +
    LIMITS.conversationsBytes;
  requireFact(
    conversationMaximum <= LIMITS.conversationsBytes && containerMaximum <= LIMITS.containerBytes,
    'bytes',
  );
  return {
    conversationMaximum,
    conversationHeadroom: LIMITS.conversationsBytes - conversationMaximum,
    containerMaximum,
    containerHeadroom: LIMITS.containerBytes - containerMaximum,
  };
}
