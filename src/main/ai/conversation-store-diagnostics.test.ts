import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { logWarn } from '../logger';
import { ConversationStore } from './conversation-store';
import type { ConversationMessage } from '../../shared/types/conversation';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
vi.mock('../logger', () => ({ logWarn: vi.fn() }));

const evidenceRoot = join(process.cwd(), 'log/stage7-e2');
fs.mkdirSync(evidenceRoot, { recursive: true });
const root = fs.mkdtempSync(join(evidenceRoot, 'conversation-write-diagnostics-'));
const id = '11111111-1111-4111-8111-000000000001';
const message: ConversationMessage = {
  id: 'm',
  role: 'user',
  content: '私有正文哨兵',
  createdAt: 1,
  status: 'complete',
};
const session = { id, title: '私有标题哨兵', createdAt: 1, updatedAt: 1, ephemeral: false };

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(logWarn).mockClear();
});

function setup(member: 'index' | 'messages' = 'messages') {
  const store = new ConversationStore(fs.mkdtempSync(join(root, 'case-')));
  expect(store.saveSessions([session])).toBe(true);
  expect(store.saveMessages(id, [message])).toBe(true);
  const target = join(store.dirPath, member === 'index' ? 'index.json' : `${id}.json`);
  return { store, target, before: fs.readFileSync(target) };
}

function expectDiagnostic(
  member: 'index' | 'messages',
  stage: string,
  category: 'invalid' | 'budget' | 'io',
  code: string,
) {
  expect(logWarn).toHaveBeenLastCalledWith(
    'conversation-store',
    `会话写入失败，已保存文件保留，后续写入已暂停（member=${member}，stage=${stage}，category=${category}，code=${code}）`,
  );
  const output = JSON.stringify(vi.mocked(logWarn).mock.calls);
  for (const privateValue of [root, id, message.content, session.title, '私有异常哨兵']) {
    expect(output).not.toContain(privateValue);
  }
}

it.each(['index', 'messages'] as const)(
  '%s 投影失败在成员写入前分类，原件保留且停止后续写入',
  (member) => {
    const { store, target, before } = setup(member);
    const open = vi.spyOn(fs, 'openSync');
    const saved =
      member === 'index'
        ? store.saveSessions([{ ...session, createdAt: Number.NaN }])
        : store.saveMessages(id, [{ ...message, createdAt: Number.NaN }]);
    expect(saved).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expectDiagnostic(member, 'project', 'invalid', 'projection-shape');
    expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
    expect(store.saveMessages(id, [message])).toBe(false);
    expect(store.saveSessions([session])).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(fs.readFileSync(target)).toEqual(before);
  },
);

it('投影数量预算与不相邻工具结果分别分类，均不扩大接纳范围', () => {
  const budget = setup();
  expect(
    budget.store.saveMessages(
      id,
      Array.from({ length: 201 }, () => message),
    ),
  ).toBe(false);
  expectDiagnostic('messages', 'project', 'budget', 'projection-count');
  expect(fs.readFileSync(budget.target)).toEqual(budget.before);
  const link = setup();
  expect(
    link.store.saveMessages(id, [
      {
        ...message,
        role: 'tool',
        toolCallId: 'orphan',
        toolStep: {
          id: 'step',
          toolCallId: 'orphan',
          name: 'browser_scroll',
          ok: true,
          contentPreview: '私有正文哨兵',
          decision: 'auto',
          createdAt: 1,
        },
      },
    ]),
  ).toBe(false);
  expectDiagnostic('messages', 'project', 'invalid', 'projection-link');
  expect(fs.readFileSync(link.target)).toEqual(link.before);
});

it.each([
  ['mkdirSync', 'mkdir'],
  ['openSync', 'open'],
  ['fstatSync', 'inspect'],
  ['writeFileSync', 'write'],
  ['fsyncSync', 'sync'],
  ['lstatSync', 'verify-temp'],
  ['renameSync', 'rename'],
] as const)('%s 单次失败记录精确阶段且不重试', (method, stage) => {
  const { store, target, before } = setup();
  const error = Object.assign(new Error('私有异常哨兵'), { code: 'EIO', path: target });
  const operation = vi.spyOn(fs, method).mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [{ ...message, content: '下一版正文' }])).toBe(false);
  expect(operation).toHaveBeenCalledTimes(1);
  expectDiagnostic('messages', stage, 'io', 'EIO');
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.existsSync(`${target}.tmp`)).toBe(!['mkdir', 'open'].includes(stage));
});

