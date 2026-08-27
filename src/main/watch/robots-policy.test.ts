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

  it('raw C0/DEL 行被忽略，其余规则继续生效（R2 逐行隔离，不再文件级拒绝）', () => {
    const garbage = `User-agent: aibrowse\nDisallow: /\n\u0000\u0001\u0002`;
    const r = parseRobotsText(garbage);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(1);
    expect(r.rules.groups[0]!.rules.length).toBe(1);
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

  it('`*` 通配符：匹配 0 或多字符（RFC 9309 §2.2.3）', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /private/*/secret\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/private/a/secret')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/private//secret')).toBe(false); // 空匹配
    expect(evaluateRobotsPath(rules, 'aibrowse', '/private/x')).toBe(true);
  });

  it('`$` 结尾锚点：只匹配精确到路径尾', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /fish$\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/fish')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/fish.html')).toBe(true);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/fish/')).toBe(true);
  });

  it('`*.gif$` 后缀匹配（RFC 9309 §5.1）', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: *.gif$\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/a/b.gif')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/a/b.gifx')).toBe(true);
  });

  it('最长匹配（RFC 9309 §5.2）：更长 disallow 优先', () => {
    const rules = parse(
      'User-agent: aibrowse\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n',
    );
    expect(evaluateRobotsPath(rules, 'aibrowse', '/example/page/disallowed.gif')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/example/page/allowed.gif')).toBe(true);
  });

  it('allow 与 disallow 等价/同长度 → allow 优先', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /page\nAllow: /page\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/page/x')).toBe(true);
  });

  it('`*` 与字面量：最长 normalized octet（排除 `*` 与末尾 `$`）', () => {
    const rules = parse('User-agent: aibrowse\nAllow: /a*\nDisallow: /ab\n');
    // R2: specificity = /ab(3) > /a*(2) → disallow 胜（不再是通配吞掉的目标长度）
    expect(evaluateRobotsPath(rules, 'aibrowse', '/ab')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2：RFC 9309 逐行解析 / octet 规范化 / group 选择（先红后绿的甄别 oracle）
// ---------------------------------------------------------------------------

describe('R2 parseRobotsText — 换行与结构空白（RFC 9309 §2.3.1）', () => {
  it('CR、LF、CRLF 分别可解析；CRLF 不产生额外 record', () => {
    const variants = [
      'User-agent: aibrowse\r\nDisallow: /x\r\n',
      'User-agent: aibrowse\nDisallow: /x\n',
      'User-agent: aibrowse\rDisallow: /x\r',
    ];
    for (const text of variants) {
      const r = parseRobotsText(text);
      expect(r.ok, JSON.stringify(text)).toBe(true);
      if (!r.ok) continue;
      expect(r.rules.groups.length).toBe(1);
      expect(r.rules.groups[0]!.rules.length).toBe(1);
    }
  });

  it('RFC 结构位置 SP/HTAB 与行尾 comment 合法', () => {
    const text =
      ' \t User-agent \t : \t aibrowse \t # comment\n\t Disallow \t : \t /x \t # trailing\n';
    const r = parseRobotsText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(1);
    const g = r.rules.groups[0]!;
    expect(g.uaTokens).toEqual(['aibrowse']);
    expect(g.rules.length).toBe(1);
    expect(g.rules[0]!.pattern).toBe('/x');
  });
});

describe('R2 parseRobotsText — 逐行错误隔离（合法 UTF-8 内）', () => {
  it('raw NUL/其它 C0/DEL/C1 行被忽略，不改变 group，后续合法规则生效', () => {
    for (const bad of ['\u0001bad', '\u0000nul', '\u007fdel', '\u0085c1', 'no colon here']) {
      const text = `User-agent: aibrowse\n${bad}\nDisallow: /x\n`;
      const r = parseRobotsText(text);
      expect(r.ok, JSON.stringify(bad)).toBe(true);
      if (!r.ok) continue;
      // 坏行不终止/不新建 group：Disallow: /x 仍属于 aibrowse
      expect(r.rules.groups.length, JSON.stringify(bad)).toBe(1);
      expect(r.rules.groups[0]!.rules.length, JSON.stringify(bad)).toBe(1);
      expect(evaluateRobotsPath(r.rules, 'aibrowse', '/x'), JSON.stringify(bad)).toBe(false);
      expect(evaluateRobotsPath(r.rules, 'aibrowse', '/y'), JSON.stringify(bad)).toBe(true);
    }
  });

  it('malformed/truncated percent triplet 只忽略该条规则，前后规则继续使用', () => {
    const text =
      'User-agent: aibrowse\nDisallow: /good1\nDisallow: /bad%G1\nDisallow: /bad%2\nAllow: /good2\n';
    const r = parseRobotsText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.groups.length).toBe(1);
    expect(r.rules.groups[0]!.rules.length).toBe(2); // 坏规则不计入、不添加
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/good1')).toBe(false); // 前后规则仍生效
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/good2')).toBe(true);
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/other')).toBe(true);
  });

  it('1,024 parseable rules 接受，第 1,025 条 unavailable；坏行不计数', () => {
    const lines = ['User-agent: aibrowse'];
    for (let i = 0; i < 1024; i += 1) lines.push(`Disallow: /p${i}`);
    const r1024 = parseRobotsText(lines.join('\n'), 1024);
    expect(r1024.ok).toBe(true);
    // 1024 合法 + 5 条坏 percent 规则 → 仍接受（坏行不计数）
    const badLines = ['User-agent: aibrowse'];
    for (let i = 0; i < 1024; i += 1) badLines.push(`Disallow: /p${i}`);
    for (let i = 0; i < 5; i += 1) badLines.push(`Disallow: /bad%G${i}`);
    const rBad = parseRobotsText(badLines.join('\n'), 1024);
    expect(rBad.ok).toBe(true);
    // 1024 合法 + 1 条合法 → unavailable
    const over = ['User-agent: aibrowse'];
    for (let i = 0; i < 1025; i += 1) over.push(`Disallow: /p${i}`);
    const rOver = parseRobotsText(over.join('\n'), 1024);
    expect(rOver.ok).toBe(false);
  });
});

describe('R2 evaluateRobotsPath — octet 规范化与匹配', () => {
  const parse = (text: string) => {
    const r = parseRobotsText(text);
    if (!r.ok) throw new Error('parse failed');
    return r.rules;
  };

  it('/foo/%62%61%7A 与 /foo/baz 等价（unreserved 解码）', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /foo/%62%61%7A\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/baz')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/%62%61%7A')).toBe(false);
  });

  it('raw 非 ASCII 与对应 UTF-8 percent octets 等价', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /foo/\u30C4\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/%E3%83%84')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/\u30C4')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/x')).toBe(true);
  });

  it('%2F 不等于字面 /', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /foo/%2F\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/')).toBe(true);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo/%2F')).toBe(false);
  });

  it('%2A/%24 保持字面编码身份（不成为通配/锚点）', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /foo%2A\nAllow: /foo%24\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo*')).toBe(true); // %2A ≠ 通配 *
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo%2A')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo$')).toBe(true); // %24 ≠ 锚点 $
    expect(evaluateRobotsPath(rules, 'aibrowse', '/foo%24')).toBe(true);
  });

  it('/x%00y 是可解析规则并只匹配规范化 %00 身份', () => {
    const r = parseRobotsText('User-agent: aibrowse\nDisallow: /x%00y\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/x%00y')).toBe(false);
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/x\u0000y')).toBe(true); // raw NUL ≠ %00
  });

  it('%7F、孤立 %80/%E3 保持编码身份，不使文件 unavailable', () => {
    const r = parseRobotsText(
      'User-agent: aibrowse\nDisallow: /a%7Fb\nDisallow: /c%80d\nDisallow: /e%E3f\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/a%7Fb')).toBe(false);
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/c%80d')).toBe(false);
    expect(evaluateRobotsPath(r.rules, 'aibrowse', '/e%E3f')).toBe(false);
  });
});

describe('R2 group 选择与合并', () => {
  const parse = (text: string) => {
    const r = parseRobotsText(text);
    if (!r.ok) throw new Error('parse failed');
    return r.rules;
  };

  it('相同 UA 组规则合并', () => {
    const rules = parse('User-agent: aibrowse\nDisallow: /a\nUser-agent: aibrowse\nDisallow: /b\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/a')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/b')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/c')).toBe(true);
  });

  it('空 specific 组不回退 `*`（specific 存在即用 specific，规则为空即允许全部）', () => {
    const rules = parse('User-agent: aibrowse\nDisallow:\nAllow:\nUser-agent: *\nDisallow: /\n');
    expect(evaluateRobotsPath(rules, 'aibrowse', '/anything')).toBe(true);
  });

  it('`*`、仅末尾 raw `$`、最长 normalized octet、等长 allow 保持正确', () => {
    const rules = parse(
      'User-agent: aibrowse\nAllow: /public/\nDisallow: /public/private/\nDisallow: *.gif$\n',
    );
    expect(evaluateRobotsPath(rules, 'aibrowse', '/public/a')).toBe(true);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/public/private/x')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/a/b.gif')).toBe(false);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/a/b.gifx')).toBe(true);
    expect(evaluateRobotsPath(rules, 'aibrowse', '/x')).toBe(true);
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

function okBody(
  status: number,
  body: string,
  finalUrl = 'https://example.com/robots.txt',
): PublicFetchResult {
  return {
    kind: 'ok',
    meta: {
      finalUrl,
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

/** 原始字节 body（用于 fatal UTF-8 文件级门测试）。 */
function okBodyBytes(
  status: number,
  bytes: number[],
  finalUrl = 'https://example.com/robots.txt',
): PublicFetchResult {
  return {
    kind: 'ok',
    meta: {
      finalUrl,
      statusCode: status,
      statusMessage: '',
      contentType: 'text/plain',
      contentEncoding: null,
      etag: null,
      lastModified: null,
      retryAfter: null,
      fetchedAt: '2024-01-01T00:00:00.000Z',
      byteLength: bytes.length,
      compressedByteLength: 0,
    },
    body: Buffer.from(bytes),
  };
}

function unchangedHttp(): PublicFetchResult {
  return {
    kind: 'unchanged-http',
    meta: {
      finalUrl: 'https://example.com/robots.txt',
      statusCode: 304,
      statusMessage: 'Not Modified',
      contentType: null,
      contentEncoding: null,
      etag: '"x"',
      lastModified: null,
      retryAfter: null,
      fetchedAt: '2024-01-01T00:00:00.000Z',
      byteLength: 0,
      compressedByteLength: 0,
    },
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

  it('robots 200 但 fatal 非法 UTF-8 → unavailable（文件级 fail-closed，零部分规则）', async () => {
    const client = new FakeRobotsClient([okBodyBytes(200, [0x61, 0xff, 0x62])]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 200 但截断 UTF-8 → unavailable（文件级 fail-closed）', async () => {
    const client = new FakeRobotsClient([okBodyBytes(200, [0x65, 0xe3])]); // 'e' + 孤立 3-byte lead
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

  it('robots 304（无缓存，不应发生）→ unavailable（fail-closed，不退化 allow-all）', async () => {
    const client = new FakeRobotsClient([unchangedHttp()]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 跨 host redirect 最终 URL → unavailable（fail-closed，不退化 allow-all）', async () => {
    const client = new FakeRobotsClient([
      okBody(200, 'User-agent: aibrowse\nAllow: /\n', 'https://cdn.example.com/robots.txt'),
    ]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
  });

  it('robots 解析 fatal UTF-8 → unavailable（不退化 allow-all）', async () => {
    const client = new FakeRobotsClient([okBodyBytes(200, [0xff])]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://example.com/feed' });
    expect(d.kind).toBe('unavailable');
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

describe('R3 IPv6 robots authority', () => {
  it('IPv6 字面量目标：robots URL 保留 bracketed authority，无 query/fragment', async () => {
    const client = new FakeRobotsClient([okBody(404, '')]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://[2606:4700:4700::1111]/feed?x=1#f' });
    expect(d.kind).toBe('allowed');
    expect(client.requests.length).toBe(1);
    expect(client.requests[0]!.url).toBe('https://[2606:4700:4700::1111]/robots.txt');
  });

  it('IPv6 目标 200 robots 最终 URL 同一 authority → 使用规则（不误判跨 host）', async () => {
    const client = new FakeRobotsClient([
      okBody(200, 'User-agent: aibrowse\nAllow: /\n', 'https://[2606:4700:4700::1111]/robots.txt'),
    ]);
    const policy = new RobotsPolicy({ client, clock: new FakeClock(0) });
    const d = await policy.checkAllowed({ url: 'https://[2606:4700:4700::1111]/feed' });
    expect(d.kind).toBe('allowed');
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
