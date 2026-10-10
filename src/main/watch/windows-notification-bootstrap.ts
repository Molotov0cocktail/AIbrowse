export const WINDOWS_NOTIFICATION_APP_ID = 'com.aibrowse.desktop';

export type WindowsNotificationUnavailableReason =
  'not-windows' | 'not-packaged' | 'identity-not-configured' | 'unsupported';

export interface WindowsNotificationQualificationInput {
  platform: NodeJS.Platform;
  packaged: boolean;
  identityConfigured: boolean;
  supported: boolean;
}

export type WindowsNotificationQualification =
  | { available: true; reason: null }
  | { available: false; reason: WindowsNotificationUnavailableReason };

// This records the real setter result, not a claim that Windows displayed a toast.
export function configureWindowsNotificationIdentity(
  setAppUserModelId: (appId: string) => void,
): boolean {
  try {
    setAppUserModelId(WINDOWS_NOTIFICATION_APP_ID);
    return true;
  } catch {
    return false;
  }
}

export function qualifyWindowsNotification(
  input: WindowsNotificationQualificationInput,
): WindowsNotificationQualification {
  if (input.platform !== 'win32') return { available: false, reason: 'not-windows' };
  if (!input.packaged) return { available: false, reason: 'not-packaged' };
  if (!input.identityConfigured) return { available: false, reason: 'identity-not-configured' };
  if (!input.supported) return { available: false, reason: 'unsupported' };
  return { available: true, reason: null };
}
