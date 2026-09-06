// AI UI matrix 9 bounds failure observation helpers. This module stays free of
// Electron imports so timeout, cleanup, and privacy behavior can be verified
// without starting the desktop shell.

export const MATRIX9_BOUNDS_WAIT_TIMEOUT_MS = 5000;
export const BOUNDS_FAILURE_COLLECTOR_TIMEOUT_MS = 1000;
export const BOUNDS_DOM_SNAPSHOT_TIMEOUT_MS = 500;
export const BOUNDS_SAMPLE_LIMIT = 128;
export const BOUNDS_CHILD_VIEW_LIMIT = 32;
const BOUNDS_LOG_NATIVE_SAMPLE_LIMIT = 48;
const BOUNDS_LOG_IPC_SAMPLE_LIMIT = 16;

export type BoundsDiagnosticPhase =
  | 'precondition'
  | 'panel-open'
  | 'panel-close'
  | 'panel-reopen'
  | 'debug-collapse'
  | 'debug-expand'
  | 'tab-switch'
  | 'window-resize'
  | 'window-restore';

export interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DimensionExpectation {
  operator: 'eq' | 'neq';
  value: number;
}

export interface BoundsExpectation {
  windowWidth: number;
  contentBounds: {
    width?: DimensionExpectation;
    height?: DimensionExpectation;
  };
  aiPanelPresent: boolean;
}

export interface BoundsPhaseEntry {
  phase: BoundsDiagnosticPhase;
  frozenWindowWidth: number;
  wallStartedAtMs: number;
  monoStartedAtMs: number;
  expected: BoundsExpectation;
}

export type SafeId =
  | { status: 'valid'; value: number }
  | { status: 'none'; value: null }
  | { status: 'invalid'; value: null }
  | { status: 'unavailable'; value: null };

export type SafeBounds =
  | { status: 'valid'; value: BoundsRect }
  | { status: 'none'; value: null }
  | { status: 'invalid'; value: null }
  | { status: 'unavailable'; value: null };

export type SafeBoolean =
  | { status: 'valid'; value: boolean }
  | { status: 'invalid'; value: null }
  | { status: 'unavailable'; value: null };

export interface RawNativeViewState {
  viewId: unknown;
  bounds: unknown;
}

export interface SafeNativeViewState {
  viewId: SafeId;
  bounds: SafeBounds;
}

export interface BoundsNativeSample extends SafeNativeViewState {
  phase: BoundsDiagnosticPhase;
  monoObservedAtMs: number;
  conditionMatched: boolean;
}

export interface BoundsIpcSample {
  phase: BoundsDiagnosticPhase;
  monoObservedAtMs: number;
  payloadBounds: SafeBounds;
  selectedNative: SafeNativeViewState;
}

export interface BoundsRingSnapshot<T> {
  items: readonly T[];
  totalCount: number;
  truncated: boolean;
}

export interface RawChildViewState extends RawNativeViewState {
  kind: unknown;
  visible: unknown;
}

export interface SafeChildViewState extends SafeNativeViewState {
  kind: 'web-contents-view' | 'other' | 'unavailable';
  visible: SafeBoolean;
}

export interface RawWindowFailureState {
  contentSize: unknown;
  visible: unknown;
  minimized: unknown;
  focused: unknown;
  selectedNative: RawNativeViewState | null;
  childViews: readonly RawChildViewState[];
  childViewTotalCount: unknown;
}

export interface SafeWindowFailureState {
  status: 'valid' | 'unavailable';
  contentSize:
    | { status: 'valid'; value: { width: number; height: number } }
    | { status: 'invalid'; value: null }
    | { status: 'unavailable'; value: null };
  visible: SafeBoolean;
  minimized: SafeBoolean;
  focused: SafeBoolean;
  selectedNative: SafeNativeViewState;
  childViews: {
    status: 'valid' | 'unavailable';
    items: readonly SafeChildViewState[];
    totalCount: number;
    truncated: boolean;
  };
}

export interface SafeDomFailureState {
  status: 'valid' | 'invalid' | 'timeout' | 'unavailable';
  contentAreaCount: number | null;
  contentBounds: SafeBounds;
  aiPanelCount: number | null;
  visibilityState: 'visible' | 'hidden' | 'prerender' | 'unknown';
  hasFocus: SafeBoolean;
}

export interface Matrix9FailureSnapshot {
  captureStartedAtMonoMs: number;
  captureFinishedAtMonoMs: number;
  window: SafeWindowFailureState;
  dom: SafeDomFailureState;
}

