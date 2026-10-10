export const DEFAULT_SMOKE_MARKER =
  '冒烟场景全部通过（T2 浏览器核心 + T3 UI 闭环 + T4 PageSnapshot 采集 + T5 安全/端到端扩展 + S3 AI 共读矩阵 1–8 + S4 UI 端到端矩阵 1–12）';
export const NORMAL_EXIT_MARKER = '冒烟自检通过，正常退出';

export interface DefaultSmokeEvidence {
  exitCode: number;
  jobZero: boolean;
  ledgerRetired: boolean;
  log: string;
}

function occurrences(value: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(marker, offset)) !== -1) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

export function verifyDefaultSmokeEvidence(value: DefaultSmokeEvidence): boolean {
  return (
    value.exitCode === 0 &&
    value.jobZero &&
    value.ledgerRetired &&
    occurrences(value.log, DEFAULT_SMOKE_MARKER) === 1 &&
    occurrences(value.log, NORMAL_EXIT_MARKER) === 1 &&
    !value.log.includes('冒烟场景失败')
  );
}
