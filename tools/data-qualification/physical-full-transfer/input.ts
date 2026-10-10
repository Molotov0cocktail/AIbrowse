import { mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  campaignSpace,
  CONVERSATION_ID,
  DATABASE_INPUTS,
  DB_MEMBERS,
  expectedInputMembers,
  FULL_BYTES,
  IMPORT_MS,
  need,
  requireScopeId,
  sessionNames,
  SOURCE_PROOFS,
  SOURCE_SCOPES,
  TREE_SHA,
} from './contract';
import {
  copyBound,
  fileFact,
  parents,
  readSmall,
  same,
  writeReceipt,
  type Check,
  type Fact,
} from '../full-transfer/io';

export interface InputFile {
  member: string;
  bytes: number;
  sha256: string;
  identity: Fact;
}
export interface InputProof {
  version: 1;
  scopeId: string;
  completed: true;
  productE2Pass: false;
  files: InputFile[];
  conversations: { bytes: number; sha256: string };
  requiredFreeBytes: string;
  allocationUnit: string;
  sourceProofs: typeof SOURCE_PROOFS;
}

function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function validateIdentity(value: unknown, bytes: number): Fact {
  const identity = object(value);
  need(Object.keys(identity).sort().join('|') === 'ctimeNs|dev|ino|mtimeNs|nlink|size');
  for (const field of Object.values(identity))
    need(typeof field === 'string' && /^[0-9]{1,40}$/u.test(field));
  need(identity.nlink === '1' && identity.size === String(bytes));
  return value as Fact;
}

export function validateInputProof(value: unknown): InputProof {
  const proof = object(value);
  need(
    Object.keys(proof).sort().join('|') ===
      'allocationUnit|completed|conversations|files|productE2Pass|requiredFreeBytes|scopeId|sourceProofs|version',
  );
  need(
    proof.version === 1 &&
      proof.completed === true &&
      proof.productE2Pass === false &&
      typeof proof.scopeId === 'string',
  );
  requireScopeId(proof.scopeId);
  const sources = object(proof.sourceProofs);
  need(Object.keys(sources).sort().join('|') === 'conversations|research|sources|watch');
  for (const [key, sha256] of Object.entries(SOURCE_PROOFS)) need(sources[key] === sha256);
  const conversations = object(proof.conversations);
  need(
    Object.keys(conversations).sort().join('|') === 'bytes|sha256' &&
      conversations.bytes === FULL_BYTES &&
      conversations.sha256 === TREE_SHA,
  );
  need(
    typeof proof.allocationUnit === 'string' &&
      /^[0-9]{1,20}$/u.test(proof.allocationUnit) &&
      BigInt(proof.allocationUnit) > 0n &&
      BigInt(proof.allocationUnit) <= 1_048_576n,
  );
  need(
    typeof proof.requiredFreeBytes === 'string' && /^[0-9]{1,20}$/u.test(proof.requiredFreeBytes),
  );
  const expected = expectedInputMembers();
  need(Array.isArray(proof.files) && proof.files.length === expected.length);
  const seen = new Set<string>();
  for (const value of proof.files) {
    const file = object(value);
    need(
      Object.keys(file).sort().join('|') === 'bytes|identity|member|sha256' &&
        typeof file.member === 'string' &&
        !seen.has(file.member),
    );
    seen.add(file.member);
    const entry = expected.find((item) => item.member === file.member);
    need(entry && entry.bytes === file.bytes && entry.sha256 === file.sha256);
    validateIdentity(file.identity, entry.bytes);
  }
  return value as InputProof;
}

function sourceFileFromProof(
  value: unknown,
  expected: (typeof DATABASE_INPUTS)[number],
  scopeId: string,
): Fact {
  const proof = object(value);
  need(
    proof.version === 1 &&
      proof.scopeId === scopeId &&
      proof.completed === true &&
      proof.productE2Pass === false &&
      proof.electronQualified === false &&
      proof.nodeVersion === 'v24.18.0' &&
      Array.isArray(proof.files),
  );
  const matches = proof.files.filter((item) => {
    const file = object(item);
    return file.member === expected.sourceMember;
  });
  need(matches.length === 1);
  const file = object(matches[0]);
  need(file.bytes === expected.bytes && file.sha256 === expected.sha256);
  return validateIdentity(file.identity, expected.bytes);
}

