// D3 robots-policy tests: RFC 9309 子集（detailed-design §6.2）。allow/disallow、
// UA 选择、最长匹配、空/畸形/超长、缓存 24h、host 变化、不可解析/安全拒绝 fail-closed、
// disallow 无 override。D5 的全局/主机并发与 5 秒共享 gate 不在本模块。
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { ROBOTS_CACHE_MS } from '../../shared/types/watch';
import {
  evaluateRobotsPath,
  parseRobotsText,
  RobotsPolicy,
  robotsDecisionToHealth,
} from './robots-policy';
import type { PublicFetchResult, PublicRequest } from './public-watch-http-client';

describe('parseRobotsText — 文本解析', () => {
  it('allow/disallow 分组与 UA 选择', () => {
    const text = 'User-agent: aibrowse\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n';
    const r = parseRobotsText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(2);
  });

  it('注释、空行、大小写、空白处理', () => {
    const text = '# comment\n\nUSER-AGENT:   AIbrowse  \nDISALLOW:  /x  # trailing\nAllow: /x\n';
    const r = parseRobotsText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(1);
    const g = r.rules.groups[0]!;
    expect(g.uaTokens).toEqual(['aibrowse']);
    expect(g.rules.length).toBe(2);
  });

  it('规则先于 UA 行的忽略；sitemap 忽略', () => {
    const text = 'Disallow: /\nUser-agent: aibrowse\nAllow: /ok\nSitemap: https://x/s.xml\n';
    const r = parseRobotsText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.rules.groups[0]!;
    expect(g.rules.length).toBe(1);
    expect(g.rules[0]!.pattern).toBe('/ok');
  });

  it('空 Disallow 值 = 无限制（不添加规则）', () => {
    const r = parseRobotsText('User-agent: aibrowse\nDisallow:\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups[0]!.rules.length).toBe(0);
  });

  it('规则数超上限 → 不可解析（fail-closed）', () => {
    const lines = ['User-agent: aibrowse'];
    for (let i = 0; i < 1100; i += 1) lines.push(`Disallow: /p${i}`);
    const r = parseRobotsText(lines.join('\n'), 1024);
    expect(r.ok).toBe(false);
  });

  it('二进制垃圾 → 不可解析', () => {
    const garbage = `User-agent: aibrowse\nDisallow: /\n\u0000\u0001\u0002`;
    const r = parseRobotsText(garbage);
    expect(r.ok).toBe(false);
  });

  it('空文本 → 无规则（允许全部）', () => {
    const r = parseRobotsText('');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(0);
  });
});

describe('evaluateRobotsPath — 最长匹配与 UA 选择', () => {
  const parse = (text: string) => {
    const r = parseRobotsText(text);
    if (!r.ok) throw new Error('parse failed');
    return r.rules;
  };

  it('最长匹配：更具体的规则优先', () => {
    const rules = parse('User-agent: aibrowse\nAllow: /public/\nDisallow: /public/private/\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/public/a')).toBe(true);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/public/private/x')).toBe(false);
  });

  it('无匹配 → 允许', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /x\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/y')).toBe(true);
  });

  it('UA 选择：具体 product 组优先，通配组不参与（RFC 9309 单选组）', () => {
    const rules = parse('User-agent: aibrowse\nAllow: /ok\n\nUser-agent: *\nDisallow: /\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/ok')).toBe(true);
    // 存在 aibrowse 具体组时，* 组不参与 → /other 无匹配 → allowed
    expect(evaluateRobotsPath(rules, 'aibrowse', '/other')).toBe(true);
    // 无具体组时回退 * 组
    const rules2 = parse('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /x\n');
    expect(evaluateRobotsPath(rules2, 'aibrowse', '/x')).toBe(false);
    expect(evaluateRobotsPath(rules2, 'aibrowse', '/y')).toBe(true);
  });

  it('只匹配本 product 的具体组；其它 product 组不影响', () => {
    const rules = parse('User-agent: googlebot\nDisallow: /\nUser-agent: aibrowse\nAllow: /\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/x')).toBe(true);
  });

  it('含 query 的路径匹配', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /feed?private\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/feed?private=1')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/feed?other=1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RobotsPolicy（fake client）
// ---------------------------------------------------------------------------

class FakeRobotsClient {
  requests: PublicRequest[] = [];
  private queue: PublicFetchResult[] = [];
  constructor(initial: PublicFetchResult[] = []) {
    this.queue = initial;
  }
  queueResponse(r: PublicFetchResult): void {
    this.queue.push(r);
  }
  async get(req: PublicRequest): Promise<PublicFetchResult> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next) return next;
    return { kind: 'failed', health: 'unavailable', reason: 'no-response' };
  }
}

function okBody(status: number, body: string): PublicFetchResult {
  return {
    kind: 'ok',
    meta: {
      finalUrl: 'https://example.com/robots.txt',
      statusCode: status,
      statusMessage: '',
      contentType: 'text/plain',
      contentEncoding: null,
      etag: null,
      lastModified: null,
      retryAfter: null,
      fetchedAt: '2024-01-01T00:00:00.000Z',
      byteLength: Buffer.byteLength(body, 'utf8'),
      compressedByteLength: 0,
    },
    body: Buffer.from(body, 'utf8'),
  };
}

