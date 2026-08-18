// C9（决议 #168 + 恢复校准）：隐私扫描 canary 分类与允许/禁止位置清单——期望表
// 完整性（6 类 × 10 面恰好一条）/评估语义（允许面 ≥1、禁止面 ===0）/汇总失败
// 清单只含标签与命中数（绝不回显 canary 本体）/字节级扫描 helper（Buffer 搜索、
// 读取失败 fail-closed）
import { describe, expect, it } from 'vitest';
import {
  countTokenInBuffer,
  countTokenInText,
  createResearchCanaries,
  evaluateResearchScan,
  readSurfaceFiles,
  RESEARCH_SCAN_EXPECTATIONS,
  summarizeResearchScan,
  validateResearchScanExpectations,
} from './smoke-research-scan';

describe('RESEARCH_SCAN_EXPECTATIONS（决议 #168(1)–(5) 允许/禁止位置清单）', () => {
  it('期望表完整：6 类 canary × 10 扫描面恰好一条', () => {
    expect(validateResearchScanExpectations(RESEARCH_SCAN_EXPECTATIONS)).toEqual([]);
    expect(RESEARCH_SCAN_EXPECTATIONS).toHaveLength(6 * 10);
  });

  it('Key/Authorization canary：所有面禁止（零命中语义）', () => {
    const keyRows = RESEARCH_SCAN_EXPECTATIONS.filter((e) => e.canaryKind === 'api-key');
    expect(keyRows).toHaveLength(10);
    expect(keyRows.every((e) => e.allowed === false)).toBe(true);
  });

  it('capture-only 正文：仅允许受控内存上下文（tool-output + provider-request-memory）', () => {
    const rows = RESEARCH_SCAN_EXPECTATIONS.filter((e) => e.canaryKind === 'capture-body');
    const allowed = rows.filter((e) => e.allowed).map((e) => e.surface);
    expect(allowed.sort()).toEqual(['provider-request-memory', 'tool-output']);
  });

  it('reasoning/transcript canary：所有面禁止（决议 #141(4) 直接丢弃零累积）', () => {
    const rows = RESEARCH_SCAN_EXPECTATIONS.filter((e) => e.canaryKind === 'reasoning-transcript');
    expect(rows.every((e) => e.allowed === false)).toBe(true);
  });

  it('Evidence 摘录 canary：允许 research.db + UI DOM + 请求内存；禁止日志/审计/会话/sources.db/CSV/工具结果', () => {
    const allowed = RESEARCH_SCAN_EXPECTATIONS.filter(
      (e) => e.canaryKind === 'evidence-excerpt' && e.allowed,
    ).map((e) => e.surface);
    expect(allowed.sort()).toEqual(['provider-request-memory', 'research-db', 'ui-dom']);
  });

  it('URL query token：允许 research.db + UI DOM + 请求内存（候选元数据）；禁止日志/审计/会话/CSV/sources.db', () => {
    const allowed = RESEARCH_SCAN_EXPECTATIONS.filter(
      (e) => e.canaryKind === 'url-token' && e.allowed,
    ).map((e) => e.surface);
    expect(allowed.sort()).toEqual(['provider-request-memory', 'research-db', 'ui-dom']);
  });

  it('CSV 公式 canary：允许 CSV + Result 持久化面（research.db）；其余面禁止', () => {
    const allowed = RESEARCH_SCAN_EXPECTATIONS.filter(
      (e) => e.canaryKind === 'csv-formula' && e.allowed,
    )
      .map((e) => e.surface)
      .sort();
    expect(allowed).toEqual(['csv-export', 'research-db']);
  });
});

describe('createResearchCanaries（运行时随机）', () => {
  it('6 类各一条、值互不相同、Key canary 为 sk- 形态', () => {
    const canaries = createResearchCanaries();
    expect(canaries).toHaveLength(6);
    const values = canaries.map((c) => c.value);
    expect(new Set(values).size).toBe(6);
    const key = canaries.find((c) => c.kind === 'api-key')!;
    expect(key.value.startsWith('sk-')).toBe(true);
    // 随机性：两次生成不重复
    const again = createResearchCanaries();
    expect(again.map((c) => c.value)).not.toEqual(values);
  });

  it('标签不含 canary 本体（输出纪律 FT-16）', () => {
    for (const c of createResearchCanaries()) {
      expect(c.label).not.toContain(c.value);
    }
  });
});

describe('字节级扫描 helper（C9 恢复校准：Buffer 搜索 + fail-closed）', () => {
  it('countTokenInBuffer：字节级计数（跨 UTF-8 多字节标记），非重叠', () => {
    const buf = Buffer.from('abc标记abc标记x标记abc', 'utf8');
    expect(countTokenInBuffer(buf, '标记')).toBe(3);
    expect(countTokenInBuffer(buf, 'abc')).toBe(3);
    expect(countTokenInBuffer(buf, '不存在')).toBe(0);
    expect(countTokenInBuffer(Buffer.alloc(0), '标记')).toBe(0);
    expect(countTokenInBuffer(buf, '')).toBe(0);
  });

  it('countTokenInText：字符串面同源计数', () => {
    expect(countTokenInText('a=b;c=d', '=')).toBe(2);
    expect(countTokenInText('无标记', 'x')).toBe(0);
  });

  it('readSurfaceFiles：读取失败 fail-closed（记入 readFailures，不静默跳过）', () => {
    const { data, readFailures } = readSurfaceFiles([
      { label: 'a.db', path: 'C:/definitely-not-exists/a.db' },
      { label: 'b.txt', path: 'C:/definitely-not-exists/b.txt' },
    ]);
    expect(readFailures).toEqual(['a.db', 'b.txt']);
    expect(data.length).toBe(0);
  });
});

describe('evaluateResearchScan / summarizeResearchScan（只返回标签/命中数/布尔）', () => {
  it('允许面：hits ≥1 通过、0 失败；禁止面：0 通过、≥1 失败', () => {
    expect(
      evaluateResearchScan(
        { canaryKind: 'evidence-excerpt', surface: 'research-db', allowed: true },
        1,
      ).ok,
    ).toBe(true);
    expect(
      evaluateResearchScan(
        { canaryKind: 'evidence-excerpt', surface: 'research-db', allowed: true },
        0,
      ).ok,
    ).toBe(false);
    expect(
      evaluateResearchScan({ canaryKind: 'api-key', surface: 'log', allowed: false }, 0).ok,
    ).toBe(true);
    expect(
      evaluateResearchScan({ canaryKind: 'api-key', surface: 'log', allowed: false }, 2).ok,
    ).toBe(false);
  });

  it('verdict 标签为 canary 类别@扫描面（不含 canary 值）', () => {
    const verdict = evaluateResearchScan(
      { canaryKind: 'csv-formula', surface: 'csv-export', allowed: true },
      3,
    );
    expect(verdict.label).toBe('csv-formula@csv-export');
    expect(verdict.hits).toBe(3);
  });

  it('汇总：任一失败 → 整体失败（失败清单只含标签与命中数）', () => {
    const verdicts = [
      { label: 'api-key@log', hits: 0, ok: true },
      { label: 'evidence-excerpt@csv-export', hits: 1, ok: false },
    ];
    const res = summarizeResearchScan(verdicts);
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual(['evidence-excerpt@csv-export：命中 1 次（与期望位置清单不符）']);
    expect(summarizeResearchScan([verdicts[0]!]).ok).toBe(true);
  });
});
