// UI 窗口导航保护策略纯函数测试（零 Electron 依赖）.
// Contract source: doc/detailed-design.md §9（UI 窗口导航保护，决议 #16）.
// 红→绿纪律：本测试先于 ui-navigation-policy.ts 实现落地（新模块缺失时先行失败）。

import { describe, expect, it } from 'vitest';
import { resolveUiNavigationAllowed } from './ui-navigation-policy';

const DEV_POLICY = { selfOrigin: 'http://localhost:5173', selfFileUrl: null };
const FILE_ENTRY = 'file:///D:/AIbrowse/out/renderer/index.html';
const FILE_POLICY = { selfOrigin: null, selfFileUrl: FILE_ENTRY };

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

describe('resolveUiNavigationAllowed — 生产模式（file: 入口精确匹配）', () => {
  it('放行入口文件自身及其 hash/query 导航（同一文档）', () => {
    expect(resolveUiNavigationAllowed(FILE_ENTRY, FILE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}#top`, FILE_POLICY)).toBe(true);
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}?v=1`, FILE_POLICY)).toBe(true);
  });

  it('拒绝同目录其他文件与字符串前缀扩展（非入口文件一律拒绝）', () => {
    // 旧前缀语义下 index.htmlx 会被放行；精确匹配必须拒绝（只允许准确的 renderer 入口）
    expect(resolveUiNavigationAllowed(`${FILE_ENTRY}x`, FILE_POLICY)).toBe(false);
    expect(
      resolveUiNavigationAllowed('file:///D:/AIbrowse/out/renderer/other.html', FILE_POLICY),
    ).toBe(false);
  });

  it('拒绝路径穿越与大小写变体（失败关闭，不做宽松本地文件判断）', () => {
    expect(
      resolveUiNavigationAllowed(
        'file:///D:/AIbrowse/out/renderer/index.html/../other.html',
        FILE_POLICY,
      ),
    ).toBe(false);
    expect(
      resolveUiNavigationAllowed('file:///d:/aibrowse/out/renderer/index.html', FILE_POLICY),
    ).toBe(false);
  });

  it('拒绝远程 URL、其他 scheme 与畸形输入', () => {
    expect(resolveUiNavigationAllowed('https://example.com/', FILE_POLICY)).toBe(false);
    // javascript:/about: 等 origin 为 'null' 的 URL 同样不匹配 file: 入口
    expect(resolveUiNavigationAllowed('javascript:alert(1)', FILE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('about:blank', FILE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('', FILE_POLICY)).toBe(false);
    expect(resolveUiNavigationAllowed('not a url', FILE_POLICY)).toBe(false);
  });
});

describe('resolveUiNavigationAllowed — 防御语义', () => {
  it('双空策略（装配错误）一律拒绝', () => {
    const emptyPolicy = { selfOrigin: null, selfFileUrl: null };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', emptyPolicy)).toBe(false);
    expect(resolveUiNavigationAllowed(FILE_ENTRY, emptyPolicy)).toBe(false);
  });

  it('两字段同时存在时 origin 优先（互斥由装配保证，防御性固化）', () => {
    const both = { selfOrigin: 'http://localhost:5173', selfFileUrl: FILE_ENTRY };
    expect(resolveUiNavigationAllowed('http://localhost:5173/', both)).toBe(true);
    expect(resolveUiNavigationAllowed(FILE_ENTRY, both)).toBe(false);
  });
});
