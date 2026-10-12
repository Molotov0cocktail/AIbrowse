// Independent review: closed Result drafts must reject substituted unknown fields.
import { describe, expect, it } from 'vitest';
import { validate } from '../../src/main/research/result-validator';
import type { ResearchResultValidationContext } from '../../src/shared/types/research';

const reference = 'independent-candidate';
const context: ResearchResultValidationContext = {
  taskId: 'independent-task',
  candidates: [
    {
      id: reference,
      url: 'https://example.test/independent',
      displayUrl: 'https://example.test/independent',
      title: '独立合成来源',
      canonicalKey: 'https://example.test/independent',
      scope: 'page',
      discoveredVia: ['goal-url'],
      sourceId: null,
      trust: null,
      priority: null,
      lastUsedAt: null,
      note: null,
      sortKey: 'independent',
    },
  ],
  evidence: [
    {
      evidenceId: 'independent-evidence',
      taskId: 'independent-task',
      captureId: 'independent-capture',
      candidateId: reference,
      sourceId: null,
      url: 'https://example.test/independent',
      title: '独立合成来源',
      accessTime: '2026-10-12T00:00:00.000Z',
      documentId: 'independent-document',
      contentHash: 'a'.repeat(64),
      type: 'quote',
      locator: { kind: 'text', excerpt: '独立合成摘录' },
      excerpt: '独立合成摘录',
      value: null,
      verification: 'verified',
    },
  ],
  claims: [],
  conflicts: [],
  verificationState: 'unavailable',
  now: '2026-10-12T00:00:00.000Z',
  createId: () => 'aaaaaaaa-1111-4111-8111-111111111111',
};
const uncertainty = { kind: 'uncertain', text: '证据有限', reason: '独立合成验证' };
const card = { title: '合成卡片', subtitle: null, body: '合成正文', sourceRefs: [reference] };
const ranking = { rank: 1, title: '合成排序', detail: '合成理由', sourceRefs: [reference] };
const blocks: Record<string, unknown>[] = [
  { kind: 'markdown', text: '合成正文' },
  { kind: 'table', columns: ['合成列'], rows: [['合成值']], sourceRefs: [reference] },
  { kind: 'cards', items: [card] },
  { kind: 'ranking', items: [ranking] },
  uncertainty,
];
const draft = (block: unknown) => ({
  title: '独立验证',
  summary: '',
  blocks: [block, uncertainty],
});
function replaceField(record: Record<string, unknown>, field: string) {
  const modified = { ...record };
  delete modified[field];
  modified['unknownField'] = '不应被接受的替代字段';
  return modified;
}

describe('独立 Result 闭合字段反例', () => {
  it.each(blocks.map((block) => [block['kind'], block] as const))(
    '合法 %s 对照通过',
    (_kind, block) => expect(validate(draft(block), context).ok).toBe(true),
  );

  it.each(
    blocks.flatMap((block) =>
      Object.keys(block).map((field) => [block['kind'], field, block] as const),
    ),
  )('%s 的 %s 被未知字段替换后整份拒绝', (_kind, field, block) => {
    expect(validate(draft(replaceField(block, field)), context).ok).toBe(false);
  });

  it.each(Object.keys(card))('cards 条目的 %s 被未知字段替换后整份拒绝', (field) => {
    const block = { kind: 'cards', items: [replaceField(card, field)] };
    expect(validate(draft(block), context).ok).toBe(false);
  });

  it.each(Object.keys(ranking))('ranking 条目的 %s 被未知字段替换后整份拒绝', (field) => {
    const block = { kind: 'ranking', items: [replaceField(ranking, field)] };
    expect(validate(draft(block), context).ok).toBe(false);
  });

  it.each(['title', 'summary', 'blocks'])('草案顶层的 %s 被替换后拒绝', (field) => {
    expect(validate(replaceField(draft(blocks[0]), field), context).ok).toBe(false);
  });

  it('卡片明确空 subtitle 保持 null，未知值不能被静默归一化', () => {
    const outcome = validate(draft({ kind: 'cards', items: [card] }), context);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.blocks[0]).toEqual({ kind: 'cards', items: [card] });
  });

  it('卡片明确 undefined subtitle 不能代替契约 null 或字符串', () => {
    const block = { kind: 'cards', items: [{ ...card, subtitle: undefined }] };
    expect(validate(draft(block), context).ok).toBe(false);
  });
});
