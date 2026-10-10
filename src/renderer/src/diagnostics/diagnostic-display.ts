import type { DiagnosticErrorCode } from '../../../shared/types/diagnostics';

const ERROR_LABELS: Readonly<Record<DiagnosticErrorCode, string>> = Object.freeze({
  'invalid-payload': '诊断请求无效，请刷新后重试',
  unavailable: '诊断信息当前不可用',
  stale: '诊断预览已失效，请重新生成',
  expired: '诊断预览已过期，请重新生成',
  busy: '已有诊断导出正在进行',
  cancelled: '已取消导出',
  'write-failed': '诊断文件保存失败',
});

export function diagnosticErrorLabel(code: DiagnosticErrorCode): string {
  return ERROR_LABELS[code];
}

export function shortDiagnosticDigest(digest: string): string {
  return digest.slice(0, 12);
}
