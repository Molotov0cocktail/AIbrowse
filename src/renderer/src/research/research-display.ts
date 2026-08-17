// C9 决议 #165：Evidence provenance 与验证标签展示纯函数——防「Evidence
// 程序验证洗白成来源整体可信」（FT-07 trust laundering 的 UI 面）。
// trust 不参与排序（#120 保持），仅展示元数据；标签语义如实组合不洗白。
import type { EvidenceProvenance } from '../../../shared/types/research';

// 准确验证标签（替代笼统「已验证」）：程序验证的只是摘录与定位的真实性
export const EVIDENCE_VERIFICATION_LABEL = '摘录与定位已验证';

// 诚实警告（FT-06/FT-07 边界明示）：程序验证不代表来源整体可信，
// 也不保证摘录不存在断章取义（语义解读依赖用户下钻复核）
export const EVIDENCE_HONEST_NOTE = '程序验证不代表来源整体可信，也不保证摘录不存在断章取义';

export const PROVENANCE_LABEL_NO_TRUST = '无可信度声明';
export const PROVENANCE_LABEL_AI_UNVERIFIED = 'AI 推断·未核验';
export const PROVENANCE_LABEL_USER_ASSERTED = '用户声明·未独立核验';

/**
 * provenance 展示标签（决议 #165(2) 至少覆盖三态）：
 * - trust=null（search 命中恒无 trust 断言——#120）→ 「无可信度声明」；
 * - ai+unverified → 「AI 推断·未核验」（不得洗白为已核验事实）；
 * - user+asserted → 「用户声明·未独立核验」（用户声明 ≠ 程序核验）；
 * - 其余组合按三元组如实组合展示（防御性形态，不洗白）。
 */
export function describeEvidenceProvenance(provenance: EvidenceProvenance): string {
  const trust = provenance.trust;
  if (trust === null) return PROVENANCE_LABEL_NO_TRUST;
  if (trust.assertedBy === 'ai' && trust.verification === 'unverified') {
    return PROVENANCE_LABEL_AI_UNVERIFIED;
  }
  if (trust.assertedBy === 'user' && trust.verification === 'asserted') {
    return PROVENANCE_LABEL_USER_ASSERTED;
  }
  const assertedBy = trust.assertedBy === 'ai' ? 'AI 推断' : '用户声明';
  const verification = trust.verification === 'asserted' ? '已声明' : '未核验';
  return `${assertedBy}·${verification}`;
}
