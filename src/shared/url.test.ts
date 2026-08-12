import { describe, expect, it } from 'vitest';
import { resolveAddressBarInput } from './url';

// 契约源：First_stage.md §十（URL / 搜索框行为）+ AGENTS.md §5（URL 判断逻辑）
describe('resolveAddressBarInput（地址栏输入 → URL/搜索判断）', () => {
  it('https:// 开头的 URL 原样放行', () => {
    expect(resolveAddressBarInput('https://example.com/page')).toBe('https://example.com/page');
  });

  it('http:// 开头的 URL 原样放行', () => {
    expect(resolveAddressBarInput('http://example.com')).toBe('http://example.com/');
  });

  it('about: 内部页面放行（新建标签页需要 about:blank）', () => {
    expect(resolveAddressBarInput('about:blank')).toBe('about:blank');
  });

  it('裸域名自动补 https://', () => {
    expect(resolveAddressBarInput('example.com')).toBe('https://example.com/');
  });

  it('带路径/查询/端口的裸域名保留完整结构', () => {
    expect(resolveAddressBarInput('example.com:8080/a?b=1#c')).toBe(
      'https://example.com:8080/a?b=1#c',
    );
  });

  it('localhost 视为有效主机名', () => {
    expect(resolveAddressBarInput('localhost:5173')).toBe('https://localhost:5173/');
  });

  it('IP 地址 + 端口视为有效主机名', () => {
    expect(resolveAddressBarInput('192.168.1.1:8080')).toBe('https://192.168.1.1:8080/');
  });

  it('普通文本走搜索引擎 URL', () => {
    expect(resolveAddressBarInput('hello world')).toBe('https://www.bing.com/search?q=hello+world');
  });

  it('搜索词中的特殊字符被正确编码', () => {
    expect(resolveAddressBarInput('你好 & 世界?')).toBe(
      'https://www.bing.com/search?q=%E4%BD%A0%E5%A5%BD+%26+%E4%B8%96%E7%95%8C%3F',
    );
  });

  it('无点的单词（如 example）按搜索处理', () => {
    expect(resolveAddressBarInput('example')).toBe('https://www.bing.com/search?q=example');
  });

  it('空输入与纯空白安全返回空字符串', () => {
    expect(resolveAddressBarInput('')).toBe('');
    expect(resolveAddressBarInput('   ')).toBe('');
  });

  it('危险 scheme（javascript:）不被直开，按搜索处理', () => {
    expect(resolveAddressBarInput('javascript:alert(1)')).toBe(
      'https://www.bing.com/search?q=javascript%3Aalert%281%29',
    );
  });

  it('主机名统一转小写', () => {
    expect(resolveAddressBarInput('https://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('多余空白被修剪', () => {
    expect(resolveAddressBarInput('  example.com  ')).toBe('https://example.com/');
  });

  it('无法解析的 URL 安全返回空字符串（不抛异常）', () => {
    expect(resolveAddressBarInput('https://')).toBe('');
  });
});
