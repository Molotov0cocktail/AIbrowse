import { describe, expect, it } from 'vitest';
import { redactTabIdForLog, redactUrlForLog, resolveAddressBarInput } from './url';

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

// C9（决议 #168）：日志用 URL 脱敏——URL query token 绝不进日志（FT-16）
describe('redactUrlForLog（日志 URL 脱敏）', () => {
  it('剥离 query 与 fragment，仅保留 scheme/host/path', () => {
    expect(redactUrlForLog('https://example.com/a?tok=SECRET#frag')).toBe('https://example.com/a');
  });

  it('无 query/fragment 的 URL 恒等', () => {
    expect(redactUrlForLog('https://example.com/a')).toBe('https://example.com/a');
  });

  it('about:blank 等内部页恒等', () => {
    expect(redactUrlForLog('about:blank')).toBe('about:blank');
  });

  it('畸形串尽力截断到 ? 或 # 之前（不抛异常）', () => {
    expect(redactUrlForLog('not-a-url?x=1')).toBe('not-a-url');
    expect(redactUrlForLog('not-a-url')).toBe('not-a-url');
  });

  it('多个敏感 query 参数全部剥离', () => {
    expect(redactUrlForLog('http://127.0.0.1:9/x?session=abc&key=def')).toBe(
      'http://127.0.0.1:9/x',
    );
  });
});

// D6 隐私红线（R2）：日志 tabId 脱敏——真实 tabId 字节零日志
describe('redactTabIdForLog（日志 tabId 脱敏）', () => {
  it('对同一 tabId 确定性生成不可逆短标签，且不含原始 tabId 字节', () => {
    const id = '12345678-1234-4abc-9def-123456789abc';
    const a = redactTabIdForLog(id);
    const b = redactTabIdForLog(id);
    expect(a).toBe(b); // 确定性
    expect(a).toMatch(/^tab#[0-9a-f]{12}$/); // sha256 前缀短标签
    expect(a).not.toContain(id);
    expect(a).not.toContain(id.slice(0, 8));
  });

  it('不同 tabId 产出不同标签', () => {
    expect(redactTabIdForLog('aaaa-1')).not.toBe(redactTabIdForLog('aaaa-2'));
  });

  it('空/非字符串安全返回固定占位', () => {
    expect(redactTabIdForLog('')).toBe('tab#<empty>');
    // @ts-expect-error — 运行时可传入非字符串（敌手形状），须安全处理
    expect(redactTabIdForLog(42)).toBe('tab#<empty>');
  });
});
