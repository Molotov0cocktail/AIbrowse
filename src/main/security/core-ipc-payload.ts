import { IPC } from '../../shared/types/ipc';
import { validateProviderConfig } from '../ai/config-store';

const schemas: Readonly<Record<string, readonly string[]>> = {
  [IPC.AppGetInfo]: [],
  [IPC.TabsList]: [],
  [IPC.TabsCreate]: ['url'],
  [IPC.TabsClose]: ['tabId'],
  [IPC.TabsActivate]: ['tabId'],
  [IPC.NavNavigate]: ['tabId', 'input'],
  [IPC.NavBack]: ['tabId'],
  [IPC.NavForward]: ['tabId'],
  [IPC.NavReload]: ['tabId'],
  [IPC.PageSnapshot]: ['tabId'],
  [IPC.ConversationList]: [],
  [IPC.ConversationCreate]: ['ephemeral'],
  [IPC.ConversationHistory]: ['sessionId'],
  [IPC.ConversationDelete]: ['sessionId'],
  [IPC.ConversationSetEphemeral]: ['sessionId', 'ephemeral'],
  [IPC.ConversationAsk]: ['sessionId', 'question'],
  [IPC.ConversationAbort]: ['requestId'],
  [IPC.ConversationPreview]: [],
  [IPC.AgentAsk]: ['sessionId', 'goal'],
  [IPC.AgentConfirm]: ['toolCallId', 'approve'],
  [IPC.ConfigProvidersList]: [],
  [IPC.ConfigProvidersSet]: ['providerId', 'baseUrl', 'model'],
  [IPC.ConfigProvidersSetKey]: ['providerId', 'apiKey'],
  [IPC.ConfigProvidersHasKey]: ['providerId'],
  [IPC.UiContentBounds]: ['x', 'y', 'width', 'height'],
  [IPC.AppRendererReady]: [],
};

/** Domain adapters retain their stricter value and budget validation. */
export function validateCoreIpcPayload(channel: string, payload: unknown): boolean {
  const allowed = schemas[channel];
  if (allowed === undefined) return true;
  if (payload === undefined)
    return allowed.length === 0 || channel === IPC.ConversationCreate || channel === IPC.TabsCreate;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (!Object.keys(record).every((key) => allowed.includes(key))) return false;
  if (channel === IPC.TabsCreate) return record.url === undefined || typeof record.url === 'string';
  if (channel === IPC.ConversationCreate)
    return record.ephemeral === undefined || typeof record.ephemeral === 'boolean';
  if (channel === IPC.ConfigProvidersSet) return validateProviderConfig(payload) !== null;
  if (channel === IPC.UiContentBounds)
    return (
      allowed.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key])) &&
      Number(record.x) >= 0 &&
      Number(record.y) >= 0 &&
      Number(record.width) > 0 &&
      Number(record.height) > 0
    );
  return allowed.every((key) => {
    const value = record[key];
    if (key === 'ephemeral' || key === 'approve') return typeof value === 'boolean';
    if (typeof value !== 'string') return false;
    if (key === 'apiKey') return value.length <= 16384;
    if (key === 'providerId')
      return (
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
        !['__proto__', 'constructor', 'prototype'].includes(value)
      );
    return value.trim() !== '';
  });
}
