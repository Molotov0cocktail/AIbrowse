import { describe, expect, it } from 'vitest';
import {
  createDiagnosticCandidate,
  DiagnosticProjectionError,
  MAX_DIAGNOSTIC_BYTES,
} from './diagnostic-projection';

function validInput() {
  return {
    application: { version: '0.1.0', buildId: 'a'.repeat(40) },
    runtime: { electron: '43.7.7', node: '24.18.0', chromium: '150.0.7339.249' },
    features: {
      browser: 'available',
      ai: 'degraded',
      sources: 'available',
      research: 'available',
      watch: 'disabled',
      storage: 'available',
    },
    errors: {
      startup: 0,
      storage: 1,
      browser: 2,
      provider: 3,
      research: 4,
      watch: 5,
      renderer: 6,
      other: 7,
    },
    counts: {
      tabs: 8,
      sessions: 9,
      sources: 10,
      researchTasks: 11,
      watchRules: 12,
      pendingOperations: 13,
    },
    durationsMs: {
      startup: 14,
      pageSnapshot: 15,
      sourceSearch: 16,
      researchRun: 17,
      watchCycle: 18,
    },
  };
}

function expectCode(action: () => unknown, code: 'shape' | 'budget'): void {
  try {
    action();
    throw new Error('预期投影失败');
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticProjectionError);
    expect((error as DiagnosticProjectionError).code).toBe(code);
  }
}

describe('diagnostic projection', () => {
  it('生成固定顺序的有界JSON、摘要与递归不可变候选', () => {
    const input = validInput();
    const candidate = createDiagnosticCandidate(input);

    expect(candidate.byteLength).toBe(Buffer.byteLength(candidate.json));
    expect(candidate.byteLength).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    expect(candidate.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(candidate.json)).toEqual(candidate.projection);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.projection)).toBe(true);
    for (const value of Object.values(candidate.projection)) {
      if (typeof value === 'object') expect(Object.isFrozen(value)).toBe(true);
    }

    input.counts.tabs = 999;
    input.features.browser = 'unavailable';
    expect(candidate.projection.counts.tabs).toBe(8);
    expect(candidate.projection.features.browser).toBe('available');
  });

  it('不受输入键插入顺序影响，任一预览字段改变都会改变JSON和摘要', () => {
    const first = validInput();
    const reordered = {
      durationsMs: { ...first.durationsMs },
      counts: { ...first.counts },
      errors: { ...first.errors },
      features: { ...first.features },
      runtime: { ...first.runtime },
      application: { ...first.application },
    };
    const baseline = createDiagnosticCandidate(first);
    expect(createDiagnosticCandidate(reordered)).toEqual(baseline);

    reordered.durationsMs.watchCycle += 1;
    const changed = createDiagnosticCandidate(reordered);
    expect(changed.json).not.toBe(baseline.json);
    expect(changed.sha256).not.toBe(baseline.sha256);
  });

  it('未采集的计数和耗时保留null，缺少字段不回填零', () => {
    const input = validInput();
    const candidate = createDiagnosticCandidate({
      ...input,
      counts: { ...input.counts, sources: null },
      durationsMs: { ...input.durationsMs, researchRun: null },
    });
    expect(candidate.projection.counts.sources).toBeNull();
    expect(candidate.projection.durationsMs.researchRun).toBeNull();

    const missing = validInput();
    const counts = { ...missing.counts } as Partial<typeof missing.counts>;
    delete counts.sources;
    expectCode(() => createDiagnosticCandidate({ ...missing, counts }), 'shape');
  });

  it.each([
    ['apiKey', 'sk-secret'],
    ['url', 'https://example.test/?token=secret'],
    ['path', 'C:\\Users\\name\\private'],
    ['cookie', 'session=secret'],
    ['form', { password: 'secret' }],
    ['rawError', new Error('secret')],
    ['body', 'secret'],
  ])('拒绝顶层污染字段 %s', (key, value) => {
    expectCode(() => createDiagnosticCandidate({ ...validInput(), [key]: value }), 'shape');
  });

  it('拒绝嵌套污染、自定义原型及伪装的原始异常', () => {
    const nested = validInput();
    expectCode(
      () => createDiagnosticCandidate({ ...nested, runtime: { ...nested.runtime, env: 'secret' } }),
      'shape',
    );
    expectCode(
      () => createDiagnosticCandidate(Object.assign(Object.create({ secret: true }), nested)),
      'shape',
    );
    expectCode(() => createDiagnosticCandidate(new Error('secret')), 'shape');
    expectCode(
      () =>
        createDiagnosticCandidate({
          ...nested,
          get application() {
            throw new Error('不应读取的getter');
          },
        }),
      'shape',
    );
  });

  it('在复制前拒绝超限token，并保留最终64KiB硬门', () => {
    const input = validInput();
    input.application.version = 'a'.repeat(MAX_DIAGNOSTIC_BYTES + 1);
    expectCode(() => createDiagnosticCandidate(input), 'budget');
    expect(createDiagnosticCandidate(validInput()).byteLength).toBeLessThanOrEqual(
      MAX_DIAGNOSTIC_BYTES,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 1_000_001])(
    '拒绝非法计数 %s',
    (value) => {
      const input = validInput();
      input.errors.other = value;
      expectCode(() => createDiagnosticCandidate(input), 'shape');
    },
  );

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -1, 1.5, 86_400_001])(
    '拒绝非法耗时 %s',
    (value) => {
      const input = validInput();
      input.durationsMs.startup = value;
      expectCode(() => createDiagnosticCandidate(input), 'shape');
    },
  );

  it.each(['v24.18.0', '24.018.0', '24.18.0-01', 'secret', '24.18.0+private', '24/18/0'])(
    '拒绝非标准数字运行时版本 %s',
    (version) => {
      const input = validInput();
      input.runtime.node = version;
      expectCode(() => createDiagnosticCandidate(input), 'shape');
    },
  );

  it.each(['150.0.7339', '150.0.7339.249-beta', '150.00.7339.249', 'secret'])(
    '拒绝非标准Chromium版本 %s',
    (version) => {
      const input = validInput();
      input.runtime.chromium = version;
      expectCode(() => createDiagnosticCandidate(input), 'shape');
    },
  );

  it.each(['A'.repeat(40), 'a'.repeat(39), 'g'.repeat(40), 'release-build'])(
    '拒绝非标准build ID %s',
    (buildId) => {
      const input = validInput();
      input.application.buildId = buildId;
      expectCode(() => createDiagnosticCandidate(input), 'shape');
    },
  );
});
