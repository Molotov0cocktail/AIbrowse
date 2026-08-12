import { describe, expect, it } from 'vitest';
import { resolvePermissionCheck, resolvePermissionRequest } from './permission-policy';

// 契约源：doc/detailed-design.md §11（2026-08-13 安全补丁：远程网页权限默认拒绝）。
// 纯策略函数测试（无 Electron mock）：v1 对一切权限类型与来源安全返回 false（拒绝）。

// Electron 43.4.0 setPermissionCheckHandler / setPermissionRequestHandler 的权限类型并集
const ALL_PERMISSIONS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'keyboardLock',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'usb',
  'window-management',
];

describe('权限策略（v1 默认拒绝）', () => {
  it('对全部已知权限类型的请求与检查一律拒绝（含正常 https 来源）', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(resolvePermissionRequest(permission, 'https://example.com/page')).toBe(false);
      expect(resolvePermissionCheck(permission, 'https://example.com')).toBe(false);
    }
  });

  it('对未知/畸形权限类型安全拒绝（越界安全返回）', () => {
    for (const permission of ['', 'superpower', 'MEDIA', 'media ', 'no-such-permission', 'null']) {
      expect(resolvePermissionRequest(permission, 'https://example.com/')).toBe(false);
      expect(resolvePermissionCheck(permission, 'https://example.com')).toBe(false);
    }
  });

  it('对畸形/空来源安全拒绝', () => {
    for (const origin of [
      '',
      '   ',
      'not a url',
      'javascript:alert(1)',
      'about:blank',
      'file:///C:/a.html',
    ]) {
      expect(resolvePermissionRequest('media', origin)).toBe(false);
      expect(resolvePermissionCheck('media', origin)).toBe(false);
    }
  });

  it('默认拒绝不区分来源：特权/本地/跨域来源一律拒绝', () => {
    expect(resolvePermissionRequest('notifications', 'file:///C:/x.html')).toBe(false);
    expect(resolvePermissionCheck('notifications', 'null')).toBe(false);
    expect(resolvePermissionCheck('geolocation', 'http://127.0.0.1:5173')).toBe(false);
  });
});
