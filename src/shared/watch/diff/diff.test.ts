// D7 diff tests: Feed/Page 确定性 Diff（detailed-design §9.2/§9.3、#S6-046）。
// 纯逻辑、零 IO。
// - Feed 仅 title/link/published/summary 产生变化对；identity 变化按 remove+add；
//   feed 顺序变化不构成 Event；双侧 typed absent/present Evidence；
// - Page link 按 canonical URL 配对（added/removed/label-changed），Region 外噪声零 pair；
// - URL 投影非法 → 该 pair fail-closed 跳过。
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './evidence';
import { diffFeedProjections, type ProjectionSnapshot } from './feed-diff';
import { diffPageProjections } from './page-diff';
import type { FeedField, FeedProjectionValue, PageProjectionValue } from '../../types/watch';

const T0 = '2026-08-28T00:00:00.000Z';
const T1 = '2026-08-28T00:10:00.000Z';

function field(text: string): FeedField {
  return {
    text,
    truncated: false,
    originalBytes: Buffer.byteLength(text, 'utf8'),
    valueHash: sha256Hex(text),
  };
}

function feedValue(
  items: FeedProjectionValue['items'],
  over: Partial<FeedProjectionValue> = {},
): FeedProjectionValue {
  return {
    type: 'feed',
    format: 'rss2',
    title: field('Feed'),
    description: field('d'),
    siteUrl: field('https://example.com'),
    feedUrl: field(''),
    items,
    itemsTruncated: false,
    ...over,
  };
}

function feedItem(
  id: string,
  title: string,
  link: string,
  extra: Partial<FeedProjectionValue['items'][number]> = {},
): FeedProjectionValue['items'][number] {
  return {
    identity: id,
    identityKind: 'guid',
    title: field(title),
    link: field(link),
    summary: field('s'),
    publishedAt: null,
    updatedAt: null,
    author: field('a'),
    ...extra,
  };
}

function snap(
  value: FeedProjectionValue,
  capturedAt = T0,
): ProjectionSnapshot<FeedProjectionValue> {
  return { value, finalUrl: 'https://example.com/feed', capturedAt, documentId: null };
}

