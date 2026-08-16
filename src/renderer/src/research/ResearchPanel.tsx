// C8 决议 #163：ResearchPanel（380px 侧栏，sidePanel 'research' 三态互斥）——
// 只承载：goal 输入、开始/停止、状态/phase/stats、历史分页、删除、打开结果。
// 大表格与 Evidence drawer 必须在主结果画布（决策 D10 红线——禁止塞入 380px
// 侧栏）。unavailable 时全部入口禁用 + 固定中文诊断（其余 Browser/Sources/
// Chat 正常）。全部状态/phase/错误码固定中文映射（零原始消息透传——FT-16）。
import { useState, type ReactElement } from 'react';
import { normalizePlainText } from '../../../shared/markdown/markdown-text';
import type { ResearchTask } from '../../../shared/types/research';
import { RESEARCH_PHASE_LABELS, RESEARCH_STATUS_LABELS, type UseResearchApi } from './use-research';

export interface ResearchPanelProps {
  research: UseResearchApi;
  onCollapse: () => void;
  onOpenResult: (taskId: string) => void; // 画布模式切换由 App 消费
}

export function ResearchPanel({
  research,
  onCollapse,
  onOpenResult,
}: ResearchPanelProps): ReactElement {
  const { state } = research;
  const [goal, setGoal] = useState('');
  const [listPage, setListPage] = useState(1);

  const unavailable = !state.available;
  const canStart = !unavailable && !state.busy && goal.trim() !== '';
  const canStop =
    !unavailable && state.task !== null && state.task.status === 'running' && !state.busy;
  const canDelete =
    !unavailable && state.task !== null && state.task.status !== 'running' && !state.busy;
  const canOpenResult =
    !unavailable && state.task !== null && state.task.status === 'completed' && !state.busy;

  const totalPages = Math.max(1, Math.ceil(state.historyTotal / state.historyPageSize));

  const start = (): void => {
    void research.createAndStart(goal).then(() => setGoal(''));
  };

  return (
    <aside className="research-panel">
      <div className="research-panel-header">
        <span className="research-panel-title">研究</span>
        <button type="button" className="research-panel-collapse" onClick={onCollapse}>
          收起
        </button>
      </div>

      {unavailable && (
        <div className="research-panel-unavailable">
          {normalizePlainText(state.unavailableReason ?? '研究功能暂不可用')}
        </div>
      )}

      <div className="research-panel-body">
        {/* 目标输入 + 开始 */}
        <label className="research-panel-label" htmlFor="research-goal-input">
          研究目标
        </label>
        <textarea
          id="research-goal-input"
          className="research-panel-goal"
          value={goal}
          maxLength={2000}
          placeholder="例如：比较主流模型当前 Agent 能力"
          disabled={unavailable}
          onChange={(e) => setGoal(e.target.value)}
        />
        <button type="button" className="research-panel-start" disabled={!canStart} onClick={start}>
          开始研究
        </button>

        {/* 状态/phase/stats */}
        {state.task !== null && (
          <div className="research-panel-status">
            <div className="research-panel-status-row">
              <span>状态：{normalizePlainText(state.status ?? '—')}</span>
              {state.phase !== null && <span>阶段：{normalizePlainText(state.phase)}</span>}
            </div>
            {state.stats !== null && (
              <div className="research-panel-stats">
                候选 {state.stats.candidateCount} · 选定 {state.stats.selectedCount} · 读取{' '}
                {state.stats.captureCount} · 失败 {state.stats.failedReadCount} · 证据{' '}
                {state.stats.evidenceCount} · 拒绝 {state.stats.rejectedEvidenceCount} · 结论{' '}
                {state.stats.claimCount} · 冲突 {state.stats.conflictCount} · 步数{' '}
                {state.stats.stepsUsed}
              </div>
            )}
            {state.error !== null && (
              <div className="research-panel-error">{normalizePlainText(state.error)}</div>
            )}
            <div className="research-panel-actions">
              <button
                type="button"
                className="research-panel-stop"
                disabled={!canStop}
                onClick={() => void research.stop()}
              >
                停止
              </button>
              <button
                type="button"
                className="research-panel-open-result"
                disabled={!canOpenResult}
                onClick={() => {
                  if (state.task !== null) onOpenResult(state.task.id);
                }}
              >
                打开结果
              </button>
              <button
                type="button"
                className="research-panel-delete"
                disabled={!canDelete}
                onClick={() => void research.deleteSelected()}
              >
                删除
              </button>
            </div>
          </div>
        )}

        {/* 历史分页 */}
        <div className="research-panel-history">
          <div className="research-panel-history-header">历史（{state.historyTotal}）</div>
          {state.history.length === 0 && (
            <div className="research-panel-history-empty">暂无研究任务</div>
          )}
          <ul className="research-panel-history-list">
            {state.history.map((task: ResearchTask) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={
                    state.selectedTaskId === task.id
                      ? 'research-panel-history-item selected'
                      : 'research-panel-history-item'
                  }
                  onClick={() => void research.selectTask(task.id)}
                >
                  <span className="research-panel-history-goal">
                    {normalizePlainText(task.goal)}
                  </span>
                  <span className="research-panel-history-meta">
                    {normalizePlainText(RESEARCH_STATUS_LABELS[task.status] ?? task.status)}
                    {task.phase !== null &&
                      ` · ${normalizePlainText(RESEARCH_PHASE_LABELS[task.phase] ?? task.phase)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="research-panel-pager">
            <button
              type="button"
              className="research-panel-page-prev"
              disabled={listPage <= 1 || unavailable}
              onClick={() => {
                const next = listPage - 1;
                setListPage(next);
                void research.refreshList(next);
              }}
            >
              上一页
            </button>
            <span className="research-panel-page-info">
              {listPage} / {totalPages}
            </span>
            <button
              type="button"
              className="research-panel-page-next"
              disabled={listPage >= totalPages || unavailable}
              onClick={() => {
                const next = listPage + 1;
                setListPage(next);
                void research.refreshList(next);
              }}
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
