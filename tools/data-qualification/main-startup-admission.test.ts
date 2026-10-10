import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { TransferBudget } from '../../src/main/storage/transfer-budget';
import { createPartialRecoveryEntry } from '../../src/main/storage/partial-recovery-entry';
const file = ts.createSourceFile(
  'index.ts',
  readFileSync(resolve('src/main/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function compile(names: string[]) {
  return ts.transpileModule(
    file.statements
      .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
      .map((node) => node.getText(file))
      .join('\n'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
}
it('真实装配 Promise 返回并释放主租约后才开始排队的冒烟', async () => {
  let finish!: () => void;
  const assembly = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const release = vi.fn(),
    smoke = vi.fn(),
    queue: Array<() => void> = [];
  const context = vm.createContext({
    mainRootAdmission: { enter: () => release },
    assembleBrowserWindow: () => assembly,
    __RELEASE__: false,
    SMOKE_MODE: true,
    smokeWindowReady: false,
    resumeSmokeAfterAssembly: smoke,
    setImmediate: (fn: () => void) => queue.push(fn),
  });
  vm.runInContext(compile(['createBrowserWindow']), context);
  const pending = vm.runInContext('createBrowserWindow()', context) as Promise<void>;
  await Promise.resolve();
  expect(context.smokeWindowReady).toBe(false);
  expect(queue).toHaveLength(0);
  finish();
  await pending;
  expect(release).toHaveBeenCalledOnce();
  expect(context.smokeWindowReady).toBe(true);
  expect(context.resumeSmokeAfterAssembly).toBeNull();
  expect(smoke).not.toHaveBeenCalled();
  expect(queue).toHaveLength(1);
  queue[0]!();
  expect(smoke).toHaveBeenCalledOnce();
});
it('恢复入口要求已就绪guardian、零业务图和前次data进程实际退出', () => {
  const factory = vi.fn(() => ({ type: 'recovery' }));
  const context = vm.createContext({
    lifecycleGuardian: {},
    mainRootAdmission: { isOpen: () => true },
    runtimeShutdown: null,
    dataAdmissionOpen: false,
    sourceService: null,
    startupAssemblyFailed: false,
    researchService: null,
    watchRepo: null,
    assemblingWatch: null,
    conversationService: null,
    dataTransferRuntime: null,
    startupPreparation: { ownsDataProcess: () => false },
    recoveryTransferRuntime: null,
    startupTransferMessage: '',
    createRecoveryTransferRuntime: factory,
    requireNodeDataRoot: () => 'synthetic',
    app: { getVersion: () => '0.1.0' },
    chooseNativeTransfer: vi.fn(),
    confirmNativeRestore: vi.fn(),
    requestDataRelaunch: vi.fn(),
  });
  vm.runInContext(compile(['assertStartupNoStores', 'installRecoveryTransfer']), context);
  for (const [field, value] of [
    ['sourceService', {}],
    ['watchRepo', {}],
    ['lifecycleGuardian', null],
    ['startupPreparation', { ownsDataProcess: () => true }],
  ] as const) {
    const old: unknown = context[field];
    context[field] = value;
    vm.runInContext('installRecoveryTransfer()', context);
    expect(factory).not.toHaveBeenCalled();
    context[field] = old;
  }
  vm.runInContext('installRecoveryTransfer()', context);
  expect(factory).toHaveBeenCalledOnce();
  const ports = factory.mock.calls[0] as unknown as [{ assertNoStores(): void }];
  context.sourceService = {};
  expect(() => ports[0].assertNoStores()).toThrow();
});

it('实际装配到首个 Store 构造边界时数据准入仍关闭', async () => {
  const observed: boolean[] = [];
  const context = vm.createContext({
    mainRootAdmission: { isOpen: () => true },
    createMainWindow: () => ({ on: vi.fn(), getContentSize: () => [800, 600] }),
    BrowserControllerImpl: class {},
    AppSessionManager: class {},
    datasetStartup: { prepare: async () => 'normal' },
    assertStartupNoStores: vi.fn(),
    createStartupDataPreparation: () => ({ prepare: async () => ({ state: 'normal' }) }),
    requireNodeDataRoot: () => 'synthetic',
    app: { getVersion: () => '0.1.0' },
    lifecycleGuardian: {},
    requestDataRelaunch: vi.fn(),
    performance: { now: () => 0 },
    TransferBudget,
    TRANSFER_WORK_MS: 1_500_000,
    __RELEASE__: true,
    SMOKE_MODE: false,
    WatchLifecycleCoordinator: class {},
    join: (...parts: string[]) => parts.join('/'),
    mkdirSync: vi.fn(),
    logError: vi.fn(),
    startupAssemblyFailed: false,
    mainWindow: null,
    browserController: null,
    startupHealthOnly: false,
    startupPreparation: null,
    startupTransferMessage: '',
    watchCoordinator: null,
    sourceService: null,
    openSourcesForStartup: () => {
      observed.push(context.dataAdmissionOpen as boolean);
      throw new Error('到达实际首个 Store 边界');
    },
    dataAdmissionOpen: false,
  });
  vm.runInContext(compile(['assembleBrowserWindow']), context);
  // Later domain dependencies are intentionally absent: only the real prefix runs.
  await (vm.runInContext('assembleBrowserWindow()', context) as Promise<void>).catch(
    () => undefined,
  );
  expect(observed).toEqual([false]);
});

function graphFixture(checking = false) {
  const order: string[] = [];
  let open = true;
  const watchScheduler = {
    releaseStartup: vi.fn(() => {
      order.push('watch-release');
      return true;
    }),
    stop: vi.fn(),
  };
  const digestScheduler = {
    releaseStartup: vi.fn(() => {
      order.push('digest-release');
      return true;
    }),
    stop: vi.fn(),
  };
  const recover = vi.fn(async () => {
    order.push('prepare-watch');
    return true;
  });
  const complete = vi.fn(async (proof: () => boolean) => {
    order.push('health-commit');
    return proof();
  });
  const context = vm.createContext({
    dataAdmissionOpen: false,
    startupAssemblyFailed: false,
    startupAdmissionFailed: false,
    mainRootAdmission: { isOpen: () => open },
    runtimeShutdown: null,
    lifecycleGuardian: {},
    runtimeMaintenance: {},
    sourceService: { getState: () => ({ mode: 'normal' }) },
    researchStoreReady: true,
    researchMaintenance: {},
    watchCoordinator: { getState: () => ({ mode: 'normal' }) },
    watchRunCoordinator: { getState: () => ({ mode: 'running' }) },
    conversationService: { getStorageStatus: () => ({ state: 'ready' }) },
    watchScheduler,
    digestScheduler,
    assemblingWatch: { scheduler: watchScheduler },
    finalizeStartupWatch: recover,
    datasetStartup: {
      isChecking: () => checking,
      complete,
      fail: vi.fn(async () => 'recovery-required'),
    },
    setTimeout: (work: () => void) => {
      order.push('host-gap');
      work();
    },
    MIN_HOST_REQUEST_GAP_MS: 2000,
    installPartialRecovery: vi.fn(),
  });
  vm.runInContext(
    compile(['startupGraphReady', 'stopStartupSchedulers', 'finalizeStartupDataGraph']),
    context,
  );
  return {
    context,
    order,
    recover,
    complete,
    watchScheduler,
    digestScheduler,
    close() {
      open = false;
    },
    run: () => vm.runInContext('finalizeStartupDataGraph()', context) as Promise<boolean>,
  };
}

it('普通完整图在旧cycle恢复期间保持关闭，完成后才同步开放两个scheduler', async () => {
  const f = graphFixture();
  f.recover.mockImplementation(async () => {
    expect(f.context.dataAdmissionOpen).toBe(false);
    expect(f.watchScheduler.releaseStartup).not.toHaveBeenCalled();
    return true;
  });
  expect(await f.run()).toBe(true);
  expect(f.context.dataAdmissionOpen).toBe(true);
  expect(f.order).toEqual(['watch-release', 'digest-release']);
  expect(f.complete).not.toHaveBeenCalled();
});

it('Research unavailable实例不能冒充normal Store；不触旧cycle或调度', async () => {
  const f = graphFixture();
  f.context.researchStoreReady = false;
  expect(await f.run()).toBe(false);
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.context.dataAdmissionOpen).toBe(false);
  expect(f.context.installPartialRecovery).toHaveBeenCalledOnce();
});

it('健康图先准备held索引、等待host gap和真实commit，再开放调度', async () => {
  const f = graphFixture(true);
  f.complete.mockImplementation(async (proof) => {
    f.order.push('health-commit');
    expect(f.context.dataAdmissionOpen).toBe(false);
    expect(f.digestScheduler.releaseStartup).not.toHaveBeenCalled();
    return proof();
  });
  expect(await f.run()).toBe(true);
  expect(f.order).toEqual([
    'prepare-watch',
    'host-gap',
    'health-commit',
    'watch-release',
    'digest-release',
  ]);
});

it.each(['watch', 'digest'] as const)(
  '任何%s release失败都重新关总门并停止两个scheduler',
  async (which) => {
    const f = graphFixture();
    (which === 'watch' ? f.watchScheduler : f.digestScheduler).releaseStartup.mockReturnValue(
      false,
    );
    expect(await f.run()).toBe(false);
    expect(f.context.dataAdmissionOpen).toBe(false);
    expect(f.watchScheduler.stop).toHaveBeenCalledOnce();
    expect(f.digestScheduler.stop).toHaveBeenCalledOnce();
    expect(f.context.installPartialRecovery).toHaveBeenCalledOnce();
  },
);

it('异步finalize期间主关闭不被迟到成功重新开放', async () => {
  const f = graphFixture();
  f.recover.mockImplementation(async () => {
    await Promise.resolve();
    f.close();
    return true;
  });
  expect(await f.run()).toBe(false);
  expect(f.context.dataAdmissionOpen).toBe(false);
  expect(f.watchScheduler.releaseStartup).not.toHaveBeenCalled();
});

it('health失败提供partial入口，保留原失败及零调度开放', async () => {
  const f = graphFixture(true);
  f.complete.mockResolvedValue(false);
  expect(await f.run()).toBe(false);
  expect(f.context.datasetStartup.fail).toHaveBeenCalledOnce();
  expect(f.context.installPartialRecovery).toHaveBeenCalledOnce();
  expect(f.watchScheduler.releaseStartup).not.toHaveBeenCalled();
});

it('装配异常只阻止健康开放，真实scheduler stop失败才锁存排水失败', async () => {
  const f = graphFixture();
  f.context.startupAssemblyFailed = true;
  expect(await f.run()).toBe(false);
  expect(f.context.startupAdmissionFailed).toBe(false);
  const g = graphFixture();
  g.watchScheduler.releaseStartup.mockReturnValue(false);
  g.watchScheduler.stop.mockImplementation(() => {
    throw new Error('stop failed');
  });
  expect(await g.run()).toBe(false);
  expect(g.digestScheduler.stop).toHaveBeenCalledOnce();
  expect(g.context.startupAdmissionFailed).toBe(true);
});

it.each([true, false])('实际Watch finalize闭包 checking=%s 遵守不重放边界', async (checking) => {
  let assignment: ts.BinaryExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.left.getText(file) === 'finalizeStartupWatch')
      assignment = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(assignment).toBeDefined();
  const recover = vi.fn(async () => ({ ok: true }));
  const start = vi.fn();
  const initialize = vi.fn();
  const context = vm.createContext({
    checking,
    mainRootAdmission: { isOpen: () => true },
    runtimeShutdown: null,
    dataAdmissionOpen: false,
    finalizeStartupWatch: null,
    coordinator: { start, getState: () => ({ mode: 'running' }) },
    digestDue: { initialize },
    watchOutcome: { repo: { listActiveDigestSchedules: () => [] } },
    startupPorts: {},
    recoverAndStartWatchRuntime: recover,
    startupOwner: {},
    assemblingWatch: {},
  });
  vm.runInContext(
    ts.transpileModule(assignment!.getText(file), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  expect(await (vm.runInContext('finalizeStartupWatch()', context) as Promise<boolean>)).toBe(true);
  expect(recover).toHaveBeenCalledTimes(checking ? 0 : 1);
  expect(start).toHaveBeenCalledTimes(checking ? 1 : 0);
  expect(initialize).toHaveBeenCalledTimes(checking ? 1 : 0);
  expect(context.dataAdmissionOpen).toBe(false);
});

it('一般装配异常先保留恢复入口并释放根租约，不在内部等待shutdown', async () => {
  const release = vi.fn();
  const installPartialRecovery = vi.fn();
  const shutdownRuntime = vi.fn();
  const context = vm.createContext({
    mainRootAdmission: { enter: () => release, isOpen: () => true },
    assembleBrowserWindow: async () => {
      throw new Error('constructor failed');
    },
    installPartialRecovery,
    shutdownRuntime,
    logWarn: vi.fn(),
    browserController: null,
  });
  vm.runInContext(compile(['createBrowserWindow']), context);
  await (vm.runInContext('createBrowserWindow()', context) as Promise<void>);
  expect(installPartialRecovery).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(shutdownRuntime).not.toHaveBeenCalled();
});

it('实际partial安装保留已开的服务并经原生确认、固定gate和主重启端口', async () => {
  const source = { owned: true };
  const ensureRecoveryGate = vi.fn(async (_root: string, context: { check(): void }) =>
    context.check(),
  );
  const requestDataRelaunch = vi.fn(async () => true);
  const context = vm.createContext({
    dataAdmissionOpen: true,
    startupAdmissionFailed: false,
    watchScheduler: null,
    digestScheduler: null,
    partialRecoveryEntry: null,
    runtimeShutdown: null,
    mainRootAdmission: { isOpen: () => true },
    lifecycleGuardian: {},
    sourceService: source,
    researchService: null,
    conversationService: null,
    watchRepo: null,
    assemblingWatch: null,
    startupPreparation: { ownsDataProcess: () => true },
    browserController: {},
    createPartialRecoveryEntry,
    confirmNativeRestore: vi.fn(async () => true),
    ensureRecoveryGate,
    requireNodeDataRoot: () => 'synthetic',
    requestDataRelaunch,
    startupTransferMessage: '',
  });
  vm.runInContext(compile(['stopStartupSchedulers', 'installPartialRecovery']), context);
  vm.runInContext('installPartialRecovery()', context);
  expect(context.sourceService).toBe(source);
  expect(context.dataAdmissionOpen).toBe(false);
  const result = await (vm.runInContext(
    "partialRecoveryEntry.start('restore', { isCurrent: () => true })",
    context,
  ) as Promise<{ state: string }>);
  expect(result.state).toBe('awaiting-restart');
  expect(ensureRecoveryGate).toHaveBeenCalledOnce();
  expect(requestDataRelaunch).toHaveBeenCalledOnce();
  // An owned old utility is handled by real shutdown; this is not a zero-writer
  // assertion and never starts a backup worker or opens a new Store.
  expect(context.startupPreparation.ownsDataProcess()).toBe(true);
});

it('实际IPC先路由partial入口，关闭其余备份/取消/原代恢复能力', async () => {
  const names = ['DataTransferStart', 'DataTransferCancel', 'DataTransferRecoverOriginal'];
  const selected: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === 'handle' &&
      names.some((name) => node.arguments[0]?.getText(file) === `IPC.${name}`)
    )
      selected.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  const callbacks = new Map<string, (payload: unknown, current: () => boolean) => unknown>();
  const partial = { start: vi.fn(async () => ({ state: 'awaiting-restart' })) };
  const ordinary = { service: { start: vi.fn(), cancel: vi.fn(), recoverOriginal: vi.fn() } };
  const recovery = { start: vi.fn(), cancel: vi.fn() };
  const context = vm.createContext({
    IPC: Object.fromEntries(names.map((name) => [name, name])),
    handle: (name: string, callback: (payload: unknown, current: () => boolean) => unknown) =>
      callbacks.set(name, callback),
    transferStatus: () => ({ state: 'recovery-required' }),
    partialRecoveryEntry: partial,
    recoveryTransferRuntime: recovery,
    dataTransferRuntime: ordinary,
  });
  vm.runInContext(
    ts.transpileModule(selected.map((node) => node.getText(file)).join(';\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  await callbacks.get('DataTransferStart')!({ action: 'restore' }, () => true);
  await callbacks.get('DataTransferStart')!({ action: 'restore' }, () => false);
  await callbacks.get('DataTransferCancel')!({}, () => true);
  await callbacks.get('DataTransferRecoverOriginal')!({}, () => true);
  expect(partial.start).toHaveBeenCalledOnce();
  expect(ordinary.service.start).not.toHaveBeenCalled();
  expect(ordinary.service.cancel).not.toHaveBeenCalled();
  expect(ordinary.service.recoverOriginal).not.toHaveBeenCalled();
  expect(recovery.start).not.toHaveBeenCalled();
});
