import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ConversationStore, parseIndexFile, parseMessagesFile } from './conversation-store';
import { LIMITS, projectSession } from './conversation-transfer';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const root = fs.mkdtempSync(join(tmpdir(), 'conversation-transfer-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const message = {
  id: 'm',
  role: 'user' as const,
  content: '保留正文',
  createdAt: 1,
  status: 'complete' as const,
};
const session = { id, title: '标题', createdAt: 1, updatedAt: 1, ephemeral: false };
function setup() {
  const store = new ConversationStore(join(root, crypto.randomUUID()));
  fs.mkdirSync(store.dirPath, { recursive: true });
  return store;
}
it('unknown fields are excluded while known invalid fields reject the entire member', () => {
  expect(
    parseMessagesFile(JSON.stringify({ version: 2, messages: [{ ...message, private: 'secret' }] }))
      ?.messages,
  ).toEqual([message]);
  expect(
    parseMessagesFile(
      JSON.stringify({
        version: 2,
        messages: [message, { ...message, contextSource: { mode: 'none' } }],
      }),
    ),
  ).toBeNull();
  expect(
    parseIndexFile(
      JSON.stringify({ version: 1, sessions: [session, { ...session, id: id.toLowerCase() }] }),
    ),
  ).toBeNull();
});
it('corruption never becomes a successful empty read or permits overwrite and deletion', () => {
  const store = setup();
  const path = join(store.dirPath, `${id}.json`);
  fs.writeFileSync(path, 'broken-private');
  expect(() => store.loadMessages(id)).toThrow();
  expect(store.saveMessages(id, [])).toBe(false);
  expect(store.saveSessions([])).toBe(false);
  expect(store.deleteFiles(id)).toBe(false);
  expect(fs.readFileSync(path, 'utf8')).toBe('broken-private');
});

it.each(['messages', 'index'] as const)(
  'failed promotion rolls back only its new %s files and exposes recovery state',
  (stage) => {
    const store = setup();
    expect(store.saveSessions([])).toBe(true);
    const index = fs.readFileSync(join(store.dirPath, 'index.json'), 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(stage === 'index' ? 'index.json' : `${id}.json`))
        throw new Error('合成发布失败');
      rename(from, to);
    });
    expect(store.promoteSession(id, [message], [session])).toBe(false);
    expect(fs.readdirSync(store.dirPath)).toEqual(['index.json']);
    expect(fs.readFileSync(join(store.dirPath, 'index.json'), 'utf8')).toBe(index);
    expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  },
);

it('promotion preserves pre-existing remnants and rejects budget before writing', () => {
  const store = setup();
  fs.writeFileSync(join(store.dirPath, `${id}.json.tmp`), '原有待恢复资料');
  expect(store.promoteSession(id, [message], [session])).toBe(false);
  expect(fs.readFileSync(join(store.dirPath, `${id}.json.tmp`), 'utf8')).toBe('原有待恢复资料');
  const clean = setup();
  expect(
    clean.promoteSession(
      id,
      [message],
      Array.from({ length: 51 }, () => session),
    ),
  ).toBe(false);
  expect(fs.readdirSync(clean.dirPath)).toEqual([]);
});
it('promotion never adopts an index temporary file replaced after its exclusive creation', () => {
  const store = setup();
  expect(store.saveSessions([])).toBe(true);
  const index = fs.readFileSync(join(store.dirPath, 'index.json'));
  const temporary = join(store.dirPath, 'index.json.tmp');
  const write = fs.writeFileSync;
  const open = fs.openSync;
  let indexFd: number | undefined;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === temporary && args[1] === 'wx') indexFd = fd;
    return fd;
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args);
      if (args[0] === indexFd) {
        fs.renameSync(temporary, join(store.dirPath, 'owned-index-displaced'));
        write(temporary, '异身份索引哨兵');
      }
    },
  );
  expect(store.promoteSession(id, [message], [session])).toBe(false);
  expect(fs.readFileSync(join(store.dirPath, 'index.json'))).toEqual(index);
  expect(fs.readFileSync(temporary, 'utf8')).toBe('异身份索引哨兵');
  expect(fs.existsSync(join(store.dirPath, `${id}.json`))).toBe(false);
});