function failed(
  health: 'security_rejected' | 'budget_exceeded' | 'unavailable' | 'parse_changed',
): PublicFetchResult {
  return { kind: 'failed', health, reason: health };
}

describe('RobotsPolicy.checkAllowed', () => {
  it('robots 404 → allowed（无 robots）', async () => {
    const client = new FakeRobotsClient([okBody(404, '')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('allowed');
  });

  it('robots Disallow: / → disallowed（无 override）', async () => {
    const client = new FakeRobotsClient([okBody(200, 'User-agent: aibrowse\nDisallow: /\n')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('disallowed');
  });

  it('robots Disallow: /private → 命中路径 disallowed，其它 allowed', async () => {
    const client = new FakeRobotsClient([
      okBody(200, 'User-agent: aibrowse\nDisallow: /private/\n'),
      okBody(200, 'User-agent: aibrowse\nDisallow: /private/\n'),
    ]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    expect((await policy.checkAllowed({ url: 'https://example.com/private/x' })).kind).toBe(
      'disallowed',
    );
    expect((await policy.checkAllowed({ url: 'https://example.com/public' })).kind).toBe('allowed');
  });

  it('robots 200 但不可解析 → unavailable（fail-closed）', async () => {
    const client = new FakeRobotsClient([okBody(200, '\u0000\u0001binary')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 获取安全拒绝 → security-rejected', async () => {
    const client = new FakeRobotsClient([failed('security_rejected')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('security-rejected');
  });

  it('robots 403 → unavailable（不假定允许）', async () => {
    const client = new FakeRobotsClient([okBody(403, '')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 5xx → unavailable（不假定允许）', async () => {
    const client = new FakeRobotsClient([okBody(503, '')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 其它 4xx（如 404 之外的 400）→ allowed（RFC 9309 视为无文件）', async () => {
    const client = new FakeRobotsClient([okBody(400, '')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('allowed');
  });

  it('robots 请求经 NetworkPolicy（URL 为 robots.txt，purpose=robots）', async () => {
    const client = new FakeRobotsClient([okBody(200, 'User-agent: aibrowse\nAllow: /\n')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(client.requests.length).toBe(1);
    expect(client.requests[0]!.url).toBe('https://example.com/robots.txt');
    expect(client.requests[0]!.purpose).toBe('robots');
  });

  it('非法目标 URL → security-rejected（零请求）', async () => {
    const client = new FakeRobotsClient();
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'file:///etc/passwd' });
    expect(d.kind).toBe('security-rejected');
    expect(client.requests.length).toBe(0);
  });
});

describe('RobotsPolicy 缓存（24h）与 host 变化', () => {
  it('缓存命中不再抓取；过期后重新抓取', async () => {
    const clock = new FakeClock(0);
    const client = new FakeRobotsClient([okBody(200, 'User-agent: aibrowse\nAllow: /\n')]);
    const policy = new RobotsPolicy({ client, clock });
    await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(client.requests.length).toBe(1);

    // 24h 内命中缓存
    clock.pushNow(ROBOTS_CACHE_MS - 1);
    await policy.checkAllowed({ url: 'https://example.com/other' });
    expect(client.requests.length).toBe(1);

    // 过期后重新抓取
    clock.pushNow(ROBOTS_CACHE_MS + 1);
    client.queueResponse(okBody(200, 'User-agent: aibrowse\nAllow: /\n'));
    await policy.checkAllowed({ url: 'https://example.com/other' });
    expect(client.requests.length).toBe(2);
  });

  it('host 变化 → 重新抓取', async () => {
    const client = new FakeRobotsClient([
      okBody(200, 'User-agent: aibrowse\nAllow: /\n'),
      okBody(200, 'User-agent: aibrowse\nAllow: /\n'),
    ]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    await policy.checkAllowed({ url: 'https://a.example.com/feed' });
    await policy.checkAllowed({ url: 'https://b.example.com/feed' });
    expect(client.requests.length).toBe(2);
    expect(client.requests[0]!.url).toBe('https://a.example.com/robots.txt');
    expect(client.requests[1]!.url).toBe('https://b.example.com/robots.txt');
  });

  it('clearCache 幂等清空', async () => {
    const client = new FakeRobotsClient([
      okBody(200, 'User-agent: aibrowse\nAllow: /\n'),
      okBody(200, 'User-agent: aibrowse\nAllow: /\n'),
    ]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    await policy.checkAllowed({ url: 'https://example.com/feed' });
    policy.clearCache();
    await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(client.requests.length).toBe(2);
  });
});

describe('robotsDecisionToHealth', () => {
  it('决策到 health 映射（闭合）', () => {
    expect(robotsDecisionToHealth({ kind: 'allowed' })).toBeNull();
    expect(robotsDecisionToHealth({ kind: 'disallowed' })).toBe('robots_disallowed');
    expect(robotsDecisionToHealth({ kind: 'unavailable' })).toBe('unavailable');
    expect(robotsDecisionToHealth({ kind: 'security-rejected' })).toBe('security_rejected');
    expect(robotsDecisionToHealth({ kind: 'aborted' })).toBe('interrupted');
  });
});
