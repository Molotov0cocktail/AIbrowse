import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ResearchTask } from '../../../shared/types/research';
import { ResearchPanel } from './ResearchPanel';
import { INITIAL_RESEARCH_UI_STATE, type UseResearchApi } from './use-research';

function renderTask(status: ResearchTask['status'], candidates: number, evidence: number): string {
  const task: ResearchTask = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    goal: '比较指定网页',
    status,
    phase: status === 'running' ? 'reading' : null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    startedAt: '2026-10-12T00:00:00.000Z',
    finishedAt: status === 'completed' ? '2026-10-12T00:00:01.000Z' : null,
    interruptedAt: null,
    errorCode: null,
    resultId: null,
    stats: {
      candidateCount: candidates,
      selectedCount: candidates,
      captureCount: candidates,
      failedReadCount: 0,
      evidenceCount: evidence,
      rejectedEvidenceCount: 0,
      claimCount: 0,
      conflictCount: 0,
      stepsUsed: 0,
      roundsUsed: 0,
    },
  };
  const research: UseResearchApi = {
    state: { ...INITIAL_RESEARCH_UI_STATE, task, stats: task.stats },
    createAndStart: vi.fn(),
    stop: vi.fn(),
    deleteSelected: vi.fn(),
    openResult: vi.fn(),
    selectTask: vi.fn(),
    refreshList: vi.fn(),
    exportCsv: vi.fn(),
    consumeCanvasCleared: vi.fn(),
  };
  return renderToString(
    createElement(ResearchPanel, { research, onCollapse: vi.fn(), onOpenResult: vi.fn() }),
  );
}

describe('研究来源与结果边界提示', () => {
  it('开始前说明目标完整网址进入候选并关联目标输入说明', () => {
    const html = renderTask('created', 0, 0);
    expect(html).toContain('目标中的完整 http(s) 网址会加入候选');
    expect(html).toContain('aria-describedby="research-source-help"');
  });

  it('已完成但没有候选时明确未找到来源，不依赖模型生成提示', () => {
    const html = renderTask('completed', 0, 0);
    expect(html).toContain('未找到可用来源');
    expect(html).toContain('请检查目标网址与信源分享设置');
  });

  it('找到来源但没有证据时明确证据不足', () => {
    const html = renderTask('completed', 2, 0);
    expect(html).toContain('未获得可用证据');
    expect(html).not.toContain('未找到可用来源');
  });

  it.each(['running', 'failed', 'cancelled'] as const)('%s 不提前判定最终研究覆盖', (status) => {
    expect(renderTask(status, 0, 0)).not.toContain('research-coverage-notice');
  });

  it('有证据的已完成任务不误报零证据', () => {
    expect(renderTask('completed', 2, 1)).not.toContain('research-coverage-notice');
  });
});
