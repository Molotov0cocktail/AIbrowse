// D7 shared page-diff: 确定性 Page Diff（detailed-design §9.2/§9.3）。纯函数、零 IO。
//
// 契约要点：
// - Region/field exact normalized equality（valueHash 判等，等价规范文本相等）；
// - link 字段按 canonical URL 配对：added/removed/label-changed（ordinal 漂移不产噪声对）；
//   link 字段对 fieldKey 取 `r{regionIndex}:link`（稳定，itemId=canonical URL）；
// - 其余字段（main-text/heading/table-header/table-cell）按 fieldKey 配对；
// - 文本生成有界共同前后文 old/new 摘录（pageValueEvidence 有界截断）；
// - table 生成 cell/row 类型化 change（fieldKey 含行/列）；
// - 不运行语义模型或模糊相似度决定 equality；
// - URL 投影失败（非法/非 http(s)/userinfo）→ 该字段 fail-closed 跳过（零噪声 pair）。
import type {
  ChangeEvidencePair,
  PageProjectionField,
  PageProjectionValue,
} from '../../types/watch';
import { evidenceSafeUrl, makeEvidencePair, pageValueEvidence } from './evidence';
import type { ProjectionSnapshot } from './feed-diff';

export type PageDiffResult = { ok: true; pairs: ChangeEvidencePair[] };

/** link 字段稳定 pair fieldKey：`r{regionIndex}:link`（与 Projection 的 ordinal key 解耦）。 */
function linkPairFieldKey(field: Extract<PageProjectionField, { kind: 'link' }>): string {
  return `r${field.regionIndex}:link`;
}

/** 字段 identity key：link 用 canonical URL，其余用 fieldKey；非法 URL → null。 */
function fieldIdentityKey(field: PageProjectionField): string | null {
  if (field.kind === 'link') return evidenceSafeUrl(field.url);
  return field.fieldKey;
}

/** 字段 pair fieldKey（link 稳定键，其余原 fieldKey）。 */
function pairFieldKeyOf(field: PageProjectionField): string {
  return field.kind === 'link' ? linkPairFieldKey(field) : field.fieldKey;
}

/** 字段规范化 value（link 用 text，其余用 value）。 */
function fieldValueOf(field: PageProjectionField): string {
  return field.kind === 'link' ? field.text : field.value;
}

interface PageFieldEntry {
  field: PageProjectionField;
  identityKey: string;
  fieldKey: string;
  label: string;
  value: string;
}

function entriesOf(value: PageProjectionValue): Map<string, PageFieldEntry> {
  const map = new Map<string, PageFieldEntry>();
  for (const field of value.fields) {
    const identityKey = fieldIdentityKey(field);
    if (identityKey === null) continue; // 无法形成合规身份 → 跳过（零噪声）
    map.set(identityKey, {
      field,
      identityKey,
      fieldKey: pairFieldKeyOf(field),
      label: field.label,
      value: fieldValueOf(field),
    });
  }
  return map;
}

/** 确定性 Page Diff：before/after 投影 → 有界双侧 pair 列表。 */
export function diffPageProjections(
  before: ProjectionSnapshot<PageProjectionValue>,
  after: ProjectionSnapshot<PageProjectionValue>,
): PageDiffResult {
  const context = {
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    beforeFinalUrl: before.finalUrl,
    afterFinalUrl: after.finalUrl,
    beforeDocumentId: before.documentId,
    afterDocumentId: after.documentId,
  };
  const pairs: ChangeEvidencePair[] = [];
  const beforeMap = entriesOf(before.value);
  const afterMap = entriesOf(after.value);
  const identities = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  for (const identity of identities) {
    const oldEntry = beforeMap.get(identity);
    const newEntry = afterMap.get(identity);
    if (oldEntry === undefined && newEntry !== undefined) {
      const pair = makeEvidencePair({
        itemId: identity,
        fieldKey: newEntry.fieldKey,
        label: newEntry.label,
        before: { kind: 'absent' },
        after: pageValueEvidence(newEntry.value),
        feedItemKey: null,
        context,
      });
      if (pair !== null) pairs.push(pair);
      continue;
    }
    if (oldEntry !== undefined && newEntry === undefined) {
      const pair = makeEvidencePair({
        itemId: identity,
        fieldKey: oldEntry.fieldKey,
        label: oldEntry.label,
        before: pageValueEvidence(oldEntry.value),
        after: { kind: 'absent' },
        feedItemKey: null,
        context,
      });
      if (pair !== null) pairs.push(pair);
      continue;
    }
    if (oldEntry !== undefined && newEntry !== undefined) {
      if (oldEntry.value === newEntry.value) continue; // exact normalized equality
      const pair = makeEvidencePair({
        itemId: identity,
        fieldKey: oldEntry.fieldKey,
        label: oldEntry.label,
        before: pageValueEvidence(oldEntry.value),
        after: pageValueEvidence(newEntry.value),
        feedItemKey: null,
        context,
      });
      if (pair !== null) pairs.push(pair);
    }
  }

  return { ok: true, pairs };
}
