import { describe, expect, it } from 'vitest';
import { diagnosticErrorLabel, shortDiagnosticDigest } from './diagnostic-display';

describe('diagnostic display', () => {
  it('错误码只映射固定中文，不回显外部正文', () => {
    expect(diagnosticErrorLabel('stale')).toBe('诊断预览已失效，请重新生成');
    expect(diagnosticErrorLabel('write-failed')).toBe('诊断文件保存失败');
  });

  it('摘要仅展示固定短前缀', () => {
    expect(shortDiagnosticDigest('a'.repeat(64))).toBe('a'.repeat(12));
  });
});
