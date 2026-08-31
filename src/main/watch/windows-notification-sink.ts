export type WindowsNotificationUnavailableReason =
  'not-windows' | 'not-packaged' | 'identity-not-configured' | 'unsupported' | 'probe-failed';

export interface WindowsNotificationQualificationInput {
  platform: NodeJS.Platform;
  packaged: boolean;
  identityConfigured: boolean;
  supported: boolean;
  probeIdentity(): boolean;
}

export type WindowsNotificationQualification =
  | { available: true; reason: null }
  | { available: false; reason: WindowsNotificationUnavailableReason };

export function qualifyWindowsNotification(
  input: WindowsNotificationQualificationInput,
): WindowsNotificationQualification {
  if (input.platform !== 'win32') return { available: false, reason: 'not-windows' };
  if (!input.packaged) return { available: false, reason: 'not-packaged' };
  if (!input.identityConfigured) return { available: false, reason: 'identity-not-configured' };
  if (!input.supported) return { available: false, reason: 'unsupported' };
  try {
    return input.probeIdentity()
      ? { available: true, reason: null }
      : { available: false, reason: 'probe-failed' };
  } catch {
    return { available: false, reason: 'probe-failed' };
  }
}
