// D3 network-policy tests: URL/IP/DNS 确定性策略（detailed-design §6.1、
// threat-model WRT-01～WRT-03）。零 socket、security_rejected、fail-closed。
import { describe, expect, it } from 'vitest';
import { classifyIpAddress, isAllowedPublicAddress, validatePublicUrl } from './network-policy';

describe('validatePublicUrl — 合法 URL 规范化', () => {
  it('https 省略端口规范化为省略形式', () => {
    const r = validatePublicUrl('https://example.com/feed.xml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.scheme).toBe('https');
    expect(r.target.host).toBe('example.com');
    expect(r.target.port).toBe(443);
    expect(r.target.url).toBe('https://example.com/feed.xml');
  });

  it('http 显式 :80 与省略端口均接受并规范化', () => {
    const a = validatePublicUrl('http://example.com/feed');
    const b = validatePublicUrl('http://example.com:80/feed');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.target.url).toBe('http://example.com/feed');
    expect(b.target.url).toBe('http://example.com/feed');
    expect(a.target.port).toBe(80);
  });

  it('https 显式 :443 接受', () => {
    const r = validatePublicUrl('https://example.com:443/x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.port).toBe(443);
    expect(r.target.url).toBe('https://example.com/x');
  });

  it('host 规范化：大写、尾点、IPv6 去括号', () => {
    const a = validatePublicUrl('http://EXAMPLE.COM./feed');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.target.host).toBe('example.com');

    // IPv6 字面量（公网）通过 host 形状校验；IP 级放行在连接 lookup 阶段
    const b = validatePublicUrl('http://[2001:4860:4860::8888]/x');
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.target.host).toBe('2001:4860:4860::8888');
  });

  it('fragment 移除、query 保留', () => {
    const r = validatePublicUrl('https://example.com/p?token=abc#frag');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.url).toBe('https://example.com/p?token=abc');
  });
});

describe('validatePublicUrl — 拒绝面（security_rejected）', () => {
  it('非 http/https scheme', () => {
    for (const u of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'chrome://x',
      'ftp://x/',
    ]) {
      const r = validatePublicUrl(u);
      expect(r.ok, u).toBe(false);
      if (!r.ok) expect(r.health).toBe('security_rejected');
    }
  });

  it('userinfo 拒绝', () => {
    for (const u of ['https://user@example.com/', 'https://user:pass@example.com/']) {
      expect(validatePublicUrl(u).ok, u).toBe(false);
    }
  });

  it('空 host / 非法 URL 拒绝', () => {
    expect(validatePublicUrl('').ok).toBe(false);
    expect(validatePublicUrl('https://').ok).toBe(false);
    expect(validatePublicUrl('http:///path').ok).toBe(false);
    expect(validatePublicUrl('not a url').ok).toBe(false);
  });

  it('非默认端口一律拒绝（含 scheme 与端口不匹配）', () => {
    for (const u of [
      'http://example.com:443/',
      'https://example.com:80/',
      'http://example.com:8080/',
      'https://example.com:8443/',
      'http://example.com:99999/',
      'http://example.com:abc/',
    ]) {
      const r = validatePublicUrl(u);
      expect(r.ok, u).toBe(false);
    }
  });

  it('localhost 与保留后缀拒绝', () => {
    for (const h of [
      'localhost',
      'foo.localhost',
      'x.local',
      'x.internal',
      'x.test',
      'x.example',
      'x.invalid',
      'x.onion',
      'x.localdomain',
      'x.lan',
      'x.home',
      'x.corp',
      'x.intranet',
      'x.priv',
    ]) {
      const r = validatePublicUrl(`https://${h}/`);
      expect(r.ok, h).toBe(false);
    }
  });

  it('host 含控制/非法字符拒绝', () => {
    expect(validatePublicUrl('https://exa mple.com/').ok).toBe(false);
    expect(validatePublicUrl('https://exa\nmple.com/').ok).toBe(false);
  });
});

