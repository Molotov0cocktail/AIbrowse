import { expect, it } from 'vitest';
import { IPC } from '../../shared/types/ipc';
import { validateCoreIpcPayload } from './core-ipc-payload';

it('指定脚本 UI 只接受编译期标识和闭合启用状态，不接受源码路径或私有能力', () => {
  for (const channel of [IPC.QualifiedScriptsList, IPC.QualifiedScriptsMenu]) {
    expect(validateCoreIpcPayload(channel, undefined)).toBe(true);
    expect(validateCoreIpcPayload(channel, {})).toBe(false);
  }
  for (const channel of [
    IPC.QualifiedScriptsInstall,
    IPC.QualifiedScriptsInstallFile,
    IPC.QualifiedScriptsRemove,
  ]) {
    for (const id of ['ac-baidu', 'github-zh'])
      expect(validateCoreIpcPayload(channel, { id })).toBe(true);
    for (const input of [
      { id: 'unknown' },
      { id: '../ac-baidu' },
      { id: 'ac-baidu', source: 'x' },
      { id: 'github-zh', path: 'x' },
      { id: 'ac-baidu', [Symbol('token')]: true },
    ])
      expect(validateCoreIpcPayload(channel, input)).toBe(false);
  }
  expect(
    validateCoreIpcPayload(IPC.QualifiedScriptsSetEnabled, { id: 'github-zh', enabled: false }),
  ).toBe(true);
  expect(
    validateCoreIpcPayload(IPC.QualifiedScriptsSetEnabled, { id: 'github-zh', enabled: 'false' }),
  ).toBe(false);
});

it('IDM 仅接受闭合 URL 字段，不接收程序路径、命令参数或执行开关', () => {
  const url = 'https://example.com/file.zip';
  expect(validateCoreIpcPayload(IPC.IdmGetStatus, undefined)).toBe(true);
  expect(validateCoreIpcPayload(IPC.IdmGetStatus, {})).toBe(false);
  expect(validateCoreIpcPayload(IPC.IdmSend, { url })).toBe(true);
  for (const payload of [
    undefined,
    {},
    { url: 3 },
    { url: '' },
    { url: 'a'.repeat(8193) },
    { url, path: 'arbitrary.exe' },
    { url, args: ['/n'] },
    { url, shell: true },
    { url, [Symbol('hidden')]: true },
    Object.create({ url }),
    Object.defineProperty({}, 'url', { get: () => url }),
  ]) {
    expect(validateCoreIpcPayload(IPC.IdmSend, payload)).toBe(false);
  }
});

it('分组与用户脚本通道拒绝未知字段、路径、代码和不合法参数', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const channel of [IPC.TabsGetState, IPC.UserScriptsList, IPC.UserScriptsImport]) {
    expect(validateCoreIpcPayload(channel, undefined)).toBe(true);
    for (const payload of [{}, { path: 'arbitrary.user.js' }, { code: 'arbitrary' }])
      expect(validateCoreIpcPayload(channel, payload)).toBe(false);
  }
  const cases = [
    [IPC.TabsCreateGroup, { tabId: id, name: '阅读', color: 'blue' }],
    [IPC.TabsUpdateGroup, { groupId: id, name: '阅读', color: 'green', collapsed: false }],
    [IPC.TabsSetGroup, { tabId: id, groupId: null }],
    [IPC.TabsUngroup, { groupId: id }],
    [IPC.UserScriptsSetEnabled, { id, enabled: true }],
    [IPC.UserScriptsRemove, { id }],
  ] as const;
  for (const [channel, payload] of cases) {
    expect(validateCoreIpcPayload(channel, payload)).toBe(true);
    expect(validateCoreIpcPayload(channel, { ...payload, code: 'arbitrary' })).toBe(false);
    expect(validateCoreIpcPayload(channel, Object.create(payload))).toBe(false);
    expect(validateCoreIpcPayload(channel, { ...payload, [Symbol('hidden')]: true })).toBe(false);
  }
  expect(validateCoreIpcPayload(IPC.UserScriptsSetEnabled, { id, enabled: 'true' })).toBe(false);
  expect(validateCoreIpcPayload(IPC.UserScriptsRemove, { id: '../config' })).toBe(false);
  expect(validateCoreIpcPayload(IPC.TabsSetGroup, { tabId: id, groupId: 'wrong' })).toBe(false);
});

