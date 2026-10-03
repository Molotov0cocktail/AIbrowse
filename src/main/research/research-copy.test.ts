import { expect, it, vi } from 'vitest';
import type { ResearchResultView, ResearchService } from '../../shared/types/research';
import { copyResearchTable } from './research-copy';

const taskId = 'aaaaaaaa-1111-4111-8111-111111111111';
const payload = { taskId, tableBlockIndex: 0, view: { sort: null, filter: '保留' } };
const view: ResearchResultView = {
  task: {
    id: taskId,
    goal: '合成',
    status: 'completed',
    phase: null,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    interruptedAt: null,
    errorCode: null,
    resultId: taskId,
    stats: {
      candidateCount: 0,
      selectedCount: 0,
      captureCount: 0,
      failedReadCount: 0,
      evidenceCount: 0,
      rejectedEvidenceCount: 0,
      claimCount: 0,
      conflictCount: 0,
      stepsUsed: 0,
      roundsUsed: 0,
    },
  },
  result: {
    resultId: taskId,
    taskId,
    title: '合成',
    summary: '',
    blocks: [{ kind: 'table', columns: ['列'], rows: [['保留\u0000'], ['筛掉']], sourceRefs: [] }],
    evidenceMap: {},
    conflicts: [],
    coverage: { total: 0, multiSource: 0, singleSource: 0, vendor: 0, thirdParty: 0, community: 0 },
    fetchedAt: '2026-10-04T00:00:00Z',
  },
  evidence: [],
};

it('复制重新读取已验证结果且只输出当前筛选投影，不接受renderer正文', async () => {
  const write = vi.fn();
  const service: Pick<ResearchService, 'getResearchResultView'> = {
    getResearchResultView: async () => ({ ok: true, view }),
  };
  expect(await copyResearchTable({ ...payload, text: '敌手' }, service, write, () => true)).toBe(
    false,
  );
  expect(write).not.toHaveBeenCalled();
  expect(await copyResearchTable(payload, service, write, () => true)).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith('列\r\n保留\r\n');
});

it('读取期间文档失效时不改剪贴板', async () => {
  let current = true;
  const write = vi.fn();
  const service: Pick<ResearchService, 'getResearchResultView'> = {
    getResearchResultView: async () => {
      current = false;
      return { ok: true, view };
    },
  };
  expect(await copyResearchTable(payload, service, write, () => current)).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