export interface BoundsObservationSnapshot {
  phaseEntry: BoundsPhaseEntry | null;
  nativeSamples: BoundsRingSnapshot<BoundsNativeSample>;
  ipcSamples: BoundsRingSnapshot<BoundsIpcSample>;
  listener: {
    attachStatus: 'attached' | 'unavailable';
    detachStatus: 'pending' | 'detached' | 'unavailable';
    ignoredSenderCount: number;
  };
}

export type BoundsFailureLayer =
  | 'window-precondition'
  | 'ui-layout'
  | 'renderer-measurement-schedule-send'
  | 'main-apply'
  | 'view-selection'
  | 'late-observation'
  | 'unknown';

export interface BoundsFailureClassification {
  layer: BoundsFailureLayer;
  rootCauseEstablished: false;
}

export interface Matrix9BoundsFailureEvidence {
  code: 'BND-M9-FAILURE-EVIDENCE-V1';
  failureObservedAtMonoMs: number;
  collection:
    | { status: 'complete'; code: 'COLLECTED' }
    | { status: 'unavailable'; code: 'COLLECTOR_TIMEOUT' | 'COLLECTOR_ERROR' };
  observation: BoundsObservationSnapshot;
  failureSnapshot: Matrix9FailureSnapshot | null;
  classification: BoundsFailureClassification;
}

export interface BoundsIpcEventLike {
  readonly sender?: unknown;
}

export type BoundsIpcListener = (event: BoundsIpcEventLike, payload: unknown) => void;

export interface BoundsIpcSource {
  on(channel: string, listener: BoundsIpcListener): unknown;
  removeListener(channel: string, listener: BoundsIpcListener): unknown;
}

export interface TimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BoundsObservation {
  beginPhase(entry: Omit<BoundsPhaseEntry, 'wallStartedAtMs' | 'monoStartedAtMs'>): void;
  recordNative(sample: RawNativeViewState | null, conditionMatched: boolean): void;
  snapshot(): BoundsObservationSnapshot;
  dispose(): void;
}

export interface CreateBoundsObservationOptions {
  ipc: BoundsIpcSource;
  channel: string;
  trustedSender: unknown;
  sampleSelectedNative: () => RawNativeViewState | null;
  nowMono?: () => number;
  nowWall?: () => number;
}

export interface CollectMatrix9FailureSnapshotOptions {
  readWindow: () => RawWindowFailureState;
  readDom: () => Promise<unknown>;
  nowMono?: () => number;
  timers?: TimerPort;
}

export interface Matrix9BoundsWaitOptions {
  condition: () => Promise<{ matched: boolean; sample: RawNativeViewState | null }>;
  failure: string;
  observation: BoundsObservation;
  waitFor: (condition: () => Promise<boolean>, timeoutMs: number, failure: string) => Promise<void>;
  collectFailure: () => Promise<Matrix9FailureSnapshot>;
  logFailure: (evidence: Matrix9BoundsFailureEvidence) => void;
  nowMono?: () => number;
  timers?: TimerPort;
}

type BoundedOutcome<T> =
  { status: 'value'; value: T } | { status: 'error' } | { status: 'timeout' };

const SYSTEM_TIMERS: TimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeNow(read: () => number): number {
  try {
    return finiteOrZero(read());
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeId(value: unknown, unavailable = false): SafeId {
  if (unavailable) return { status: 'unavailable', value: null };
  if (value === null || value === undefined) return { status: 'none', value: null };
  const id = safeInteger(value);
  return id === null ? { status: 'invalid', value: null } : { status: 'valid', value: id };
}

export function sanitizeBounds(value: unknown, unavailable = false): SafeBounds {
  if (unavailable) return { status: 'unavailable', value: null };
  if (value === null || value === undefined) return { status: 'none', value: null };
  if (!isRecord(value)) return { status: 'invalid', value: null };
  const x = safeProperty(value, 'x');
  const y = safeProperty(value, 'y');
  const width = safeProperty(value, 'width');
  const height = safeProperty(value, 'height');
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return { status: 'invalid', value: null };
  }
  return { status: 'valid', value: { x, y, width, height } };
}

function sanitizeBoolean(value: unknown, unavailable = false): SafeBoolean {
  if (unavailable) return { status: 'unavailable', value: null };
  return typeof value === 'boolean'
    ? { status: 'valid', value }
    : { status: 'invalid', value: null };
}

function unavailableNative(): SafeNativeViewState {
  return {
    viewId: { status: 'unavailable', value: null },
    bounds: { status: 'unavailable', value: null },
  };
}

function sanitizeNative(value: RawNativeViewState | null): SafeNativeViewState {
  if (value === null) {
    return {
      viewId: { status: 'none', value: null },
      bounds: { status: 'none', value: null },
    };
  }
  return {
    viewId: sanitizeId(value.viewId),
    bounds: sanitizeBounds(value.bounds),
  };
}

class FixedRing<T> {
  private readonly items: T[] = [];
  private totalCount = 0;

  push(value: T): void {
    this.totalCount += 1;
    if (this.items.length === BOUNDS_SAMPLE_LIMIT) this.items.shift();
    this.items.push(value);
  }

  clear(): void {
    this.items.length = 0;
    this.totalCount = 0;
  }

  snapshot(): BoundsRingSnapshot<T> {
    return {
      items: this.items.slice(),
      totalCount: this.totalCount,
      truncated: this.totalCount > this.items.length,
    };
  }
}

export async function settleWithin<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  timers: TimerPort = SYSTEM_TIMERS,
): Promise<BoundedOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown;

    const finish = (outcome: BoundedOutcome<T>): void => {
      if (settled) return;
      settled = true;
      try {
        timers.clearTimeout(timer);
      } catch {
        // Diagnostic cleanup must never replace the product smoke result.
      }
      resolve(outcome);
    };

    try {
      timer = timers.setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    } catch {
      resolve({ status: 'error' });
      return;
    }

    let task: Promise<T>;
    try {
      task = Promise.resolve().then(factory);
    } catch {
      finish({ status: 'error' });
      return;
    }
    // Supplying both handlers here also consumes a rejection that arrives after
    // the timeout won, so late diagnostic promises never become unhandled.
    task.then(
      (value) => finish({ status: 'value', value }),
      () => finish({ status: 'error' }),
    );
  });
}

