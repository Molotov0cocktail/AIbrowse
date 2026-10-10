import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statfsSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectWatch as inspect } from './inspect';
import { openPrivateStagingDatabase } from '../../../src/main/storage/staging-sqlite';
import {
  copyBound,
  fact,
  fileFact,
  parents,
  readSmall,
  same,
  writeReceipt,
  type Check,
} from '../full-transfer/io';
import { backupOwnedFixture } from '../physical-capacity/backup';
import {
  generationSpace,
  need,
  NODE_VERSION,
  object,
  SOURCE,
  requireScopeId,
  RUNTIME_ID,
  SOURCE_PROOF,
  TARGET_BYTES,
  WORK_MS,
} from './contract';
import { padPrivateFixture } from '../physical-capacity/padding';

function digest(path: string, check: Check) {
  const identity = fileFact(path),
    fd = openSync(path, 'r'),
    hash = createHash('sha256'),
    buffer = Buffer.alloc(65536);
  try {
    need(
      Number(identity.size) === TARGET_BYTES &&
        same(identity, fact(fstatSync(fd, { bigint: true }))),
    );
    for (let offset = 0; offset < TARGET_BYTES;) {
      check();
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, TARGET_BYTES - offset), offset);
      need(n > 0);
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    need(readSync(fd, buffer, 0, 1, TARGET_BYTES) === 0);
    need(same(identity, fact(fstatSync(fd, { bigint: true }))));
  } finally {
    closeSync(fd);
  }
  need(same(identity, fileFact(path)));
  check();
  return { identity, sha256: hash.digest('hex'), bytes: TARGET_BYTES };
}

/** Fixed synthetic COPY entry. The outer native Job owns the hard deadline. */
export async function generateWatch(repository: string, scopeId: string): Promise<void> {
  requireScopeId(scopeId);
  need(process.version === NODE_VERSION && process.platform === 'win32');
  const started = performance.now(),
    check = () => need(performance.now() - started < WORK_MS);
  const scope = join(repository, 'log/stage7-e2', scopeId),
    root = join(scope, 'fixtures');
  const sourceRoot = join(repository, 'log/stage7-e2', RUNTIME_ID),
    source = join(sourceRoot, 'fixtures', SOURCE.member);
  const parentChecks = [parents(scope), parents(dirname(source))];
  const sourceProof = readSmall(join(sourceRoot, 'fixture-proof.json'), check);
  need(sourceProof.sha256 === SOURCE_PROOF && object(sourceProof.value).completed === true);
  need(object(object(sourceProof.value).hashes)['fixtures/' + SOURCE.member] === SOURCE.sha256);
  const original = fileFact(source);
  need(Number(original.size) === SOURCE.bytes);
  need(readdirSync(dirname(source)).join('|') === basename(source));
  const volume = readSmall(join(scope, 'generate-volume.json'), check),
    allocation = object(volume.value);
  need(
    typeof allocation.unit === 'string' &&
      /^[0-9]{1,20}$/u.test(allocation.unit) &&
      typeof allocation.available === 'string' &&
      /^[0-9]{1,20}$/u.test(allocation.available),
  );
  const required = generationSpace(BigInt(allocation.unit)),
    disk = statfsSync(scope, { bigint: true });
  need(BigInt(allocation.available) >= required && disk.bavail * disk.bsize >= required);
  mkdirSync(root);
  const path = join(root, 'watch.db'),
    backupPath = join(root, 'watch-backup.db');
  const copied = copyBound(source, path, SOURCE.bytes, SOURCE.sha256, check, original);
  need(copied.fact.dev !== original.dev || copied.fact.ino !== original.ino);
  const verifySource = () => {
    check();
    parentChecks.forEach((verify) => verify());
    sourceProof.verify();
    volume.verify();
    need(same(original, fileFact(source)));
    need(readdirSync(dirname(source)).join('|') === basename(source));
  };
  const { db, settings } = openPrivateStagingDatabase(path, 'watch');
  let before: ReturnType<typeof inspect>,
    after: ReturnType<typeof inspect>,
    padding: ReturnType<typeof padPrivateFixture>;
  try {
    before = inspect(db, check);
    need(
      before.semantic.counts.watch_rules === 200 &&
        before.semantic.counts.watch_events === 2800 &&
        before.semantic.counts.watch_event_items === 8400 &&
        before.semantic.counts.watch_digests === 1030,
    );
    padding = padPrivateFixture(db, TARGET_BYTES, check);
    after = inspect(db, check);
    need(
      before.schemaSha256 === after.schemaSha256 &&
        before.userVersion === after.userVersion &&
        before.dataSha256 === after.dataSha256 &&
        JSON.stringify(before.semantic) === JSON.stringify(after.semantic),
    );
  } finally {
    db.close();
  }
  verifySource();
  const grown = fileFact(path);
  need(
    grown.dev === copied.fact.dev &&
      grown.ino === copied.fact.ino &&
      Number(grown.size) === TARGET_BYTES,
  );
  need(readdirSync(root).join('|') === 'watch.db');
  const journal = await backupOwnedFixture(path, backupPath, TARGET_BYTES, check);
  const restored = new DatabaseSync(backupPath, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
    timeout: 0,
  });
  let backupFacts: ReturnType<typeof inspect>;
  try {
    restored.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-8192;',
    );
    backupFacts = inspect(restored, check);
    need(JSON.stringify(backupFacts) === JSON.stringify(after));
  } finally {
    restored.close();
  }
  need(readdirSync(root).sort().join('|') === 'watch-backup.db|watch.db');
  const files = [path, backupPath].map((file) => ({
    member: basename(file),
    ...digest(file, check),
  }));
  verifySource();
  const buildProof = readSmall(join(scope, 'build-proof.json'), check);
  const receipt = writeReceipt(
    join(scope, 'fixture-proof.json'),
    {
      version: 1,
      scopeId,
      completed: true,
      productE2Pass: false,
      electronQualified: false,
      kind: 'watch512-node-construction',
      sourceProof: SOURCE_PROOF,
      buildProofSha256: buildProof.sha256,
      nodeVersion: process.version,
      source: original,
      before,
      after,
      backup: backupFacts,
      journal,
      padding,
      settings,
      files,
      allocationUnit: allocation.unit,
      requiredFreeBytes: String(required),
      durationMs: performance.now() - started,
    },
    check,
  );
  verifySource();
  buildProof.verify();
  receipt();
  files.forEach((file) => need(same(file.identity, fileFact(join(root, file.member)))));
  check();
}
