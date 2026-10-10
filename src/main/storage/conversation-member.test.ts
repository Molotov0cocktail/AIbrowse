import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LIMITS } from '../ai/conversation-transfer';
import { writeConversationMember, readConversationMember } from './conversation-member';
const root = fs.mkdtempSync(join(tmpdir(), 'conversation-member-'));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const snapshotId = '11111111-1111-4111-8111-111111111111';
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 5000,
});
function fixture() {
  const source = fs.mkdtempSync(join(root, 'source-'));
  fs.writeFileSync(
    join(source, 'index.json'),
    JSON.stringify({
      version: 1,
      sessions: [{ id, title: '标题', createdAt: 1, updatedAt: 2, ephemeral: false }],
    }),
  );
  return {
    sourceDirectory: source,
    outputPath: join(root, crypto.randomUUID()),
    snapshotId,
    control: control(),
  };
}
it('projects unknown fields and preserves the original UUID spelling and all legal text', () => {
  const input = fixture();
  const message = { id: 'm', role: 'user', content: '保留正文', createdAt: 1, status: 'complete' };
  fs.writeFileSync(
    join(input.sourceDirectory, `${id}.json`),
    JSON.stringify({ version: 1, messages: [{ ...message, secret: 'private' }] }),
  );
  const wire = writeConversationMember(input);
  const staging = join(root, crypto.randomUUID());
  const restored = readConversationMember({
    inputPath: input.outputPath,
    stagingDirectory: staging,
    snapshotId,
    control: control(),
  });
  expect(restored).toEqual(wire);
  expect(fs.readdirSync(staging).sort()).toEqual([`${id}.json`, 'index.json'].sort());
  expect(JSON.parse(fs.readFileSync(join(staging, `${id}.json`), 'utf8'))).toEqual({
    version: 2,
    messages: [message],
  });
});
it('preserves the existing empty-session meaning when its message file has never been created', () => {
  const input = fixture();
  writeConversationMember(input);
  const staging = join(root, crypto.randomUUID());
  readConversationMember({
    inputPath: input.outputPath,
    stagingDirectory: staging,
    snapshotId,
    control: control(),
  });
  expect(JSON.parse(fs.readFileSync(join(staging, `${id}.json`), 'utf8'))).toEqual({
    version: 2,
    messages: [],
  });
  expect(fs.readdirSync(input.sourceDirectory)).toEqual(['index.json']);
});
it('refuses unknown source files without deleting them', () => {
  const input = fixture();
  fs.writeFileSync(join(input.sourceDirectory, 'private.txt'), 'secret');
  expect(() => writeConversationMember(input)).toThrow('备份数据校验失败');
  expect(fs.readFileSync(join(input.sourceDirectory, 'private.txt'), 'utf8')).toBe('secret');
});
it('refuses same-inode edits to the earlier index while later sessions are written', () => {
  const input = fixture();
  writeConversationMember(input);
  const stagingDirectory = join(root, crypto.randomUUID());
  const index = join(stagingDirectory, 'index.json');
  const open = fs.openSync;
  let edited = false;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === join(stagingDirectory, `${id}.json`) && args[1] === 'wx') {
      const before = fs.lstatSync(index, { bigint: true });
      fs.writeFileSync(index, Buffer.alloc(Number(before.size), 88));
      expect(fs.lstatSync(index, { bigint: true }).ino).toBe(before.ino);
      edited = true;
    }
    return open(...args);
  });
  expect(() =>
    readConversationMember({
      inputPath: input.outputPath,
      stagingDirectory,
      snapshotId,
      control: control(),
    }),
  ).toThrow('备份数据校验失败');
  expect(edited).toBe(true);
  expect(fs.readFileSync(index, 'utf8')).toMatch(/^X+$/);
});
it('uses the operation deadline for final group verification after earlier session deadlines elapsed', () => {
  const input = fixture();
  const sessions = Array.from({ length: 25 }, (_, i) => ({
    id: `${i.toString(16).padStart(8, '0')}-ABCD-4ABC-8DEF-ABCDEFABCDEF`,
    title: '合成',
    createdAt: 1,
    updatedAt: 2,
    ephemeral: false,
  }));
  fs.writeFileSync(
    join(input.sourceDirectory, 'index.json'),
    JSON.stringify({ version: 1, sessions }),
  );
  writeConversationMember(input);
  const stagingDirectory = join(root, crypto.randomUUID());
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === 'string' && args[0].startsWith(stagingDirectory) && args[1] === 'wx')
      now += 1000;
    return open(...args);
  });
  expect(
    readConversationMember({
      inputPath: input.outputPath,
      stagingDirectory,
      snapshotId,
      control: { signal: new AbortController().signal, deadline: 100000 },
    }).sessions,
  ).toBe(25);
});