export function createBoundsObservation(
  options: CreateBoundsObservationOptions,
): BoundsObservation {
  const nowMono = options.nowMono ?? (() => performance.now());
  const nowWall = options.nowWall ?? (() => Date.now());
  const nativeSamples = new FixedRing<BoundsNativeSample>();
  const ipcSamples = new FixedRing<BoundsIpcSample>();
  let phaseEntry: BoundsPhaseEntry | null = null;
  let disposed = false;
  let attachStatus: 'attached' | 'unavailable' = 'unavailable';
  let detachStatus: 'pending' | 'detached' | 'unavailable' = 'pending';
  let ignoredSenderCount = 0;

  const listener: BoundsIpcListener = (event, payload) => {
    try {
      if (event.sender !== options.trustedSender) {
        ignoredSenderCount += 1;
        return;
      }
      if (phaseEntry === null || disposed) return;
      let selectedNative: SafeNativeViewState;
      try {
        selectedNative = sanitizeNative(options.sampleSelectedNative());
      } catch {
        selectedNative = unavailableNative();
      }
      ipcSamples.push({
        phase: phaseEntry.phase,
        monoObservedAtMs: safeNow(nowMono),
        payloadBounds: sanitizeBounds(payload),
        selectedNative,
      });
    } catch {
      // Passive observation must never throw through Electron's IPC delivery.
    }
  };

  try {
    options.ipc.on(options.channel, listener);
    attachStatus = 'attached';
  } catch {
    attachStatus = 'unavailable';
    try {
      options.ipc.removeListener(options.channel, listener);
      detachStatus = 'detached';
    } catch {
      detachStatus = 'unavailable';
    }
  }

  return {
    beginPhase(entry): void {
      if (disposed) return;
      nativeSamples.clear();
      ipcSamples.clear();
      ignoredSenderCount = 0;
      phaseEntry = {
        phase: entry.phase,
        frozenWindowWidth: finiteOrZero(entry.frozenWindowWidth),
        wallStartedAtMs: safeNow(nowWall),
        monoStartedAtMs: safeNow(nowMono),
        expected: entry.expected,
      };
    },
    recordNative(sample, conditionMatched): void {
      if (phaseEntry === null || disposed) return;
      const safe = sanitizeNative(sample);
      nativeSamples.push({
        phase: phaseEntry.phase,
        monoObservedAtMs: safeNow(nowMono),
        conditionMatched: conditionMatched === true,
        ...safe,
      });
    },
    snapshot(): BoundsObservationSnapshot {
      return {
        phaseEntry,
        nativeSamples: nativeSamples.snapshot(),
        ipcSamples: ipcSamples.snapshot(),
        listener: { attachStatus, detachStatus, ignoredSenderCount },
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (attachStatus !== 'attached') {
        if (detachStatus === 'pending') detachStatus = 'detached';
        return;
      }
      try {
        options.ipc.removeListener(options.channel, listener);
        detachStatus = 'detached';
      } catch {
        detachStatus = 'unavailable';
      }
    },
  };
}

function sanitizeContentSize(value: unknown): SafeWindowFailureState['contentSize'] {
  if (!Array.isArray(value) || value.length < 2) return { status: 'invalid', value: null };
  const width = value[0];
  const height = value[1];
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return { status: 'invalid', value: null };
  }
  return { status: 'valid', value: { width, height } };
}

