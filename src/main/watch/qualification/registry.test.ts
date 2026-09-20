import { describe, expect, it } from 'vitest';
import { QualificationRegistry } from './registry';

describe('资格资源唯一所有权', () => {
  function setup() {
    const trace: string[] = [];
    const registry = new QualificationRegistry(
      (kind, event) => trace.push(`${kind}:${event.identity}`),
      (code) => {
        throw new Error(code);
      },
    );
    return { registry, trace };
  }

  it('按真实settlement配对所有nested Promise，身份不复用', async () => {
    const { registry, trace } = setup();
    let done: (() => void) | undefined;
    const promise = registry.track(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    expect(
      registry.snapshot().find((x) => x.registry === 'watch-async-operation')?.identities,
    ).toEqual(['watch-async-operation:1']);
    done!();
    await promise;
    await registry.track(async () => {});
    expect(trace).toEqual([
      'register:watch-async-operation:1',
      'unregister:watch-async-operation:1',
      'register:watch-async-operation:2',
      'unregister:watch-async-operation:2',
    ]);
  });

  it('冻结时owner完成立即失败，不排队洗成稳定sample', async () => {
    const { registry } = setup();
    let done: (() => void) | undefined;
    const promise = registry.track(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    registry.freeze();
    done!();
    await expect(promise).rejects.toThrow('barrier-mutation');
    expect(() => registry.increment('unhandledRejectionTotal')).toThrow('barrier-mutation');
  });

  it('stop后只允许原live owner的清理后代，零资源不得伪造', async () => {
    const { registry } = setup();
    const owner = registry.register({ registry: 'watch-store', detail: null });
    registry.closeAdmission();
    expect(() => registry.track(async () => {})).toThrow('admission-after-stop');
    expect(() => registry.track(async () => {}, 'watch-store:999')).toThrow('admission-after-stop');
    await registry.track(async () => {}, owner);
    registry.unregister(owner);
    expect(() => registry.unregister(owner)).toThrow('registry-unpaired');
    const normal = setup().registry;
    expect(() => normal.register({ registry: 'socket', detail: null })).toThrow(
      'unexpected-resource',
    );
  });

  it('stop已有owner的多层真实异步清理保留父谱系，所有settlement后归零', async () => {
    const { registry, trace } = setup();
    const owner = registry.register({ registry: 'task-tab', detail: null });
    registry.closeAdmission();
    await registry.track(async () => {
      await Promise.resolve();
      await registry.track(async () => {
        await Promise.resolve();
        await registry.track(async () => {
          registry.unregister(owner);
        });
      });
    }, owner);
    expect(registry.snapshot().every((row) => row.identities.length === 0)).toBe(true);
    expect(
      trace.filter((entry) => entry.startsWith('register:watch-async-operation:')),
    ).toHaveLength(3);
  });

  it('stop前已live的Promise在await后开始cleanup，继承真实原owner而非新admission', async () => {
    const { registry } = setup();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = registry.track(async () => {
      await pending;
      await registry.track(async () => {});
    });
    registry.closeAdmission();
    release!();
    await expect(work).resolves.toBeUndefined();
    expect(registry.snapshot().every((row) => row.identities.length === 0)).toBe(true);
  });
});
