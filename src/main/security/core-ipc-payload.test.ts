import { expect, it } from 'vitest';
import { IPC } from '../../shared/types/ipc';
import { validateCoreIpcPayload } from './core-ipc-payload';

it('诊断仅接受空预览与闭合候选标识，不接收路径或正文', () => {
  const digest = 'a'.repeat(64);
  expect(validateCoreIpcPayload(IPC.DiagnosticPreview, undefined)).toBe(true);
  expect(validateCoreIpcPayload(IPC.DiagnosticPreview, {})).toBe(true);
  for (const value of [{ path: 'private' }, new Date(), { sample: {} }])
    expect(validateCoreIpcPayload(IPC.DiagnosticPreview, value)).toBe(false);
  expect(validateCoreIpcPayload(IPC.DiagnosticExport, { sequence: 1, digest })).toBe(true);
  for (const value of [
    undefined,
    {},
    { sequence: 0, digest },
    { sequence: 1, digest: 'bad' },
    { sequence: 1, digest, path: 'private' },
    { sequence: 1, digest, json: 'private' },
    Object.create({ sequence: 1, digest }),
  ])
    expect(validateCoreIpcPayload(IPC.DiagnosticExport, value)).toBe(false);
});

it('数据转移只接受闭合action与UUID，状态查询零参数且无路径或批准通道', () => {
  const id = '7f24a960-dd65-4ef2-a04a-742c0e87c845';
  expect(validateCoreIpcPayload('data-transfer:start', { action: 'backup' })).toBe(true);
  expect(validateCoreIpcPayload('data-transfer:start', { action: 'restore' })).toBe(true);
  for (const payload of [
    undefined,
    {},
    { action: 'delete' },
    { action: 'restore', approved: true },
    { action: 'backup', path: 'private' },
  ])
    expect(validateCoreIpcPayload('data-transfer:start', payload)).toBe(false);
  for (const channel of ['data-transfer:cancel', 'data-transfer:recover-original']) {
    expect(validateCoreIpcPayload(channel, { operationId: id })).toBe(true);
    for (const payload of [
      undefined,
      {},
      { operationId: '../private' },
      { operationId: id, generation: 1 },
    ])
      expect(validateCoreIpcPayload(channel, payload)).toBe(false);
  }
  for (const channel of ['data-transfer:status', 'conversation:storage-status']) {
    expect(validateCoreIpcPayload(channel, undefined)).toBe(true);
    expect(validateCoreIpcPayload(channel, { path: 'private' })).toBe(false);
  }
});

it('数据转移不接受原型继承字段或非普通查询对象', () => {
  expect(validateCoreIpcPayload('data-transfer:start', Object.create({ action: 'restore' }))).toBe(
    false,
  );
  expect(validateCoreIpcPayload('data-transfer:status', new Date())).toBe(false);
});

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