function sanitizeChildView(value: RawChildViewState): SafeChildViewState {
  const kind =
    value.kind === 'web-contents-view'
      ? 'web-contents-view'
      : value.kind === 'other'
        ? 'other'
        : 'unavailable';
  return {
    kind,
    viewId: sanitizeId(value.viewId, kind === 'unavailable'),
    visible: sanitizeBoolean(value.visible, kind === 'unavailable'),
    bounds: sanitizeBounds(value.bounds, kind === 'unavailable'),
  };
}

function unavailableWindow(): SafeWindowFailureState {
  return {
    status: 'unavailable',
    contentSize: { status: 'unavailable', value: null },
    visible: { status: 'unavailable', value: null },
    minimized: { status: 'unavailable', value: null },
    focused: { status: 'unavailable', value: null },
    selectedNative: unavailableNative(),
    childViews: { status: 'unavailable', items: [], totalCount: 0, truncated: false },
  };
}

function sanitizeWindow(value: RawWindowFailureState): SafeWindowFailureState {
  const totalCount = safeInteger(value.childViewTotalCount) ?? value.childViews.length;
  const limited = value.childViews.slice(0, BOUNDS_CHILD_VIEW_LIMIT).map(sanitizeChildView);
  return {
    status: 'valid',
    contentSize: sanitizeContentSize(value.contentSize),
    visible: sanitizeBoolean(value.visible),
    minimized: sanitizeBoolean(value.minimized),
    focused: sanitizeBoolean(value.focused),
    selectedNative: sanitizeNative(value.selectedNative),
    childViews: {
      status: 'valid',
      items: limited,
      totalCount,
      truncated: totalCount > limited.length,
    },
  };
}

function unavailableDom(status: SafeDomFailureState['status']): SafeDomFailureState {
  return {
    status,
    contentAreaCount: null,
    contentBounds: { status: 'unavailable', value: null },
    aiPanelCount: null,
    visibilityState: 'unknown',
    hasFocus: { status: 'unavailable', value: null },
  };
}

export function sanitizeDomFailureState(value: unknown): SafeDomFailureState {
  if (!isRecord(value)) return unavailableDom('invalid');
  const contentAreaCount = safeInteger(safeProperty(value, 'contentAreaCount'));
  const aiPanelCount = safeInteger(safeProperty(value, 'aiPanelCount'));
  const visibility = safeProperty(value, 'visibilityState');
  const visibilityState =
    visibility === 'visible' || visibility === 'hidden' || visibility === 'prerender'
      ? visibility
      : 'unknown';
  const contentBounds = sanitizeBounds(safeProperty(value, 'contentBounds'));
  const hasFocus = sanitizeBoolean(safeProperty(value, 'hasFocus'));
  if (contentAreaCount === null || aiPanelCount === null) return unavailableDom('invalid');
  return {
    status: 'valid',
    contentAreaCount,
    contentBounds,
    aiPanelCount,
    visibilityState,
    hasFocus,
  };
}

export async function collectMatrix9FailureSnapshot(
  options: CollectMatrix9FailureSnapshotOptions,
): Promise<Matrix9FailureSnapshot> {
  const nowMono = options.nowMono ?? (() => performance.now());
  const started = safeNow(nowMono);
  let windowState: SafeWindowFailureState;
  try {
    windowState = sanitizeWindow(options.readWindow());
  } catch {
    windowState = unavailableWindow();
  }

  const domOutcome = await settleWithin(
    options.readDom,
    BOUNDS_DOM_SNAPSHOT_TIMEOUT_MS,
    options.timers ?? SYSTEM_TIMERS,
  );
  const domState =
    domOutcome.status === 'value'
      ? sanitizeDomFailureState(domOutcome.value)
      : unavailableDom(domOutcome.status === 'timeout' ? 'timeout' : 'unavailable');
  return {
    captureStartedAtMonoMs: started,
    captureFinishedAtMonoMs: safeNow(nowMono),
    window: windowState,
    dom: domState,
  };
}

function dimensionMatches(actual: number, expected: DimensionExpectation | undefined): boolean {
  if (expected === undefined) return true;
  return expected.operator === 'eq' ? actual === expected.value : actual !== expected.value;
}

function boundsMatch(bounds: SafeBounds, expected: BoundsExpectation): boolean {
  if (bounds.status !== 'valid') return false;
  return (
    dimensionMatches(bounds.value.width, expected.contentBounds.width) &&
    dimensionMatches(bounds.value.height, expected.contentBounds.height)
  );
}