it('托盘偏好读取零参数且写入只接受闭合布尔值', () => {
  expect(validateCoreIpcPayload(IPC.AppPreferencesGet, undefined)).toBe(true);
  for (const payload of [{}, { runInTray: false }, new Date()])
    expect(validateCoreIpcPayload(IPC.AppPreferencesGet, payload)).toBe(false);

  expect(validateCoreIpcPayload(IPC.AppPreferencesSet, { runInTray: true })).toBe(true);
  expect(validateCoreIpcPayload(IPC.AppPreferencesSet, { runInTray: false })).toBe(true);
  for (const payload of [
    undefined,
    {},
    { runInTray: 'true' },
    { runInTray: true, startup: true },
    Object.create({ runInTray: true }),
    new (class {
      runInTray = true;
    })(),
  ])
    expect(validateCoreIpcPayload(IPC.AppPreferencesSet, payload)).toBe(false);
});

it('浏览资料库严格限制查询、标识、网址与外观枚举', () => {
  const request = { query: '', cursor: null, limit: 50 };
  expect(validateCoreIpcPayload('browser-library:history-list', request)).toBe(true);
  for (const payload of [
    undefined,
    { ...request, limit: 101 },
    { ...request, sql: 'SELECT 1' },
    Object.create(request),
    { ...request, cursor: { at: 'bad', id: 'bad' } },
  ])
    expect(validateCoreIpcPayload('browser-library:history-list', payload)).toBe(false);
  for (const channel of [
    'browser-library:history-clear',
    'browser-library:bookmark-add-current',
    'browser-library:status',
  ]) {
    expect(validateCoreIpcPayload(channel, undefined)).toBe(true);
    for (const payload of [{ path: 'private' }, new Date(), { [Symbol('x')]: true }])
      expect(validateCoreIpcPayload(channel, payload)).toBe(false);
  }
  expect(validateCoreIpcPayload('ui:appearance', { appearance: 'dark' })).toBe(true);
  expect(validateCoreIpcPayload('ui:appearance', { appearance: 'system', color: 'red' })).toBe(
    false,
  );
  expect(validateCoreIpcPayload('ui:appearance', { appearance: 'invalid' })).toBe(false);
});

it('主题色IPC只接受旧模式或新闭合模式加RGB色种子，不开放任意样式', () => {
  for (const appearance of ['system', 'light', 'dark']) {
    expect(validateCoreIpcPayload(IPC.UiAppearance, { appearance })).toBe(true);
    for (const themeColor of [null, '#000000', '#FFFFFF', '#a1B2c3'])
      expect(validateCoreIpcPayload(IPC.UiAppearance, { appearance, themeColor })).toBe(true);
  }
  for (const themeColor of [
    undefined,
    '',
    'red',
    '#fff',
    '#11223344',
    ' #112233',
    '#112233\n',
    'rgb(1,2,3)',
    'url(file:///private)',
    {},
    1,
    false,
  ])
    expect(validateCoreIpcPayload(IPC.UiAppearance, { appearance: 'dark', themeColor })).toBe(
      false,
    );
  for (const payload of [
    { appearance: 'dark', themeColor: null, color: '#000000' },
    { themeColor: '#112233' },
    { appearance: 'other', themeColor: '#112233' },
    { appearance: 'dark', themeColor: null, [Symbol('x')]: true },
    Object.assign(new Date(), { appearance: 'dark', themeColor: null }),
  ])
    expect(validateCoreIpcPayload(IPC.UiAppearance, payload)).toBe(false);
});

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
