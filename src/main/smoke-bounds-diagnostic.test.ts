import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  BOUNDS_CHILD_VIEW_LIMIT,
  BOUNDS_DOM_SNAPSHOT_TIMEOUT_MS,
  BOUNDS_FAILURE_COLLECTOR_TIMEOUT_MS,
  BOUNDS_SAMPLE_LIMIT,
  MATRIX9_BOUNDS_WAIT_TIMEOUT_MS,
  classifyMatrix9BoundsFailure,
  collectMatrix9FailureSnapshot,
  createBoundsObservation,
  runMatrix9BoundsWait,
  sanitizeBounds,
  sanitizeDomFailureState,
  summarizeMatrix9BoundsEvidence,
  type BoundsExpectation,
  type BoundsIpcListener,
  type BoundsIpcSource,
  type BoundsObservationSnapshot,
  type BoundsRect,
  type Matrix9BoundsFailureEvidence,
  type Matrix9FailureSnapshot,
  type SafeBounds,
  type SafeNativeViewState,
  type TimerPort,
} from './smoke-bounds-diagnostic';

const EXPECTED: BoundsExpectation = {
  windowWidth: 1000,
  contentBounds: { width: { operator: 'eq', value: 620 } },
  aiPanelPresent: true,
};

const rect = (width: number, height = 600): BoundsRect => ({ x: 0, y: 70, width, height });

const safeBounds = (width: number, height = 600): SafeBounds => ({
  status: 'valid',
  value: rect(width, height),
});

const safeNative = (viewId: number, width: number, height = 600): SafeNativeViewState => ({
  viewId: { status: 'valid', value: viewId },
  bounds: safeBounds(width, height),
});

class FakeIpc implements BoundsIpcSource {
  readonly listeners = new Set<BoundsIpcListener>();
  onCount = 0;
  removeCount = 0;

  on(_channel: string, listener: BoundsIpcListener): void {
    this.onCount += 1;
    this.listeners.add(listener);
  }