function domMatches(dom: SafeDomFailureState, expected: BoundsExpectation): boolean | null {
  if (
    dom.status !== 'valid' ||
    dom.contentAreaCount === null ||
    dom.aiPanelCount === null ||
    dom.contentBounds.status !== 'valid'
  ) {
    return null;
  }
  return (
    dom.contentAreaCount === 1 &&
    (expected.aiPanelPresent ? dom.aiPanelCount === 1 : dom.aiPanelCount === 0) &&
    boundsMatch(dom.contentBounds, expected)
  );
}

function unknownBoundsFailure(): BoundsFailureClassification {
  return { layer: 'unknown', rootCauseEstablished: false };
}

function completeRing<T>(ring: BoundsRingSnapshot<T>): boolean {
  return !ring.truncated && ring.totalCount === ring.items.length;
}

function hasValidNativeState(state: SafeNativeViewState): boolean {
  return state.viewId.status === 'valid' && state.bounds.status === 'valid';
}

interface TimedNativeFact {
  monoObservedAtMs: number;
  viewId: number;
  matchesExpected: boolean;
}

function toTimedNativeFact(
  state: SafeNativeViewState,
  monoObservedAtMs: number,
  expected: BoundsExpectation,
): TimedNativeFact | null {
  if (
    !Number.isFinite(monoObservedAtMs) ||
    state.viewId.status !== 'valid' ||
    state.bounds.status !== 'valid'
  ) {
    return null;
  }
  return {
    monoObservedAtMs,
    viewId: state.viewId.value,
    matchesExpected: boundsMatch(state.bounds, expected),
  };
}

function collectTimedNativeFacts(
  observation: BoundsObservationSnapshot,
  expected: BoundsExpectation,
): readonly TimedNativeFact[] | null {
  const nativeFacts = observation.nativeSamples.items.map((sample) =>
    toTimedNativeFact(sample, sample.monoObservedAtMs, expected),
  );
  const ipcFacts = observation.ipcSamples.items.map((sample) =>
    toTimedNativeFact(sample.selectedNative, sample.monoObservedAtMs, expected),
  );
  const facts = [...nativeFacts, ...ipcFacts];
  return facts.every((fact): fact is TimedNativeFact => fact !== null) ? facts : null;
}

function hasOnTimeNativeConflict(
  facts: readonly TimedNativeFact[],
  failureObservedAtMonoMs: number,
): boolean {
  const evidenceByView = new Map<number, { matched: boolean; unmatched: boolean }>();
  for (const fact of facts) {
    if (fact.monoObservedAtMs > failureObservedAtMonoMs) continue;
    const evidence = evidenceByView.get(fact.viewId) ?? { matched: false, unmatched: false };
    if (fact.matchesExpected) evidence.matched = true;
    else evidence.unmatched = true;
    evidenceByView.set(fact.viewId, evidence);
  }
  return [...evidenceByView.values()].some((evidence) => evidence.matched && evidence.unmatched);
}

function hasCompatibleFailureTiming(
  entry: BoundsPhaseEntry,
  snapshot: Matrix9FailureSnapshot,
  failureObservedAtMonoMs: number,
): boolean {
  return (
    Number.isFinite(entry.monoStartedAtMs) &&
    Number.isFinite(failureObservedAtMonoMs) &&
    Number.isFinite(snapshot.captureStartedAtMonoMs) &&
    Number.isFinite(snapshot.captureFinishedAtMonoMs) &&
    entry.monoStartedAtMs <= failureObservedAtMonoMs &&
    failureObservedAtMonoMs <= snapshot.captureStartedAtMonoMs &&
    snapshot.captureStartedAtMonoMs <= snapshot.captureFinishedAtMonoMs
  );
}

function hasCompatibleNativeEvidence(
  observation: BoundsObservationSnapshot,
  failureObservedAtMonoMs: number,
): boolean {
  const entry = observation.phaseEntry;
  if (
    entry === null ||
    observation.nativeSamples.items.length === 0 ||
    !completeRing(observation.nativeSamples)
  ) {
    return false;
  }
  return observation.nativeSamples.items.every(
    (sample) =>
      sample.phase === entry.phase &&
      Number.isFinite(sample.monoObservedAtMs) &&
      entry.monoStartedAtMs <= sample.monoObservedAtMs &&
      sample.monoObservedAtMs <= failureObservedAtMonoMs &&
      sample.conditionMatched === false &&
      hasValidNativeState(sample) &&
      !boundsMatch(sample.bounds, entry.expected),
  );
}

