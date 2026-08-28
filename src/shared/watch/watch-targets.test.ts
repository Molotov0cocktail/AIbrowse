// D4 watch-targets tests: FeedTarget/PageTarget 严格校验（detailed-design
// §3.2/§10.1）——exact own-key、own-data 读取（getter/原型链拒绝）、未来
// version/type/kind fail-closed、URL 仅 http/https、region 形状/预算、
// sessionConsent 精确校验。纯函数零 IO。
import { describe, expect, it } from 'vitest';
import { MAX_REGIONS_PER_RULE } from '../types/watch';
import { validateFeedTarget, validatePageTarget } from './watch-targets';

const okFeed = {
  type: 'feed',
  feedUrl: 'https://example.com/rss.xml',
  format: 'rss2',
};

const okPage = {
  type: 'page',
  pageUrl: 'https://example.com/doc',
  regions: [{ kind: 'main-text', label: '正文' }],
  sessionConsent: null,
};

describe('validateFeedTarget', () => {
  it('合法 feed 通过并保持字段', () => {
    const r = validateFeedTarget({ ...okFeed, format: 'atom' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ ...okFeed, format: 'atom' });
  });

  it('非对象/数组/原型链/缺失 type/未来 type 拒绝', () => {
    expect(validateFeedTarget(null).ok).toBe(false);
    expect(validateFeedTarget([]).ok).toBe(false);
    expect(validateFeedTarget('x').ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, type: 'rss' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, type: undefined }).ok).toBe(false);
  });

  it('额外键/缺键拒绝（exact own-key）', () => {
    expect(validateFeedTarget({ ...okFeed, extra: 1 }).ok).toBe(false);
    expect(validateFeedTarget({ type: 'feed', feedUrl: okFeed.feedUrl }).ok).toBe(false);
    expect(validateFeedTarget({ type: 'feed', feedUrl: okFeed.feedUrl, format: 'rss2', x: 1 }).ok).toBe(false);
  });

  it('URL 仅 http/https、无 userinfo、有界', () => {
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'ftp://x.com/f' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'file:///etc/passwd' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'https://u:p@x.com/f' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'https://x.com/' + 'a'.repeat(2100) }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, feedUrl: 'https://x.com/' + 'a'.repeat(2000) }).ok).toBe(true);
  });

  it('format 仅 rss2/atom', () => {
    expect(validateFeedTarget({ ...okFeed, format: 'json' }).ok).toBe(false);
    expect(validateFeedTarget({ ...okFeed, format: 1 }).ok).toBe(false);
  });

  it('getter 字段拒绝（own-data 读取）', () => {
    const hostile = { type: 'feed', feedUrl: 'https://x.com/f', format: 'rss2' };
    Object.defineProperty(hostile, 'feedUrl', { get: () => 'https://evil.com' });
    expect(validateFeedTarget(hostile).ok).toBe(false);
  });
});

describe('validatePageTarget', () => {
  it('合法 page 通过', () => {
    const r = validatePageTarget({
      ...okPage,
      regions: [
        { kind: 'headings', label: '标题', levels: [1, 2] },
        { kind: 'table', label: '表格', headerFingerprint: 'h', occurrence: 0 },
        { kind: 'links', label: '链接', sameOriginOnly: true },
      ],
      sessionConsent: {
        version: 1,
        origin: 'https://example.com',
        grantedAt: '2026-08-28T00:00:00.000Z',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.sessionConsent).toEqual({
        version: 1,
        origin: 'https://example.com',
        grantedAt: '2026-08-28T00:00:00.000Z',
      });
    }
  });

  it('未来 type/kind/consent version fail-closed', () => {
    expect(validatePageTarget({ ...okPage, type: 'iframe' }).ok).toBe(false);
    expect(
      validatePageTarget({ ...okPage, regions: [{ kind: 'xpath', label: 'x' }] }).ok,
    ).toBe(false);
    expect(
      validatePageTarget({
        ...okPage,
        sessionConsent: { version: 2, origin: 'https://example.com', grantedAt: '2026-01-01T00:00:00.000Z' },
      }).ok,
    ).toBe(false);
  });

  it('regions 空/超上限拒绝；MAX_REGIONS_PER_RULE 边界通过', () => {
    expect(validatePageTarget({ ...okPage, regions: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_REGIONS_PER_RULE }, (_, i) => ({
      kind: 'main-text',
      label: `正文${i}`,
    }));
    expect(validatePageTarget({ ...okPage, regions: many }).ok).toBe(true);
    expect(
      validatePageTarget({
        ...okPage,
        regions: [...many, { kind: 'main-text', label: '溢出' }],
      }).ok,
    ).toBe(false);
  });

  it('headings levels 仅 1|2|3、非空、无非法成员', () => {
    const withLevels = (levels: unknown) =>
      validatePageTarget({ ...okPage, regions: [{ kind: 'headings', label: 'h', levels }] });
    expect(withLevels([1, 2, 3]).ok).toBe(true);
    expect(withLevels([]).ok).toBe(false);
    expect(withLevels([0]).ok).toBe(false);
    expect(withLevels([4]).ok).toBe(false);
    expect(withLevels(['1']).ok).toBe(false);
    expect(withLevels([1, 2, 3, 1]).ok).toBe(false);
  });

  it('table occurrence 非负整数；headerFingerprint 非空有界', () => {
    const withTable = (headerFingerprint: unknown, occurrence: unknown) =>
      validatePageTarget({
        ...okPage,
        regions: [{ kind: 'table', label: 't', headerFingerprint, occurrence }],
      });
    expect(withTable('h', 0).ok).toBe(true);
    expect(withTable('', 0).ok).toBe(false);
    expect(withTable('h', -1).ok).toBe(false);
    expect(withTable('h', 1.5).ok).toBe(false);
    expect(withTable('h', '0').ok).toBe(false);
    expect(withTable('x'.repeat(257), 0).ok).toBe(false);
  });

  it('links sameOriginOnly 必须 boolean', () => {
    expect(
      validatePageTarget({ ...okPage, regions: [{ kind: 'links', label: 'l', sameOriginOnly: false }] }).ok,
    ).toBe(true);
    expect(
      validatePageTarget({ ...okPage, regions: [{ kind: 'links', label: 'l', sameOriginOnly: 'yes' }] }).ok,
    ).toBe(false);
  });

  it('sessionConsent origin 必须为规范化 http/https origin；grantedAt 必须可解析 ISO', () => {
    const withConsent = (origin: unknown, grantedAt: unknown) =>
      validatePageTarget({
        ...okPage,
        sessionConsent: { version: 1, origin, grantedAt },
      });
    expect(withConsent('https://example.com', '2026-08-28T00:00:00.000Z').ok).toBe(true);
    expect(withConsent('https://example.com/path', '2026-08-28T00:00:00.000Z').ok).toBe(false);
    expect(withConsent('chrome://x', '2026-08-28T00:00:00.000Z').ok).toBe(false);
    expect(withConsent('https://example.com', 'not-a-time').ok).toBe(false);
    expect(withConsent('https://example.com', '').ok).toBe(false);
  });

  it('consent 额外键/非对象拒绝', () => {
    expect(
      validatePageTarget({
        ...okPage,
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: '2026-01-01T00:00:00.000Z', extra: 1 },
      }).ok,
    ).toBe(false);
    expect(validatePageTarget({ ...okPage, sessionConsent: 'yes' }).ok).toBe(false);
  });
});
