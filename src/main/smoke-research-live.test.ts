// C9（决议 #169）：LIVE_RESEARCH 场景清单/台账/失败分类——3 个有界场景包
// （manifest 每 id 恰好执行一次、合计覆盖 Fifth §7 七项 + FRT-01/02/08/11
// 观察子集）、执行同源校验（未执行/重复/未知 id fail-closed）、台账只记录
// 次数与用途（无凭据字段）、失败分类七类不混同
import { describe, expect, it } from 'vitest';
import {
  classifyLiveResearchFailure,
  describeLiveResearchLedger,
  LIVE_RESEARCH_SCENARIO_MANIFEST,
  validateLiveResearchExecution,
  validateLiveResearchScenarioManifest,
  type LiveResearchLedgerEntry,
} from './smoke-research-live';

describe('LIVE_RESEARCH_SCENARIO_MANIFEST（决议 #169(6) + C9 恢复校准）', () => {
  it('清单完整：id 唯一、goal/purpose 非空、kind 合法', () => {
    expect(validateLiveResearchScenarioManifest(LIVE_RESEARCH_SCENARIO_MANIFEST)).toEqual([]);
  });

  it('3 个有界场景包：结构场景合计覆盖 Fifth §7 七项 + 观察场景覆盖 FRT-01/02/08/11', () => {
    const ids = LIVE_RESEARCH_SCENARIO_MANIFEST.map((s) => s.id);
    expect(ids).toEqual(['lr1-group-compare', 'lr2-sources-plus-search', 'lr3-hostile-observe']);
    // 结构场景映射 §7 条目（七条体验全部被至少一个结构场景覆盖）
    const structural = LIVE_RESEARCH_SCENARIO_MANIFEST.filter((s) => s.kind === 'structural');
    const covered = new Set(structural.flatMap((s) => s.fifth7));
    expect(covered.size).toBe(7);
    expect(covered).toContain('只查看某个分组');
    expect(covered).toContain('优先用收藏来源');
    expect(covered).toContain('说法冲突在哪里');
    expect(covered).toContain('整理成表格');
    expect(covered).toContain('切成卡片/排行榜展示');
    expect(covered).toContain('点击关键结论能看到对应来源');
    expect(covered).toContain('读取失败时继续并明确记录');
    // 观察场景存在（FRT 真实观察子集——语义行为不冒充防御）
    const observe = LIVE_RESEARCH_SCENARIO_MANIFEST.filter((s) => s.kind === 'observe');
    expect(observe).toHaveLength(1);
    for (const tag of ['FRT-01', 'FRT-02', 'FRT-08', 'FRT-11']) {
      expect(observe[0]!.purpose.includes(tag)).toBe(true);
    }
  });

  it('缺陷清单检出（重复 id/空文案/非法 kind）', () => {
    const dup = [...LIVE_RESEARCH_SCENARIO_MANIFEST, LIVE_RESEARCH_SCENARIO_MANIFEST[0]!];
    expect(validateLiveResearchScenarioManifest(dup).length).toBeGreaterThan(0);
    const emptyGoal = LIVE_RESEARCH_SCENARIO_MANIFEST.map((s, i) =>
      i === 0 ? { ...s, goal: ' ' } : s,
    );
    expect(validateLiveResearchScenarioManifest(emptyGoal).length).toBeGreaterThan(0);
  });
});

describe('validateLiveResearchExecution（manifest 与执行同源，fail-closed）', () => {
  const manifestIds = LIVE_RESEARCH_SCENARIO_MANIFEST.map((s) => s.id);

  it('全部执行恰好一次 → 通过', () => {
    expect(validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, manifestIds)).toEqual([]);
  });

  it('未执行（缺项）→ 失败', () => {
    const executed = manifestIds.filter((id) => id !== 'lr2-sources-plus-search');
    const errors = validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, executed);
    expect(errors.some((e) => e.startsWith('lr2-sources-plus-search：未执行'))).toBe(true);
  });

  it('重复执行 → 失败', () => {
    const errors = validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, [
      ...manifestIds,
      'lr1-group-compare',
    ]);
    expect(errors.some((e) => e.startsWith('lr1-group-compare：重复执行'))).toBe(true);
  });

  it('未知 id → 失败', () => {
    const errors = validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, [
      ...manifestIds,
      'lr-unknown',
    ]);
    expect(errors.some((e) => e.startsWith('lr-unknown：未知场景 id'))).toBe(true);
  });

  it('空执行 → 全部缺项失败', () => {
    const errors = validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, []);
    expect(errors).toHaveLength(manifestIds.length);
  });
});

describe('describeLiveResearchLedger（决议 #169(8) 台账纪律）', () => {
  it('只输出场景数/HTTP 次数/用途与结果分类（purpose 必须进入摘要）', () => {
    const entries: LiveResearchLedgerEntry[] = [
      { scenario: 'lr1', httpCalls: 8, resultKind: 'completed', purpose: '分组比较' },
      { scenario: 'lr3', httpCalls: 5, resultKind: 'failed-network', purpose: '敌对观察' },
    ];
    const text = describeLiveResearchLedger(entries);
    expect(text).toContain('2 项');
    expect(text).toContain('13 次');
    expect(text).toContain('lr1');
    expect(text).toContain('completed');
    expect(text).toContain('failed-network');
    expect(text).toContain('用途：分组比较');
    expect(text).toContain('用途：敌对观察');
  });

  it('空台账安全返回', () => {
    expect(describeLiveResearchLedger([])).toContain('0 项');
  });
});

describe('classifyLiveResearchFailure（决议 #117 失败分类 + C9 恢复校准）', () => {
  it('余额/权限/网络/服务端/模型兼容按 HTTP 状态区分（有状态依据）', () => {
    expect(classifyLiveResearchFailure({ httpStatus: 402 })).toBe('balance');
    expect(classifyLiveResearchFailure({ httpStatus: 401 })).toBe('permission');
    expect(classifyLiveResearchFailure({ httpStatus: 403 })).toBe('permission');
    expect(classifyLiveResearchFailure({ httpStatus: 429 })).toBe('server');
    expect(classifyLiveResearchFailure({ httpStatus: 500 })).toBe('server');
    expect(classifyLiveResearchFailure({ httpStatus: 503 })).toBe('server');
    expect(classifyLiveResearchFailure({ httpStatus: 400 })).toBe('model-compat');
    expect(classifyLiveResearchFailure({ errorCode: 'research-timeout' })).toBe('network');
  });

  it('research-provider-unavailable 无状态 → unclassified（不得伪造 permission/余额/网络）', () => {
    expect(classifyLiveResearchFailure({ errorCode: 'research-provider-unavailable' })).toBe(
      'unclassified',
    );
  });

  it('产品缺陷与夹具缺陷区分', () => {
    expect(classifyLiveResearchFailure({ errorCode: 'research-internal' })).toBe('product-defect');
    expect(classifyLiveResearchFailure({ errorCode: 'research-budget-exhausted' })).toBe(
      'product-defect',
    );
    expect(classifyLiveResearchFailure({ note: 'fixture page missing' })).toBe('fixture-defect');
  });
});
