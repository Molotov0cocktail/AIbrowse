// 决议 #152(5)：URL 判定纯函数——Validator 与 Renderer 共用同一实现
// （绝对 http/https、禁止 userinfo）。任何危险形态必须安全返回 false。
import { describe, expect, it } from 'vitest';
import { isSafeMarkdownUrl } from './markdown-url';

describe('isSafeMarkdownUrl（决议 #152(5)：绝对 http/https + 禁止 userinfo）', () => {
  it('接受绝对 http/https URL', () => {
    expect(isSafeMarkdownUrl('https://example.com')).toBe(true);
    expect(isSafeMarkdownUrl('http://example.com')).toBe(true);
    expect(isSafeMarkdownUrl('https://example.com/a/b?q=1#frag')).toBe(true);
    expect(isSafeMarkdownUrl('https://example.com:8443/path')).toBe(true);
  });

  it('协议大小写归一（WHATWG 小写化）', () => {
    expect(isSafeMarkdownUrl('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(isSafeMarkdownUrl('Http://example.com')).toBe(true);
  });

  it('拒绝 javascript:/data:/file:/about: 等危险 scheme', () => {
    expect(isSafeMarkdownUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownUrl('javascript:void(0)')).toBe(false);
    expect(isSafeMarkdownUrl('data:text/html,<script>x</script>')).toBe(false);
    expect(isSafeMarkdownUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeMarkdownUrl('file:///C:/windows')).toBe(false);
    expect(isSafeMarkdownUrl('about:blank')).toBe(false);
    expect(isSafeMarkdownUrl('vbscript:x')).toBe(false);
    expect(isSafeMarkdownUrl('magnet:?xt=x')).toBe(false);
  });

  it('拒绝相对/协议相对/畸形 URL', () => {
    expect(isSafeMarkdownUrl('example.com')).toBe(false);
    expect(isSafeMarkdownUrl('/relative/path')).toBe(false);
    expect(isSafeMarkdownUrl('./local')).toBe(false);
    expect(isSafeMarkdownUrl('//evil.com/x')).toBe(false);
    expect(isSafeMarkdownUrl('')).toBe(false);
    expect(isSafeMarkdownUrl('not a url')).toBe(false);
    expect(isSafeMarkdownUrl('https://')).toBe(false);
  });

  it('拒绝 userinfo（user:pass@ / user@）', () => {
    expect(isSafeMarkdownUrl('https://user@example.com/')).toBe(false);
    expect(isSafeMarkdownUrl('https://user:pass@example.com/')).toBe(false);
    expect(isSafeMarkdownUrl('http://a@b@c.com/')).toBe(false);
  });

  it('非字符串输入安全返回 false（防御）', () => {
    expect(isSafeMarkdownUrl(42 as unknown as string)).toBe(false);
    expect(isSafeMarkdownUrl(null as unknown as string)).toBe(false);
    expect(isSafeMarkdownUrl(undefined as unknown as string)).toBe(false);
  });

  it('敌对畸形（嵌套 scheme 伪装/空格绕过）全部拒绝', () => {
    expect(isSafeMarkdownUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeMarkdownUrl(' https://example.com')).toBe(false);
    expect(isSafeMarkdownUrl('https://example.com ')).toBe(false);
    expect(isSafeMarkdownUrl('https://example.com\texpected')).toBe(false);
  });
});
