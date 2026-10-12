import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { browserPageForLibrary } from '../../src/main/browser-library-ipc';
import { openBrowserLibraryStore } from '../../src/main/browser-library/browser-library-store';
import type { BrowserLibraryService } from '../../src/main/browser-library/browser-library-service';
import { MaintenanceAdmission } from '../../src/main/storage/maintenance-admission';
import { MaintenanceCoordinator } from '../../src/main/storage/maintenance-coordinator';

const source = ts.createSourceFile(
  'index.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const services: BrowserLibraryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function find(predicate: (node: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new Error('独立接线检查必须精确匹配一个生产节点');
  return found[0]!;
}

function declaration(name: string): string {
  return find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}

function callback(name: string): string {
  const constructor = find(
    (node) =>
      ts.isNewExpression(node) && node.expression.getText(source) === 'BrowserControllerImpl',
  );
  if (!ts.isNewExpression(constructor)) throw new Error('浏览器生产构造器缺失');
  const options = constructor.arguments?.[0];
  if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('浏览器选项缺失');
  const property = options.properties.find((item) => item.name?.getText(source) === name);
  if (!property || !ts.isPropertyAssignment(property)) throw new Error('生产导航回调缺失');
  return `const ${name} = ${property.initializer.getText(source)};`;
}

function install(context: vm.Context, code: string): void {
  vm.runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
}

function library(): BrowserLibraryService {
  const root = mkdtempSync(join(tmpdir(), 'browser-library-main-review-'));
  const store = openBrowserLibraryStore({ dbPath: join(root, 'browser.db') });
  if (store.mode !== 'normal') throw new Error(store.reason);
  services.push(store.service);
  return store.service;
}

function startup(version: 1 | 2, openFails = false) {
  const order: string[] = [];
  let checking = true;
  let committed = false;
  const service = library();
  const complete = vi.fn(async (healthy: () => boolean) => {
    expect(healthy()).toBe(true);
    order.push('commit');
    committed = true;
    checking = false;
    return true;
  });
  const fail = vi.fn(async () => (committed ? 'recovery-required' : 'old-restored'));
  const watchRelease = vi.fn(() => {
    order.push('watch-release');
    return true;
  });
  const digestRelease = vi.fn(() => {
    order.push('digest-release');
    return true;
  });
  const stop = vi.fn();
  const recover = vi.fn();
  const open = vi.fn(() => {
    expect(checking).toBe(false);
    expect(committed).toBe(true);
    order.push('library-open');
    return openFails ? { mode: 'unavailable', service: null } : { mode: 'normal', service };
  });
  const context = vm.createContext({
    join,
    setTimeout: (resolve: () => void) => queueMicrotask(resolve),
    MIN_HOST_REQUEST_GAP_MS: 0,
    mainRootAdmission: new MaintenanceAdmission(),
    runtimeShutdown: null,
    dataAdmissionOpen: false,
    startupAssemblyFailed: false,
    startupAdmissionFailed: false,
    lifecycleGuardian: {},
    runtimeMaintenance: null,
    browserLibraryService: version === 2 ? service : null,
    sourceService: { getState: () => ({ mode: 'normal' }) },
    researchStoreReady: true,
    researchMaintenance: {},
    watchCoordinator: { getState: () => ({ mode: 'normal' }) },
    watchRunCoordinator: { getState: () => ({ mode: 'running' }) },
    watchScheduler: { releaseStartup: watchRelease },
    digestScheduler: { releaseStartup: digestRelease },
    conversationService: { getStorageStatus: () => ({ state: 'ready' }) },
    finalizeStartupWatch: async () => {
      order.push('watch-prepare');
      return true;
    },
    datasetStartup: {
      isChecking: () => checking,
      includesDomain: () => version === 2,
      complete,
      fail,
    },
    requireNodeDataRoot: () => 'D:/synthetic-no-io',
    openBrowserLibraryStore: open,
    assembleVerifiedTransferBrowserLibraryStore: () => {
      throw new Error('旧清单不能借用新库健康句柄');
    },
    stopStartupSchedulers: stop,
    installPartialRecovery: recover,
  });
  const captured: BrowserLibraryService[] = [];
  context.prepareMaintenance = () => {
    const current = context.browserLibraryService as BrowserLibraryService | null;
    if (!current) throw new Error('维护装配必须捕获实际新库服务');
    captured.push(current);
    context.runtimeMaintenance = {};
    order.push('maintenance');
  };
  install(
    context,
    ['startupGraphReady', 'openBrowserLibraryForStartup', 'finalizeStartupDataGraph']
      .map(declaration)
      .join('\n'),
  );
  return {
    context,
    service,
    order,
    captured,
    complete,
    fail,
    open,
    stop,
    recover,
    watchRelease,
    digestRelease,
    run: () =>
      vm.runInContext('finalizeStartupDataGraph(prepareMaintenance)', context) as Promise<boolean>,
  };
}