function hasCompatibleIpcEvidence(
  observation: BoundsObservationSnapshot,
  failureSnapshot: Matrix9FailureSnapshot,
): boolean {
  const entry = observation.phaseEntry;
  if (
    entry === null ||
    observation.listener.attachStatus !== 'attached' ||
    !completeRing(observation.ipcSamples)
  ) {
    return false;
  }
  return observation.ipcSamples.items.every(
    (sample) =>
      sample.phase === entry.phase &&
      Number.isFinite(sample.monoObservedAtMs) &&
      entry.monoStartedAtMs <= sample.monoObservedAtMs &&
      sample.monoObservedAtMs <= failureSnapshot.captureFinishedAtMonoMs &&
      sample.payloadBounds.status === 'valid' &&
      hasValidNativeState(sample.selectedNative),
  );
}

interface FailureTargetRelation {
  waitedViewId: number;
  selectedMatches: boolean;
  visibleTarget: { viewId: number; matchesExpected: boolean } | null;
}

function collectFailureTargetRelation(
  observation: BoundsObservationSnapshot,
  windowState: SafeWindowFailureState,
  expected: BoundsExpectation,
): FailureTargetRelation | null {
  // Only the condition's own samples identify the object observed by the failed
  // wait. An IPC sample or the later snapshot cannot substitute for this anchor.
  const waitedIds = new Set<number>();
  for (const sample of observation.nativeSamples.items) {
    if (!hasValidNativeState(sample) || sample.viewId.status !== 'valid') return null;
    waitedIds.add(sample.viewId.value);
  }
  const selected = windowState.selectedNative;
  if (
    waitedIds.size !== 1 ||
    !hasValidNativeState(selected) ||
    selected.viewId.status !== 'valid' ||
    !waitedIds.has(selected.viewId.value) ||
    windowState.childViews.status !== 'valid' ||
    windowState.childViews.truncated ||
    windowState.childViews.totalCount !== windowState.childViews.items.length
  ) {
    return null;
  }
  const waitedViewId = selected.viewId.value;
  const selectedMatches = boundsMatch(selected.bounds, expected);
  const children = windowState.childViews.items;
  // A complete empty child projection is not a target witness. Existing
  // same-target proofs can still be established by wait/IPC/selected evidence.
  if (children.length === 0) return { waitedViewId, selectedMatches, visibleTarget: null };

  const childIds = new Set<number>();
  const sampledIds = new Set([
    waitedViewId,
    ...observation.ipcSamples.items.flatMap((sample) =>
      sample.selectedNative.viewId.status === 'valid' ? [sample.selectedNative.viewId.value] : [],
    ),
  ]);
  const visibleTargets: { viewId: number; matchesExpected: boolean }[] = [];
  for (const child of children) {
    if (
      child.kind === 'unavailable' ||
      child.viewId.status !== 'valid' ||
      child.visible.status !== 'valid' ||
      !hasValidNativeState(child) ||
      childIds.has(child.viewId.value)
    ) {
      return null;
    }
    const viewId = child.viewId.value;
    childIds.add(viewId);
    const matchesExpected = boundsMatch(child.bounds, expected);
    if (
      (child.kind === 'other' && sampledIds.has(viewId)) ||
      (viewId === waitedViewId && matchesExpected !== selectedMatches)
    ) {
      return null;
    }
    if (child.kind === 'web-contents-view' && child.visible.value) {
      visibleTargets.push({ viewId, matchesExpected });
    }
  }
  if (visibleTargets.length !== 1) return null;
  return { waitedViewId, selectedMatches, visibleTarget: visibleTargets[0]! };
}

