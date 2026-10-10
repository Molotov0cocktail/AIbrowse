import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { WindowsNotificationSink } from './windows-notification-lifecycle';

class NativeNotification extends EventEmitter {
  show = vi.fn();
  close = vi.fn(() => this.emit('close', { reason: 'applicationHidden' }));
}

const input = {
  subjectType: 'event' as const,
  subjectId: '00000000-0000-4000-8000-000000000001',
  title: 'AIbrowse 监控提醒',
  body: '监控来源发生变化',
  important: false,
};

function fixture(captureRouteGuard?: () => () => boolean) {
  const natives: NativeNotification[] = [];
  const route = vi.fn();
  const audit = vi.fn();
  const create = vi.fn(() => {
    const notification = new NativeNotification();
    natives.push(notification);
    return notification;
  });
  const sink = new WindowsNotificationSink({ create }, route, audit, captureRouteGuard);
  return { sink, natives, route, audit, create };
}

describe('Windows 原生通知生命周期', () => {
  it('提交成功不等于原生 show 回执', () => {
    const { sink, natives, audit } = fixture();
    expect(sink.show(input)).toBe(true);
    expect(audit).not.toHaveBeenCalled();
    natives[0]!.emit('show');
    expect(audit.mock.calls).toEqual([['shown']]);
  });

  it('原生失败后迟到 click 不得路由', () => {
    const { sink, natives, route, audit } = fixture();
    sink.show(input);
    natives[0]!.emit('failed', new Error('private native text'));
    natives[0]!.emit('click');
    expect(route).not.toHaveBeenCalled();
    expect(audit.mock.calls).toEqual([['failed']]);
  });

  it('至多保留 200 个原生通知，超限不创建新对象', () => {
    const { sink, create, audit } = fixture();
    for (let i = 0; i < 200; i += 1) expect(sink.show(input)).toBe(true);
    expect(sink.show(input)).toBe(false);
    expect(create).toHaveBeenCalledTimes(200);
    expect(audit.mock.calls).toEqual([['failed']]);
  });

  it('timedOut 后仍可从通知中心点击，重复回调仅路由一次', () => {
    const { sink, natives, route, audit } = fixture();
    sink.show(input);
    const native = natives[0]!;
    const click = native.listeners('click')[0]!;
    native.emit('show');
    native.emit('show');
    native.emit('close', { reason: 'timedOut' });
    native.emit('close', { reason: 'timedOut' });
    native.emit('click');
    click();
    native.emit('failed');
    expect(route.mock.calls).toEqual([[input.subjectType, input.subjectId]]);
    expect(audit.mock.calls).toEqual([['shown'], ['clicked']]);
  });

  it.each(['userCanceled', 'applicationHidden'])('超时后 %s 释放容量并拒绝旧点击', (reason) => {
    const { sink, natives, route, audit } = fixture();
    for (let i = 0; i < 200; i += 1) sink.show(input);
    const native = natives[0]!;
    const click = native.listeners('click')[0]!;
    native.emit('close', { reason: 'timedOut' });
    expect(sink.show(input)).toBe(false);
    native.emit('close', { reason });
    native.emit('close', { reason });
    click();
    expect(sink.show(input)).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(audit.mock.calls).toEqual([['failed']]);
  });

  it.each(['click', 'failed'])('%s 终态释放一次容量', (event) => {
    const { sink, natives } = fixture();
    for (let i = 0; i < 200; i += 1) sink.show(input);
    natives[0]!.emit(event);
    expect(sink.show(input)).toBe(true);
    expect(sink.show(input)).toBe(false);
  });

  it('dispose 先让全部回调失效，再关闭原生对象，且可重复调用', () => {
    const { sink, natives, route, audit, create } = fixture();
    sink.show(input);
    sink.show(input);
    const callbacks = natives.flatMap((native) =>
      ['show', 'click', 'failed', 'close'].flatMap((event) => native.listeners(event)),
    );
    natives[0]!.close.mockImplementation(() => {
      for (const callback of callbacks) callback({ reason: 'applicationHidden' });
      throw new Error('private close failure');
    });
    sink.dispose();
    sink.dispose();
    for (const callback of callbacks) callback({ reason: 'userCanceled' });
    expect(natives.map((native) => native.close.mock.calls.length)).toEqual([1, 1]);
    expect(natives.map((native) => native.eventNames())).toEqual([[], []]);
    expect(sink.show(input)).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
    expect(route).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('点击复核投递时的数据实体和当前维护准入', () => {
    let currentDataset = {};
    let admitted = true;
    const { sink, natives, route, audit } = fixture(() => {
      const dataset = currentDataset;
      return () => admitted && currentDataset === dataset;
    });
    sink.show(input);
    admitted = false;
    natives[0]!.emit('click');
    admitted = true;
    sink.show(input);
    currentDataset = {};
    natives[1]!.emit('click');
    expect(route).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('原生 show 抛出或同步 failed 不重复审计', () => {
    const native = new NativeNotification();
    native.show.mockImplementation(() => {
      native.emit('failed');
      throw new Error('private native show failure');
    });
    const audit = vi.fn();
    const sink = new WindowsNotificationSink({ create: () => native }, vi.fn(), audit);
    expect(sink.show(input)).toBe(false);
    native.emit('click');
    native.emit('show');
    expect(audit.mock.calls).toEqual([['failed']]);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('同步 failed 回执令本次提交返回 false', () => {
    const native = new NativeNotification();
    native.show.mockImplementation(() => native.emit('failed'));
    const audit = vi.fn();
    const sink = new WindowsNotificationSink({ create: () => native }, vi.fn(), audit);
    expect(sink.show(input)).toBe(false);
    expect(audit.mock.calls).toEqual([['failed']]);
  });

  it('route 抛错后仍只保留一个失败终态', () => {
    const { sink, natives, route, audit } = fixture();
    route.mockImplementation(() => {
      throw new Error('private route failure');
    });
    sink.show(input);
    natives[0]!.emit('click');
    natives[0]!.emit('failed');
    expect(route).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls).toEqual([['failed']]);
  });

  it('实际 main 接线捕获数据实体并在点击时检查维护与 Watch 准入', () => {
    const file = new URL('../index.ts', import.meta.url);
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let capture: ts.Expression | undefined;
    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === 'WindowsNotificationSink'
      ) {
        capture = node.arguments?.[3];
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!capture) throw new Error('原生通知缺少数据世代准入');
    let rootOpen = true;
    let watchOpen = true;
    const originalWatch = {};
    const originalSource = {};
    const context = vm.createContext({
      watchRepo: originalWatch,
      sourceService: originalSource,
      mainRootIsOpen: () => rootOpen,
      watchIpcAdmission: { isOpen: () => watchOpen },
    });
    const createGuard = vm.runInContext(
      ts.transpileModule(`(${capture.getText(source)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2023 },
      }).outputText,
      context,
    ) as () => () => boolean;
    const guard = createGuard();
    expect(guard()).toBe(true);
    context['watchRepo'] = {};
    expect(guard()).toBe(false);
    context['watchRepo'] = originalWatch;
    context['sourceService'] = {};
    expect(guard()).toBe(false);
    context['sourceService'] = originalSource;
    rootOpen = false;
    expect(guard()).toBe(false);
    rootOpen = true;
    watchOpen = false;
    expect(guard()).toBe(false);
    watchOpen = true;
    expect(guard()).toBe(true);
    context['watchRepo'] = null;
    expect(createGuard()()).toBe(false);
    context['watchRepo'] = originalWatch;
    context['sourceService'] = null;
    expect(createGuard()()).toBe(false);
  });

  it('实际 main 关门时先拒绝 Watch 准入，再清理原生通知且只清理一次', () => {
    const file = new URL('../index.ts', import.meta.url);
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'stopWatchIpcAdmission',
    );
    if (!declaration) throw new Error('Watch 关门入口缺失');
    const order: string[] = [];
    const dispose = vi.fn(() => order.push('dispose'));
    const context = vm.createContext({
      watchIpcAdmission: { beginShutdown: () => order.push('sealed') },
      watchWindowsSink: { dispose },
      watchSubscriptionDestroyedCleanup: null,
      watchSubscriptionSender: {},
      watchSubscriptionCurrent: () => true,
      pushWatchStatus: () => undefined,
    });
    vm.runInContext(
      ts.transpileModule(declaration.getText(source), {
        compilerOptions: { target: ts.ScriptTarget.ES2023 },
      }).outputText,
      context,
    );
    vm.runInContext('stopWatchIpcAdmission(); stopWatchIpcAdmission();', context);
    expect(order).toEqual(['sealed', 'dispose', 'sealed']);
    expect(context['watchWindowsSink']).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