describe('diffFeedProjections（§9.2/#S6-046）', () => {
  it('新增/删除 item → 双侧 typed absent/present Evidence（before/after 均存在）', () => {
    const before = feedValue([feedItem('a', 'A', 'https://e.com/a')]);
    const after = feedValue([
      feedItem('a', 'A', 'https://e.com/a'),
      feedItem('b', 'B', 'https://e.com/b'),
    ]);
    const r = diffFeedProjections(snap(before, T0), snap(after, T1));
    expect(r.ok).toBe(true);
    expect(r.pairs.length).toBe(1); // 只加 b
    const p = r.pairs[0]!;
    expect(p.itemId).toBe('b');
    expect(p.feedItemKey).toBe('b');
    expect(p.before).toEqual({ kind: 'absent' });
    expect(p.after.kind).toBe('present');
    if (p.after.kind === 'present') {
      expect(p.after.excerpt).toBe('B');
      expect(p.after.valueHash).toBe(sha256Hex('B')); // 截断前完整值哈希
      expect(p.afterCapturedAt).toBe(T1);
      expect(p.beforeCapturedAt).toBe(T0);
    }
  });

  it('删除 item → after=absent', () => {
    const before = feedValue([feedItem('a', 'A', 'https://e.com/a')]);
    const after = feedValue([]);
    const r = diffFeedProjections(snap(before), snap(after, T1));
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.itemId).toBe('a');
    expect(r.pairs[0]!.after).toEqual({ kind: 'absent' });
    expect(r.pairs[0]!.before.kind).toBe('present');
  });

  it('同 item title 变化 → changed pair；valueHash 判等', () => {
    const before = feedValue([feedItem('a', 'Old', 'https://e.com/a')]);
    const after = feedValue([feedItem('a', 'New', 'https://e.com/a')]);
    const r = diffFeedProjections(snap(before), snap(after));
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.fieldKey).toBe('title');
    if (r.pairs[0]!.before.kind === 'present' && r.pairs[0]!.after.kind === 'present') {
      expect(r.pairs[0]!.before.valueHash).toBe(sha256Hex('Old'));
      expect(r.pairs[0]!.after.valueHash).toBe(sha256Hex('New'));
    }
  });

  it('published null→present / present→null 分别产生 absent/present 变化', () => {
    const before = feedValue([feedItem('a', 'A', 'https://e.com/a')]); // publishedAt=null
    const after = feedValue([
      feedItem('a', 'A', 'https://e.com/a', { publishedAt: field('2026-08-28') }),
    ]);
    let r = diffFeedProjections(snap(before), snap(after));
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.fieldKey).toBe('published');
    expect(r.pairs[0]!.before).toEqual({ kind: 'absent' });
    expect(r.pairs[0]!.after.kind).toBe('present');
    // 反向
    r = diffFeedProjections(snap(after), snap(before));
    expect(r.pairs[0]!.before.kind).toBe('present');
    expect(r.pairs[0]!.after).toEqual({ kind: 'absent' });
  });

  it('feed 顺序变化本身不构成 Event；updatedAt/author 不产生变化对', () => {
    const before = feedValue([
      feedItem('a', 'A', 'https://e.com/a'),
      feedItem('b', 'B', 'https://e.com/b'),
    ]);
    const after = feedValue([
      feedItem('b', 'B', 'https://e.com/b'),
      feedItem('a', 'A', 'https://e.com/a'),
    ]);
    const r = diffFeedProjections(snap(before), snap(after));
    expect(r.pairs.length).toBe(0); // 顺序变化零 pair
    // updatedAt/author 变化零 pair
    const changed = feedValue([
      feedItem('a', 'A', 'https://e.com/a', { updatedAt: field('u1'), author: field('a2') }),
    ]);
    const r2 = diffFeedProjections(
      snap(feedValue([feedItem('a', 'A', 'https://e.com/a')])),
      snap(changed),
    );
    expect(r2.pairs.length).toBe(0);
  });

  it('identity 改变 → remove+add（双侧 Evidence 完整）', () => {
    const before = feedValue([feedItem('old-id', 'A', 'https://e.com/a')]);
    const after = feedValue([feedItem('new-id', 'A', 'https://e.com/a')]);
    const r = diffFeedProjections(snap(before), snap(after));
    expect(r.pairs.length).toBe(2);
    expect(r.pairs.some((p) => p.itemId === 'old-id' && p.after.kind === 'absent')).toBe(true);
    expect(r.pairs.some((p) => p.itemId === 'new-id' && p.before.kind === 'absent')).toBe(true);
  });

  it('重复 identity 首次去重（不重复事件）', () => {
    const after = feedValue([
      feedItem('a', 'First', 'https://e.com/a'),
      feedItem('a', 'Dup', 'https://e.com/a'),
    ]);
    const r = diffFeedProjections(snap(feedValue([])), snap(after));
    expect(r.pairs.length).toBe(1);
    if (r.pairs[0]!.after.kind === 'present') expect(r.pairs[0]!.after.excerpt).toBe('First');
  });
});

