import type { WatchAccessMode, WatchNotificationLevel } from '../../shared/types/watch';
import type { InAppNotificationDto } from '../../shared/types/watch-ipc';

const encoder = new TextEncoder();

function stripUnsafeCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    result +=
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
        ? ' '
        : character;
  }
  return result;
}

function safeText(value: string, maxBytes: number): string {
  const cleaned = stripUnsafeCharacters(value).replace(/\s+/gu, ' ').trim();
  if (encoder.encode(cleaned).byteLength <= maxBytes) return cleaned;
  let result = '';
  for (const char of cleaned) {
    if (encoder.encode(`${result}${char}`).byteLength > maxBytes) break;
    result += char;
  }
  return result;
}

export interface NotificationPolicyInput {
  notificationId: string;
  subjectType: 'event' | 'digest';
  subjectId: string;
  accessMode: WatchAccessMode;
  showDetails: boolean;
  importance: WatchNotificationLevel;
  sourceName: string;
  changeCount: number;
  fieldLabels: string[];
  createdAt: string;
}

export function buildInAppNotification(input: NotificationPolicyInput): InAppNotificationDto {
  let body: string;
  if (input.subjectType === 'digest') {
    body = `监控摘要已生成，共 ${Math.max(0, Math.trunc(input.changeCount))} 项变化`;
  } else if (input.accessMode === 'session' && !input.showDetails) {
    body = '受保护来源发生变化';
  } else {
    const name = safeText(input.sourceName, 96) || '来源';
    const labels = input.showDetails
      ? input.fieldLabels
          .slice(0, 3)
          .map((label) => safeText(label, 96))
          .filter(Boolean)
      : [];
    body = `${name}发生 ${Math.max(0, Math.trunc(input.changeCount))} 项变化${labels.length > 0 ? `：${labels.join('、')}` : ''}`;
  }
  return {
    notificationId: input.notificationId,
    dedupeKey: `in-app|${input.subjectType}|${input.subjectId}|1`,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    privacyVersion: 1,
    importance: input.importance,
    title: 'AIbrowse 监控提醒',
    body: safeText(body, 512),
    createdAt: input.createdAt,
  };
}
