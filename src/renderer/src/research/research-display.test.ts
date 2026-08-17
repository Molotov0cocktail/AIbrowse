// C9 决议 #165：Evidence provenance 与验证标签展示纯函数——三态覆盖 +
// 防御性组合如实展示（不洗白）+ 标签常量冻结
import { describe, expect, it } from 'vitest';
import {
  describeEvidenceProvenance,
  EVIDENCE_HONEST_NOTE,
  EVIDENCE_VERIFICATION_LABEL,
  PROVENANCE_LABEL_AI_UNVERIFIED,
  PROVENANCE_LABEL_NO_TRUST,
  PROVENANCE_LABEL_USER_ASSERTED,
} from './research-display';
import type { EvidenceProvenance } from '../../../shared/types/research';

function provenance(trust: EvidenceProvenance['trust']): EvidenceProvenance {
  return { discoveredVia: ['sources'], trust };
}

describe('describeEvidenceProvenance（决议 #165(2)）', () => {
  it('trust=null → 「无可信度声明」（search 命中恒无 trust 断言）', () => {
    expect(describeEvidenceProvenance(provenance(null))).toBe(PROVENANCE_LABEL_NO_TRUST);
  });

  it('ai+unverified → 「AI 推断·未核验」（不得洗白为已核验）', () => {
    expect(
      describeEvidenceProvenance(
        provenance({ value: 'official', assertedBy: 'ai', verification: 'unverified' }),
      ),
    ).toBe(PROVENANCE_LABEL_AI_UNVERIFIED);
  });

  it('user+asserted → 「用户声明·未独立核验」（用户声明 ≠ 程序核验）', () => {
    expect(
      describeEvidenceProvenance(
        provenance({ value: 'official', assertedBy: 'user', verification: 'asserted' }),
      ),
    ).toBe(PROVENANCE_LABEL_USER_ASSERTED);
  });

  it('防御性组合（ai+asserted / user+unverified）如实组合不洗白', () => {
    expect(
      describeEvidenceProvenance(
        provenance({ value: 'primary', assertedBy: 'ai', verification: 'asserted' }),
      ),
    ).toBe('AI 推断·已声明');
    expect(
      describeEvidenceProvenance(
        provenance({ value: 'community', assertedBy: 'user', verification: 'unverified' }),
      ),
    ).toBe('用户声明·未核验');
  });

  it('标签常量冻结（准确验证标签 + 诚实警告边界）', () => {
    expect(EVIDENCE_VERIFICATION_LABEL).toBe('摘录与定位已验证');
    expect(EVIDENCE_HONEST_NOTE).toContain('不代表来源整体可信');
    expect(EVIDENCE_HONEST_NOTE).toContain('断章取义');
  });
});