export function classifyMatrix9BoundsFailure(
  observation: BoundsObservationSnapshot,
  failureSnapshot: Matrix9FailureSnapshot | null,
  failureObservedAtMonoMs: number,
): BoundsFailureClassification {
  const entry = observation.phaseEntry;
  if (entry === null || failureSnapshot === null) {
    return unknownBoundsFailure();
  }
  if (failureSnapshot.window.status !== 'valid') return unknownBoundsFailure();
  const currentSize = failureSnapshot.window.contentSize;
  if (currentSize.status !== 'valid') return unknownBoundsFailure();
  if (currentSize.value.width !== entry.expected.windowWidth) {
    return { layer: 'window-precondition', rootCauseEstablished: false };
  }

  const matchesDom = domMatches(failureSnapshot.dom, entry.expected);
  if (matchesDom === false) return { layer: 'ui-layout', rootCauseEstablished: false };
  if (matchesDom === null) return unknownBoundsFailure();

  if (
    failureSnapshot.window.visible.status !== 'valid' ||
    !failureSnapshot.window.visible.value ||
    failureSnapshot.window.minimized.status !== 'valid' ||
    failureSnapshot.window.minimized.value ||
    failureSnapshot.window.focused.status !== 'valid' ||
    failureSnapshot.dom.visibilityState !== 'visible' ||
    failureSnapshot.dom.hasFocus.status !== 'valid' ||
    !hasCompatibleFailureTiming(entry, failureSnapshot, failureObservedAtMonoMs) ||
    !hasCompatibleNativeEvidence(observation, failureObservedAtMonoMs) ||
    !hasCompatibleIpcEvidence(observation, failureSnapshot)
  ) {
    return unknownBoundsFailure();
  }

  const nativeFacts = collectTimedNativeFacts(observation, entry.expected);
  if (nativeFacts === null || hasOnTimeNativeConflict(nativeFacts, failureObservedAtMonoMs)) {
    return unknownBoundsFailure();
  }

  const relation = collectFailureTargetRelation(
    observation,
    failureSnapshot.window,
    entry.expected,
  );
  if (relation === null) return unknownBoundsFailure();
  const { waitedViewId, selectedMatches, visibleTarget } = relation;
  const selectionTarget =
    visibleTarget !== null && visibleTarget.viewId !== waitedViewId ? visibleTarget : null;

  // Check every sampled target before payloads are used as positive witnesses.
  // Current visibility cannot make an earlier IPC target unrelated to the wait.
  if (selectionTarget === null) {
    if (!nativeFacts.every((fact) => fact.viewId === waitedViewId)) return unknownBoundsFailure();
  } else if (
    selectedMatches ||
    !selectionTarget.matchesExpected ||
    !nativeFacts.every(
      (fact) =>
        (fact.viewId === waitedViewId && !fact.matchesExpected) ||
        (fact.viewId === selectionTarget.viewId && fact.matchesExpected),
    )
  ) {
    return unknownBoundsFailure();
  }

  const matchingIpc = observation.ipcSamples.items.filter((sample) =>
    boundsMatch(sample.payloadBounds, entry.expected),
  );
  if (matchingIpc.length === 0) {
    return selectionTarget === null &&
      !selectedMatches &&
      nativeFacts.every((fact) => !fact.matchesExpected)
      ? { layer: 'renderer-measurement-schedule-send', rootCauseEstablished: false }
      : unknownBoundsFailure();
  }

  const onTimeMatchingIpc = matchingIpc.filter(
    (sample) => sample.monoObservedAtMs <= failureObservedAtMonoMs,
  );
  const lateMatchingIpc = matchingIpc.filter(
    (sample) => sample.monoObservedAtMs > failureObservedAtMonoMs,
  );
  if (onTimeMatchingIpc.length > 0 && lateMatchingIpc.length > 0) {
    return unknownBoundsFailure();
  }

  if (onTimeMatchingIpc.length > 0) {
    if (
      selectionTarget === null &&
      !selectedMatches &&
      nativeFacts.every((fact) => !fact.matchesExpected)
    ) {
      return { layer: 'main-apply', rootCauseEstablished: false };
    }
    if (
      selectionTarget !== null &&
      onTimeMatchingIpc.every(
        (sample) =>
          sample.selectedNative.viewId.status === 'valid' &&
          sample.selectedNative.viewId.value === selectionTarget.viewId,
      )
    ) {
      return { layer: 'view-selection', rootCauseEstablished: false };
    }
    return unknownBoundsFailure();
  }

  if (
    selectionTarget === null &&
    selectedMatches &&
    lateMatchingIpc.length === matchingIpc.length &&
    nativeFacts.every((fact) =>
      fact.monoObservedAtMs <= failureObservedAtMonoMs
        ? !fact.matchesExpected
        : fact.matchesExpected,
    )
  ) {
    return { layer: 'late-observation', rootCauseEstablished: false };
  }

  return unknownBoundsFailure();
}

export async function runMatrix9BoundsWait(options: Matrix9BoundsWaitOptions): Promise<void> {
  try {
    await options.waitFor(
      async () => {
        const result = await options.condition();
        options.observation.recordNative(result.sample, result.matched);
        return result.matched;
      },
      MATRIX9_BOUNDS_WAIT_TIMEOUT_MS,
      options.failure,
    );
  } catch (originalError) {
    const nowMono = options.nowMono ?? (() => performance.now());
    const failureObservedAtMonoMs = safeNow(nowMono);
    const outcome = await settleWithin(
      options.collectFailure,
      BOUNDS_FAILURE_COLLECTOR_TIMEOUT_MS,
      options.timers ?? SYSTEM_TIMERS,
    );
    const failureSnapshot = outcome.status === 'value' ? outcome.value : null;
    // A failed wait ends matrix-9 observation immediately. The surrounding
    // smoke finally calls dispose again, so this also verifies idempotent cleanup.
    options.observation.dispose();
    const observation = options.observation.snapshot();
    const evidence: Matrix9BoundsFailureEvidence = {
      code: 'BND-M9-FAILURE-EVIDENCE-V1',
      failureObservedAtMonoMs,
      collection:
        outcome.status === 'value'
          ? { status: 'complete', code: 'COLLECTED' }
          : {
              status: 'unavailable',
              code: outcome.status === 'timeout' ? 'COLLECTOR_TIMEOUT' : 'COLLECTOR_ERROR',
            },
      observation,
      failureSnapshot,
      classification: classifyMatrix9BoundsFailure(
        observation,
        failureSnapshot,
        failureObservedAtMonoMs,
      ),
    };
    try {
      options.logFailure(evidence);
    } catch {
      // Logging is diagnostic-only and must not replace the original failure.
    }
    throw originalError;
  }
}

