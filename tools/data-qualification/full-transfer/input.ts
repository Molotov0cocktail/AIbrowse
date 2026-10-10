import { mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  campaignSpace,
  CONVERSATION_ID,
  DB_MEMBERS,
  FULL_BYTES,
  IMPORT_MS,
  need,
  requireScopeId,
  RUNTIME_ID,
  sessionNames,
  TREE_SHA,
  SOURCE_PROOFS,
  expectedInputMembers,
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
} from './io';

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
  const sources = object(proof.sourceProofs),
    conversations = object(proof.conversations);
  need(
    Object.keys(sources).sort().join('|') === 'conversations|runtime' &&
      sources.conversations === SOURCE_PROOFS.conversations &&
      sources.runtime === SOURCE_PROOFS.runtime,
  );
  need(
    Object.keys(conversations).sort().join('|') === 'bytes|sha256' &&
      conversations.bytes === FULL_BYTES &&
      conversations.sha256 === TREE_SHA,
  );
  need(
    typeof proof.allocationUnit === 'string' &&
      /^[0-9]{1,20}$/u.test(proof.allocationUnit) &&
      BigInt(proof.allocationUnit) > 0n &&
      BigInt(proof.allocationUnit) <= 1048576n,
  );
  need(
    typeof proof.requiredFreeBytes === 'string' && /^[0-9]{1,20}$/u.test(proof.requiredFreeBytes),
  );
  const expected = expectedInputMembers(),
    files = proof.files;
  need(Array.isArray(files) && files.length === 54);
  const seen = new Set<string>();
  for (const item of files) {
    const file = object(item);
    need(
      Object.keys(file).sort().join('|') === 'bytes|identity|member|sha256' &&
        typeof file.member === 'string' &&
        !seen.has(file.member),
    );
    seen.add(file.member);
    const entry = expected.find((e) => e.member === file.member);
    need(entry && entry.bytes === file.bytes && entry.sha256 === file.sha256);
    const identity = object(file.identity);
    need(Object.keys(identity).sort().join('|') === 'ctimeNs|dev|ino|mtimeNs|nlink|size');
    for (const field of Object.values(identity))
      need(typeof field === 'string' && /^[0-9]{1,40}$/u.test(field));
    need(identity.nlink === '1' && identity.size === String(entry.bytes));
  }
  return value as InputProof;
}
export function importInput(
  repository: string,
  scopeId: string,
  now = () => performance.now(),
): InputProof {
  requireScopeId(scopeId);
  const started = now();
  const check = () => {
    need(now() - started < IMPORT_MS);
  };
  const scope = join(repository, 'log/stage7-e2', scopeId),
    root = join(scope, 'profile');
  const full = join(repository, 'log/stage7-e2', CONVERSATION_ID);
  const runtime = join(repository, 'log/stage7-e2', RUNTIME_ID);
  const originalParents = [parents(scope), parents(full), parents(runtime)];
  const fullReceipt = readSmall(join(full, 'fixture-proof.json'), check);
  const dbReceipt = readSmall(join(runtime, 'fixture-proof.json'), check);
  need(fullReceipt.sha256 === 'a1ac75ca459c2342fd572de2a7cd2b73b8adb5f4597c2941dc068dff61a3086a');
  need(dbReceipt.sha256 === 'f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5');
  const fullProof = object(fullReceipt.value),
    dbProof = object(dbReceipt.value);
  need(
    fullProof.completed === true &&
      fullProof.scopeId === CONVERSATION_ID &&
      fullProof.totalBytes === FULL_BYTES &&
      dbProof.completed === true,
  );
  const hashes = object(dbProof.hashes),
    members = object(fullProof.files);
  need(Object.keys(members).sort().join('|') === sessionNames().sort().join('|'));
  need(
    readdirSync(join(full, 'conversations')).sort().join('|') === sessionNames().sort().join('|'),
  );
  const plan = [
    ...DB_MEMBERS.map((member) => ({
      member,
      source: join(runtime, 'fixtures', member),
      bytes: Number(fileFact(join(runtime, 'fixtures', member)).size),
      sha256: hashes['fixtures/' + member] as string,
      expected: undefined as Fact | undefined,
    })),
    ...sessionNames().map((name) => {
      const entry = object(members[name]);
      need(
        entry.bytes === (name === 'index.json' ? 15676 : 67108864) &&
          typeof entry.sha256 === 'string',
      );
      return {
        member: 'conversations/' + name,
        source: join(full, 'conversations', name),
        bytes: entry.bytes as number,
        sha256: entry.sha256,
        expected: entry.identity as Fact,
      };
    }),
  ];
  need(
    plan
      .slice(0, 3)
      .map((p) => p.bytes)
      .join(',') === '151023616,15015936,110444544',
  );
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
  const unit = BigInt(allocation.unit),
    required = campaignSpace(
      unit,
      plan.map((p) => p.bytes),
    );
  need(BigInt(allocation.available) >= required && disk.bavail * disk.bsize >= required);
  mkdirSync(root);
  for (const directory of ['sources', 'research', 'watch', 'conversations'])
    mkdirSync(join(root, directory));
  const checks: Check[] = [],
    files: InputFile[] = [];
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
    fullReceipt.verify();
    dbReceipt.verify();
    allocationReceipt.verify();
    originalParents.forEach((fn) => fn());
    checks.forEach((fn) => fn());
    need(
      readdirSync(join(full, 'conversations')).sort().join('|') === sessionNames().sort().join('|'),
    );
    need(
      readdirSync(join(root, 'conversations')).sort().join('|') === sessionNames().sort().join('|'),
    );
    for (const member of DB_MEMBERS)
      need(readdirSync(join(root, member.split('/')[0])).join() === member.split('/')[1]);
    originalParents.forEach((fn) => fn());
    checks.forEach((fn) => fn());
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
  need(proof.version === 1 && proof.completed && proof.productE2Pass === false);
  need(
    proof.files.length === 54 &&
      proof.conversations.bytes === FULL_BYTES &&
      proof.conversations.sha256 === TREE_SHA,
  );
  const names = [...DB_MEMBERS, ...sessionNames().map((name) => 'conversations/' + name)].sort();
  need(
    proof.files
      .map((f) => f.member)
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