  removeListener(_channel: string, listener: BoundsIpcListener): void {
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  emit(sender: unknown, payload: unknown): void {
    for (const listener of this.listeners) listener({ sender }, payload);
  }
}

function createStartedObservation(options?: {
  ipc?: FakeIpc;
  trustedSender?: object;
  sampleSelectedNative?: () => { viewId: unknown; bounds: unknown } | null;
  nowMono?: () => number;
}) {
  const ipc = options?.ipc ?? new FakeIpc();
  const trustedSender = options?.trustedSender ?? {};
  let mono = 10;
  const observation = createBoundsObservation({
    ipc,
    channel: 'ui:content-bounds',
    trustedSender,
    sampleSelectedNative:
      options?.sampleSelectedNative ?? (() => ({ viewId: 2, bounds: rect(620) })),
    nowMono: options?.nowMono ?? (() => ++mono),
    nowWall: () => 1_725_000_000_000,
  });
  observation.beginPhase({
    phase: 'panel-open',
    frozenWindowWidth: 1000,
    expected: EXPECTED,
  });
  return { ipc, trustedSender, observation };
}

function failureSnapshot(options?: {
  currentWindowWidth?: number;
  contentSizeStatus?: 'valid' | 'unavailable';
  domWidth?: number;
  domStatus?: 'valid' | 'timeout';
  selectedViewId?: number;
  selectedWidth?: number;
  childViews?: Matrix9FailureSnapshot['window']['childViews']['items'];
  childViewsTruncated?: boolean;
  finishedAt?: number;
}): Matrix9FailureSnapshot {
  const domStatus = options?.domStatus ?? 'valid';
  return {
    captureStartedAtMonoMs: 100,
    captureFinishedAtMonoMs: options?.finishedAt ?? 100,
    window: {
      status: 'valid',
      contentSize:
        options?.contentSizeStatus === 'unavailable'
          ? { status: 'unavailable', value: null }
          : {
              status: 'valid',
              value: { width: options?.currentWindowWidth ?? 1000, height: 700 },
            },
      visible: { status: 'valid', value: true },
      minimized: { status: 'valid', value: false },
      focused: { status: 'valid', value: true },
      selectedNative: safeNative(options?.selectedViewId ?? 1, options?.selectedWidth ?? 600),
      childViews: {
        status: 'valid',
        items: options?.childViews ?? [],
        totalCount: options?.childViews?.length ?? 0,
        truncated: options?.childViewsTruncated ?? false,
      },
    },
    dom:
      domStatus === 'valid'
        ? {
            status: 'valid',
            contentAreaCount: 1,
            contentBounds: safeBounds(options?.domWidth ?? 620),
            aiPanelCount: 1,
            visibilityState: 'visible',
            hasFocus: { status: 'valid', value: true },
          }
        : {
            status: 'timeout',
            contentAreaCount: null,
            contentBounds: { status: 'unavailable', value: null },
            aiPanelCount: null,
            visibilityState: 'unknown',
            hasFocus: { status: 'unavailable', value: null },
          },
  };
}

function observationSnapshot(options?: {
  native?: BoundsObservationSnapshot['nativeSamples']['items'];
  nativeTruncated?: boolean;
  ipc?: BoundsObservationSnapshot['ipcSamples']['items'];
  ipcTruncated?: boolean;
  listenerAttachStatus?: 'attached' | 'unavailable';
}): BoundsObservationSnapshot {
  const native = options?.native ?? [
    {
      phase: 'panel-open',
      monoObservedAtMs: 90,
      conditionMatched: false,
      ...safeNative(1, 600),
    },
  ];
  const ipc = options?.ipc ?? [];
  return {
    phaseEntry: {
      phase: 'panel-open',
      frozenWindowWidth: 1000,
      wallStartedAtMs: 1_725_000_000_000,
      monoStartedAtMs: 10,
      expected: EXPECTED,
    },
    nativeSamples: {
      items: native,
      totalCount: native.length + (options?.nativeTruncated ? 1 : 0),
      truncated: options?.nativeTruncated ?? false,
    },
    ipcSamples: {
      items: ipc,
      totalCount: ipc.length + (options?.ipcTruncated ? 1 : 0),
      truncated: options?.ipcTruncated ?? false,
    },
    listener: {
      attachStatus: options?.listenerAttachStatus ?? 'attached',
      detachStatus: 'detached',
      ignoredSenderCount: 0,
    },
  };
}

const ipcSample = (options?: {
  mono?: number;
  payloadWidth?: number;
  nativeViewId?: number;
  nativeWidth?: number;
}): BoundsObservationSnapshot['ipcSamples']['items'][number] => ({
  phase: 'panel-open',
  monoObservedAtMs: options?.mono ?? 90,
  payloadBounds: safeBounds(options?.payloadWidth ?? 620),
  selectedNative: safeNative(options?.nativeViewId ?? 1, options?.nativeWidth ?? 620),
});

function rawWindow(childCount = 1) {
  return {
    contentSize: [1000, 700],
    visible: true,
    minimized: false,
    focused: true,
    selectedNative: { viewId: 1, bounds: rect(600) },
    childViews: Array.from({ length: childCount }, (_, index) => ({
      kind: 'web-contents-view',
      viewId: index + 1,
      visible: index === 0,
      bounds: rect(600),
      ignored: 'PRIVATE_MARKER',
    })),
    childViewTotalCount: childCount,
  };
}

function rawDom() {
  return {
    contentAreaCount: 1,
    contentBounds: rect(620),
    aiPanelCount: 1,
    visibilityState: 'visible',
    hasFocus: false,
    ignored: 'PRIVATE_MARKER',
  };
}

describe('矩阵 9 bounds 失败观测', () => {
  it('沿用原 5000ms wait/failure，并在原 wait 失败后恰一次采集、记录且重抛同一 Error', async () => {
    const original = new Error('矩阵 9 原错误');
    const collectFailure = vi.fn(async () => failureSnapshot());
    const logFailure = vi.fn();
    const condition = vi.fn(async () => ({
      matched: false,
      sample: { viewId: 1, bounds: rect(600) },
    }));
    const waitFor = vi.fn(
      async (receivedCondition: () => Promise<boolean>, timeoutMs: number, failure: string) => {
        expect(await receivedCondition()).toBe(false);
        expect(timeoutMs).toBe(MATRIX9_BOUNDS_WAIT_TIMEOUT_MS);
        expect(failure).toBe('矩阵 9 原文');
        throw original;
      },
    );
    const { observation, ipc } = createStartedObservation();

    let caught: unknown;
    try {
      await runMatrix9BoundsWait({
        condition,
        failure: '矩阵 9 原文',
        observation,
        waitFor,
        collectFailure,
        logFailure,
        nowMono: () => 100,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(waitFor).toHaveBeenCalledTimes(1);
    expect(condition).toHaveBeenCalledTimes(1);
    expect(collectFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure.mock.calls[0]![0].code).toBe('BND-M9-FAILURE-EVIDENCE-V1');
    expect(logFailure.mock.calls[0]![0].observation.nativeSamples.items).toHaveLength(1);
    expect(logFailure.mock.calls[0]![0].observation.listener.detachStatus).toBe('detached');
    expect(ipc.listeners.size).toBe(0);
  });

  it('成功路径零 DOM/failure collector、零诊断日志，条件仍由原 wait 调用', async () => {
    const collectFailure = vi.fn(async () => failureSnapshot());
    const logFailure = vi.fn();
    const condition = vi.fn(async () => ({
      matched: true,
      sample: { viewId: 2, bounds: rect(620) },
    }));
    const waitFor = vi.fn(
      async (receivedCondition: () => Promise<boolean>, timeoutMs: number, failure: string) => {
        expect(await receivedCondition()).toBe(true);
        expect(timeoutMs).toBe(5000);
        expect(failure).toBe('原错误文案');
      },
    );
    const { observation, ipc } = createStartedObservation();

    await runMatrix9BoundsWait({
      condition,
      failure: '原错误文案',
      observation,
      waitFor,
      collectFailure,
      logFailure,
    });

    expect(collectFailure).not.toHaveBeenCalled();
    expect(logFailure).not.toHaveBeenCalled();
    expect(observation.snapshot().nativeSamples.items[0]?.conditionMatched).toBe(true);
    observation.dispose();
    observation.dispose();
    expect(ipc.removeCount).toBe(1);
    expect(ipc.listeners.size).toBe(0);
  });

  it('collector 或日志自身失败都不替换原 Error，且不回显敌手错误正文', async () => {
    const original = new Error('原 wait error');
    const logFailure = vi.fn((evidence: Matrix9BoundsFailureEvidence) => {
      void evidence;
      throw new Error('LOGGER_PRIVATE_MARKER');
    });
    const { observation } = createStartedObservation();
    const collectFailure = vi.fn(async () => {
      throw new Error('COLLECTOR_PRIVATE_MARKER');
    });

    await expect(
      runMatrix9BoundsWait({
        condition: async () => ({ matched: false, sample: null }),
        failure: '原错误文案',
        observation,
        waitFor: async () => {
          throw original;
        },
        collectFailure,
        logFailure,
        nowMono: () => 100,
      }),
    ).rejects.toBe(original);

    expect(collectFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(logFailure.mock.calls[0]![0]);
    expect(serialized).toContain('COLLECTOR_ERROR');
    expect(serialized).not.toContain('COLLECTOR_PRIVATE_MARKER');
    expect(serialized).not.toContain('LOGGER_PRIVATE_MARKER');
  });

  it('1000ms collector 上限使用可控 timer；迟到 reject 已消费且原错误身份不变', async () => {
    const callbacks: {
      timeout: (() => void) | null;
      rejectLate: ((error: Error) => void) | null;
    } = { timeout: null, rejectLate: null };
    let scheduledDelay = -1;
    const timers: TimerPort = {
      setTimeout(callback, delayMs) {
        callbacks.timeout = callback;
        scheduledDelay = delayMs;
        return 1;
      },
      clearTimeout: vi.fn(),
    };
    const collectFailure = vi.fn(
      () =>
        new Promise<Matrix9FailureSnapshot>((_resolve, reject) => {
          callbacks.rejectLate = reject;
        }),
    );
    const logFailure = vi.fn();
    const original = new Error('original');
    const { observation } = createStartedObservation();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = runMatrix9BoundsWait({
        condition: async () => ({ matched: false, sample: null }),
        failure: 'failure',
        observation,
        waitFor: async () => {
          throw original;
        },
        collectFailure,
        logFailure,
        nowMono: () => 100,
        timers,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(scheduledDelay).toBe(BOUNDS_FAILURE_COLLECTOR_TIMEOUT_MS);
      expect(callbacks.timeout).not.toBeNull();
      callbacks.timeout?.();
      await expect(pending).rejects.toBe(original);
      expect(logFailure.mock.calls[0]![0].collection).toEqual({
        status: 'unavailable',
        code: 'COLLECTOR_TIMEOUT',
      });
      callbacks.rejectLate?.(new Error('LATE_PRIVATE_MARKER'));
      await setImmediate();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('native 与 IPC ring 各固定 128 项，保留最新项并报告 total/truncated', () => {
    const { observation, ipc, trustedSender } = createStartedObservation();
    for (let index = 0; index < BOUNDS_SAMPLE_LIMIT + 3; index += 1) {
      observation.recordNative({ viewId: index, bounds: rect(600 + index) }, false);
      ipc.emit(trustedSender, rect(600 + index));
    }
    const snapshot = observation.snapshot();
    expect(snapshot.nativeSamples.items).toHaveLength(BOUNDS_SAMPLE_LIMIT);
    expect(snapshot.nativeSamples.totalCount).toBe(BOUNDS_SAMPLE_LIMIT + 3);
    expect(snapshot.nativeSamples.truncated).toBe(true);
    expect(snapshot.nativeSamples.items[0]?.viewId).toEqual({ status: 'valid', value: 3 });
    expect(snapshot.ipcSamples.items).toHaveLength(BOUNDS_SAMPLE_LIMIT);
    expect(snapshot.ipcSamples.totalCount).toBe(BOUNDS_SAMPLE_LIMIT + 3);
    expect(snapshot.ipcSamples.truncated).toBe(true);
  });

  it('IPC 仅接受精确主窗口 sender；非法/非 finite payload 只记 invalid 且不序列化原对象', () => {
    const ipc = new FakeIpc();
    const trustedSender = {};
    const { observation } = createStartedObservation({
      ipc,
      trustedSender,
      sampleSelectedNative: () => {
        throw new Error('NATIVE_PRIVATE_MARKER');
      },
    });
    ipc.emit({}, { x: 0, y: 0, width: 620, height: 600, secret: 'SENDER_PRIVATE_MARKER' });
    ipc.emit(trustedSender, {
      x: 0,
      y: 0,
      width: Number.POSITIVE_INFINITY,
      height: 600,
      secret: 'PAYLOAD_PRIVATE_MARKER',
    });
    const snapshot = observation.snapshot();
    expect(snapshot.listener.ignoredSenderCount).toBe(1);
    expect(snapshot.ipcSamples.items).toHaveLength(1);
    expect(snapshot.ipcSamples.items[0]?.payloadBounds.status).toBe('invalid');
    expect(snapshot.ipcSamples.items[0]?.selectedNative.bounds.status).toBe('unavailable');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('PRIVATE_MARKER');
  });

  it('observer attach 失败和回调异常均安全收口，不向 IPC 产品路径抛错', () => {
    const throwingIpc: BoundsIpcSource = {
      on() {
        throw new Error('attach');
      },
      removeListener() {
        throw new Error('detach');
      },
    };
    const observation = createBoundsObservation({
      ipc: throwingIpc,
      channel: 'ui:content-bounds',
      trustedSender: {},
      sampleSelectedNative: () => null,
    });
    expect(observation.snapshot().listener).toMatchObject({
      attachStatus: 'unavailable',
      detachStatus: 'unavailable',
    });
    expect(() => observation.dispose()).not.toThrow();
  });

  it('失败快照仅在调用时读 window/DOM；child views 上限 32，截断与总数可追溯', async () => {
    const readWindow = vi.fn(() => rawWindow(BOUNDS_CHILD_VIEW_LIMIT + 8));
    const readDom = vi.fn(async () => rawDom());
    expect(readWindow).not.toHaveBeenCalled();
    expect(readDom).not.toHaveBeenCalled();

    const snapshot = await collectMatrix9FailureSnapshot({
      readWindow,
      readDom,
      nowMono: () => 50,
    });

    expect(readWindow).toHaveBeenCalledTimes(1);
    expect(readDom).toHaveBeenCalledTimes(1);
    expect(snapshot.window.childViews.items).toHaveLength(BOUNDS_CHILD_VIEW_LIMIT);
    expect(snapshot.window.childViews.totalCount).toBe(BOUNDS_CHILD_VIEW_LIMIT + 8);
    expect(snapshot.window.childViews.truncated).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_MARKER');
  });

  it('DOM 单次读取固定 500ms 上限且 timer 完成后清理', async () => {
    const callbacks: { timeout: (() => void) | null } = { timeout: null };
    let scheduledDelay = -1;
    const clearTimeoutSpy = vi.fn();
    const timers: TimerPort = {
      setTimeout(callback, delayMs) {
        callbacks.timeout = callback;
        scheduledDelay = delayMs;
        return 2;
      },
      clearTimeout: clearTimeoutSpy,
    };
    const readDom = vi.fn(() => new Promise<unknown>(() => undefined));
    const pending = collectMatrix9FailureSnapshot({
      readWindow: () => rawWindow(),
      readDom,
      nowMono: () => 50,
      timers,
    });
    await Promise.resolve();
    expect(scheduledDelay).toBe(BOUNDS_DOM_SNAPSHOT_TIMEOUT_MS);
    expect(readDom).toHaveBeenCalledTimes(1);
    callbacks.timeout?.();
    const snapshot = await pending;
    expect(snapshot.dom.status).toBe('timeout');
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('DOM 白名单只保留 rect/count/visibility/focus，getter/non-finite 输入 fail closed', () => {
    const hostileBounds = {
      get x(): number {
        throw new Error('GETTER_PRIVATE_MARKER');
      },
      y: 0,
      width: 620,
      height: 600,
      innerText: 'DOM_PRIVATE_MARKER',
    };
    expect(sanitizeBounds(hostileBounds).status).toBe('invalid');
    expect(sanitizeBounds({ x: 0, y: 0, width: Number.NaN, height: 1 }).status).toBe('invalid');
    const dom = sanitizeDomFailureState({ ...rawDom(), contentBounds: hostileBounds });
    expect(dom.status).toBe('valid');
    expect(dom.contentBounds.status).toBe('invalid');
    expect(JSON.stringify(dom)).not.toContain('PRIVATE_MARKER');
  });

  it('单条日志投影在双 ring 满载时仍受 8 KiB 预算约束，并显式标记输出截断', () => {
    const { observation, ipc, trustedSender } = createStartedObservation();
    for (let index = 0; index < BOUNDS_SAMPLE_LIMIT + 1; index += 1) {
      observation.recordNative({ viewId: index, bounds: rect(600 + index) }, false);
      ipc.emit(trustedSender, rect(600 + index));
    }
    const evidence: Matrix9BoundsFailureEvidence = {
      code: 'BND-M9-FAILURE-EVIDENCE-V1',
      failureObservedAtMonoMs: 100,
      collection: { status: 'complete', code: 'COLLECTED' },
      observation: observation.snapshot(),
      failureSnapshot: failureSnapshot({
        childViews: Array.from({ length: BOUNDS_CHILD_VIEW_LIMIT }, (_, index) => ({
          kind: 'web-contents-view' as const,
          viewId: { status: 'valid' as const, value: index },
          visible: { status: 'valid' as const, value: index === 0 },
          bounds: safeBounds(600 + index),
        })),
        childViewsTruncated: true,
      }),
      classification: { layer: 'unknown', rootCauseEstablished: false },
    };
    const serialized = JSON.stringify(summarizeMatrix9BoundsEvidence(evidence));
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(8192);
    expect(serialized).toContain('"outputTruncated":true');
  });

  it('IPC listener 未 attach 时不把空 IPC ring 误判为 renderer 层', () => {
    const observation = createBoundsObservation({
      ipc: {
        on() {
          throw new Error('attach failed');
        },
        removeListener() {},
      },
      channel: 'ui:content-bounds',
      trustedSender: {},
      sampleSelectedNative: () => ({ viewId: 1, bounds: rect(600) }),
      nowMono: () => 90,
      nowWall: () => 1_725_000_000_000,
    });
    observation.beginPhase({
      phase: 'panel-open',
      frozenWindowWidth: 1000,
      expected: EXPECTED,
    });
    observation.recordNative({ viewId: 1, bounds: rect(600) }, false);

    expect(classifyMatrix9BoundsFailure(observation.snapshot(), failureSnapshot(), 100)).toEqual({
      layer: 'unknown',
      rootCauseEstablished: false,
    });
  });

  it('window contentSize 不可用时不暗认冻结宽度前提成立', () => {
    expect(
      classifyMatrix9BoundsFailure(
        observationSnapshot(),
        failureSnapshot({ contentSizeStatus: 'unavailable' }),
        100,
      ),
    ).toEqual({ layer: 'unknown', rootCauseEstablished: false });
  });

  it('只有无关 hidden Tab 的旧 bounds 匹配时不误判 view-selection', () => {
    expect(
      classifyMatrix9BoundsFailure(
        observationSnapshot({ ipc: [ipcSample({ nativeViewId: 2, nativeWidth: 620 })] }),
        failureSnapshot({
          selectedViewId: 1,
          selectedWidth: 600,
          childViews: [
            {
              kind: 'web-contents-view',
              viewId: { status: 'valid', value: 2 },
              visible: { status: 'valid', value: false },
              bounds: safeBounds(620),
            },
          ],
        }),
        100,
      ),
    ).toEqual({ layer: 'unknown', rootCauseEstablished: false });
  });

  it('failure 前后均已有匹配 IPC/native 时不误判 late-observation', () => {
    expect(
      classifyMatrix9BoundsFailure(
        observationSnapshot({ ipc: [ipcSample({ mono: 90 }), ipcSample({ mono: 101 })] }),
        failureSnapshot({ selectedWidth: 620, finishedAt: 101 }),
        100,
      ),
    ).toEqual({ layer: 'unknown', rootCauseEstablished: false });
  });

  it.each([
    [
      '非 WebContentsView',
      {
        kind: 'other' as const,
        viewId: { status: 'valid' as const, value: 2 },
        visible: { status: 'valid' as const, value: true },
        bounds: safeBounds(620),
      },
    ],
    [
      '缺失目标 id',
      {
        kind: 'web-contents-view' as const,
        viewId: { status: 'none' as const, value: null },
        visible: { status: 'valid' as const, value: true },
        bounds: safeBounds(620),
      },
    ],
  ])('%s 的巧合 bounds 不足以判定 view-selection', (_label, childView) => {
    expect(
      classifyMatrix9BoundsFailure(
        observationSnapshot({ ipc: [ipcSample({ nativeViewId: 2, nativeWidth: 620 })] }),
        failureSnapshot({ childViews: [childView] }),
        100,
      ),
    ).toEqual({ layer: 'unknown', rootCauseEstablished: false });
  });

  it('唯一可见 WebContentsView 与 on-time IPC 目标身份一致时保留 view-selection 正例', () => {
    expect(
      classifyMatrix9BoundsFailure(
        observationSnapshot({ ipc: [ipcSample({ nativeViewId: 2, nativeWidth: 620 })] }),
        failureSnapshot({
          childViews: [
            {
              kind: 'web-contents-view',
              viewId: { status: 'valid', value: 2 },
              visible: { status: 'valid', value: true },
              bounds: safeBounds(620),
            },
          ],
        }),
        100,
      ),
    ).toEqual({ layer: 'view-selection', rootCauseEstablished: false });
  });

  it.each([
    [
      'failure 前已匹配',
      observationSnapshot({ ipc: [ipcSample({ mono: 90 })] }),
      failureSnapshot({ selectedWidth: 620 }),
    ],
    [
      'IPC ring 截断',
      observationSnapshot({ ipc: [ipcSample({ mono: 101 })], ipcTruncated: true }),
      failureSnapshot({ selectedWidth: 620, finishedAt: 101 }),
    ],
    [
      'native ring 截断',
      observationSnapshot({ ipc: [ipcSample({ mono: 101 })], nativeTruncated: true }),
      failureSnapshot({ selectedWidth: 620, finishedAt: 101 }),
    ],
    [
      '失败前 native 已报告匹配',
      observationSnapshot({
        native: [
          {
            phase: 'panel-open',
            monoObservedAtMs: 90,
            conditionMatched: true,
            ...safeNative(1, 620),
          },
        ],
        ipc: [ipcSample({ mono: 101 })],
      }),
      failureSnapshot({ selectedWidth: 620, finishedAt: 101 }),
    ],
  ])('%s 时证据不能证明仅 failure 后匹配', (_label, observation, snapshot) => {
    expect(classifyMatrix9BoundsFailure(observation, snapshot, 100)).toEqual({
      layer: 'unknown',
      rootCauseEstablished: false,
    });
  });

  it.each([
    ['window-precondition', observationSnapshot(), failureSnapshot({ currentWindowWidth: 999 })],
    ['ui-layout', observationSnapshot(), failureSnapshot({ domWidth: 619 })],
    ['renderer-measurement-schedule-send', observationSnapshot(), failureSnapshot()],
    [
      'main-apply',
      observationSnapshot({ ipc: [ipcSample({ nativeWidth: 600 })] }),
      failureSnapshot(),
    ],
    [
      'view-selection',
      observationSnapshot({ ipc: [ipcSample({ nativeViewId: 2, nativeWidth: 620 })] }),
      failureSnapshot({
        selectedViewId: 1,
        selectedWidth: 600,
        childViews: [
          {
            kind: 'web-contents-view',
            viewId: { status: 'valid', value: 2 },
            visible: { status: 'valid', value: true },
            bounds: safeBounds(620),
          },
        ],
      }),
    ],
    [
      'late-observation',
      observationSnapshot({ ipc: [ipcSample({ mono: 101 })] }),
      failureSnapshot({ selectedWidth: 620, finishedAt: 101 }),
    ],
    ['unknown', observationSnapshot(), failureSnapshot({ domStatus: 'timeout' })],
    [
      'unknown',
      observationSnapshot({ ipcTruncated: true }),
      failureSnapshot({ childViewsTruncated: true }),
    ],
  ] as const)('分层结果 %s 只标记待查层且永不宣称根因', (layer, observation, snapshot) => {
    expect(classifyMatrix9BoundsFailure(observation, snapshot, 100)).toEqual({
      layer,
      rootCauseEstablished: false,
    });
  });
});