describe('classifyIpAddress — IPv4', () => {
  it('私网/回环/链路本地/组播/保留分类', () => {
    expect(classifyIpAddress('10.0.0.1')).toBe('private');
    expect(classifyIpAddress('172.16.0.1')).toBe('private');
    expect(classifyIpAddress('172.31.255.255')).toBe('private');
    expect(classifyIpAddress('192.168.1.1')).toBe('private');
    expect(classifyIpAddress('127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('127.255.255.255')).toBe('loopback');
    expect(classifyIpAddress('169.254.169.254')).toBe('link-local');
    expect(classifyIpAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyIpAddress('100.64.0.1')).toBe('reserved');
    expect(classifyIpAddress('192.0.0.1')).toBe('reserved');
    expect(classifyIpAddress('192.0.2.1')).toBe('reserved');
    expect(classifyIpAddress('192.88.99.1')).toBe('reserved');
    expect(classifyIpAddress('198.18.0.1')).toBe('reserved');
    expect(classifyIpAddress('198.51.100.1')).toBe('reserved');
    expect(classifyIpAddress('203.0.113.1')).toBe('reserved');
    expect(classifyIpAddress('224.0.0.1')).toBe('multicast');
    expect(classifyIpAddress('239.255.255.255')).toBe('multicast');
    expect(classifyIpAddress('240.0.0.1')).toBe('reserved');
    expect(classifyIpAddress('255.255.255.255')).toBe('reserved');
  });

  it('公网 IPv4', () => {
    expect(classifyIpAddress('8.8.8.8')).toBe('public');
    expect(classifyIpAddress('93.184.216.34')).toBe('public');
    expect(classifyIpAddress('1.1.1.1')).toBe('public');
    expect(classifyIpAddress('172.32.0.1')).toBe('public'); // 172.32 不在 172.16/12
    expect(classifyIpAddress('11.0.0.1')).toBe('public');
  });

  it('非法输入 invalid', () => {
    expect(classifyIpAddress('')).toBe('invalid');
    expect(classifyIpAddress('999.1.1.1')).toBe('invalid');
    expect(classifyIpAddress('1.2.3')).toBe('invalid');
    expect(classifyIpAddress('not-an-ip')).toBe('invalid');
    expect(classifyIpAddress('1.2.3.4.5')).toBe('invalid');
  });
});

describe('classifyIpAddress — IPv6', () => {
  it('回环/未指定/链路本地/ULA/组播', () => {
    expect(classifyIpAddress('::1')).toBe('loopback');
    expect(classifyIpAddress('::')).toBe('unspecified');
    expect(classifyIpAddress('fe80::1')).toBe('link-local');
    expect(classifyIpAddress('febf::1')).toBe('link-local');
    expect(classifyIpAddress('fe90::1')).toBe('link-local');
    expect(classifyIpAddress('fc00::1')).toBe('private');
    expect(classifyIpAddress('fd00::1')).toBe('private');
    expect(classifyIpAddress('ff02::1')).toBe('multicast');
    expect(classifyIpAddress('fe80::1%lo0')).toBe('link-local');
  });

  it('6to4/NAT64/文档段/Teredo/ORCHID/discard 保留', () => {
    expect(classifyIpAddress('2002::1')).toBe('reserved');
    expect(classifyIpAddress('64:ff9b::1')).toBe('reserved');
    expect(classifyIpAddress('2001:db8::1')).toBe('reserved');
    expect(classifyIpAddress('2001::1')).toBe('reserved');
    expect(classifyIpAddress('2001:10::1')).toBe('reserved');
    expect(classifyIpAddress('100::1')).toBe('reserved');
  });

  it('IPv4-mapped 按内嵌 IPv4 分类', () => {
    expect(classifyIpAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('::ffff:192.168.1.1')).toBe('private');
    expect(classifyIpAddress('::ffff:8.8.8.8')).toBe('public');
  });

  it('公网 IPv6', () => {
    expect(classifyIpAddress('2001:4860:4860::8888')).toBe('public');
    expect(classifyIpAddress('2606:4700:4700::1111')).toBe('public');
  });
});

describe('isAllowedPublicAddress', () => {
  it('只放行公网 unicast；其余 fail-closed', () => {
    expect(isAllowedPublicAddress('8.8.8.8')).toBe(true);
    expect(isAllowedPublicAddress('2001:4860:4860::8888')).toBe(true);
    expect(isAllowedPublicAddress('10.0.0.1')).toBe(false);
    expect(isAllowedPublicAddress('127.0.0.1')).toBe(false);
    expect(isAllowedPublicAddress('::1')).toBe(false);
    expect(isAllowedPublicAddress('fe80::1')).toBe(false);
    expect(isAllowedPublicAddress('not-an-ip')).toBe(false);
  });
});