it('关闭文件失败记录 close 并保留尚未发布的新文件', () => {
  const { store, target, before } = setup();
  const close = fs.closeSync;
  vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
    close(fd);
    throw Object.assign(new Error('私有异常哨兵'), { code: 'EBADF' });
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'close', 'io', 'EBADF');
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.existsSync(`${target}.tmp`)).toBe(true);
});

it('写入首错不被随后关闭异常替代，两次操作均不重试', () => {
  const { store, target, before } = setup();
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('私有异常哨兵'), { code: 'ENOSPC' });
  });
  const close = fs.closeSync;
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
    close(fd);
    throw Object.assign(new Error('私有异常哨兵'), { code: 'EBADF' });
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'write', 'io', 'ENOSPC');
  expect(write).toHaveBeenCalledTimes(1);
  expect(closeSpy).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.existsSync(`${target}.tmp`)).toBe(true);
});

it('原有临时文件的 EEXIST 单独分类并保留两份原件', () => {
  const { store, target, before } = setup('index');
  fs.writeFileSync(`${target}.tmp`, '旧失败临时文件');
  expect(store.saveSessions([session])).toBe(false);
  expectDiagnostic('index', 'open', 'io', 'EEXIST');
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.readFileSync(`${target}.tmp`, 'utf8')).toBe('旧失败临时文件');
});

it.each(['私有异常哨兵', undefined, 123])('未知错误码 %s 归 other，不插入原值', (code) => {
  const { store } = setup();
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('私有异常哨兵'), { code });
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'rename', 'io', 'other');
});

it('发布后身份复核失败归 verify-target 并封闭写入', () => {
  const { store, target } = setup();
  const inspect = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
    if (args[0] === target) throw Object.assign(new Error('私有异常哨兵'), { code: 'EACCES' });
    return inspect(...args);
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'verify-target', 'io', 'EACCES');
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.existsSync(`${target}.tmp`)).toBe(false);
});

it('错误 code 的 getter 不执行，未知异常仍归 other', () => {
  const { store } = setup();
  const getter = vi.fn(() => {
    throw new Error('私有异常哨兵');
  });
  const error = Object.defineProperty(new Error('私有异常哨兵'), 'code', { get: getter });
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'rename', 'io', 'other');
  expect(getter).not.toHaveBeenCalled();
});

it('非法成员 ID 只记录固定分类，保持原有封闭状态', () => {
  const { store } = setup();
  expect(store.saveMessages('私有异常哨兵', [message])).toBe(false);
  expectDiagnostic('messages', 'validate-id', 'io', 'invalid-id');
});

it('promotion 已有目标保护失败只记录成员类别，原件不删除', () => {
  const { store, target, before } = setup();
  expect(store.promoteSession(id, [message], [session])).toBe(false);
  expectDiagnostic('messages', 'check-target', 'io', 'target-exists');
  expect(fs.readFileSync(target)).toEqual(before);
});

it('临时文件身份替换归 identity，保留替换者与原有目标', () => {
  const { store, target, before } = setup();
  const write = fs.writeFileSync;
  const displaced = `${target}.displaced`;
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((...args) => {
    write(...args);
    fs.renameSync(`${target}.tmp`, displaced);
    write(`${target}.tmp`, '替换者资料');
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expectDiagnostic('messages', 'verify-temp', 'io', 'identity');
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.readFileSync(`${target}.tmp`, 'utf8')).toBe('替换者资料');
  expect(fs.existsSync(displaced)).toBe(true);
});

it('promotion 回滚异常与首次 index 发布错误分别记录，未删原索引', () => {
  const store = new ConversationStore(fs.mkdtempSync(join(root, 'case-')));
  expect(store.saveSessions([])).toBe(true);
  const index = join(store.dirPath, 'index.json');
  const before = fs.readFileSync(index);
  const target = join(store.dirPath, `${id}.json`);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === index) throw Object.assign(new Error('私有异常哨兵'), { code: 'EIO' });
    rename(from, to);
  });
  const remove = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation((...args) => {
    if (args[0] === target) throw Object.assign(new Error('私有异常哨兵'), { code: 'EACCES' });
    remove(...args);
  });
  expect(store.promoteSession(id, [message], [session])).toBe(false);
  expect(vi.mocked(logWarn).mock.calls[0]?.[1]).toContain(
    'member=index，stage=rename，category=io，code=EIO',
  );
  expectDiagnostic('messages', 'rollback-remove', 'io', 'EACCES');
  expect(fs.readFileSync(index)).toEqual(before);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  expect(fs.existsSync(`${index}.tmp`)).toBe(false);
});