function wire() {
  const input = fixture();
  writeConversationMember(input);
  return input;
}
function reject(input: ReturnType<typeof fixture>) {
  return () =>
    readConversationMember({
      inputPath: input.outputPath,
      stagingDirectory: join(root, crypto.randomUUID()),
      snapshotId,
      control: control(),
    });
}
function rewriteChild(file: string, index: number, change: (value: Buffer) => Buffer): void {
  const raw = fs.readFileSync(file);
  let offset = 32;
  for (let i = 0; i < index; i++) offset += 77 + Number(raw.readBigUInt64BE(offset + 37));
  const oldLength = Number(raw.readBigUInt64BE(offset + 37));
  const body = change(raw.subarray(offset + 77, offset + 77 + oldLength));
  const header = Buffer.from(raw.subarray(offset, offset + 77));
  header.writeBigUInt64BE(BigInt(body.length), 37);
  createHash('sha256').update(body).digest().copy(header, 45);
  fs.writeFileSync(
    file,
    Buffer.concat([raw.subarray(0, offset), header, body, raw.subarray(offset + 77 + oldLength)]),
  );
}
it('normalizes a genuinely empty initial directory, while no-index orphan files reject', () => {
  const empty = fs.mkdtempSync(join(root, 'empty-'));
  const output = join(root, crypto.randomUUID());
  expect(
    writeConversationMember({
      sourceDirectory: empty,
      outputPath: output,
      snapshotId,
      control: control(),
    }).sessions,
  ).toBe(0);
  expect(
    readConversationMember({
      inputPath: output,
      stagingDirectory: join(root, crypto.randomUUID()),
      snapshotId,
      control: control(),
    }).sessions,
  ).toBe(0);
  fs.writeFileSync(join(empty, `${id}.json`), '{}');
  expect(() =>
    writeConversationMember({
      sourceDirectory: empty,
      outputPath: join(root, crypto.randomUUID()),
      snapshotId,
      control: control(),
    }),
  ).toThrow();
});
it('rejects casefold duplicate UUIDs in the decoded index', () => {
  const input = wire();
  rewriteChild(input.outputPath, 0, (body) => {
    const index = JSON.parse(body.toString());
    index.sessions.push({ ...index.sessions[0], id: id.toLowerCase() });
    return Buffer.from(JSON.stringify(index));
  });
  expect(reject(input)).toThrow('备份数据校验失败');
});
it.each([
  'unknown-child',
  'case-change',
  'hash',
  'snapshot',
  'version',
  'count',
  'short',
  'tail',
  'length-overflow',
] as const)('rejects malformed conversation framing %s', (kind) => {
  const input = wire();
  let bytes = fs.readFileSync(input.outputPath);
  const second = 32 + 77 + Number(bytes.readBigUInt64BE(32 + 37));
  if (kind === 'unknown-child') bytes.write('../private', second + 1, 'ascii');
  if (kind === 'case-change') bytes.write(id.toLowerCase(), second + 1, 'ascii');
  if (kind === 'hash') bytes[second + 45] ^= 1;
  if (kind === 'snapshot') bytes[16] ^= 1;
  if (kind === 'version') bytes.writeUInt32BE(2, 8);
  if (kind === 'count') bytes.writeUInt32BE(52, 12);
  if (kind === 'short') bytes = bytes.subarray(0, bytes.length - 1);
  if (kind === 'tail') bytes = Buffer.concat([bytes, Buffer.from('private-tail')]);
  if (kind === 'length-overflow')
    bytes.writeBigUInt64BE(BigInt(LIMITS.sessionBytes + 1), second + 37);
  fs.writeFileSync(input.outputPath, bytes);
  expect(reject(input)).toThrow('备份数据校验失败');
  expect(fs.readFileSync(input.outputPath)).toEqual(bytes);
});
it('projects unknown fields on incoming wire as well as on local export', () => {
  const input = wire();
  rewriteChild(input.outputPath, 1, (body) => {
    const parsed = JSON.parse(body.toString());
    parsed.secret = 'private';
    return Buffer.from(JSON.stringify(parsed));
  });
  const target = join(root, crypto.randomUUID());
  readConversationMember({
    inputPath: input.outputPath,
    stagingDirectory: target,
    snapshotId,
    control: control(),
  });
  expect(JSON.parse(fs.readFileSync(join(target, `${id}.json`), 'utf8'))).toEqual({
    version: 2,
    messages: [],
  });
});
it.each(['known-field', 'duplicate-key', 'utf8', 'node-depth'] as const)(
  'rejects bad existing data %s without treating it as empty',
  (kind) => {
    const input = fixture();
    const path = join(input.sourceDirectory, `${id}.json`);
    const body =
      kind === 'known-field'
        ? Buffer.from(
            '{"version":2,"messages":[{"id":"m","role":"user","content":5,"createdAt":1,"status":"complete"}]}',
          )
        : kind === 'duplicate-key'
          ? Buffer.from('{"version":2,"messages":[],"\\u006dessages":[]}')
          : kind === 'utf8'
            ? Buffer.from([0xc0, 0x80])
            : Buffer.from(
                '{"version":2,"messages":[],"extra":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}',
              );
    fs.writeFileSync(path, body);
    expect(() => writeConversationMember(input)).toThrow('备份数据校验失败');
    expect(fs.readFileSync(path)).toEqual(body);
  },
);
it('uses casefold filename identity but keeps the original index UUID spelling in output', () => {
  const input = fixture();
  fs.writeFileSync(
    join(input.sourceDirectory, `${id.toLowerCase()}.json`),
    '{"version":2,"messages":[]}',
  );
  writeConversationMember(input);
  const target = join(root, crypto.randomUUID());
  readConversationMember({
    inputPath: input.outputPath,
    stagingDirectory: target,
    snapshotId,
    control: control(),
  });
  expect(fs.readdirSync(target)).toContain(`${id}.json`);
});
it('checks the session file size before allocating or reading its body', () => {
  const input = fixture();
  const path = join(input.sourceDirectory, `${id}.json`);
  fs.writeFileSync(path, '{}');
  const original = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original(...args);
    if (args[0] === path && stat !== undefined)
      Reflect.set(stat, 'size', BigInt(LIMITS.sessionBytes + 1));
    return stat;
  });
  const open = vi.spyOn(fs, 'openSync');
  expect(() => writeConversationMember(input)).toThrow('备份数据校验失败');
  expect(open.mock.calls.some((args) => args[0] === path)).toBe(false);
});
it('refuses reuse of an existing restore directory and link-backed source directories', () => {
  const input = wire();
  const target = fs.mkdtempSync(join(root, 'existing-'));
  expect(() =>
    readConversationMember({
      inputPath: input.outputPath,
      stagingDirectory: target,
      snapshotId,
      control: control(),
    }),
  ).toThrow();
  expect(fs.readdirSync(target)).toEqual([]);
  const link = join(root, crypto.randomUUID());
  fs.symlinkSync(input.sourceDirectory, link, 'junction');
  expect(() =>
    writeConversationMember({
      ...input,
      sourceDirectory: link,
      outputPath: join(root, crypto.randomUUID()),
    }),
  ).toThrow();
});