export function importInput(
  repository: string,
  scopeId: string,
  now = () => performance.now(),
): InputProof {
  requireScopeId(scopeId);
  const started = now();
  const check = () => need(now() - started < IMPORT_MS);
  const scope = join(repository, 'log/stage7-e2', scopeId);
  const root = join(scope, 'profile');
  const conversationRoot = join(repository, 'log/stage7-e2', CONVERSATION_ID);
  const sourceRoots = Object.fromEntries(
    (['sources', 'research', 'watch'] as const).map((key) => [
      key,
      join(repository, 'log/stage7-e2', SOURCE_SCOPES[key].scopeId),
    ]),
  ) as Record<'sources' | 'research' | 'watch', string>;
  const originalParents = [
    parents(scope),
    parents(conversationRoot),
    ...Object.values(sourceRoots).map((path) => parents(path)),
  ];
  const conversationReceipt = readSmall(join(conversationRoot, 'fixture-proof.json'), check);
  need(conversationReceipt.sha256 === SOURCE_PROOFS.conversations);
  const conversationProof = object(conversationReceipt.value);
  need(
    conversationProof.completed === true &&
      conversationProof.scopeId === CONVERSATION_ID &&
      conversationProof.totalBytes === FULL_BYTES,
  );
  const conversationMembers = object(conversationProof.files);
  need(Object.keys(conversationMembers).sort().join('|') === sessionNames().sort().join('|'));
  need(
    readdirSync(join(conversationRoot, 'conversations')).sort().join('|') ===
      sessionNames().sort().join('|'),
  );

  const sourceReceipts = Object.fromEntries(
    (['sources', 'research', 'watch'] as const).map((key) => {
      const receipt = readSmall(join(sourceRoots[key], 'fixture-proof.json'), check);
      need(receipt.sha256 === SOURCE_PROOFS[key]);
      return [key, receipt];
    }),
  ) as Record<'sources' | 'research' | 'watch', ReturnType<typeof readSmall>>;

  const plan = [
    ...DATABASE_INPUTS.map((entry) => ({
      member: entry.member,
      source: join(sourceRoots[entry.sourceKey], 'fixtures', entry.sourceMember),
      bytes: entry.bytes,
      sha256: entry.sha256,
      expected: sourceFileFromProof(
        sourceReceipts[entry.sourceKey].value,
        entry,
        SOURCE_SCOPES[entry.sourceKey].scopeId,
      ),
    })),
    ...sessionNames().map((name) => {
      const entry = object(conversationMembers[name]);
      const bytes = name === 'index.json' ? 15_676 : 67_108_864;
      const sha256 =
        name === 'index.json'
          ? '1fd977794918a8cedada66e1fdf39a41934f4f0a675f067c79cf2f44d3093884'
          : '7288b0201d2c8d2e351570e682351ef0ae0b6ed5e5d4336bf6766b86071f4b0f';
      need(entry.bytes === bytes && entry.sha256 === sha256);
      return {
        member: 'conversations/' + name,
        source: join(conversationRoot, 'conversations', name),
        bytes,
        sha256,
        expected: validateIdentity(entry.identity, bytes),
      };
    }),
  ];
  need(plan.length === 54);
  const disk = statfsSync(scope, { bigint: true });
  check();
  const allocationReceipt = readSmall(join(scope, 'import-volume.json'), check);
  const allocation = object(allocationReceipt.value);
  need(
    typeof allocation.unit === 'string' &&
      /^[0-9]+$/u.test(allocation.unit) &&
      typeof allocation.available === 'string' &&
      /^[0-9]+$/u.test(allocation.available),
  );
  const unit = BigInt(allocation.unit);
  const required = campaignSpace(
    unit,
    plan.map((item) => item.bytes),
  );
  need(BigInt(allocation.available) >= required && disk.bavail * disk.bsize >= required);
  mkdirSync(root);
  for (const directory of ['sources', 'research', 'watch', 'conversations'])
    mkdirSync(join(root, directory));
  const checks: Check[] = [];
  const files: InputFile[] = [];
  for (const item of plan) {
    check();
    const copied = copyBound(
      item.source,
      join(root, item.member),
      item.bytes,
      item.sha256,
      check,
      item.expected,
    );
    checks.push(copied.verify);
    files.push({
      member: item.member,
      bytes: item.bytes,
      sha256: item.sha256,
      identity: copied.fact,
    });
  }
  const verify = () => {
    conversationReceipt.verify();
    Object.values(sourceReceipts).forEach((receipt) => receipt.verify());
    allocationReceipt.verify();
    originalParents.forEach((fn) => fn());
    checks.forEach((fn) => fn());
    need(
      readdirSync(join(conversationRoot, 'conversations')).sort().join('|') ===
        sessionNames().sort().join('|'),
    );
    need(
      readdirSync(join(root, 'conversations')).sort().join('|') === sessionNames().sort().join('|'),
    );
    for (const member of DB_MEMBERS)
      need(readdirSync(join(root, member.split('/')[0])).join() === member.split('/')[1]);
    check();
  };
  verify();
  const proof: InputProof = {
    version: 1,
    scopeId,
    completed: true,
    productE2Pass: false,
    files,
    conversations: { bytes: FULL_BYTES, sha256: TREE_SHA },
    requiredFreeBytes: String(required),
    allocationUnit: String(unit),
    sourceProofs: SOURCE_PROOFS,
  };
  validateInputProof(proof);
  const receipt = writeReceipt(join(scope, 'input-proof.json'), proof, check);
  verify();
  receipt();
  check();
  return proof;
}

export function verifyInputMetadata(root: string, proof: InputProof, check: Check): void {
  check();
  validateInputProof(proof);
  const names = expectedInputMembers()
    .map((entry) => entry.member)
    .sort();
  need(
    proof.files
      .map((file) => file.member)
      .sort()
      .join('|') === names.join('|'),
  );
  for (const file of proof.files) {
    check();
    need(same(file.identity, fileFact(join(root, file.member))));
  }
  need(
    readdirSync(join(root, 'conversations')).sort().join('|') === sessionNames().sort().join('|'),
  );
  check();
}