describe('diffPageProjections（§9.2/§9.3）', () => {
  const pageValue = (fields: PageProjectionValue['fields']): PageProjectionValue => ({
    type: 'page',
    fields,
  });
  const mainField = (fieldKey: string, value: string): PageProjectionValue['fields'][number] => ({
    fieldKey,
    regionIndex: 0,
    kind: 'main-text',
    label: '正文',
    value,
  });
  const linkField = (
    fieldKey: string,
    text: string,
    url: string,
  ): PageProjectionValue['fields'][number] => ({
    fieldKey,
    regionIndex: 0,
    kind: 'link',
    label: '链接',
    ordinal: 1,
    text,
    url,
  });
  const psnap = (value: PageProjectionValue): ProjectionSnapshot<PageProjectionValue> => ({
    value,
    finalUrl: 'https://example.com/page?token=SECRET',
    capturedAt: T0,
    documentId: '42',
  });

  it('main-text 变化 → changed pair（itemId=fieldKey、URL 去 query、documentId 保留）', () => {
    const before = pageValue([mainField('r0:main', 'hello')]);
    const after = pageValue([mainField('r0:main', 'hello world')]);
    const r = diffPageProjections(psnap(before), { ...psnap(after), capturedAt: T1 });
    expect(r.pairs.length).toBe(1);
    const p = r.pairs[0]!;
    expect(p.itemId).toBe('r0:main');
    expect(p.fieldKey).toBe('r0:main');
    expect(p.beforeFinalUrl).toBe('https://example.com/page'); // query 已移除
    expect(p.beforeDocumentId).toBe('42');
    if (p.before.kind === 'present' && p.after.kind === 'present') {
      expect(p.before.valueHash).toBe(sha256Hex('hello'));
      expect(p.after.valueHash).toBe(sha256Hex('hello world'));
      expect(p.after.excerpt).toBe('hello world');
    }
  });

  it('link 按 canonical URL 配对：label-changed / added / removed；顺序噪声零 pair', () => {
    const before = pageValue([linkField('r0:link:1', 'Label', 'https://e.com/x?q=1#f')]);
    const after = pageValue([linkField('r0:link:1', 'New Label', 'https://e.com/x')]); // 同 URL 改 label
    let r = diffPageProjections(psnap(before), psnap(after));
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.itemId).toBe('https://e.com/x'); // canonical URL 身份
    expect(r.pairs[0]!.fieldKey).toBe('r0:link'); // 稳定 link 键

    // 新增 link（基线 x 已为 New Label，故只新增 y 一个 pair）
    const withNew = pageValue([
      linkField('r0:link:1', 'New Label', 'https://e.com/x'),
      linkField('r0:link:2', 'Added', 'https://e.com/y'),
    ]);
    r = diffPageProjections(
      psnap(pageValue([linkField('r0:link:1', 'New Label', 'https://e.com/x')])),
      psnap(withNew),
    );
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.itemId).toBe('https://e.com/y');
    expect(r.pairs[0]!.before.kind).toBe('absent');
    expect(r.pairs[0]!.after.kind).toBe('present');

    // 移除 link
    r = diffPageProjections(psnap(withNew), psnap(pageValue([])));
    expect(r.pairs.length).toBe(2);
    expect(r.pairs.every((p) => p.after.kind === 'absent')).toBe(true);
  });

  it('link ordinal 漂移不产生噪声（同一 URL 同一 text）', () => {
    const before = pageValue([
      linkField('r0:link:1', 'A', 'https://e.com/a'),
      linkField('r0:link:2', 'B', 'https://e.com/b'),
    ]);
    const after = pageValue([
      linkField('r0:link:2', 'B', 'https://e.com/b'),
      linkField('r0:link:1', 'A', 'https://e.com/a'),
    ]);
    const r = diffPageProjections(psnap(before), psnap(after));
    expect(r.pairs.length).toBe(0);
  });

  it('URL 投影非法（file:/非 http/https）→ 该字段零 pair（fail-closed）', () => {
    const before = pageValue([mainField('r0:main', 'hello')]);
    const after = pageValue([
      mainField('r0:main', 'hello world'),
      linkField('r0:link:1', 'bad', 'file:///etc/passwd'),
    ]);
    const r = diffPageProjections(psnap(before), psnap(after));
    expect(r.pairs.length).toBe(1); // 只 main-text；非法 link 跳过
    expect(r.pairs[0]!.fieldKey).toBe('r0:main');
  });
});