it('rejects a newline-suffixed UUID without altering its spelling', () => {
  const input = fixture();
  const indexPath = join(input.sourceDirectory, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.sessions[0].id += '\n';
  fs.writeFileSync(indexPath, JSON.stringify(index));
  expect(() => writeConversationMember(input)).toThrow('备份数据校验失败');
});
it('enumerates source names incrementally instead of materializing an unbounded directory', () => {
  const input = fixture();
  const enumeration = vi.spyOn(fs, 'readdirSync');
  writeConversationMember(input);
  expect(enumeration).not.toHaveBeenCalled();
});
it('round trips fifty small sessions and rejects a fifty-first index entry', () => {
  const input = fixture();
  const sessions = Array.from({ length: 50 }, (_, i) => ({
    id: `${i.toString(16).padStart(8, '0')}-ABCD-4ABC-8DEF-ABCDEFABCDEF`,
    title: `会话 ${i}`,
    createdAt: 1,
    updatedAt: 2,
    ephemeral: false,
  }));
  const indexPath = join(input.sourceDirectory, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, sessions }));
  expect(writeConversationMember(input).sessions).toBe(50);
  const stagingDirectory = join(root, crypto.randomUUID());
  expect(
    readConversationMember({
      inputPath: input.outputPath,
      stagingDirectory,
      snapshotId,
      control: control(),
    }).sessions,
  ).toBe(50);
  expect(fs.readdirSync(stagingDirectory)).toHaveLength(51);
  expect(
    JSON.parse(fs.readFileSync(join(stagingDirectory, 'index.json'), 'utf8')).sessions,
  ).toEqual(sessions);
  sessions.push({ ...sessions[0], id });
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, sessions }));
  expect(() =>
    writeConversationMember({ ...input, outputPath: join(root, crypto.randomUUID()) }),
  ).toThrow('备份数据校验失败');
  expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).sessions).toHaveLength(51);
});
it('rejects excessive index bytes and message count rather than dropping entries', () => {
  const input = fixture();
  const indexPath = join(input.sourceDirectory, 'index.json');
  fs.writeFileSync(indexPath, ' '.repeat(LIMITS.indexBytes + 1));
  expect(() => writeConversationMember(input)).toThrow();
  const second = fixture();
  const messages = Array.from({ length: 201 }, () => ({
    id: 'm',
    role: 'user',
    content: 'x',
    createdAt: 0,
    status: 'complete',
  }));
  fs.writeFileSync(
    join(second.sourceDirectory, `${id}.json`),
    JSON.stringify({ version: 2, messages }),
  );
  expect(() => writeConversationMember(second)).toThrow();
});
it('rejects incoming known-field corruption after its byte hash is made self-consistent', () => {
  const input = wire();
  rewriteChild(input.outputPath, 1, () =>
    Buffer.from(
      '{"version":2,"messages":[{"id":"m","role":"assistant","content":"keep","createdAt":1,"status":"complete","agentRun":{"status":"bad"}}]}',
    ),
  );
  expect(reject(input)).toThrow('备份数据校验失败');
});
