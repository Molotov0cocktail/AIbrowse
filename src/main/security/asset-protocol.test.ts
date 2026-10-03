import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ASSET_CSP,
  APP_ASSET_SCHEME,
  APP_ENTRY_URL,
  createAppAssetHandler,
  installAppAssetProtocol,
  registerAppAssetScheme,
  type AppAssetManifest,
} from './asset-protocol';

const MANIFEST: AppAssetManifest = {
  version: 1,
  assets: {
    '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/assets/main.js': { file: 'assets/main.js', contentType: 'text/javascript; charset=utf-8' },
  },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-assets-'));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>AIbrowse</title>');
  await writeFile(join(root, 'assets/main.js'), 'globalThis.__loaded = true;');
  return root;
}

describe('aibrowse 资产协议', () => {
  it('固定注册为 standard + secure，且不启用 CSP 绕过、Service Worker 或扩展', () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerAppAssetScheme({ registerSchemesAsPrivileged });
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: APP_ASSET_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          bypassCSP: false,
          allowServiceWorkers: false,
          allowExtensions: false,
        },
      },
    ]);
    expect(APP_ENTRY_URL).toBe('aibrowse://app/index.html');
  });

  it('只读取 manifest 映射，并在响应上施加闭合 CSP 与 nosniff', async () => {
    const handler = createAppAssetHandler(await fixtureRoot(), MANIFEST);
    const response = await handler({ url: APP_ENTRY_URL, method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>AIbrowse</title>');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(APP_ASSET_CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(APP_ASSET_CSP).toContain("script-src 'self'");
    expect(APP_ASSET_CSP).toContain("connect-src 'none'");
    expect(APP_ASSET_CSP).toContain("frame-src 'none'");
    expect(APP_ASSET_CSP).toContain("object-src 'none'");
    expect(APP_ASSET_CSP).toContain("form-action 'none'");
    expect(APP_ASSET_CSP).not.toContain('unsafe-eval');
    expect(APP_ASSET_CSP).not.toContain('http:');
    expect(APP_ASSET_CSP).not.toContain('https:');
  });

  it('允许同一清单资产的 query/hash，但 HEAD 不返回正文', async () => {
    const handler = createAppAssetHandler(await fixtureRoot(), MANIFEST);
    const withQuery = await handler({ url: `${APP_ENTRY_URL}?v=1#route`, method: 'GET' });
    expect(withQuery.status).toBe(200);
    const head = await handler({ url: APP_ENTRY_URL, method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it.each([
    'aibrowse://evil/index.html',
    'aibrowse://app:80/index.html',
    'aibrowse://user@app/index.html',
    'file:///C:/Windows/win.ini',
    'https://app/index.html',
    'aibrowse://app/unknown.js',
    'aibrowse://app/%2e%2e/index.html',
    'aibrowse://app/%252e%252e/index.html',
    'aibrowse://app/..%2findex.html',
    'aibrowse://app/assets%5cmain.js',
    'aibrowse://app/assets\\main.js',
    'aibrowse://app//server/share',
    'aibrowse://app/C:/secret.txt',
    'aibrowse://app/secret.txt:stream',
    'aibrowse://app/%00',
  ])('拒绝非固定来源、未知资产及路径语法：%s', async (url) => {
    const handler = createAppAssetHandler(await fixtureRoot(), MANIFEST);
    const response = await handler({ url, method: 'GET' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('拒绝非 GET/HEAD 方法，且不回显请求路径', async () => {
    const handler = createAppAssetHandler(await fixtureRoot(), MANIFEST);
    const response = await handler({ url: APP_ENTRY_URL, method: 'POST' });
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('');
  });

  it.each([
    { version: 2, assets: MANIFEST.assets },
    { version: 1, assets: { 'index.html': MANIFEST.assets['/index.html'] } },
    { version: 1, assets: { '/index.html': { file: '../secret', contentType: 'text/html' } } },
    { version: 1, assets: { '/index.html': { file: 'C:/secret', contentType: 'text/html' } } },
    {
      version: 1,
      assets: { '/index.html': { file: 'index.html', contentType: 'text/html\r\nx: y' } },
    },
  ])('manifest 自身越界时安装失败关闭：%j', async (manifest) => {
    const root = await fixtureRoot();
    expect(() => createAppAssetHandler(root, manifest as AppAssetManifest)).toThrow();
  });

  it('通过目标 Session 的 protocol 装配，重复或已有 handler 时失败关闭', async () => {
    const root = await fixtureRoot();
    const handle = vi.fn();
    const target = { isProtocolHandled: vi.fn(() => false), handle };
    installAppAssetProtocol(target, root, MANIFEST);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toBe(APP_ASSET_SCHEME);

    expect(() => installAppAssetProtocol(target, root, MANIFEST)).toThrow();
    expect(() =>
      installAppAssetProtocol(
        { isProtocolHandled: vi.fn(() => true), handle: vi.fn() },
        root,
        MANIFEST,
      ),
    ).toThrow();
  });
});
