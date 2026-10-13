import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { dispatchBrowserLibrary } from '../../src/main/browser-library-ipc';
import { IPC } from '../../src/shared/types/ipc';

// An explicit revision replays the same oracle against a historical source without checkout.
const revision = process.env['AIBROWSE_STARTUP_TEST_SOURCE_REVISION'];
if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision))
  throw new Error('启动接线对照必须提供完整提交SHA');
const source = ts.createSourceFile(
  'index.ts',
  revision === undefined
    ? readFileSync('src/main/index.ts', 'utf8')
    : execFileSync('git', ['show', `${revision}:src/main/index.ts`], { encoding: 'utf8' }),
  ts.ScriptTarget.Latest,
  true,
);

function extract(predicate: (node: ts.Node) => boolean): string {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1) throw new Error('启动接线必须精确匹配一个生产节点');
  return matches[0]!.getText(source);
}

function declaration(name: string): string {
  return extract((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
}

function install(context: vm.Context, code: string): void {
  vm.runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(admitted = true) {
  let initializing = false;
  const assignments: boolean[] = [];
  const pending = deferred();
  const release = vi.fn(() => {
    expect(initializing).toBe(false);
  });
  const assemble = vi.fn(() => pending.promise);
  const recover = vi.fn();
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const dispatch = vi.fn(dispatchBrowserLibrary);
  const globals = {
    __RELEASE__: true,
    browserLibraryService: null,
    conversationService: null,
    partialRecoveryEntry: null,
    recoveryTransferRuntime: null,
    dataTransferRuntime: null,
    startupTransferMessage: '本地数据服务未准备完成，原件已保留',
    browserController: null,
    mainRootAdmission: {
      enter: vi.fn(() => (admitted ? release : null)),
      isOpen: () => true,
    },
    assembleBrowserWindow: assemble,
    installPartialRecovery: recover,
    logWarn: vi.fn(),
    IPC,
    dispatchBrowserLibrary: dispatch,
    handle: (channel: string, handler: (payload: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  };
  Object.defineProperty(globals, 'startupDataInitializing', {
    configurable: true,
    get: () => initializing,
    set: (value: boolean) => {
      initializing = value;
      assignments.push(value);
    },
  });
  const context = vm.createContext(globals);
  install(context, declaration('createBrowserWindow'));
  install(
    context,
    extract(
      (node) =>
        ts.isForOfStatement(node) &&
        ts.isArrayLiteralExpression(node.expression) &&
        node.expression.elements.some(
          (element) => element.getText(source) === 'IPC.BrowserLibraryStatus',
        ),
    ),
  );
  install(
    context,
    'const ' +
      extract(
        (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'transferStatus',
      ) +
      ';',
  );
  for (const channel of ['DataTransferStatus', 'ConversationStorageStatus']) {
    install(
      context,
      extract(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'handle' &&
          node.arguments[0]?.getText(source) === `IPC.${channel}`,
      ),
    );
  }
  const status = () => handlers.get(IPC.BrowserLibraryStatus)!(undefined);
  return {
    context,
    pending,
    release,
    assemble,
    recover,
    assignments,
    dispatch,
    status,
    transferStatus: () => handlers.get(IPC.DataTransferStatus)!(undefined),
    conversationStatus: () => handlers.get(IPC.ConversationStorageStatus)!(undefined),
    initializing: () => initializing,
    run: () => vm.runInContext('createBrowserWindow()', context) as Promise<void>,
  };
}

it('实际窗口装配开始即表达初始化，成功后先清状态再释放租约', async () => {
  const f = fixture();
  const running = f.run();
  expect(f.initializing()).toBe(true);
  expect(f.status()).toMatchObject({ state: 'initializing' });
  expect(f.conversationStatus()).toEqual({ state: 'initializing', code: null });
  expect(f.transferStatus()).toMatchObject({ state: 'initializing', code: 'none' });
  expect(f.release).not.toHaveBeenCalled();
  f.context.browserLibraryService = {
    getStatus: () => ({ state: 'available', message: '已准备' }),
  };
  f.pending.resolve();
  await running;
  expect(f.assignments).toEqual([true, false]);
  expect(f.initializing()).toBe(false);
  expect(f.status()).toMatchObject({ state: 'available' });
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
});

it('真实装配等待脚本时窗口已销毁，提前返回仍结束初始化', async () => {
  const f = fixture();
  let destroyed = false;
  const createWindow = vi.fn(() => ({ isDestroyed: () => destroyed }));
  const createScripts = vi.fn(() => ({ ready: f.pending.promise }));
  Object.assign(f.context, {
    mainWindow: null,
    userScriptService: null,
    idmService: null,
    qualifiedScripts: null,
    createMainWindow: createWindow,
    createUserScriptFeature: () => ({ service: {} }),
    createIdmFeature: () => ({}),
    mainRootIsOpen: () => true,
    requireNodeDataRoot: () => '受控数据目录，不执行IO',
    createQualifiedScriptFeature: createScripts,
  });
  install(f.context, declaration('assembleBrowserWindow'));
  const running = f.run();
  expect(createWindow).toHaveBeenCalledOnce();
  expect(createScripts).toHaveBeenCalledOnce();
  expect(f.initializing()).toBe(true);
  destroyed = true;
  f.pending.resolve();
  await running;
  expect(f.assignments).toEqual([true, false]);
  expect(f.status()).toMatchObject({ state: 'unavailable' });
  expect(f.conversationStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(f.transferStatus()).toMatchObject({ state: 'recovery-required', code: 'recovery' });
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
});

it('装配异常后保留恢复入口并清初始化状态，真实不可用可见', async () => {
  const f = fixture();
  const running = f.run();
  f.pending.reject(new Error('受控装配失败'));
  await running;
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.assignments).toEqual([true, false]);
  expect(f.status()).toMatchObject({ state: 'unavailable' });
  expect(f.release).toHaveBeenCalledOnce();
});

it('恢复入口自身抛错仍经finally清初始化并释放租约', async () => {
  const f = fixture();
  f.recover.mockImplementation(() => {
    throw new Error('受控恢复失败');
  });
  const running = f.run();
  f.pending.reject(new Error('受控装配失败'));
  await expect(running).rejects.toThrow('受控恢复失败');
  expect(f.assignments).toEqual([true, false]);
  expect(f.status()).toMatchObject({ state: 'unavailable' });
  expect(f.release).toHaveBeenCalledOnce();
});

it('根租约已拒绝时不开始装配且不写初始化标记', async () => {
  const f = fixture(false);
  await f.run();
  expect(f.assignments).toEqual([]);
  expect(f.initializing()).toBe(false);
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(f.status()).toMatchObject({ state: 'unavailable' });
});

it('实际IPC闭包逐次读取并以第五参数传递初始化状态', () => {
  const f = fixture();
  for (const initializing of [true, false]) {
    f.context.startupDataInitializing = initializing;
    expect(f.status()).toMatchObject({ state: initializing ? 'initializing' : 'unavailable' });
    expect(f.dispatch).toHaveBeenLastCalledWith(
      IPC.BrowserLibraryStatus,
      undefined,
      null,
      expect.any(Function),
      initializing,
    );
  }
});

it('正常启动三域尚无服务时会话和数据转移实际IPC返回中性初始化', () => {
  const f = fixture();
  f.context.startupDataInitializing = true;
  expect.soft(f.conversationStatus()).toEqual({ state: 'initializing', code: null });
  expect.soft(f.transferStatus()).toMatchObject({
    operationId: null,
    action: null,
    state: 'initializing',
    code: 'none',
    canCancel: false,
    canRecoverOriginal: false,
    availableActions: [],
  });
});

it('初始化结束仍无服务时会话和数据转移恢复真实故障', () => {
  const f = fixture();
  f.context.startupDataInitializing = false;
  expect(f.conversationStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(f.transferStatus()).toMatchObject({ state: 'recovery-required', code: 'recovery' });
});

it.each(['ready', 'recovery-required'] as const)(
  '已有会话服务的%s状态优先于初始化标志',
  (state) => {
    const f = fixture();
    const expected = { state, code: state === 'ready' ? null : 'io' };
    const read = vi.fn(() => expected);
    f.context.startupDataInitializing = true;
    f.context.conversationService = { getStorageStatus: read };
    expect(f.conversationStatus()).toBe(expected);
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(['unavailable', 'storage-error', 'maintenance'] as const)(
  '已有浏览资料服务的%s状态优先于统一初始化标志',
  (state) => {
    const f = fixture();
    const expected = { state, message: '受控资料状态' };
    f.context.startupDataInitializing = true;
    f.context.browserLibraryService = { getStatus: () => expected };
    expect(f.status()).toBe(expected);
  },
);

it.each(['partialRecoveryEntry', 'recoveryTransferRuntime', 'dataTransferRuntime'] as const)(
  '已有%s的真实恢复状态优先于初始化标志',
  (runtime) => {
    const f = fixture();
    const expected = {
      operationId: null,
      action: null,
      state: 'recovery-required',
      code: 'recovery',
      message: '需要恢复受控原数据',
      canCancel: false,
      canRecoverOriginal: false,
      availableActions: ['restore'],
    };
    const read = vi.fn(() => expected);
    f.context.startupDataInitializing = true;
    f.context[runtime] = { getStatus: read };
    expect(f.transferStatus()).toBe(expected);
    expect(read).toHaveBeenCalledOnce();
  },
);