it('旧v1先提交原健康图，再打开资料库并捕获维护服务，最后共同开放调度', async () => {
  const f = startup(1);
  expect(await f.run()).toBe(true);
  expect(f.order).toEqual([
    'watch-prepare',
    'commit',
    'library-open',
    'maintenance',
    'watch-release',
    'digest-release',
  ]);
  expect(f.captured).toEqual([f.service]);
  expect(f.context.dataAdmissionOpen).toBe(true);
  expect(f.fail).not.toHaveBeenCalled();
});

it('旧v1已提交后新资料库打开失败仍关闭总准入和两调度器，进入恢复入口', async () => {
  const f = startup(1, true);
  expect(await f.run()).toBe(false);
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.context.dataAdmissionOpen).toBe(false);
  expect(f.context.runtimeMaintenance).toBeNull();
  expect(f.captured).toEqual([]);
  expect(f.watchRelease).not.toHaveBeenCalled();
  expect(f.digestRelease).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.recover).toHaveBeenCalledOnce();
});

it('新v2只有第四库已装配时才提交健康图，不能走旧库延后打开分支', async () => {
  const f = startup(2);
  expect(await f.run()).toBe(true);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.order).toEqual([
    'watch-prepare',
    'commit',
    'maintenance',
    'watch-release',
    'digest-release',
  ]);
  expect(f.captured).toEqual([f.service]);
  const missing = startup(2);
  missing.context.browserLibraryService = null;
  expect(await missing.run()).toBe(false);
  expect(missing.complete).not.toHaveBeenCalled();
  expect(missing.watchRelease).not.toHaveBeenCalled();
  expect(missing.digestRelease).not.toHaveBeenCalled();
  expect(missing.context.dataAdmissionOpen).toBe(false);
});

it('健康确认期间退出封门不打开新资料库，也不释放调度或总准入', async () => {
  const f = startup(1);
  f.complete.mockImplementationOnce(async () => {
    (f.context.mainRootAdmission as MaintenanceAdmission).beginShutdown();
    return false;
  });
  expect(await f.run()).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.watchRelease).not.toHaveBeenCalled();
  expect(f.digestRelease).not.toHaveBeenCalled();
  expect(f.context.dataAdmissionOpen).toBe(false);
});

it('生产导航与标题回调受实际维护屏障和退出封门保护，清除后不会复活记录', async () => {
  const service = library();
  const root = new MaintenanceAdmission();
  const maintenance = new MaintenanceCoordinator([service, root], async () => {});
  const context = vm.createContext({
    mainRootAdmission: root,
    dataAdmissionOpen: true,
    runtimeMaintenance: maintenance,
    browserLibraryService: service,
    browserPageForLibrary,
    input: { url: 'https://example.com/path?private=local#fragment', title: '初始标题' },
  });
  install(
    context,
    [
      declaration('mainRootIsOpen'),
      callback('onNavigationCommitted'),
      callback('onVisitTitleChanged'),
    ].join('\n'),
  );
  const commit = () => vm.runInContext('onNavigationCommitted(input)', context) as string | null;
  const update = (id: string, title: string) => {
    context.visit = { ...(context.input as { url: string; title: string }), id, title };
    vm.runInContext('onVisitTitleChanged(visit)', context);
  };
  const rows = () => {
    const result = service.listHistory({ query: '', cursor: null, limit: 100 });
    if (!result.ok) throw new Error(result.message);
    return result.value.items;
  };
  const id = commit();
  expect(id).not.toBeNull();
  update(id!, '已更新');
  expect(rows()[0]?.title).toBe('已更新');
  const ticket = await maintenance.acquire(performance.now() + 1000);
  expect(ticket.ok).toBe(true);
  expect(commit()).toBeNull();
  update(id!, '维护期间不得写');
  if (!ticket.ok) throw new Error('维护屏障失败');
  expect(maintenance.resume(ticket.ticket)).toBe(true);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.title).toBe('已更新');
  expect(service.clearHistory()).toEqual({ ok: true, value: true });
  update(id!, '清除后迟到');
  expect(rows()).toEqual([]);
  const newId = commit();
  expect(newId).not.toBeNull();
  root.beginShutdown();
  expect(commit()).toBeNull();
  update(newId!, '退出后不得写');
  await root.drain();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.title).toBe('初始标题');
});
