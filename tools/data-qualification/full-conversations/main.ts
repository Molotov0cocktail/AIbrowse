import { createHash } from 'node:crypto';
import { join, basename, dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { LIMITS, projectSession, sessionChunks } from '../../../src/main/ai/conversation-transfer';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json';
import { fiftyIndex } from '../projection/samples';
import {
  bindParents,
  hashRegular,
  readBounded,
  recheckFile,
  recheckReplicas,
  replicateSeed,
  requireFixture,
  type FileFact,
} from './files';

export const PREPARE_MS = 150_000;
export const FULL_PREFIX = /^full-conversations-[a-f0-9]{32}$/;
export const RUNTIME_ID = /^runtime-[a-f0-9]{32}$/;
function jsonObject(bytes: Buffer): Record<string, unknown> {
  const value: unknown = parseBoundedJson(bytes.toString('utf8'), {
    bytes: 65536,
    depth: 16,
    nodes: 16384,
  });
  requireFixture(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function requireScope(scope: string): string {
  requireFixture(
    FULL_PREFIX.test(basename(scope)) &&
      basename(dirname(scope)) === 'stage7-e2' &&
      basename(dirname(dirname(scope))) === 'log',
  );
  bindParents(scope)();
  return resolve(scope, '../../..');
}
export function prepareFullConversations(
  scope: string,
  sourceId: string,
  check: () => void,
): () => void {
  const repository = requireScope(scope);
  requireFixture(RUNTIME_ID.test(sourceId) && /^v24\./.test(process.version));
  const parents = bindParents(scope);
  const buildPath = join(scope, 'build-proof.json');
  const buildReceipt = readBounded(buildPath, 65536, check);
  const build = jsonObject(buildReceipt.bytes);
  requireFixture(
    build.scopeId === basename(scope) &&
      build.version === 1 &&
      typeof build.sources === 'object' &&
      build.sources !== null &&
      !Array.isArray(build.sources),
  );
  const sourceHashes = build.sources as Record<string, unknown>;
  // The compiler-bound list is fixed in build.ts; never derive a path from proof keys.
  const sourceNames = [
    'tools/data-qualification/full-conversations/files.ts',
    'tools/data-qualification/full-conversations/main.ts',
    'tools/data-qualification/full-conversations/entry.ts',
    'tools/data-qualification/full-conversations/build.ts',
    'tools/data-qualification/projection/samples.ts',
    'tools/data-qualification/projection/projection.ts',
    'tools/data-qualification/fixtures.ts',
    'src/main/ai/conversation-transfer.ts',
    'src/main/storage/bounded-json.ts',
    'package.json',
    'package-lock.json',
  ];
  requireFixture(
    Object.keys(sourceHashes).sort().join('\n') === [...sourceNames].sort().join('\n'),
  );
  const verifyBuild = (): void => {
    for (const name of sourceNames)
      requireFixture(
        hashRegular(join(repository, name), 1024 ** 2, check).sha256 === sourceHashes[name],
      );
    requireFixture(
      hashRegular(join(scope, 'prepare.cjs'), 1024 ** 2, check).sha256 === build.bundleSha256,
    );
  };
  verifyBuild();
  const source = join(repository, 'log', 'stage7-e2', sourceId);
  const sourceParents = bindParents(source);
  const proofPath = join(source, 'fixture-proof.json');
  const origin = readBounded(proofPath, 65536, check);
  const proof = jsonObject(origin.bytes);
  requireFixture(
    proof.completed === true &&
      proof.productE2Pass === false &&
      proof.hashes !== null &&
      typeof proof.hashes === 'object' &&
      !Array.isArray(proof.hashes),
  );
  const firstId = fiftyIndex().sessions[0]!.id;
  const seedMember = `fixtures/conversations/${firstId}.json`;
  const expected = (proof.hashes as Record<string, unknown>)[seedMember];
  requireFixture(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected));
  const seed = join(source, 'fixtures', 'conversations', `${firstId}.json`);
  const seedParents = bindParents(dirname(seed));
  const seedIdentity = hashRegular(seed, LIMITS.sessionBytes, check);
  const inspectSeed = (): { messageCount: number; maximumMessageBytes: number } => {
    const raw = readBounded(seed, LIMITS.sessionBytes, check);
    requireFixture(raw.fact.bytes === LIMITS.sessionBytes && raw.fact.sha256 === expected);
    const projection = projectSession(
      parseBoundedJson(raw.bytes.toString('utf8'), {
        bytes: LIMITS.sessionBytes,
        depth: LIMITS.inputDepth,
        nodes: LIMITS.nodes,
      }),
      check,
    );
    requireFixture(
      projection.excludedFields === 0 &&
        projection.compactBytes === LIMITS.sessionBytes &&
        Array.isArray(projection.value.messages) &&
        projection.value.messages.length === LIMITS.messages,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    for (const chunk of sessionChunks(projection.value)) {
      check();
      hash.update(chunk);
      bytes += chunk.length;
    }
    requireFixture(hash.digest('hex') === expected && bytes === LIMITS.sessionBytes);
    check();
    return {
      messageCount: projection.value.messages.length,
      maximumMessageBytes: projection.maximumMessageBytes,
    };
  };
  const semantic = inspectSeed();
  const plan = {
    seed,
    destination: join(scope, 'conversations'),
    index: Buffer.from(JSON.stringify(fiftyIndex())),
    bytes: LIMITS.sessionBytes,
    sha256: expected,
    check,
  };
  const files = replicateSeed(plan);
  requireFixture(Object.keys(files).length === 51);
  const totalBytes = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
  requireFixture(
    totalBytes === 50 * LIMITS.sessionBytes + plan.index.length &&
      totalBytes <= LIMITS.conversationsBytes,
  );
  verifyBuild();
  parents();
  requireFixture(hashRegular(proofPath, 65536, check).sha256 === origin.fact.sha256);
  check();
  const report = {
    version: 1,
    scopeId: basename(scope),
    completed: true,
    productE2Pass: false,
    nodeVersion: process.version,
    prepareMs: PREPARE_MS,
    sessions: 50,
    sessionBytes: LIMITS.sessionBytes,
    ...semantic,
    totalBytes,
    seed: { sourceId, member: seedMember, sha256: expected, proofSha256: origin.fact.sha256 },
    buildProofSha256: buildReceipt.fact.sha256,
    files: Object.fromEntries(
      Object.entries(files).map(([name, fact]) => [
        name,
        {
          bytes: fact.bytes,
          sha256: fact.sha256,
          identity: {
            dev: String(fact.identity.dev),
            ino: String(fact.identity.ino),
            nlink: String(fact.identity.nlink),
            size: String(fact.identity.size),
            mtimeNs: String(fact.identity.mtimeNs),
            ctimeNs: String(fact.identity.ctimeNs),
          },
        },
      ]),
    ),
  };
  const text = JSON.stringify(report, null, 2);
  requireFixture(Buffer.byteLength(text) <= 65536);
  const fixtureProofPath = join(scope, 'fixture-proof.json');
  let fixtureProofFact: FileFact | null = null;
  const complete = (): void => {
    parents();
    sourceParents();
    seedParents();
    recheckFile(buildPath, buildReceipt.fact);
    recheckFile(seed, seedIdentity);
    recheckFile(proofPath, origin.fact);
    if (fixtureProofFact !== null) recheckFile(fixtureProofPath, fixtureProofFact);
    recheckReplicas(files);
    check();
  };
  complete();
  writeFileSync(fixtureProofPath, text, { flag: 'wx' });
  fixtureProofFact = hashRegular(fixtureProofPath, 65536, check);
  requireFixture(fixtureProofFact.sha256 === createHash('sha256').update(text).digest('hex'));
  complete();
  return complete;
}