it('promotion rejects an index replacement whose distinct 64-bit file id rounds to the same number', () => {
  const store = setup();
  expect(store.saveSessions([])).toBe(true);
  const indexPath = join(store.dirPath, 'index.json');
  const index = fs.readFileSync(indexPath);
  const temporary = join(store.dirPath, 'index.json.tmp');
  const displaced = join(store.dirPath, 'owned-index-displaced');
  const volumeId = 3_568_200_107n;
  const ownedId = 9_288_674_232_423_212n;
  const foreignId = ownedId + 1n;
  expect(Number(ownedId)).toBe(Number(foreignId));

  const fstat = fs.fstatSync;
  const lstat = fs.lstatSync;
  const write = fs.writeFileSync;
  const open = fs.openSync;
  let indexFd: number | undefined;
  let replaced = false;

  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: fs.StatOptions) => {
    if (fd !== indexFd) return options?.bigint ? fstat(fd, { bigint: true }) : fstat(fd);
    if (options?.bigint) {
      const stat = fstat(fd, { bigint: true });
      stat.dev = volumeId;
      stat.ino = ownedId;
      return stat;
    }
    const stat = fstat(fd);
    stat.dev = Number(volumeId);
    stat.ino = Number(ownedId);
    return stat;
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
    const isForeignIndex = replaced && (path === temporary || path === indexPath);
    if (options?.bigint) {
      const stat = lstat(path, { bigint: true });
      if (isForeignIndex) {
        stat.dev = volumeId;
        stat.ino = foreignId;
      }
      return stat;
    }
    const stat = lstat(path);
    if (isForeignIndex) {
      stat.dev = Number(volumeId);
      stat.ino = Number(foreignId);
    }
    return stat;
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === temporary && args[1] === 'wx') indexFd = fd;
    return fd;
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args);
      if (args[0] === indexFd) {
        fs.renameSync(temporary, displaced);
        write(temporary, '64位异身份索引哨兵');
        replaced = true;
      }
    },
  );

  expect(store.promoteSession(id, [message], [session])).toBe(false);
  expect(fs.readFileSync(indexPath)).toEqual(index);
  expect(fs.readFileSync(temporary, 'utf8')).toBe('64位异身份索引哨兵');
  expect(fs.readFileSync(displaced, 'utf8')).toContain('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF');
  expect(fs.existsSync(join(store.dirPath, `${id}.json`))).toBe(false);
});

it('ordinary writes preserve interrupted temporary members instead of truncating them', () => {
  const store = setup();
  const temporary = join(store.dirPath, 'index.json.tmp');
  fs.writeFileSync(temporary, '待恢复原件');
  expect(store.saveSessions([session])).toBe(false);
  expect(fs.readFileSync(temporary, 'utf8')).toBe('待恢复原件');
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
});
it('index byte budget is checked before reading file contents', () => {
  const store = setup();
  const path = join(store.dirPath, 'index.json');
  fs.writeFileSync(path, ' '.repeat(65537));
  const read = vi.spyOn(fs, 'readSync');
  const whole = vi.spyOn(fs, 'readFileSync');
  expect(() => store.loadSessions()).toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(whole).not.toHaveBeenCalled();
  expect(fs.statSync(path).size).toBe(65537);
});
it('UUID path identity is preserved and traversal is rejected', () => {
  const store = setup();
  expect(store.saveSessions([session])).toBe(true);
  expect(store.saveMessages(id, [message])).toBe(true);
  expect(store.loadSessions()).toEqual([session]);
  expect(store.loadMessages(id)).toEqual([message]);
  expect(() => store.loadMessages('../outside')).toThrow();
});

it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
  'UUID末尾换行%j不能作为合法会话身份进入索引或路径',
  (ending) => {
    expect(
      parseIndexFile(JSON.stringify({ version: 1, sessions: [{ ...session, id: id + ending }] })),
    ).toBeNull();
    const store = setup();
    expect(() => store.loadMessages(id + ending)).toThrow();
  },
);

it('checks complete escaped message bytes without truncating legal content', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ ...message, content: '' }));
  const content = 'x'.repeat(LIMITS.messageBytes - overhead);
  const raw = { version: 2, messages: [{ ...message, content }] };
  expect(projectSession(raw).maximumMessageBytes).toBe(LIMITS.messageBytes);
  expect(parseMessagesFile(JSON.stringify(raw))?.messages[0]?.content).toBe(content);
  expect(
    parseMessagesFile(
      JSON.stringify({ version: 2, messages: [{ ...message, content: content + 'x' }] }),
    ),
  ).toBeNull();
  expect(
    parseMessagesFile(
      JSON.stringify({ version: 2, messages: [{ ...message, content: '\u0000'.repeat(700000) }] }),
    ),
  ).toBeNull();
});
it('refuses input depth, node, message count and duplicate keys before accepting projection', () => {
  let deep: unknown = 0;
  for (let i = 0; i < 16; i++) deep = { child: deep };
  expect(
    parseMessagesFile(JSON.stringify({ version: 2, messages: [message], unknown: deep })),
  ).toBeNull();
  expect(
    parseMessagesFile(
      JSON.stringify({ version: 2, messages: [message], unknown: Array(LIMITS.nodes).fill(0) }),
    ),
  ).toBeNull();
  expect(
    parseMessagesFile(JSON.stringify({ version: 2, messages: Array(201).fill(message) })),
  ).toBeNull();
  expect(parseMessagesFile('{"version":2,"messages":[],"\\u006dessages":[]}')).toBeNull();
});
it('rejects the 64 MiB session stat before any read and closes its descriptor', () => {
  const store = setup();
  fs.writeFileSync(join(store.dirPath, `${id}.json`), '{}');
  const stat = fs.statSync(join(store.dirPath, `${id}.json`));
  stat.size = LIMITS.sessionBytes + 1;
  vi.spyOn(fs, 'fstatSync').mockReturnValue(stat);
  const read = vi.spyOn(fs, 'readSync');
  const close = vi.spyOn(fs, 'closeSync');
  expect(() => store.loadMessages(id)).toThrow('原文件已保留');
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'budget' });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it('rejects invalid UTF8 without replacing bytes or allowing deletion', () => {
  const store = setup();
  const path = join(store.dirPath, `${id}.json`);
  const raw = Buffer.from([0xc0, 0x80]);
  fs.writeFileSync(path, raw);
  expect(() => store.loadMessages(id)).toThrow();
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
  expect(store.deleteFiles(id)).toBe(false);
  expect(fs.readFileSync(path)).toEqual(raw);
});
