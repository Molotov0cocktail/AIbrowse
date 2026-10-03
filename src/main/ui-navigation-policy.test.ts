// UI 窗口导航保护策略纯函数测试（零 Electron 依赖）.
// Contract source: doc/detailed-design.md §9（UI 窗口导航保护，决议 #16）.
// 红→绿纪律：本测试先于 ui-navigation-policy.ts 实现落地（新模块缺失时先行失败）。

import { describe, expect, it } from 'vitest';
import { resolveUiNavigationAllowed } from './ui-navigation-policy';

const DEV_POLICY = { selfOrigin: 'http://localhost:5173', selfFileUrl: null, selfAppUrl: null };
const FILE_ENTRY = 'file:///D:/AIbrowse/out/renderer/index.html';
const FILE_POLICY = { selfOrigin: null, selfFileUrl: FILE_ENTRY, selfAppUrl: null };
const RELEASE_ENTRY = 'aibrowse://app/index.html';
const RELEASE_POLICY = { selfOrigin: null, selfFileUrl: null, selfAppUrl: RELEASE_ENTRY };

describe('resolveUiNavigationAllowed — 开发模式（origin 白名单）', () => {
  it('放行同 origin 的任意路径/查询/片段', () => {
    expect(resolveUiNavigationAllowed('http://localhost:5173/', DEV_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed('http://localhost:5173/some/route?q=1#top', DEV_POLICY)).toBe(
      true,
    );
  });

  it('拒绝跨 origin 导航（远程页面是核心威胁）', () => {
    expect(resolveUiNavigationAllowed('https://example.com/', DEV_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('https://evil.example.com/', DEV_POLICY)).toBe(false);
  });

  it('拒绝同 host 但端口/协议不同（严格 origin 相等）', () => {
    expect(resolveUiNavigationAllowed('http://localhost:5174/', DEV_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('https://localhost:5173/', DEV_POLICY)).toBe(false);
  });

  it('拒绝畸形与非 web URL（越界安全返回，不抛异常）', () => {
    expect(resolveUiNavigationAllowed('', DEV_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('not a url', DEV_POLICY)).toBe(false);
    // javascript:/about: 的 origin 为 'null'，不匹配任何自身 origin
    expect(resolveUiNavigationAllowed('javascript:alert(1)', DEV_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('about:blank', DEV_POLICY)).toBe(false);
  });
});

describe('resolveUiNavigationAllowed — release 模式（aibrowse: 入口精确匹配）', () => {
  it('只放行入口自身及 hash 路由，拒绝 query 变体', () => {
    expect(resolveUiNavigationAllowed(RELEASE_ENTRY, RELEASE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${RELEASE_ENTRY}#top`, RELEASE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${RELEASE_ENTRY}?v=1`, RELEASE_POLICY)).toBe(false);
  });

  it('拒绝同目录其他文件与字符串前缀扩展（非入口文件一律拒绝）', () => {
    // 旧前缀语义下 index.htmlx 会被放行；精确匹配必须拒绝（只允许准确的 renderer 入口）
    expect(resolveUiNavigationAllowed(`${RELEASE_ENTRY}x`, RELEASE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('aibrowse://app/other.html', RELEASE_POLICY)).toBe(false);
  });

  it('拒绝路径穿越、其他 host 和编码变体', () => {
    expect(
      resolveUiNavigationAllowed('aibrowse://app/index.html/../other.html', RELEASE_POLICY),
    ).toBe(false);
    expect(resolveUiNavigationAllowed('aibrowse://evil/index.html', RELEASE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('aibrowse://app/%69ndex.html', RELEASE_POLICY)).toBe(false);
  });

  it('拒绝远程 URL、其他 scheme 与畸形输入', () => {
    expect(resolveUiNavigationAllowed('https://example.com/', RELEASE_POLICY)).toBe(false);
    expect(
      resolveUiNavigationAllowed('file:///D:/AIbrowse/out/renderer/index.html', RELEASE_POLICY),
    ).toBe(false);
    expect(resolveUiNavigationAllowed('javascript:alert(1)', RELEASE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('about:blank', RELEASE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('', RELEASE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('not a url', RELEASE_POLICY)).toBe(false);
  });
});

describe('resolveUiNavigationAllowed — 防御语义', () => {
  it('双空策略（装配错误）一律拒绝', () => {
    const emptyPolicy = { selfOrigin: null, selfFileUrl: null, selfAppUrl: null };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', emptyPolicy)).toBe(false);
    expect(resolveUiNavigationAllowed(RELEASE_ENTRY, emptyPolicy)).toBe(false);
  });

  it('两字段同时存在时 origin 优先（互斥由装配保证，防御性固化）', () => {
    const both = {
      selfOrigin: 'http://localhost:5173',
      selfFileUrl: null,
      selfAppUrl: RELEASE_ENTRY,
    };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', both)).toBe(true);
    expect(resolveUiNavigationAllowed(RELEASE_ENTRY, both)).toBe(false);
  });
});

describe('resolveUiNavigationAllowed — production preview（file: 入口精确匹配）', () => {
  it('保留既有唯一入口兼容，拒绝同目录文件和远程 URL', () => {
    expect(resolveUiNavigationAllowed(FILE_ENTRY, FILE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}#route`, FILE_POLICY)).toBe(true);
    expect(
      resolveUiNavigationAllowed('file:///D:/AIbrowse/out/renderer/other.html', FILE_POLICY),
    ).toBe(false);
    expect(resolveUiNavigationAllowed('https://example.com/', FILE_POLICY)).toBe(false);
    expect(
      resolveUiNavigationAllowed(
        'file:///D:/AIbrowse/out/renderer/assets/../index.html',
        FILE_POLICY,
      ),
    ).toBe(false);
  });
});
