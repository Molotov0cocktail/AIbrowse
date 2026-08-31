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

export interface NativeNotificationLike {
  once(event: 'click' | 'failed', listener: () => void): void;
  show(): void;
}

export interface WindowsNotificationFactory {
  create(options: { title: string; body: string; silent: boolean }): NativeNotificationLike;
}

export class WindowsNotificationSink {
  constructor(
    private readonly factory: WindowsNotificationFactory,
    private readonly route: (subjectType: 'event' | 'digest', subjectId: string) => void,
    private readonly audit: (result: 'shown' | 'failed' | 'clicked') => void,
  ) {}

  show(input: {
    subjectType: 'event' | 'digest';
    subjectId: string;
    title: string;
    body: string;
    important: boolean;
  }): boolean {
    try {
      const notification = this.factory.create({
        title: input.title,
        body: input.body,
        silent: !input.important,
      });
      notification.once('failed', () => this.audit('failed'));
      notification.once('click', () => {
        this.route(input.subjectType, input.subjectId);
        this.audit('clicked');
      });
      notification.show();
      this.audit('shown');
      return true;
    } catch {
      this.audit('failed');
      return false;
    }
  }
}
