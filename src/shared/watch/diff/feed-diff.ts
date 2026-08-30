// D7 shared feed-diff: 确定性 Feed Diff（detailed-design §9.2/§9.3）。纯函数、零 IO。
//
// 契约要点：
// - 仅 title/link/published/summary 四字段产生变化对（updatedAt/author v1 不产生）；
// - item 新增/删除：新增用 before='absent'、删除用 after='absent'，双侧证据完整；
// - 同 item 字段变化：before/after 均 present（valueHash 判等，等价规范文本比较）；
// - feed 顺序变化本身不构成 Event；重复 identity 由 parser 首次去重（本层防御性跳过）；
// - 身份：itemId=FeedItem.identity 且 feedItemKey 同值；
// - URL 投影失败（非法/非 http(s)/userinfo）→ 该 pair fail-closed 跳过。
import type { ChangeEvidencePair, FeedProjectionValue } from '../../types/watch';
import { feedFieldEvidence, feedIdentityOf, makeEvidencePair } from './evidence';

export interface ProjectionSnapshot<T> {
  value: T;
  finalUrl: string;
  capturedAt: string;
  documentId: string | null;
}

export type FeedDiffResult = { ok: true; pairs: ChangeEvidencePair[] };

const FEED_FIELD_KEYS = ['title', 'link', 'summary', 'published'] as const;
type FeedFieldKey = (typeof FEED_FIELD_KEYS)[number];

const FEED_FIELD_LABELS: Record<FeedFieldKey, string> = {
  title: '标题',
  link: '链接',
  summary: '摘要',
  published: '发布时间',
};

/**
 * 获取 item 的指定对比字段（FeedField | null）：
 * title/link/summary 恒 present；published 映射 publishedAt（RSS pubDate / Atom published）。
 */
function itemFieldOf(
  item: FeedProjectionValue['items'][number],
  key: FeedFieldKey,
): { kind: 'present'; field: FeedProjectionValue['items'][number]['title'] } | { kind: 'absent' } {
  if (key === 'title') return { kind: 'present', field: item.title };
  if (key === 'link') return { kind: 'present', field: item.link };
  if (key === 'summary') return { kind: 'present', field: item.summary };
  if (item.publishedAt === null) return { kind: 'absent' };
  return { kind: 'present', field: item.publishedAt };
}

/** 双侧字段 evidence 相等：valueHash 相同即视为相等（截断前完整规范化值哈希）。 */
function fieldEqual(
  a: { kind: 'present'; field: FeedProjectionValue['items'][number]['title'] } | { kind: 'absent' },
  b: { kind: 'present'; field: FeedProjectionValue['items'][number]['title'] } | { kind: 'absent' },
): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.field.valueHash === b.field.valueHash;
}

/** 确定性 Feed Diff：before/after 投影 → 有界双侧 pair 列表。 */
export function diffFeedProjections(
  before: ProjectionSnapshot<FeedProjectionValue>,
  after: ProjectionSnapshot<FeedProjectionValue>,
): FeedDiffResult {
  const context = {
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    beforeFinalUrl: before.finalUrl,
    afterFinalUrl: after.finalUrl,
    beforeDocumentId: before.documentId,
    afterDocumentId: after.documentId,
  };
  const pairs: ChangeEvidencePair[] = [];

  const beforeById = new Map<string, FeedProjectionValue['items'][number]>();
  for (const item of before.value.items) {
    if (!beforeById.has(item.identity)) beforeById.set(item.identity, item);
  }
  const afterById = new Map<string, FeedProjectionValue['items'][number]>();
  for (const item of after.value.items) {
    if (!afterById.has(item.identity)) afterById.set(item.identity, item);
  }

  const identities = new Set<string>([...beforeById.keys(), ...afterById.keys()]);
  for (const identity of identities) {
    const oldItem = beforeById.get(identity);
    const newItem = afterById.get(identity);
    const { itemId, feedItemKey } = feedIdentityOf(identity);

    if (oldItem === undefined && newItem !== undefined) {
      // 新增：before=absent、after=title（代表字段），双侧证据完整
      const pair = makeEvidencePair({
        itemId,
        fieldKey: 'title',
        label: FEED_FIELD_LABELS.title,
        before: { kind: 'absent' },
        after: feedFieldEvidence(newItem.title),
        feedItemKey,
        context,
      });
      if (pair !== null) pairs.push(pair);
      continue;
    }
    if (oldItem !== undefined && newItem === undefined) {
      const pair = makeEvidencePair({
        itemId,
        fieldKey: 'title',
        label: FEED_FIELD_LABELS.title,
        before: feedFieldEvidence(oldItem.title),
        after: { kind: 'absent' },
        feedItemKey,
        context,
      });
      if (pair !== null) pairs.push(pair);
      continue;
    }
    if (oldItem !== undefined && newItem !== undefined) {
      for (const key of FEED_FIELD_KEYS) {
        const oldField = itemFieldOf(oldItem, key);
        const newField = itemFieldOf(newItem, key);
        if (fieldEqual(oldField, newField)) continue;
        const pair = makeEvidencePair({
          itemId,
          fieldKey: key,
          label: FEED_FIELD_LABELS[key],
          before:
            oldField.kind === 'present' ? feedFieldEvidence(oldField.field) : { kind: 'absent' },
          after:
            newField.kind === 'present' ? feedFieldEvidence(newField.field) : { kind: 'absent' },
          feedItemKey,
          context,
        });
        if (pair !== null) pairs.push(pair);
      }
    }
  }

  return { ok: true, pairs };
}
