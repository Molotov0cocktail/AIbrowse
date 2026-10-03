import { expect, it } from 'vitest';
import { IPC } from '../../shared/types/ipc';
import { validateCoreIpcPayload } from './core-ipc-payload';

it('核心通道拒绝夹带批准标志、路径和未知字段', () => {
  expect(
    validateCoreIpcPayload(IPC.ConfigProvidersSet, {
      providerId: 'test',
      baseUrl: 'https://example.com',
      model: 'test',
      approved: true,
    }),
  ).toBe(false);
  expect(
    validateCoreIpcPayload(IPC.TabsCreate, { url: 'https://example.com', preload: 'evil' }),
  ).toBe(false);
  expect(validateCoreIpcPayload(IPC.ConversationCreate, { ephemeral: true, path: '../evil' })).toBe(
    false,
  );
  expect(validateCoreIpcPayload(IPC.AppGetInfo, { extra: true })).toBe(false);
  expect(validateCoreIpcPayload(IPC.AppGetInfo, undefined)).toBe(true);
  expect(validateCoreIpcPayload(IPC.ConversationCreate, undefined)).toBe(true);
  expect(validateCoreIpcPayload(IPC.TabsCreate, { url: undefined })).toBe(true);
  expect(validateCoreIpcPayload(IPC.TabsCreate, { url: 42 })).toBe(false);
  expect(validateCoreIpcPayload(IPC.ConversationCreate, { ephemeral: 'false' })).toBe(false);
  expect(
    validateCoreIpcPayload(IPC.ConversationSetEphemeral, { sessionId: 'test', ephemeral: 'false' }),
  ).toBe(false);
  expect(validateCoreIpcPayload(IPC.NavNavigate, { tabId: 'test' })).toBe(false);
});
