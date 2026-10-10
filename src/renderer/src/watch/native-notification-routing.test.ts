import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { validateWatchIpcOutput } from '../../../shared/watch/watch-ipc-validator';

const eventId = '00000000-0000-4000-8000-000000000001';
const digestId = '00000000-0000-4000-8000-000000000002';

function readSource(relative: string): ts.SourceFile {
  const file = new URL(relative, import.meta.url);
  return ts.createSourceFile(
    file.pathname,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function findNode(source: ts.SourceFile, match: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (match(node)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result) throw new Error('实际通知接线节点缺失');
  return result;
}

function evaluate<T>(text: string, context: vm.Context): T {
  return vm.runInContext(
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  ) as T;
}

describe('原生用户点击与被动 Watch 提醒分流', () => {
  it.each(['event', 'digest'])('闭合输出接受内部 %s activation', (subjectType) => {
    expect(
      validateWatchIpcOutput({ type: 'activation', revision: 1, subjectType, subjectId: eventId }),
    ).toBe(true);
  });

  it.each([
    { subjectId: 'https://private.invalid' },
    { subjectType: 'rule' },
    { body: '私密正文' },
    { path: 'C:/private' },
    { revision: -1 },
    { extra: true },
  ])('主动 push 拒绝额外字段或错误身份：%s', (delta) => {
    expect(
      validateWatchIpcOutput({
        type: 'activation',
        revision: 1,
        subjectType: 'event',
        subjectId: eventId,
        ...delta,
      }),
    ).toBe(false);
  });

  it.each([
    ['browser', 'event', eventId],
    ['watch', 'event', eventId],
    ['browser', 'digest', digestId],
    ['watch', 'digest', digestId],
  ])('实际 App 在 %s 视图一次点击定位 %s', (view, subjectType, subjectId) => {
    const source = readSource('../App.tsx');
    const subscribe = findNode(
      source,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'window.aibrowse.watch.subscribe',
    ) as ts.CallExpression;
    const setWatchFocus = vi.fn();
    const setViewMode = vi.fn();
    const setWatchNotice = vi.fn();
    const context = vm.createContext({
      viewModeRef: { current: view },
      setWatchFocus,
      setViewMode,
      setWatchNotice,
      setWatchSourceId: vi.fn(),
      setSidePanel: vi.fn(),
      setWatchUnreadCount: vi.fn(),
    });
    const receive = evaluate<(push: unknown) => void>(
      `(${subscribe.arguments[0]!.getText(source)})`,
      context,
    );
    receive({ type: 'activation', revision: 1, subjectType, subjectId });
    expect(setWatchFocus).toHaveBeenCalledExactlyOnceWith({ type: subjectType, id: subjectId });
    expect(setViewMode).toHaveBeenCalledExactlyOnceWith('watch');
    expect(setWatchNotice).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each(['browser', 'watch'])('实际 App 的 %s 被动提醒不抢焦点', (view) => {
    const source = readSource('../App.tsx');
    const subscribe = findNode(
      source,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'window.aibrowse.watch.subscribe',
    ) as ts.CallExpression;
    const setWatchFocus = vi.fn();
    const setViewMode = vi.fn();
    const setWatchNotice = vi.fn();
    const receive = evaluate<(push: unknown) => void>(
      `(${subscribe.arguments[0]!.getText(source)})`,
      vm.createContext({
        viewModeRef: { current: view },
        setWatchFocus,
        setViewMode,
        setWatchNotice,
        setWatchSourceId: vi.fn(),
        setSidePanel: vi.fn(),
        setWatchUnreadCount: vi.fn(),
      }),
    );
    const notification = { subjectType: 'event', subjectId: eventId, body: '受保护来源发生变化' };
    receive({ type: 'notification', revision: 1, notification });
    expect(setWatchFocus).not.toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
    expect(setWatchNotice.mock.calls).toEqual(view === 'browser' ? [[notification]] : []);
  });

  it('实际 Workspace 对 activation 不读取普通 notification 正文', () => {
    const source = readSource('./WatchWorkspace.tsx');
    const subscribe = findNode(
      source,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'window.aibrowse.watch.subscribe',
    ) as ts.CallExpression;
    const setMessage = vi.fn();
    const receive = evaluate<(push: unknown) => void>(
      `(${subscribe.arguments[0]!.getText(source)})`,
      vm.createContext({ dispatch: vi.fn(), setStatus: vi.fn(), setMessage }),
    );
    receive({ type: 'activation', revision: 1, subjectType: 'event', subjectId: eventId });
    expect(setMessage).not.toHaveBeenCalled();
  });

  it.each(['event', 'digest'])(
    '实际 Workspace 的迟到旧 digest 不能覆盖新的 %s 目标',
    async (type) => {
      const source = readSource('./WatchWorkspace.tsx');
      const effect = findNode(
        source,
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'useEffect' &&
          node.arguments[1]?.getText(source) === '[focusSubject]',
      ) as ts.CallExpression;
      const requests: Array<(value: unknown) => void> = [];
      const getDigest = vi.fn(() => new Promise((resolve) => requests.push(resolve)));
      const setDigestDetail = vi.fn();
      const firstFocus = { type: 'digest', id: eventId };
      const focusSubjectRef = { current: firstFocus };
      const context = vm.createContext({
        focusSubject: firstFocus,
        focusSubjectRef,
        eventRequestVersion: { current: 0 },
        digestRequestVersion: { current: 0 },
        dispatch: vi.fn(),
        setDigestDetail,
        setEventDetail: vi.fn(),
        setWizardOpen: vi.fn(),
        setMessage: vi.fn(),
        isObject: (value: unknown) => typeof value === 'object' && value !== null,
        window: { aibrowse: { watch: { getDigest } } },
      });
      let loader: ts.VariableDeclaration | undefined;
      function visit(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'loadDigest')
          loader = node;
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (loader) evaluate(`const ${loader.getText(source)};`, context);
      const runEffect = evaluate<() => void | (() => void)>(
        `(${effect.arguments[0]!.getText(source)})`,
        context,
      );
      const cleanup = runEffect();
      if (typeof cleanup === 'function') cleanup();
      context['focusSubject'] = { type, id: digestId };
      focusSubjectRef.current = context['focusSubject'];
      runEffect();
      if (type === 'digest') {
        requests[1]!({ ok: true, value: { id: digestId } });
        await Promise.resolve();
      }
      requests[0]!({ ok: true, value: { id: eventId } });
      await Promise.resolve();
      expect(setDigestDetail.mock.calls.filter(([value]) => value !== null)).toEqual(
        type === 'digest' ? [[{ id: digestId }]] : [],
      );
    },
  );

  it('实际 Workspace 的迟到旧 event 不能覆盖新的目标，未命中清空旧详情', async () => {
    const source = readSource('./WatchWorkspace.tsx');
    const loader = findNode(
      source,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'loadEvents',
    ) as ts.VariableDeclaration;
    const requests: Array<(value: unknown) => void> = [];
    const listEvents = vi.fn(() => new Promise((resolve) => requests.push(resolve)));
    const setEventDetail = vi.fn();
    const focusSubjectRef = { current: { type: 'event', id: eventId } };
    const loadEvents = evaluate<(id: string) => void>(
      `(${loader.initializer!.getText(source)})`,
      vm.createContext({
        eventFilter: {},
        focusSubjectRef,
        eventRequestVersion: { current: 0 },
        setEvents: vi.fn(),
        setEventDetail,
        isObject: (value: unknown) => typeof value === 'object' && value !== null,
        window: { aibrowse: { watch: { listEvents } } },
      }),
    );
    loadEvents(eventId);
    focusSubjectRef.current = { type: 'event', id: digestId };
    loadEvents(digestId);
    requests[1]!({ ok: true, value: { items: [], selected: { id: digestId } } });
    await Promise.resolve();
    requests[0]!({ ok: true, value: { items: [], selected: { id: eventId } } });
    await Promise.resolve();
    expect(setEventDetail.mock.calls.filter(([value]) => value !== null)).toEqual([
      [{ id: digestId }],
    ]);
    loadEvents(digestId);
    requests[2]!({ ok: true, value: { items: [], selected: null } });
    await Promise.resolve();
    expect(setEventDetail).toHaveBeenLastCalledWith(null);
    loadEvents(digestId);
    focusSubjectRef.current = { type: 'digest', id: eventId };
    requests[3]!({ ok: true, value: { items: [], selected: { id: digestId } } });
    await Promise.resolve();
    expect(setEventDetail).toHaveBeenLastCalledWith(null);
  });

  it.each([
    [true, true, true, eventId, ['restore', 'show', 'focus', 'send']],
    [false, true, true, digestId, ['show', 'focus', 'send']],
    [true, false, true, eventId, []],
    [true, true, false, eventId, []],
    [true, true, true, 'https://private.invalid', []],
  ] as const)(
    '实际 main 原生点击只恢复可信当前主窗并发送内部 activation：%s',
    (minimized, rootOpen, watchOpen, id, expected) => {
      const source = readSource('../../../main/index.ts');
      const constructor = findNode(
        source,
        (node) =>
          ts.isNewExpression(node) && node.expression.getText(source) === 'WindowsNotificationSink',
      ) as ts.NewExpression;
      const order: string[] = [];
      const payloads: unknown[] = [];
      const route = evaluate<(type: 'event' | 'digest', id: string) => void>(
        `(${constructor.arguments![1]!.getText(source)})`,
        vm.createContext({
          runMainBackground: (work: () => void) => work(),
          mainRootIsOpen: () => rootOpen,
          watchIpcAdmission: { isOpen: () => watchOpen },
          mainWindow: {
            isDestroyed: () => false,
            isMinimized: () => minimized,
            restore: () => order.push('restore'),
            show: () => order.push('show'),
            focus: () => order.push('focus'),
          },
          currentWatchSender: () => ({
            send: (_channel: string, push: unknown) => {
              order.push('send');
              payloads.push(JSON.parse(JSON.stringify(push)));
            },
          }),
          watchRevision: 0,
          IPC: { WatchSubscribe: 'watch:subscribe' },
          validateWatchIpcOutput: (value: unknown) =>
            validateWatchIpcOutput(JSON.parse(JSON.stringify(value))),
        }),
      );
      route('event', id);
      expect(order).toEqual(expected);
      expect(payloads).toEqual(
        expected.length === 0
          ? []
          : [{ type: 'activation', revision: 1, subjectType: 'event', subjectId: id }],
      );
    },
  );

  it('实际 preload 只把授权文档收到的闭合 activation 交给订阅者', () => {
    const source = readSource('../../../preload/index.ts');
    const declaration = findNode(
      source,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'receiveWatchPush',
    ) as ts.VariableDeclaration;
    const listener = vi.fn();
    let authorized = false;
    const receive = evaluate<(event: null, payload: unknown) => void>(
      `(${declaration.initializer!.getText(source)})`,
      vm.createContext({
        documentAuthorization: { isAuthorized: () => authorized },
        validateWatchIpcOutput,
        watchListeners: new Set([listener]),
      }),
    );
    const push = { type: 'activation', revision: 1, subjectType: 'digest', subjectId: digestId };
    receive(null, push);
    expect(listener).not.toHaveBeenCalled();
    authorized = true;
    receive(null, { ...push, body: 'private' });
    receive(null, { ...push, subjectId: 'invalid' });
    expect(listener).not.toHaveBeenCalled();
    receive(null, push);
    expect(listener).toHaveBeenCalledExactlyOnceWith(push);
  });
});
