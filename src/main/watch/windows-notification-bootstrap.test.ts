import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  configureWindowsNotificationIdentity,
  qualifyWindowsNotification,
  WINDOWS_NOTIFICATION_APP_ID,
  type WindowsNotificationQualification,
} from './windows-notification-bootstrap';

describe('Windows 通知实际身份配置', () => {
  const base = {
    platform: 'win32' as const,
    packaged: true,
    identityConfigured: true,
    supported: true,
  };

  it('固定 AUMID 的真实 setter 成功后才授予资格', () => {
    const setter = vi.fn();
    const identityConfigured = configureWindowsNotificationIdentity(setter);
    expect(setter).toHaveBeenCalledExactlyOnceWith(WINDOWS_NOTIFICATION_APP_ID);
    expect(qualifyWindowsNotification({ ...base, identityConfigured })).toEqual({
      available: true,
      reason: null,
    });
  });

  it('setter 异常仅禁用通知，不回显错误正文', () => {
    const setter = vi.fn(() => {
      throw new Error('private platform error');
    });
    const identityConfigured = configureWindowsNotificationIdentity(setter);
    expect(setter).toHaveBeenCalledExactlyOnceWith(WINDOWS_NOTIFICATION_APP_ID);
    expect(qualifyWindowsNotification({ ...base, identityConfigured })).toEqual({
      available: false,
      reason: 'identity-not-configured',
    });
  });

  it.each([
    [{ ...base, identityConfigured: false }, 'identity-not-configured'],
    [{ ...base, supported: false }, 'unsupported'],
    [{ ...base, packaged: false }, 'not-packaged'],
    [{ ...base, platform: 'linux' as const }, 'not-windows'],
    [{ ...base, platform: 'darwin' as const }, 'not-windows'],
    [{ ...base, packaged: false, identityConfigured: false }, 'not-packaged'],
  ] as const)('缺少资格时保持不可用：%s', (input, reason) => {
    expect(qualifyWindowsNotification(input)).toEqual({ available: false, reason });
  });

  it('生产装配消费实际配置成功状态，不能保留硬编码 false', () => {
    const filename = new URL('../index.ts', import.meta.url);
    const source = ts.createSourceFile(
      filename.pathname,
      readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'windowsQualificationResult'
      ) {
        initializer = node.initializer;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!initializer) throw new Error('Windows 通知装配入口缺失');
    const expression = ts.transpileModule(`return (${initializer.getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2023 },
    }).outputText;
    const evaluate = new Function(
      'qualifyWindowsNotification',
      'process',
      'app',
      'Notification',
      'windowsNotificationIdentityConfigured',
      expression,
    ) as (
      qualify: typeof qualifyWindowsNotification,
      process: { platform: 'win32' },
      app: { isPackaged: boolean },
      notification: { isSupported(): boolean },
      identityConfigured: boolean,
    ) => WindowsNotificationQualification;
    expect(
      evaluate(
        qualifyWindowsNotification,
        { platform: 'win32' },
        { isPackaged: true },
        { isSupported: () => true },
        configureWindowsNotificationIdentity(() => undefined),
      ),
    ).toEqual({ available: true, reason: null });
  });
});
