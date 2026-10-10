import * as fs from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { logWarn } from '../../src/main/logger';
import { ConversationReadError, ConversationStore } from '../../src/main/ai/conversation-store';
import { ProjectionError } from '../../src/main/ai/conversation-transfer';
import type { ConversationMessage } from '../../src/shared/types/conversation';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
vi.mock('../../src/main/logger', () => ({ logWarn: vi.fn() }));

const evidence = join(process.cwd(), 'log/stage7-e2/resume-persistence-failure-review-001');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(join(evidence, 'independent-cases-'));
const id = '33333333-3333-4333-8333-000000000003';
const message: ConversationMessage = {
  id: 'review-message',
  role: 'user',
  content: '独立正文哨兵',
  createdAt: 3,
  status: 'complete',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(logWarn).mockClear();
});

function setup() {
  const store = new ConversationStore(fs.mkdtempSync(join(root, 'case-')));
  expect(store.saveMessages(id, [message])).toBe(true);
  const target = join(store.dirPath, `${id}.json`);
  return { store, target, before: fs.readFileSync(target) };
}

it.each(['projection', 'read'] as const)('独立反例：%s 类实例的 code getter 也不得执行', (kind) => {
  const { store, target, before } = setup();
  const error =
    kind === 'projection' ? new ProjectionError('shape') : new ConversationReadError('invalid');
  const getter = vi.fn(() => (kind === 'projection' ? 'shape' : 'invalid'));
  Object.defineProperty(error, 'code', { get: getter });
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(logWarn).toHaveBeenLastCalledWith(
    'conversation-store',
    '会话写入失败，已保存文件保留，后续写入已暂停（member=messages，stage=rename，category=io，code=other）',
  );
  expect(fs.readFileSync(target)).toEqual(before);
});

it('独立反例：白名单检查与日志不得二次读取可变 code', () => {
  const { store } = setup();
  const error = new ProjectionError('shape');
  const getter = vi.fn().mockReturnValueOnce('shape').mockReturnValue('独立私密错误码哨兵');
  Object.defineProperty(error, 'code', { get: getter });
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain('独立私密错误码哨兵');
  expect(getter).not.toHaveBeenCalled();
});

it('独立反例：异常原型检查抛错时仍封闭写入并返回受控失败', () => {
  const { store, target, before } = setup();
  const error = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error('独立原型异常哨兵');
      },
    },
  );
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(logWarn).toHaveBeenLastCalledWith(
    'conversation-store',
    '会话写入失败，已保存文件保留，后续写入已暂停（member=messages，stage=rename，category=io，code=other）',
  );
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(fs.readFileSync(target)).toEqual(before);
});

it.each(['inspect', 'sync'] as const)('独立控制：%s 与 close 同错保留首错且只关闭一次', (stage) => {
  const { store, target, before } = setup();
  const operation = vi
    .spyOn(fs, stage === 'inspect' ? 'fstatSync' : 'fsyncSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('独立主体异常哨兵'), { code: 'ENOSPC' });
    });
  const close = fs.closeSync;
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
    close(fd);
    throw Object.assign(new Error('独立关闭异常哨兵'), { code: 'EBADF' });
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(operation).toHaveBeenCalledOnce();
  expect(closeSpy).toHaveBeenCalledOnce();
  expect(logWarn).toHaveBeenLastCalledWith(
    'conversation-store',
    `会话写入失败，已保存文件保留，后续写入已暂停（member=messages，stage=${stage}，category=io，code=ENOSPC）`,
  );
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.existsSync(`${target}.tmp`)).toBe(true);
});

it.each([null, '独立文本异常哨兵', 1, { code: 'EIO', message: '独立文本异常哨兵' }])(
  '独立控制：普通异常仅产生闭合字段 %#',
  (error) => {
    const { store } = setup();
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw error;
    });
    expect(store.saveMessages(id, [message])).toBe(false);
    const output = JSON.stringify(vi.mocked(logWarn).mock.calls);
    for (const secret of ['独立文本异常哨兵', root, id, message.content])
      expect(output).not.toContain(secret);
    expect(output).toMatch(/member=messages，stage=rename，category=io，code=(other|EIO)/);
  },
);

it('独立控制：错误 message、stack 与 path 的 getter 均不得读取', () => {
  const { store } = setup();
  const getter = vi.fn(() => {
    throw new Error('独立敏感字段哨兵');
  });
  const error = Object.create(null) as object;
  Object.defineProperty(error, 'code', { value: 'EACCES' });
  for (const property of ['message', 'stack', 'path'])
    Object.defineProperty(error, property, { get: getter });
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw error;
  });
  expect(store.saveMessages(id, [message])).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(logWarn).toHaveBeenLastCalledWith(
    'conversation-store',
    '会话写入失败，已保存文件保留，后续写入已暂停（member=messages，stage=rename，category=io，code=EACCES）',
  );
});

it.each(['descriptor', 'prototype'] as const)('独立控制：分类器自身%s检查抛错时归other', (kind) => {
  const file = ts.createSourceFile(
    'store.ts',
    fs.readFileSync('src/main/ai/conversation-store.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const classifier = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'writeErrorCode',
  );
  const guard = file.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'WriteGuardError',
  );
  if (!classifier || !guard) throw new Error('缺少实际分类器');
  const trap = vi.fn(() => {
    throw new Error('独立反射异常哨兵');
  });
  const error = new Proxy(
    { code: 'EIO' },
    kind === 'descriptor' ? { getOwnPropertyDescriptor: trap } : { getPrototypeOf: trap },
  );
  const context = vm.createContext({ ProjectionError, ConversationReadError, error });
  vm.runInContext(
    ts.transpileModule(`${guard.getText(file)}\n${classifier.getText(file)}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  expect(vm.runInContext('writeErrorCode(error)', context)).toBe('other');
  expect(trap).toHaveBeenCalledOnce();
});

const main = ts.createSourceFile(
  'src/main/index.ts',
  fs.readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function exitFunction() {
  const declaration = main.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'exitAfterRendererAdmissionDrain',
  );
  if (!declaration) throw new Error('缺少实际main退出编排');
  return ts.transpileModule(declaration.getText(main), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

it.each(['pending', 'reject'] as const)(
  '独立控制：main排水%s时不得清理、退休或退出',
  async (state) => {
    const cleanup = vi.fn();
    const finish = vi.fn();
    const exit = vi.fn();
    const failure = vi.fn();
    const context = vm.createContext({
      shutdownRuntime: () =>
        state === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('排水失败')),
      finishGuardianShutdown: finish,
      mainFailureShutdown: { isActive: () => false },
      reportShutdownFailure: failure,
      app: { exit },
      cleanup,
    });
    vm.runInContext(exitFunction(), context);
    vm.runInContext('exitAfterRendererAdmissionDrain(1, cleanup)', context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(state === 'reject' ? 1 : 0);
  },
);
