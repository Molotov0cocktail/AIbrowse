import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MaintenanceAdmission } from './maintenance-admission';
import { RuntimeShutdown, RuntimeShutdownError, type ShutdownProducer } from './runtime-shutdown';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let step = 0; step < 15; step++) await Promise.resolve();
}

describe('永久退出协调', () => {
  it('全根和生产者先同步闭门，再发取消；原根直到取消后才能释放', async () => {
    const root = new MaintenanceAdmission();
    const release = root.enter()!;
    const order: string[] = [];
    const producers: ShutdownProducer[] = ['a', 'b'].map((name) => ({
      beginShutdown: () => order.push(`seal:${name}`),
      drainBeforeClose: async () => {
        expect(root.isOpen()).toBe(false);
        expect(order.slice(0, 2)).toEqual(['seal:a', 'seal:b']);
        order.push(`abort:${name}`);
        if (name === 'b') release();
      },
    }));
    const close = vi.fn();
    const runtime = new RuntimeShutdown({
      roots: [root],
      producers,
      waitForUsage: async () => undefined,
      cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
      closeResources: close,
    });
    const work = runtime.shutdown();
    expect(order).toEqual(['seal:a', 'seal:b', 'abort:a', 'abort:b']);
    await work;
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.getPhase()).toBe('closed');
  });

  it('某域同步抛错仍启动其它排水，等待其原 Promise 后锁存失败且零关闭', async () => {
    const pending = deferred();
    const close = vi.fn();
    const tail = vi.fn(async () => undefined);
    const other = vi.fn(() => pending.promise);
    const runtime = new RuntimeShutdown({
      roots: [],
      producers: [
        {
          beginShutdown: () => undefined,
          drainBeforeClose: () => {
            throw new Error('private');
          },
        },
        { beginShutdown: () => undefined, drainBeforeClose: other },
      ],
      waitForUsage: tail,
      cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
      closeResources: close,
    });
    const work = runtime.shutdown();
    expect(other).toHaveBeenCalledOnce();
    await flush();
    expect(tail).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(runtime.getPhase()).toBe('draining');
    const inspection = runtime.getPending();
    expect(inspection).toEqual({ roots: [], producers: [1] });
    inspection.producers.length = 0;
    expect(runtime.getPending().producers).toEqual([1]);
    pending.resolve();
    await expect(work).rejects.toMatchObject({ stage: 'drain' });
    expect(runtime.shutdown()).toBe(work);
    expect(runtime.getPhase()).toBe('failed');
    expect(runtime.getPending()).toEqual({ roots: [], producers: [] });
    expect(close).not.toHaveBeenCalled();
  });

  it('原域终态后才观察 usage，尾写入与任务 Tab 清理均完成才关闭', async () => {
    const operation = deferred();
    const usage = deferred();
    const workspace = deferred();
    const order: string[] = [];
    const runtime = new RuntimeShutdown({
      roots: [],
      producers: [
        {
          beginShutdown: () => undefined,
          drainBeforeClose: async () => {
            await operation.promise;
            order.push('terminal-enqueued-usage');
          },
        },
      ],
      waitForUsage: async () => {
        order.push('usage');
        await usage.promise;
      },
      cleanupWorkspace: async () => {
        order.push('workspace');
        await workspace.promise;
        return { ok: true, retainedCount: 0 };
      },
      closeResources: () => {
        order.push('close');
      },
    });
    const work = runtime.shutdown();
    await flush();
    expect(order).toEqual([]);
    operation.resolve();
    await flush();
    expect(order).toEqual(['terminal-enqueued-usage', 'usage']);
    usage.resolve();
    await flush();
    expect(order).toEqual(['terminal-enqueued-usage', 'usage', 'workspace']);
    workspace.resolve();
    await work;
    expect(order.at(-1)).toBe('close');
  });

  it.each([
    { ok: false, retainedCount: 0 },
    { ok: true, retainedCount: 1 },
  ])('任务 Tab 未完整清理时保留句柄 %j', async (cleanup) => {
    const close = vi.fn();
    const runtime = new RuntimeShutdown({
      roots: [],
      producers: [],
      waitForUsage: async () => undefined,
      cleanupWorkspace: async () => cleanup,
      closeResources: close,
    });
    await expect(runtime.shutdown()).rejects.toMatchObject({ stage: 'workspace' });
    expect(close).not.toHaveBeenCalled();
  });

  it('准入关闭抛错仍关闭其余入口并取消；重入共享已发布 Promise', async () => {
    let reentrant: Promise<void> | null = null;
    const remaining = vi.fn();
    const close = vi.fn();
    const runtime = new RuntimeShutdown({
      roots: [
        {
          beginShutdown: () => {
            throw new Error('private');
          },
          drain: async () => undefined,
        },
      ],
      producers: [
        {
          beginShutdown: remaining,
          drainBeforeClose: async () => {
            reentrant = runtime.shutdown();
          },
        },
      ],
      waitForUsage: async () => undefined,
      cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
      closeResources: close,
    });
    const work = runtime.shutdown();
    expect(reentrant).toBe(work);
    await expect(work).rejects.toMatchObject({ stage: 'admission' });
    expect(remaining).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('资源关闭错误不授予正常退出，也不重新执行关闭', async () => {
    const close = vi.fn(() => {
      throw new Error('private');
    });
    const runtime = new RuntimeShutdown({
      roots: [],
      producers: [],
      waitForUsage: async () => undefined,
      cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
      closeResources: close,
    });
    const work = runtime.shutdown();
    await expect(work).rejects.toBeInstanceOf(RuntimeShutdownError);
    expect(runtime.shutdown()).toBe(work);
    expect(runtime.getPhase()).toBe('failed');
    expect(close).toHaveBeenCalledOnce();
  });
});

const index = ts.createSourceFile(
  'index.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function extract(predicate: (node: ts.Node) => boolean): string {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(index);
  if (found === undefined) throw new Error('主入口接线节点缺失');
  return found.getText(index);
}

function mainFixture(digestFailure = false, duringStartup = false) {
  const root = new MaintenanceAdmission();
  const rootRelease = root.enter()!;
  const watchPending = deferred();
  const usagePending = deferred();
  const closed = vi.fn();
  const quit = vi.fn();
  const order: string[] = [];
  const producer = (name: string) => ({
    beginShutdown: () => {
      order.push(`seal:${name}`);
    },
    drainBeforeClose: vi.fn(async () => {
      order.push(`drain:${name}`);
    }),
  });
  const research = { ...producer('research'), shutdown: closed };
  const digest = {
    stopAdmission: () => {
      order.push('seal:digest');
    },
    abort: vi.fn(() => {
      order.push('abort:digest');
      rootRelease();
    }),
    drain: vi.fn(async () => {
      if (digestFailure) throw new Error('private');
    }),
    dispose: closed,
  };
  const watch = {
    beginShutdown: () => {
      order.push('seal:watch');
    },
    stop: vi.fn(() => watchPending.promise),
  };
  const startup = {
    repo: { dispose: closed },
    coordinator: watch,
    scheduler: {
      stop: () => {
        order.push('seal:scheduler');
      },
    },
    hostGate: null,
    startupDrainFailed: false,
  };
  const startupPending = deferred();
  let beforeQuit!: (event: { preventDefault(): void }) => void;
  let onClosed!: () => void;
  const context = vm.createContext({
    RuntimeShutdown,
    __RELEASE__: true,
    runtimeShutdown: null,
    dataTransferRuntime: null,
    recoveryTransferRuntime: null,
    partialRecoveryEntry: null,
    startupAdmissionFailed: false,
    startupPreparation: null,
    lifecycleGuardian: null,
    mainFailureShutdown: { isActive: () => false },
    diagnosticService: { invalidateAndDrain: vi.fn(async () => undefined) },
    shutdownQuitScheduled: false,
    shutdownQuitReady: false,
    mainRootAdmission: root,
    researchIpcAdmission: new MaintenanceAdmission(),
    sourceIpcAdmission: new MaintenanceAdmission(),
    watchIpcAdmission: new MaintenanceAdmission(),
    runtimeMaintenance: { shutdown: () => undefined, waitForIdle: async () => undefined },
    watchSubscriptionDestroyedCleanup: null,
    watchSubscriptionSender: null,
    watchSubscriptionCurrent: () => true,
    pushWatchStatus: () => undefined,
    sourceIpcAdmissionOpen: true,
    watchShutdownStarted: false,
    conversationService: producer('conversation'),
    researchMaintenance: research,
    sourceService: { dispose: closed },
    sourceUsageTracker: { waitForIdle: vi.fn(() => usagePending.promise) },
    assemblingWatch: duringStartup ? startup : null,
    assembleBrowserWindow: () => startupPending.promise,
    watchRunCoordinator: duringStartup ? null : watch,
    watchRepo: duringStartup ? null : { dispose: closed },
    watchScheduler: {
      stop: () => {
        order.push('seal:scheduler');
      },
    },
    watchHostGate: null,
    digestService: digest,
    digestScheduler: {
      stop: () => {
        order.push('seal:digest-scheduler');
      },
    },
    watchWorkspace: { cleanupAll: vi.fn(async () => ({ ok: true, retainedCount: 0 })) },
    watchCoordinator: { dispose: closed },
    browserController: { dispose: closed },
    watchPreviewService: producer('preview'),
    watchExportService: producer('export'),
    watchNotifications: producer('notifications'),
    watchWindowsNotifications: producer('windows'),
    watchWindowsSink: null,
    watchPreviewStore: null,
    watchGrantStore: null,
    watchIpcAdapter: null,
    watchPublicStackRobots: null,
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    cleanupSmokeDirectories: vi.fn(async () => undefined),
    mainWindow: null,
    app: {
      on: (_event: string, handler: typeof beforeQuit) => {
        beforeQuit = handler;
      },
      quit,
    },
    win: {
      on: (_event: string, handler: typeof onClosed) => {
        onClosed = handler;
      },
    },
  });
  const declarations = [
    'stopWatchIpcAdmission',
    'stopRendererAdmissions',
    'shutdownRuntime',
    'reportShutdownFailure',
    'finishGuardianShutdown',
    'createBrowserWindow',
  ];
  const nodes = declarations.map((name) =>
    extract((node) => ts.isFunctionDeclaration(node) && node.name?.text === name),
  );
  nodes.push(
    extract(
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(index) === 'app.on' &&
        node.arguments[0]?.getText(index) === "'before-quit'",
    ),
  );
  nodes.push(
    extract(
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(index) === 'win.on' &&
        node.arguments[0]?.getText(index) === "'closed'",
    ),
  );
  vm.runInContext(
    ts.transpileModule(nodes.join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  const shutdown = (): Promise<void> =>
    vm.runInContext('shutdownRuntime()', context) as Promise<void>;
  return {
    root,
    context,
    order,
    digest,
    watch,
    watchPending,
    usagePending,
    closed,
    quit,
    beforeQuit: () => beforeQuit({ preventDefault: vi.fn() }),
    onClosed: () => onClosed(),
    shutdown,
    startup,
    startupPending,
    createWindow: (): Promise<void> =>
      vm.runInContext('createBrowserWindow()', context) as Promise<void>,
  };
}

describe('实际 main 接线 AST 集成', () => {
  it('持根退出会立即 abort，窗口关闭与 before-quit 共享排水，usage 之后仅关闭一次', async () => {
    const fixture = mainFixture();
    fixture.beforeQuit();
    fixture.onClosed();
    fixture.beforeQuit();
    const work = fixture.shutdown();
    expect(fixture.root.isOpen()).toBe(false);
    expect(fixture.digest.abort).toHaveBeenCalledOnce();
    const firstDrain = fixture.order.findIndex((step) => step.startsWith('drain:'));
    expect(fixture.order.slice(0, firstDrain)).toContain('seal:watch');
    expect(fixture.order.slice(0, firstDrain)).toContain('seal:digest');
    expect(fixture.watch.stop).toHaveBeenCalledOnce();
    expect(fixture.closed).not.toHaveBeenCalled();
    fixture.watchPending.resolve();
    await flush();
    expect(fixture.closed).not.toHaveBeenCalled();
    fixture.usagePending.resolve();
    await work;
    await flush();
    expect(fixture.closed).toHaveBeenCalledTimes(6);
    expect(fixture.quit).toHaveBeenCalledOnce();
    fixture.beforeQuit();
    expect(fixture.closed).toHaveBeenCalledTimes(6);
  });

  it('Digest 排水拒绝仍等 Watch 原操作，保留所有句柄且不会 app.quit', async () => {
    const fixture = mainFixture(true);
    fixture.beforeQuit();
    fixture.onClosed();
    const work = fixture.shutdown();
    expect(fixture.watch.stop).toHaveBeenCalledOnce();
    await flush();
    expect(fixture.closed).not.toHaveBeenCalled();
    fixture.watchPending.resolve();
    fixture.usagePending.resolve();
    await expect(work).rejects.toMatchObject({ stage: 'drain' });
    await flush();
    fixture.beforeQuit();
    expect(fixture.closed).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it('启动尚未发布 Watch 时仍先取消，原 startup 根释放前不得关闭任何句柄', async () => {
    const fixture = mainFixture(false, true);
    const startup = fixture.createWindow();
    fixture.beforeQuit();
    const work = fixture.shutdown();
    expect(fixture.watch.stop).toHaveBeenCalledOnce();
    fixture.watchPending.resolve();
    fixture.usagePending.resolve();
    await flush();
    expect(fixture.closed).not.toHaveBeenCalled();
    fixture.startupPending.resolve();
    await startup;
    await work;
    expect(fixture.closed).toHaveBeenCalledTimes(6);
  });

  it('startup 迟到报告无法收敛时锁存保留，不能被各域空 drain 覆盖', async () => {
    const fixture = mainFixture(false, true);
    const startup = fixture.createWindow();
    fixture.beforeQuit();
    const work = fixture.shutdown();
    fixture.watchPending.resolve();
    fixture.usagePending.resolve();
    fixture.startup.startupDrainFailed = true;
    fixture.startupPending.resolve();
    await startup;
    await expect(work).rejects.toMatchObject({ stage: 'drain' });
    expect(fixture.closed).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it('只有装配失败但未曾失败排水时，使用真实参与者排水并正常关闭', async () => {
    const fixture = mainFixture(false, true);
    fixture.context.startupAssemblyFailed = true;
    const work = fixture.shutdown();
    fixture.watchPending.resolve();
    fixture.usagePending.resolve();
    await work;
    expect(fixture.watch.stop).toHaveBeenCalledOnce();
    expect(fixture.closed).toHaveBeenCalledTimes(6);
  });

  it('partial恢复确认或gate原操作未结束时不得关闭真实服务句柄', async () => {
    const fixture = mainFixture();
    const original = deferred();
    const begin = vi.fn();
    fixture.context.partialRecoveryEntry = {
      beginShutdown: begin,
      drainBeforeClose: () => original.promise,
    };
    const work = fixture.shutdown();
    fixture.watchPending.resolve();
    fixture.usagePending.resolve();
    await flush();
    expect(begin).toHaveBeenCalledOnce();
    expect(fixture.closed).not.toHaveBeenCalled();
    original.resolve();
    await work;
    expect(fixture.closed).toHaveBeenCalledTimes(6);
  });
});
