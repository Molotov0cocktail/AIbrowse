import { describe, expect, it } from 'vitest';
import { qualifyWindowsNotification } from './windows-notification-sink';

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
