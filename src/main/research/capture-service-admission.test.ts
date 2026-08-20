// C4 Replan red-state oracle (isolated small-budget mock) — verifies the
// visibleText prefix boundary only (Contract: visibleText is the only unit
// allowed a partial payload; a prefix that cannot fully enter, or no
// surrogate-safe payload character that can enter, must be zero-write,
// zero-registration).
//
// This file shrinks MAX_PAGE_CAPTURE_CHARS to 6 (< the '[text] ' prefix of
// 7 chars) via vi.mock, isolating the unified admission invariant
// "prefix cannot fully enter → zero canonical, zero textSection". No
// production budget parameter is added, no stats/helper is exported, and no
// production public API is expanded for the tests.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/types/research', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/types/research')>();
  return { ...actual, MAX_PAGE_CAPTURE_CHARS: 6 };
});

import { buildCaptureContent } from './capture-service';

function makeSnap(visibleText: string): Parameters<typeof buildCaptureContent>[0] {
  return {
    url: 'https://example.com/x',
    title: 't',
    visibleText,
    headings: [],
    links: [],
    tables: [],
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

describe('隔离小预算：visible prefix 边界（统一 admission 零写入、零登记）', () => {
  it('P1 prefix 未完整进入（预算 6 < [text] 前缀 7）→ 零 canonical、零 section', () => {
    const c = buildCaptureContent(makeSnap('AB'), 'cap-p1');
    expect(c.canonicalText).toBe('');
    expect(c.textSections).toEqual([]);
    expect(c.canonicalText.length).toBe(0);
  });

  it('P2 预算不足且 payload 为 surrogate（无 surrogate-safe 字符可进入）→ 零写入、零登记', () => {
    const c = buildCaptureContent(makeSnap('𝄞'), 'cap-p2');
    expect(c.canonicalText).toBe('');
    expect(c.textSections).toEqual([]);
  });

  it('P3 空/纯空白 visible → 规范化后为空 → 跳过、零 canonical、零 section', () => {
    const c = buildCaptureContent(makeSnap('  '), 'cap-p3');
    expect(c.canonicalText).toBe('');
    expect(c.textSections).toEqual([]);
  });
});
