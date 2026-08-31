import { describe, expect, it } from 'vitest';
import { qualifyWindowsNotification, WindowsNotificationSink } from './windows-notification-sink';

describe('D9 Windows Notification identity gate', () => {
  const base = {
    platform: 'win32' as const,
    packaged: true,
    identityConfigured: true,
    supported: true,
    probeIdentity: (): boolean => true,
  };
  it.each([
    [{ ...base, platform: 'linux' as const }, 'not-windows'],
    [{ ...base, packaged: false }, 'not-packaged'],
    [{ ...base, identityConfigured: false }, 'identity-not-configured'],
    [{ ...base, supported: false }, 'unsupported'],
    [{ ...base, probeIdentity: (): boolean => false }, 'probe-failed'],
  ] as const)('资格不满足时 fail-closed: %s', (input, reason) => {
    expect(qualifyWindowsNotification(input)).toEqual({ available: false, reason });
  });
  it('仅注入式完整 PASS 分支可用', () =>
    expect(qualifyWindowsNotification(base)).toEqual({ available: true, reason: null }));
  it('probe 异常不泄露正文', () =>
    expect(
      qualifyWindowsNotification({
        ...base,
        probeIdentity: (): boolean => {
          throw new Error('secret');
        },
      }),
    ).toEqual({ available: false, reason: 'probe-failed' }));
});

describe('D9 Windows Notification sink', () => {
  it('仅以内部 subject UUID 路由 click，并记录 show/click', () => {
    const listeners = new Map<string, () => void>();
    const routed: string[] = [];
    const audits: string[] = [];
    const sink = new WindowsNotificationSink(
      {
        create: () => ({
          once: (event, listener) => listeners.set(event, listener),
          show: () => undefined,
        }),
      },
      (type, id) => routed.push(`${type}:${id}`),
      (result) => audits.push(result),
    );
    expect(
      sink.show({
        subjectType: 'event',
        subjectId: '00000000-0000-4000-8000-000000000001',
        title: '固定标题',
        body: '固定正文',
        important: false,
      }),
    ).toBe(true);
    listeners.get('click')?.();
    expect(routed).toEqual(['event:00000000-0000-4000-8000-000000000001']);
    expect(audits).toEqual(['shown', 'clicked']);
  });

  it('native show 异常闭合失败且不路由', () => {
    const audits: string[] = [];
    const sink = new WindowsNotificationSink(
      {
        create: () => ({
          once: () => undefined,
          show: () => {
            throw new Error('不可回显');
          },
        }),
      },
      () => {
        throw new Error('不应路由');
      },
      (result) => audits.push(result),
    );
    expect(
      sink.show({
        subjectType: 'digest',
        subjectId: '00000000-0000-4000-8000-000000000002',
        title: '标题',
        body: '正文',
        important: true,
      }),
    ).toBe(false);
    expect(audits).toEqual(['failed']);
  });
});
