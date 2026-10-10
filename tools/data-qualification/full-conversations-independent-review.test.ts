import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as files from './full-conversations/files';
import { prepareFullConversations } from './full-conversations/main';
import { fiftyIndex } from './projection/samples';

// Only the exported capacity constants are reduced; projection and file IO stay real.
const small = vi.hoisted(() => {
  const seed = JSON.stringify({
    version: 2,
    messages: [
      { id: 'small-message', role: 'user', content: 'small', createdAt: 0, status: 'complete' },
    ],
  });
  return { seed, bytes: Buffer.byteLength(seed) };
});
vi.mock('../../src/main/ai/conversation-transfer', async (original) => {
  const module = await original<typeof import('../../src/main/ai/conversation-transfer')>();
  return { ...module, LIMITS: { ...module.LIMITS, sessionBytes: small.bytes, messages: 1 } };
});
vi.mock('./full-conversations/files', async (original) => ({
  ...(await original<typeof import('./full-conversations/files')>()),
}));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'full-conversations-independent-'));
  owned.push(root);
  const scopeId = `full-conversations-${'1'.repeat(32)}`;
  const sourceId = `runtime-${'2'.repeat(32)}`;
  const scope = join(root, 'log', 'stage7-e2', scopeId);
  const origin = join(root, 'log', 'stage7-e2', sourceId);
  fs.mkdirSync(scope, { recursive: true });
  fs.mkdirSync(join(origin, 'fixtures', 'conversations'), { recursive: true });
  const member = `fixtures/conversations/${fiftyIndex().sessions[0]!.id}.json`;
  fs.writeFileSync(join(origin, member), small.seed, { flag: 'wx' });
  fs.writeFileSync(
    join(origin, 'fixture-proof.json'),
    JSON.stringify({
      completed: true,
      productE2Pass: false,
      hashes: { [member]: sha(small.seed) },
    }),
    { flag: 'wx' },
  );
  const names = [
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
  const sources = Object.fromEntries(
    names.map((name) => {
      fs.mkdirSync(dirname(join(root, name)), { recursive: true });
      fs.writeFileSync(join(root, name), name, { flag: 'wx' });
      return [name, sha(name)];
    }),
  );
  fs.writeFileSync(join(scope, 'prepare.cjs'), 'synthetic-bundle', { flag: 'wx' });
  fs.writeFileSync(
    join(scope, 'build-proof.json'),
    JSON.stringify({ version: 1, scopeId, sources, bundleSha256: sha('synthetic-bundle') }),
    { flag: 'wx' },
  );
  return { root, scope, sourceId, origin };
}

it('小模板仍走当前产品投影和实际50个独立输出的完整准备路径', () => {
  const f = fixture();
  prepareFullConversations(f.scope, f.sourceId, () => undefined);
  expect(fs.readdirSync(join(f.scope, 'conversations'))).toHaveLength(51);
  const proof = JSON.parse(fs.readFileSync(join(f.scope, 'fixture-proof.json'), 'utf8'));
  expect(proof.completed).toBe(true);
  expect(proof.sessions).toBe(50);
  expect(proof.messageCount).toBe(1);
});

it.each(['unknown-member', 'build-proof'] as const)(
  '复制成功后、完成证明前出现%s必须拒绝并保留现场',
  (kind) => {
    const f = fixture();
    const original = files.replicateSeed;
    vi.spyOn(files, 'replicateSeed').mockImplementation((plan) => {
      const facts = original(plan);
      if (kind === 'unknown-member')
        fs.writeFileSync(join(plan.destination, 'unknown.json'), '{}', { flag: 'wx' });
      else fs.writeFileSync(join(f.scope, 'build-proof.json'), '{"version":999}');
      return facts;
    });
    expect(() => prepareFullConversations(f.scope, f.sourceId, () => undefined)).toThrow();
    if (kind === 'unknown-member')
      expect(fs.existsSync(join(f.scope, 'conversations', 'unknown.json'))).toBe(true);
    else expect(fs.readFileSync(join(f.scope, 'build-proof.json'), 'utf8')).toBe('{"version":999}');
  },
);

it('写完成证明的最后IO中输出被改，不能仍然完成准备', () => {
  const f = fixture();
  const write = fs.writeFileSync;
  let changed = false;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    write(...args);
    if (!changed && args[0] === join(f.scope, 'fixture-proof.json')) {
      changed = true;
      write(
        join(f.scope, 'conversations', `${fiftyIndex().sessions[0]!.id}.json`),
        'x'.repeat(small.bytes),
      );
    }
  });
  expect(() => prepareFullConversations(f.scope, f.sourceId, () => undefined)).toThrow();
  expect(changed).toBe(true);
});

it('最终整组验证期间源祖先被换为junction不能重新认领同一文件', () => {
  const f = fixture();
  const plan = {
    seed: join(f.origin, 'fixtures', 'conversations', `${fiftyIndex().sessions[0]!.id}.json`),
    destination: join(f.scope, 'conversations'),
    index: Buffer.from(JSON.stringify(fiftyIndex())),
    bytes: small.bytes,
    sha256: sha(small.seed),
    check() {},
  };
  const facts = files.replicateSeed(plan);
  const read = fs.readdirSync;
  let reads = 0;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    const value = read(...args);
    if (args[0] === plan.destination && ++reads === 2) {
      const sourceDirectory = dirname(plan.seed);
      const retained = `${sourceDirectory}-retained`;
      fs.renameSync(sourceDirectory, retained);
      fs.symlinkSync(retained, sourceDirectory, 'junction');
    }
    return value;
  }) as typeof fs.readdirSync);
  expect(() => files.verifyReplicas(plan, facts)).toThrow();
  expect(fs.lstatSync(dirname(plan.seed)).isSymbolicLink()).toBe(true);
});
