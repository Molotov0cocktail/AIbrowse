// UI 窗口导航保护策略纯函数测试（零 Electron 依赖）.
// Contract source: doc/detailed-design.md §9（UI 窗口导航保护，决议 #16）.
// 红→绿纪律：本测试先于 ui-navigation-policy.ts 实现落地（新模块缺失时先行失败）。

import { describe, expect, it } from 'vitest';
import { resolveUiNavigationAllowed } from './ui-navigation-policy';

const DEV_POLICY = { selfOrigin: 'http://localhost:5173', selfFilePrefix: null };
const FILE_ENTRY = 'file:///D:/AIbrowse/out/renderer/index.html';
const FILE_POLICY = { selfOrigin: null, selfFilePrefix: FILE_ENTRY };

describe('resolveUiNavigationAllowed — 开发模式（origin 白名单）', () => {
  it('放行同 origin 的任意路径/查询/片段', () => {
    expect(resolveUiNavigationAllowed('http://localhost:5173/', DEV_POLICY)).toBe(true);
    expect(
      resolveUiNavigationAllowed('http://localhost:5173/some/route?q=1#top', DEV_POLICY),
    ).toBe(true);
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

describe('resolveUiNavigationAllowed — 生产模式（file: 入口前缀）', () => {
  it('放行入口文件自身及其 hash/query 导航', () => {
    expect(resolveUiNavigationAllowed(FILE_ENTRY, FILE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}#top`, FILE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}?v=1`, FILE_POLICY)).toBe(true);
  });

  it('按入口文件路径前缀匹配（§9 定稿语义）', () => {
    // 定稿：生产按入口文件路径前缀匹配——index.htmlx 满足字符串前缀，同样放行
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}x`, FILE_POLICY)).toBe(true);
  });

  it('拒绝其他 file: 路径与远程 URL', () => {
    expect(
      resolveUiNavigationAllowed('file:///D:/AIbrowse/out/renderer/other.html', FILE_POLICY),
    ).toBe(false);
    expect(resolveUiNavigationAllowed('file:///C:/other.html', FILE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('https://example.com/', FILE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('', FILE_POLICY)).toBe(false);
  });
});

describe('resolveUiNavigationAllowed — 防御语义', () => {
  it('双空策略（装配错误）一律拒绝', () => {
    const emptyPolicy = { selfOrigin: null, selfFilePrefix: null };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', emptyPolicy)).toBe(false);
    expect(resolveUiNavigationAllowed(FILE_ENTRY, emptyPolicy)).toBe(false);
  });

  it('两字段同时存在时 origin 优先（互斥由装配保证，防御性固化）', () => {
    const both = { selfOrigin: 'http://localhost:5173', selfFilePrefix: FILE_ENTRY };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', both)).toBe(true);
    expect(resolveUiNavigationAllowed(FILE_ENTRY, both)).toBe(false);
  });
});
