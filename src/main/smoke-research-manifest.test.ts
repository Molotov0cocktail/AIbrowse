// C9（决议 #167）：FRT manifest 单一事实源——12 项编号连续/类别合法/
// 证据落点非空；独立结果聚合（缺失/重复/失败/未知编号）；Fifth §7 七条映射
import { describe, expect, it } from 'vitest';
import {
  aggregateFrtOutcomes,
  RESEARCH_FIFTH7_OFFLINE_MAPPING,
  RESEARCH_FRT_MANIFEST,
  validateResearchFifth7Mapping,
  validateResearchFrtManifest,
  type FrtOutcome,
} from './smoke-research-manifest';

describe('RESEARCH_FRT_MANIFEST（决议 #167(1) 唯一事实源）', () => {
  it('12 项编号连续、字段完整、类别合法', () => {
    expect(validateResearchFrtManifest(RESEARCH_FRT_MANIFEST)).toEqual([]);
    expect(RESEARCH_FRT_MANIFEST).toHaveLength(12);
    expect(RESEARCH_FRT_MANIFEST[0]!.id).toBe('FRT-01');
    expect(RESEARCH_FRT_MANIFEST[11]!.id).toBe('FRT-12');
  });

  it('诚实边界校准（决议 #166）：FRT-06 为诚实限制、FRT-08 为诚实限制、FRT-01 为结构边界', () => {
    const byId = new Map(RESEARCH_FRT_MANIFEST.map((e) => [e.id, e]));
    expect(byId.get('FRT-01')!.category).toBe('structural-boundary');
    expect(byId.get('FRT-06')!.category).toBe('honest-limit');
    expect(byId.get('FRT-08')!.category).toBe('honest-limit');
    // 观察项不得冒充结构断言：manifest 中观察类仅允许出现在真实 Provider
    // 登记面（8.20 离线矩阵全部为 structural-boundary/honest-limit）
    expect(RESEARCH_FRT_MANIFEST.filter((e) => e.category === 'observe')).toHaveLength(0);
  });

  it('缺陷 manifest 检出（缺项/错序/重复/空字段/非法类别）', () => {
    const truncated = RESEARCH_FRT_MANIFEST.slice(0, 11);
    expect(validateResearchFrtManifest(truncated).length).toBeGreaterThan(0);
    const reordered = [...RESEARCH_FRT_MANIFEST];
    const first = reordered[0]!;
    const broken = reordered.map((e, i) => (i === 0 ? { ...first, id: 'FRT-02' } : e));
    expect(validateResearchFrtManifest(broken).length).toBeGreaterThan(0);
    const emptyName = RESEARCH_FRT_MANIFEST.map((e, i) => (i === 0 ? { ...e, name: '  ' } : e));
    expect(validateResearchFrtManifest(emptyName).some((m) => m.includes('名称'))).toBe(true);
  });
});

describe('aggregateFrtOutcomes（决议 #167(2) 独立结果聚合）', () => {
  const allOk: FrtOutcome[] = RESEARCH_FRT_MANIFEST.map((e) => ({
    id: e.id,
    ok: true,
    detail: '通过',
  }));

  it('12 项全通过 → 整体通过', () => {
    expect(aggregateFrtOutcomes(allOk, RESEARCH_FRT_MANIFEST).ok).toBe(true);
  });

  it('单项失败不遮蔽其他项 → 聚合失败且失败清单含该项', () => {
    const withFailure = allOk.map((o) =>
      o.id === 'FRT-03' ? { ...o, ok: false, detail: '摘录未拒绝' } : o,
    );
    const res = aggregateFrtOutcomes(withFailure, RESEARCH_FRT_MANIFEST);
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.startsWith('FRT-03'))).toBe(true);
    expect(res.failures).toHaveLength(1);
  });

  it('结果缺失/重复/未知编号 → 聚合失败', () => {
    const missing = allOk.filter((o) => o.id !== 'FRT-12');
    expect(aggregateFrtOutcomes(missing, RESEARCH_FRT_MANIFEST).ok).toBe(false);
    const duplicated = [...allOk, { ...allOk[0]! }];
    expect(aggregateFrtOutcomes(duplicated, RESEARCH_FRT_MANIFEST).ok).toBe(false);
    const unknown = [...allOk, { id: 'FRT-99', ok: true, detail: 'x' }];
    expect(aggregateFrtOutcomes(unknown, RESEARCH_FRT_MANIFEST).ok).toBe(false);
  });
});

describe('RESEARCH_FIFTH7_OFFLINE_MAPPING（决议 #167(3)）', () => {
  it('恰好 7 条且完整（候选合并 → 读取 → Evidence → Cross-check → Result → UI/导出）', () => {
    expect(validateResearchFifth7Mapping(RESEARCH_FIFTH7_OFFLINE_MAPPING)).toEqual([]);
    expect(RESEARCH_FIFTH7_OFFLINE_MAPPING).toHaveLength(7);
  });

  it('缺陷映射检出（数量/空条目/重复）', () => {
    expect(
      validateResearchFifth7Mapping(RESEARCH_FIFTH7_OFFLINE_MAPPING.slice(0, 6)).length,
    ).toBeGreaterThan(0);
    const dup = [...RESEARCH_FIFTH7_OFFLINE_MAPPING, RESEARCH_FIFTH7_OFFLINE_MAPPING[0]!];
    expect(validateResearchFifth7Mapping(dup).length).toBeGreaterThan(0);
  });
});