function compactBounds(bounds: SafeBounds): readonly (number | string | null)[] {
  return bounds.status === 'valid'
    ? ['v', bounds.value.x, bounds.value.y, bounds.value.width, bounds.value.height]
    : [bounds.status[0] ?? 'u', null, null, null, null];
}

function compactId(id: SafeId): readonly (number | string | null)[] {
  return id.status === 'valid' ? ['v', id.value] : [id.status[0] ?? 'u', null];
}

function compactBoolean(value: SafeBoolean): boolean | string | null {
  return value.status === 'valid' ? value.value : (value.status[0] ?? null);
}

function recent<T>(items: readonly T[], limit: number): readonly T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

/**
 * Emit a single bounded logger record. The in-memory rings retain 128 recent
 * samples; the log projection keeps a smaller recent tail and reports both
 * ring and projection truncation so the logger's 8 KiB line budget remains
 * independently auditable.
 */
export function summarizeMatrix9BoundsEvidence(evidence: Matrix9BoundsFailureEvidence): unknown {
  const nativeItems = recent(
    evidence.observation.nativeSamples.items,
    BOUNDS_LOG_NATIVE_SAMPLE_LIMIT,
  );
  const ipcItems = recent(evidence.observation.ipcSamples.items, BOUNDS_LOG_IPC_SAMPLE_LIMIT);
  const failure = evidence.failureSnapshot;
  return {
    code: evidence.code,
    collection: evidence.collection,
    classification: evidence.classification,
    failureObservedAtMonoMs: evidence.failureObservedAtMonoMs,
    phaseEntry: evidence.observation.phaseEntry,
    listener: evidence.observation.listener,
    nativeSamples: {
      totalCount: evidence.observation.nativeSamples.totalCount,
      ringTruncated: evidence.observation.nativeSamples.truncated,
      outputTruncated: nativeItems.length < evidence.observation.nativeSamples.items.length,
      items: nativeItems.map((sample) => [
        sample.monoObservedAtMs,
        ...compactId(sample.viewId),
        ...compactBounds(sample.bounds),
        sample.conditionMatched,
      ]),
    },
    ipcSamples: {
      totalCount: evidence.observation.ipcSamples.totalCount,
      ringTruncated: evidence.observation.ipcSamples.truncated,
      outputTruncated: ipcItems.length < evidence.observation.ipcSamples.items.length,
      items: ipcItems.map((sample) => [
        sample.monoObservedAtMs,
        ...compactBounds(sample.payloadBounds),
        ...compactId(sample.selectedNative.viewId),
        ...compactBounds(sample.selectedNative.bounds),
      ]),
    },
    failureSnapshot:
      failure === null
        ? null
        : {
            captureStartedAtMonoMs: failure.captureStartedAtMonoMs,
            captureFinishedAtMonoMs: failure.captureFinishedAtMonoMs,
            window: {
              status: failure.window.status,
              contentSize:
                failure.window.contentSize.status === 'valid'
                  ? [
                      'v',
                      failure.window.contentSize.value.width,
                      failure.window.contentSize.value.height,
                    ]
                  : [failure.window.contentSize.status[0] ?? 'u', null, null],
              visible: compactBoolean(failure.window.visible),
              minimized: compactBoolean(failure.window.minimized),
              focused: compactBoolean(failure.window.focused),
              selectedNative: [
                ...compactId(failure.window.selectedNative.viewId),
                ...compactBounds(failure.window.selectedNative.bounds),
              ],
              childViews: {
                totalCount: failure.window.childViews.totalCount,
                truncated: failure.window.childViews.truncated,
                items: failure.window.childViews.items.map((child) => [
                  child.kind,
                  ...compactId(child.viewId),
                  compactBoolean(child.visible),
                  ...compactBounds(child.bounds),
                ]),
              },
            },
            dom: {
              status: failure.dom.status,
              contentAreaCount: failure.dom.contentAreaCount,
              contentBounds: compactBounds(failure.dom.contentBounds),
              aiPanelCount: failure.dom.aiPanelCount,
              visibilityState: failure.dom.visibilityState,
              hasFocus: compactBoolean(failure.dom.hasFocus),
            },
          },
  };
}
