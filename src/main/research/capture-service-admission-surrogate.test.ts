// C4 Repair B coverage oracle (isolated small-budget mock) — budget 8 leaves
// exactly one UTF-16 code unit after the complete '[text] ' prefix. The BMP
// control proves that one code unit can enter; the surrogate-pair case proves
// that a valid pair is rolled back whole instead of being split.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/types/research', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/types/research')>();
  return { ...actual, MAX_PAGE_CAPTURE_CHARS: 8 };
});

import { MAX_PAGE_CAPTURE_CHARS } from '../../shared/types/research';
import { buildCaptureContent } from './capture-service';

const VISIBLE_PREFIX = '[text] ';

function makeSnap(
  visibleText: string,
  options: { includeLaterUnits?: boolean } = {},
): Parameters<typeof buildCaptureContent>[0] {
  const includeLaterUnits = options.includeLaterUnits ?? false;
  return {
    url: includeLaterUnits ? 'https://example.com/surrogate' : '',
    title: includeLaterUnits ? '后续标题' : '',
    visibleText,
    headings: includeLaterUnits ? [{ level: 1, text: '后续章节' }] : [],
    links: includeLaterUnits
      ? [{ id: 'link-1', text: '后续链接', href: 'https://example.com/later' }]
      : [],
    tables: includeLaterUnits ? [{ headers: ['列'], rows: [['值']] }] : [],
    buttons: [],
    meta: {
      capturedAt: 1,
      documentId: 1,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('隔离小预算：visible surrogate-safe rollback', () => {
  it('BMP 对照：prefix 完整且 1 个 code unit 可进入', () => {
    expect(VISIBLE_PREFIX.length).toBe(7);
    expect(MAX_PAGE_CAPTURE_CHARS).toBe(8);
    expect(MAX_PAGE_CAPTURE_CHARS - VISIBLE_PREFIX.length).toBe(1);

    const content = buildCaptureContent(makeSnap('A'), 'cap-bmp');

    expect(content.canonicalText).toBe('[text] A');
    expect(content.canonicalText).toHaveLength(8);
    expect(content.textSections).toEqual(['A']);
    expect(content.canonicalText).not.toContain('\n');
  });

  it('surrogate 对照：capacity=1 时有效 pair 整体回退，后续 projection 为空', () => {
    const pair = '𝄞';
    expect(pair).toHaveLength(2);
    expect(MAX_PAGE_CAPTURE_CHARS - VISIBLE_PREFIX.length).toBe(1);

    const content = buildCaptureContent(
      makeSnap(pair, { includeLaterUnits: true }),
      'cap-surrogate',
    );

    expect(content.canonicalText).toBe('');
    expect(content.textSections).toEqual([]);
    expect(content.tables).toEqual([]);
    expect(content.fields).toEqual({});
    expect(hasUnpairedSurrogate(content.canonicalText)).toBe(false);
    expect(Object.keys(content).sort()).toEqual(
      ['captureId', 'canonicalText', 'textSections', 'tables', 'fields'].sort(),
    );
  });
});
