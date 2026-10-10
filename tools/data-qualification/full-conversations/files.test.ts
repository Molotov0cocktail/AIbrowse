import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replicateSeed, verifyReplicas, recheckReplicas, type ReplicaPlan } from './files';
import { fiftyIndex } from '../projection/samples';
import { prepareFullConversations } from './main';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function setup(): ReplicaPlan {
  const root = fs.mkdtempSync(join(tmpdir(), 'full-conversations-small-'));
  owned.push(root);
  const seed = join(root, 'seed.json');
  const bytes = Buffer.from('{"version":2,"messages":[]}');
  fs.writeFileSync(seed, bytes, { flag: 'wx' });
  const index = fiftyIndex();
  index.sessions = index.sessions.slice(0, 2);
  return {
    seed,
    destination: join(root, 'conversations'),
    index: Buffer.from(JSON.stringify(index)),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    check() {},
  };
}
describe('完整会话集合工具的小文件IO对照', () => {
  it('完成检查沿用创建时输出目录身份，不能认领后来同文件的junction', () => {
    const plan = setup();
    const facts = replicateSeed(plan);
    const retained = `${plan.destination}-retained`;
    fs.renameSync(plan.destination, retained);
    fs.symlinkSync(retained, plan.destination, 'junction');
    expect(() => recheckReplicas(facts)).toThrow();
    expect(fs.lstatSync(plan.destination).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(retained)).toHaveLength(3);
  });
  it('后续证明IO之后的完成检查仍拒绝新成员并保留它', () => {
    const plan = setup();
    const facts = replicateSeed(plan);
    const unknown = join(plan.destination, 'late.json');
    fs.writeFileSync(unknown, '{}', { flag: 'wx' });
    expect(() => recheckReplicas(facts)).toThrow();
    expect(fs.readFileSync(unknown, 'utf8')).toBe('{}');
  });
  it('排他生成独立普通文件、精确读回且拒绝覆盖', () => {
    const plan = setup();
    const facts = replicateSeed(plan);
    expect(Object.keys(facts)).toHaveLength(3);
    verifyReplicas(plan, facts);
    const ids = new Set(
      Object.values(facts).map((fact) => `${fact.identity.dev}:${fact.identity.ino}`),
    );
    expect(ids.size).toBe(3);
    expect(Object.values(facts).every((fact) => fact.identity.nlink === 1n)).toBe(true);
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.readFileSync(plan.seed, 'utf8')).toBe('{"version":2,"messages":[]}');
  });
  it('推进短写而不是跳过未写尾部', () => {
    const plan = setup();
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => write(fd, buffer, offset, Math.min(3, length), position)) as typeof fs.writeSync);
    const facts = replicateSeed(plan);
    verifyReplicas(plan, facts);
  });
  it('零写失败保留源与失败目录', () => {
    const plan = setup();
    vi.spyOn(fs, 'writeSync').mockReturnValue(0);
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.existsSync(plan.seed)).toBe(true);
    expect(fs.existsSync(plan.destination)).toBe(true);
  });
  it('伪摘要拒绝且不删除输入', () => {
    const plan = setup();
    plan.sha256 = '0'.repeat(64);
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.existsSync(plan.seed)).toBe(true);
  });
  it('源硬链接拒绝', () => {
    const plan = setup();
    fs.linkSync(plan.seed, `${plan.seed}.link`);
    expect(() => replicateSeed(plan)).toThrow();
  });
  it('目标目录链接拒绝并保留陌生对象', () => {
    const plan = setup();
    const other = `${plan.destination}-other`;
    fs.mkdirSync(other);
    fs.symlinkSync(other, plan.destination, 'junction');
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.lstatSync(plan.destination).isSymbolicLink()).toBe(true);
  });
  it('检查回调取消后不继续，现场保留', () => {
    const plan = setup();
    let calls = 0;
    plan.check = () => {
      if (++calls > 12) throw new Error('取消');
    };
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.existsSync(plan.seed)).toBe(true);
  });
  it('写入途中seed变化拒绝且保留失败输出', () => {
    const plan = setup();
    const write = fs.writeSync;
    let changed = false;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const count = write(fd, buffer, offset, length, position);
      if (!changed) {
        changed = true;
        fs.appendFileSync(plan.seed, 'x');
      }
      return count;
    }) as typeof fs.writeSync);
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.readFileSync(plan.seed, 'utf8')).toMatch(/x$/);
    expect(fs.readdirSync(plan.destination)).toContain('index.json');
  });
  it('flush后才到期仍拒绝，不把已经写完当成功', () => {
    const plan = setup();
    const flush = fs.fsyncSync;
    let expired = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      flush(fd);
      expired = true;
    });
    plan.check = () => {
      if (expired) throw new Error('期限已到');
    };
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.readdirSync(plan.destination)).toContain('index.json');
  });
  it('目标祖先链接拒绝，不在未知位置创建集合', () => {
    const plan = setup();
    const other = `${plan.destination}-other`;
    fs.mkdirSync(other);
    const link = `${plan.destination}-link`;
    fs.symlinkSync(other, link, 'junction');
    plan.destination = join(link, 'new');
    expect(() => replicateSeed(plan)).toThrow();
    expect(fs.readdirSync(other)).toEqual([]);
  });
  it('跨scope构建证明拒绝且不创建会话目录', () => {
    const plan = setup();
    const scope = join(
      plan.destination,
      'log',
      'stage7-e2',
      `full-conversations-${'1'.repeat(32)}`,
    );
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(
      join(scope, 'build-proof.json'),
      JSON.stringify({ version: 1, scopeId: `full-conversations-${'2'.repeat(32)}`, sources: {} }),
    );
    expect(() =>
      prepareFullConversations(scope, `runtime-${'3'.repeat(32)}`, () => undefined),
    ).toThrow();
    expect(fs.existsSync(join(scope, 'conversations'))).toBe(false);
  });
  it.each(['content', 'unknown', 'seed', 'replacement'] as const)(
    '最终验证分别拒绝%s变化',
    (kind) => {
      const plan = setup();
      const facts = replicateSeed(plan);
      const file = join(
        plan.destination,
        Object.keys(facts).find((name) => name !== 'index.json')!,
      );
      if (kind === 'content') fs.writeFileSync(file, 'x'.repeat(plan.bytes));
      if (kind === 'unknown') fs.writeFileSync(join(plan.destination, 'unknown'), 'x');
      if (kind === 'seed') fs.appendFileSync(plan.seed, 'x');
      if (kind === 'replacement') {
        fs.renameSync(file, `${file}.preserved`);
        fs.writeFileSync(file, fs.readFileSync(plan.seed), { flag: 'wx' });
        fs.renameSync(`${file}.preserved`, `${plan.seed}.preserved`);
      }
      expect(() => verifyReplicas(plan, facts)).toThrow();
    },
  );
  it('大小写重复UUID和路径字面量被产品索引校验拒绝', () => {
    const plan = setup();
    const index = fiftyIndex();
    index.sessions = index.sessions.slice(0, 2);
    index.sessions[0]!.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    index.sessions[1]!.id = index.sessions[0]!.id.toUpperCase();
    plan.index = Buffer.from(JSON.stringify(index));
    expect(() => replicateSeed(plan)).toThrow();
    index.sessions[1]!.id = '../other';
    plan.index = Buffer.from(JSON.stringify(index));
    expect(() => replicateSeed(plan)).toThrow();
  });
});
