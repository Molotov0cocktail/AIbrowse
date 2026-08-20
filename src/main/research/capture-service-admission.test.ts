// C4 Replan 红态 oracle（隔离小预算 mock）——仅验证 visibleText prefix 边界
// （Contract：visibleText 是唯一允许 partial payload 的 unit；prefix 未完整进入
// 或没有一个 surrogate-safe payload 字符可进入时必须零写入、零登记）。
//
// 本文件通过 vi.mock 把 MAX_PAGE_CAPTURE_CHARS 缩小到 6（< '[text] ' 前缀 7 字符），
// 隔离验证「prefix 未完整进入 → 零 canonical、零 textSection」这一统一 admission
// 不变量。不新增生产 budget 参数、不导出 stats/helper、不为测试扩张生产公共接口。
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
