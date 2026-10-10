import * as fs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LIMITS, projectIndex } from '../../../src/main/ai/conversation-transfer';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json';

export interface FileFact {
  bytes: number;
  sha256: string;
  identity: BigIntStats;
}
export interface ReplicaPlan {
  seed: string;
  destination: string;
  index: Buffer;
  bytes: number;
  sha256: string;
  check(): void;
}
const completionChecks = new WeakMap<Record<string, FileFact>, () => void>();

export function recheckReplicas(facts: Record<string, FileFact>): void {
  const check = completionChecks.get(facts);
  requireFixture(check !== undefined);
  check();
}
export const CHUNK_BYTES = 64 * 1024;
export function requireFixture(condition: unknown): asserts condition {
  if (!condition) throw new Error('完整会话合成夹具校验失败，现场已保留');
}
function same(a: BigIntStats, b: BigIntStats, content = true): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    (!content ||
      (a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs &&
        a.nlink === b.nlink))
  );
}
export function bindParents(path: string): () => void {
  const parents: { path: string; stat: BigIntStats }[] = [];
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const stat = fs.lstatSync(dir, { bigint: true });
    requireFixture(stat.isDirectory() && !stat.isSymbolicLink());
    parents.push({ path: dir, stat });
    if (dir === parse(dir).root) break;
  }
  return () => {
    for (const parent of parents) {
      const stat = fs.lstatSync(parent.path, { bigint: true });
      requireFixture(
        stat.isDirectory() && !stat.isSymbolicLink() && same(parent.stat, stat, false),
      );
    }
  };
}
function regular(path: string, limit: number): BigIntStats {
  const stat = fs.lstatSync(path, { bigint: true });
  requireFixture(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(limit),
  );
  return stat;
}
export function recheckFile(path: string, fact: FileFact): void {
  requireFixture(same(fact.identity, regular(path, fact.bytes)));
}
function streamFile(
  path: string,
  limit: number,
  check: () => void,
  consume: (chunk: Buffer) => void,
): FileFact {
  check();
  const parents = bindParents(dirname(path));
  const before = regular(path, limit);
  const fd = fs.openSync(path, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    requireFixture(same(before, fs.fstatSync(fd, { bigint: true })));
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      check();
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - bytes + 1), bytes);
      if (count === 0) break;
      bytes += count;
      requireFixture(bytes <= limit);
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      consume(chunk);
    }
    requireFixture(
      BigInt(bytes) === before.size && same(before, fs.fstatSync(fd, { bigint: true })),
    );
  } finally {
    fs.closeSync(fd);
  }
  parents();
  requireFixture(same(before, regular(path, limit)));
  check();
  return { bytes, sha256: hash.digest('hex'), identity: before };
}
export function hashRegular(path: string, limit: number, check: () => void): FileFact {
  return streamFile(path, limit, check, () => undefined);
}
export function readBounded(
  path: string,
  limit: number,
  check: () => void,
): { bytes: Buffer; fact: FileFact } {
  const chunks: Buffer[] = [];
  const fact = streamFile(path, limit, check, (chunk) => chunks.push(Buffer.from(chunk)));
  return { bytes: Buffer.concat(chunks), fact };
}
function writeAll(fd: number, chunk: Buffer, position: number, check: () => void): number {
  let offset = 0;
  while (offset < chunk.length) {
    check();
    const count = fs.writeSync(fd, chunk, offset, chunk.length - offset, position + offset);
    requireFixture(Number.isInteger(count) && count > 0 && count <= chunk.length - offset);
    offset += count;
  }
  return offset;
}
function members(plan: ReplicaPlan): string[] {
  requireFixture(
    Number.isSafeInteger(plan.bytes) &&
      plan.bytes > 0 &&
      plan.bytes <= LIMITS.sessionBytes &&
      /^[a-f0-9]{64}$/.test(plan.sha256),
  );
  const projected = projectIndex(
    parseBoundedJson(plan.index.toString('utf8'), {
      bytes: LIMITS.indexBytes,
      depth: LIMITS.inputDepth,
      nodes: LIMITS.nodes,
    }),
  );
  requireFixture(
    projected.excludedFields === 0 &&
      Buffer.from(JSON.stringify(projected.value)).equals(plan.index),
  );
  const sessions = projected.value.sessions;
  requireFixture(Array.isArray(sessions) && sessions.length > 0);
  return sessions.map((entry) => {
    requireFixture(
      entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof entry.id === 'string',
    );
    return `${entry.id}.json`;
  });
}
export function replicateSeed(plan: ReplicaPlan): Record<string, FileFact> {
  const names = members(plan);
  const parents = bindParents(dirname(plan.destination));
  const seedParents = bindParents(dirname(plan.seed));
  const seed = hashRegular(plan.seed, plan.bytes, plan.check);
  requireFixture(seed.bytes === plan.bytes && seed.sha256 === plan.sha256);
  parents();
  plan.check();
  fs.mkdirSync(plan.destination);
  const destination = bindParents(plan.destination);
  const facts: Record<string, FileFact> = {};
  const expectedNames = ['index.json', ...names].sort();
  completionChecks.set(facts, () => {
    plan.check();
    requireFixture(
      JSON.stringify(fs.readdirSync(plan.destination).sort()) === JSON.stringify(expectedNames),
    );
    parents();
    destination();
    seedParents();
    recheckFile(plan.seed, seed);
    for (const name of expectedNames) {
      const fact = facts[name];
      requireFixture(fact !== undefined);
      recheckFile(join(plan.destination, name), fact);
    }
    plan.check();
  });
  for (const name of ['index.json', ...names]) {
    destination();
    plan.check();
    const path = join(plan.destination, name);
    const fd = fs.openSync(path, 'wx');
    const created = fs.fstatSync(fd, { bigint: true });
    let position = 0;
    try {
      if (name === 'index.json') position = writeAll(fd, plan.index, 0, plan.check);
      else {
        const source = streamFile(plan.seed, plan.bytes, plan.check, (chunk) => {
          position += writeAll(fd, chunk, position, plan.check);
        });
        requireFixture(source.sha256 === seed.sha256 && same(source.identity, seed.identity));
      }
      fs.fsyncSync(fd);
      requireFixture(fs.fstatSync(fd, { bigint: true }).size === BigInt(position));
    } finally {
      fs.closeSync(fd);
    }
    destination();
    const fact = hashRegular(
      path,
      name === 'index.json' ? LIMITS.indexBytes : plan.bytes,
      plan.check,
    );
    requireFixture(same(created, fact.identity, false));
    const expected =
      name === 'index.json' ? createHash('sha256').update(plan.index).digest('hex') : plan.sha256;
    requireFixture(fact.sha256 === expected && fact.bytes === position);
    facts[name] = fact;
  }
  verifyReplicas(plan, facts);
  recheckReplicas(facts);
  return facts;
}
export function verifyReplicas(plan: ReplicaPlan, facts: Record<string, FileFact>): void {
  const names = ['index.json', ...members(plan)].sort();
  const parents = bindParents(plan.destination);
  const seedParents = bindParents(dirname(plan.seed));
  const seed = hashRegular(plan.seed, plan.bytes, plan.check);
  requireFixture(seed.bytes === plan.bytes && seed.sha256 === plan.sha256);
  requireFixture(JSON.stringify(Object.keys(facts).sort()) === JSON.stringify(names));
  requireFixture(JSON.stringify(fs.readdirSync(plan.destination).sort()) === JSON.stringify(names));
  const identities = new Set<string>([`${seed.identity.dev}:${seed.identity.ino}`]);
  for (const name of names) {
    const expected = facts[name]!;
    const actual = hashRegular(
      join(plan.destination, name),
      name === 'index.json' ? LIMITS.indexBytes : plan.bytes,
      plan.check,
    );
    requireFixture(
      same(expected.identity, actual.identity) &&
        actual.bytes === expected.bytes &&
        actual.sha256 === expected.sha256,
    );
    requireFixture(
      actual.sha256 ===
        (name === 'index.json'
          ? createHash('sha256').update(plan.index).digest('hex')
          : plan.sha256),
    );
    const identity = `${actual.identity.dev}:${actual.identity.ino}`;
    requireFixture(!identities.has(identity));
    identities.add(identity);
  }
  parents();
  requireFixture(same(seed.identity, regular(plan.seed, plan.bytes)));
  requireFixture(JSON.stringify(fs.readdirSync(plan.destination).sort()) === JSON.stringify(names));
  for (const name of names)
    requireFixture(
      same(
        facts[name]!.identity,
        regular(
          join(plan.destination, name),
          name === 'index.json' ? LIMITS.indexBytes : plan.bytes,
        ),
      ),
    );
  parents();
  seedParents();
  recheckFile(plan.seed, seed);
  plan.check();
}
