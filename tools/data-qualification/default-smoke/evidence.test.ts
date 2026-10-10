import { expect, it } from 'vitest';
import {
  DEFAULT_SMOKE_MARKER,
  NORMAL_EXIT_MARKER,
  verifyDefaultSmokeEvidence,
} from './evidence.ts';

const valid = {
  exitCode: 0,
  jobZero: true,
  ledgerRetired: true,
  log: `${DEFAULT_SMOKE_MARKER}\n${NORMAL_EXIT_MARKER}`,
};

it('只接受完整默认矩阵marker、正常退出、原Job归零和双账本退休', () => {
  expect(verifyDefaultSmokeEvidence(valid)).toBe(true);
  for (const patch of [
    { exitCode: 91 },
    { jobZero: false },
    { ledgerRetired: false },
    { log: NORMAL_EXIT_MARKER },
    {
      log: `冒烟场景全部通过（浏览器核心 + S5 真实 Provider 流式一问一答）\n${NORMAL_EXIT_MARKER}`,
    },
    { log: `${DEFAULT_SMOKE_MARKER}\n${NORMAL_EXIT_MARKER}\n冒烟场景失败（调度层）` },
    { log: `${DEFAULT_SMOKE_MARKER}\n${DEFAULT_SMOKE_MARKER}\n${NORMAL_EXIT_MARKER}` },
  ])
    expect(verifyDefaultSmokeEvidence({ ...valid, ...patch })).toBe(false);
});
