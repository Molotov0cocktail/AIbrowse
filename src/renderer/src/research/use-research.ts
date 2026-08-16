// C8 决议 #163(4)：useResearch/reducer 契约（reducer 纯函数零 React 依赖可
// 单测；hook 部分在下方——订阅/退订/invoke 接线）。
// taskId 键控（其他任务事件不覆盖当前选中任务）；progress running 有界节流/
// 合并（语义变化才刷新——相同 phase/status/stats 快照合并）；terminal 立即
// 刷新；task-done 触发 task/result/list 重读标记；事件可能早于 start invoke
// 返回（安全收敛：事件为主、invoke 结果只补缺——不把 running 覆盖回
// created）；删除当前画布任务清空结果画布（resultCanvasCleared 标记由
// 消费方切回 browser 模式）；start 失败 created 保留进历史；unavailable 中文
// 诊断；全部状态/phase/错误码映射为固定中文 UI（零异常/SQL/路径/Provider
// 原文透传——FT-16）。
import type {
  ResearchErrorCode,
  ResearchProgressEvent,
  ResearchResultView,
  ResearchTask,
  ResearchTaskDoneStatus,
} from '../../../shared/types/research';

export interface ResearchUiState {
  available: boolean;
  unavailableReason: string | null;
  selectedTaskId: string | null;
  task: ResearchTask | null;
  resultView: ResearchResultView | null;
  phase: string | null; // 固定中文 phase 文案（running 时）
  status: string | null; // 固定中文 status 文案
  stats: ResearchTask['stats'] | null;
  finishedAt: string | null;
  error: string | null; // 固定中文诊断（操作失败）
  history: ResearchTask[];
  historyPage: number;
  historyPageSize: number;
  historyTotal: number;
  busy: boolean; // 写操作进行中（create/start/stop/delete）
  reloadRequested: boolean; // task-done 后需要重读 task/result/list
  resultCanvasCleared: boolean; // 删除当前画布任务后置位（消费方切回 browser）
}

export const INITIAL_RESEARCH_UI_STATE: ResearchUiState = {
  available: true,
  unavailableReason: null,
  selectedTaskId: null,
  task: null,
  resultView: null,
  phase: null,
  status: null,
  stats: null,
  finishedAt: null,
  error: null,
  history: [],
  historyPage: 1,
  historyPageSize: 20,
  historyTotal: 0,
  busy: false,
  reloadRequested: false,
  resultCanvasCleared: false,
};

// ---------- 固定中文映射（决议 #163(5)：零原始消息透传） ----------

export const RESEARCH_STATUS_LABELS: Record<string, string> = {
  created: '已创建',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export const RESEARCH_PHASE_LABELS: Record<string, string> = {
  planning: '规划来源',
  reading: '读取来源',
  verifying: '交叉核验',
  synthesizing: '综合生成',
};

export const RESEARCH_ERROR_LABELS: Record<ResearchErrorCode, string> = {
  'research-invalid-goal': '研究目标无效，请重新输入',
  'research-busy': '已有研究任务运行中，请稍候',
  'research-not-found': '任务不存在或已删除',
  'research-invalid-state': '当前状态不允许该操作',
  'research-unavailable': '研究功能暂不可用',
  'research-sources-unavailable': '信源数据暂不可用',
  'research-provider-unavailable': '模型服务未配置或不可用',
  'research-budget-exhausted': '研究预算已用尽',
  'research-timeout': '研究超时',
  'research-task-limit': '研究任务数量已达上限',
  'research-internal': '内部错误，详情见日志',
  'research-runtime-unavailable': '研究运行环境不可用',
};

export function describeResearchError(errorCode: ResearchErrorCode | string): string {
  return RESEARCH_ERROR_LABELS[errorCode as ResearchErrorCode] ?? '操作失败，请重试';
}

// ---------- reducer 事件（invoke 结果 + progress + task-done + 生命周期） ----------

export type ResearchUiEvent =
  | { kind: 'create-ok'; task: ResearchTask }
  | { kind: 'start-ok'; task: ResearchTask }
  | { kind: 'stop-ok'; task: ResearchTask }
  | { kind: 'get-ok'; task: ResearchTask }
  | { kind: 'invoke-error'; errorCode: ResearchErrorCode | string }
  | { kind: 'progress'; event: ResearchProgressEvent }
  | { kind: 'task-done'; taskId: string; status: ResearchTaskDoneStatus }
  | { kind: 'list-ok'; items: ResearchTask[]; page: number; pageSize: number; total: number }
  | { kind: 'result-ok'; view: ResearchResultView }
  | { kind: 'result-error'; errorCode: ResearchErrorCode | string }
  | { kind: 'delete-ok'; taskId: string }
  | { kind: 'busy' }
  | { kind: 'idle' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'reload-consumed' }
  | { kind: 'canvas-cleared-consumed' }
  | { kind: 'reset' };

// ---------- reducer（纯函数；输入零修改） ----------

function sameStats(a: ResearchTask['stats'] | null, b: ResearchTask['stats'] | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.candidateCount === b.candidateCount &&
    a.selectedCount === b.selectedCount &&
    a.captureCount === b.captureCount &&
    a.failedReadCount === b.failedReadCount &&
    a.evidenceCount === b.evidenceCount &&
    a.rejectedEvidenceCount === b.rejectedEvidenceCount &&
    a.claimCount === b.claimCount &&
    a.conflictCount === b.conflictCount &&
    a.stepsUsed === b.stepsUsed &&
    a.roundsUsed === b.roundsUsed
  );
}

export function reduceResearchUi(state: ResearchUiState, event: ResearchUiEvent): ResearchUiState {
  switch (event.kind) {
    case 'create-ok':
      return {
        ...state,
        selectedTaskId: event.task.id,
        task: event.task,
        status: RESEARCH_STATUS_LABELS[event.task.status] ?? null,
        phase: null,
        stats: event.task.stats,
        finishedAt: event.task.finishedAt,
        error: null,
        busy: false,
        resultCanvasCleared: false,
      };
    case 'start-ok':
      // 决议 #163(4)：事件可能早于 invoke 返回——若 progress 已把状态推到
      // running，迟到 start-ok（created 快照）只补缺不覆盖（以事件为主）
      if (state.task !== null && state.status === RESEARCH_STATUS_LABELS['running']) {
        return { ...state, busy: false };
      }
      return {
        ...state,
        selectedTaskId: event.task.id,
        task: event.task,
        status: RESEARCH_STATUS_LABELS[event.task.status] ?? null,
        phase: event.task.status === 'running' ? (RESEARCH_PHASE_LABELS['planning'] ?? null) : null,
        stats: event.task.stats,
        busy: false,
        error: null,
      };
    case 'stop-ok':
      return {
        ...state,
        task: event.task,
        status: RESEARCH_STATUS_LABELS[event.task.status] ?? null,
        phase: null,
        stats: event.task.stats,
        finishedAt: event.task.finishedAt,
        busy: false,
      };
    case 'get-ok':
      return {
        ...state,
        selectedTaskId: event.task.id,
        task: event.task,
        status: RESEARCH_STATUS_LABELS[event.task.status] ?? null,
        phase:
          event.task.status === 'running' && event.task.phase !== null
            ? (RESEARCH_PHASE_LABELS[event.task.phase] ?? null)
            : null,
        stats: event.task.stats,
        finishedAt: event.task.finishedAt,
        resultCanvasCleared: false,
      };
    case 'invoke-error':
      return { ...state, error: describeResearchError(event.errorCode), busy: false };
    case 'progress': {
      const e = event.event;
      // 决议 #163(4)：taskId 键控——其他任务事件零影响
      if (state.selectedTaskId !== null && e.taskId !== state.selectedTaskId) return state;
      // running 有界节流：相同 phase/status/stats 快照合并（不产生新状态）
      if (
        e.status === 'running' &&
        state.phase === RESEARCH_PHASE_LABELS[e.phase ?? ''] &&
        state.status === RESEARCH_STATUS_LABELS[e.status] &&
        sameStats(state.stats, e.stats)
      ) {
        return state;
      }
      return {
        ...state,
        status: RESEARCH_STATUS_LABELS[e.status] ?? state.status,
        phase: e.phase !== null ? (RESEARCH_PHASE_LABELS[e.phase] ?? null) : null,
        stats: e.stats,
        finishedAt: e.finishedAt,
        error: null,
      };
    }
    case 'task-done':
      // 决议 #163(4)：task-done 触发 task/result/list 重读（reloadRequested）；
      // 其他任务零影响
      if (state.selectedTaskId !== null && event.taskId !== state.selectedTaskId) return state;
      return {
        ...state,
        status: RESEARCH_STATUS_LABELS[event.status] ?? state.status,
        reloadRequested: true,
        error: null,
      };
    case 'list-ok':
      return {
        ...state,
        history: event.items,
        historyPage: event.page,
        historyPageSize: event.pageSize,
        historyTotal: event.total,
        reloadRequested: false,
      };
    case 'result-ok':
      return {
        ...state,
        selectedTaskId: event.view.task.id,
        task: event.view.task,
        resultView: event.view,
        status: RESEARCH_STATUS_LABELS[event.view.task.status] ?? null,
        stats: event.view.task.stats,
        finishedAt: event.view.task.finishedAt,
        error: null,
        resultCanvasCleared: false,
      };
    case 'result-error':
      // 结果读取失败不破坏画布外的任务状态（错误诊断显示）
      return { ...state, error: describeResearchError(event.errorCode) };
    case 'delete-ok':
      // 决议 #163(4)：删除当前画布任务 → 清空结果画布（消费方切回 browser）
      if (state.selectedTaskId !== null && event.taskId === state.selectedTaskId) {
        return {
          ...state,
          selectedTaskId: null,
          task: null,
          resultView: null,
          phase: null,
          status: null,
          stats: null,
          finishedAt: null,
          error: null,
          busy: false,
          reloadRequested: true,
          resultCanvasCleared: true,
        };
      }
      return { ...state, busy: false, reloadRequested: true };
    case 'busy':
      return { ...state, busy: true };
    case 'idle':
      return { ...state, busy: false };
    case 'unavailable':
      return { ...state, available: false, unavailableReason: event.reason };
    case 'reload-consumed':
      return { ...state, reloadRequested: false };
    case 'canvas-cleared-consumed':
      return { ...state, resultCanvasCleared: false };
    case 'reset':
      return {
        ...INITIAL_RESEARCH_UI_STATE,
        available: state.available,
        unavailableReason: state.unavailableReason,
      };
  }
}

// ---------- useResearch hook（React 接线：订阅/退订/invoke；reducer 纯函数已单测） ----------

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ExportCsvResult, ResearchExportCsvView } from '../../../shared/types/research';

export interface ResearchExportCsvOptions {
  taskId: string;
  tableBlockIndex: number;
  view: ResearchExportCsvView;
}

export interface UseResearchApi {
  state: ResearchUiState;
  createAndStart(goal: string): Promise<void>;
  stop(): Promise<void>;
  deleteSelected(): Promise<void>;
  openResult(taskId: string): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  refreshList(page?: number): Promise<void>;
  exportCsv(options: ResearchExportCsvOptions): Promise<ExportCsvResult>;
  consumeCanvasCleared(): void; // 消费 resultCanvasCleared 标记（App 切回 browser 后调用）
}

export function useResearch(): UseResearchApi {
  const [state, dispatch] = useReducer(reduceResearchUi, INITIAL_RESEARCH_UI_STATE);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; // 退订后零 setState（决议 #163(4)）
    };
  }, []);

  // 事件订阅：progress/task-done（eventRelay 退订函数）
  useEffect(() => {
    const offProgress = window.aibrowse.research.onProgress((event) => {
      dispatch({ kind: 'progress', event });
    });
    const offDone = window.aibrowse.research.onTaskDone((event) => {
      dispatch({ kind: 'task-done', taskId: event.taskId, status: event.status });
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  // 挂载即拉取历史（可用时）
  useEffect(() => {
    void refreshList(1);
  }, []);

  // task-done → 重读 task/result/list（reloadRequested 标记由 reducer 置位）
  useEffect(() => {
    if (!state.reloadRequested) return;
    dispatch({ kind: 'reload-consumed' });
    if (state.selectedTaskId !== null) {
      void loadTaskAndResult(state.selectedTaskId);
    }
    void refreshList(state.historyPage);
  }, [state.reloadRequested]);

  const loadTaskAndResult = useCallback(async (taskId: string): Promise<void> => {
    if (!mounted.current) return;
    const got = await window.aibrowse.research.get(taskId);
    if (!mounted.current) return;
    if (got.ok) {
      dispatch({ kind: 'get-ok', task: got.value.task });
      if (got.value.task.status === 'completed') {
        const res = await window.aibrowse.research.result(taskId);
        if (!mounted.current) return;
        if (res.ok) dispatch({ kind: 'result-ok', view: res.value.view });
        else dispatch({ kind: 'result-error', errorCode: res.errorCode });
      }
    } else {
      dispatch({ kind: 'invoke-error', errorCode: got.errorCode });
    }
  }, []);

  const refreshList = useCallback(async (page?: number): Promise<void> => {
    if (!mounted.current) return;
    const pageSize = 20;
    const target = page ?? 1;
    const res = await window.aibrowse.research.list({ page: target, pageSize });
    if (!mounted.current) return;
    if (res.ok) {
      dispatch({
        kind: 'list-ok',
        items: res.value.items,
        page: res.value.page,
        pageSize: res.value.pageSize,
        total: res.value.total,
      });
    } else {
      dispatch({ kind: 'invoke-error', errorCode: res.errorCode });
    }
  }, []);

  const createAndStart = useCallback(
    async (goal: string): Promise<void> => {
      if (!mounted.current) return;
      const trimmed = goal.trim();
      if (trimmed === '') {
        dispatch({ kind: 'invoke-error', errorCode: 'research-invalid-goal' });
        return;
      }
      dispatch({ kind: 'busy' });
      const created = await window.aibrowse.research.create(trimmed);
      if (!mounted.current) return;
      if (!created.ok) {
        dispatch({ kind: 'invoke-error', errorCode: created.errorCode });
        return;
      }
      dispatch({ kind: 'create-ok', task: created.value.task });
      // 决议 #163(3)：「开始研究」按 create→start 顺序执行；start 失败时
      // created 任务仍进入历史（reducer 保留），可重新启动或删除
      const started = await window.aibrowse.research.start(created.value.task.id);
      if (!mounted.current) return;
      if (started.ok) dispatch({ kind: 'start-ok', task: started.value.task });
      else dispatch({ kind: 'invoke-error', errorCode: started.errorCode });
      void refreshList(1);
    },
    [refreshList],
  );

  const stop = useCallback(async (): Promise<void> => {
    if (!mounted.current || state.selectedTaskId === null) return;
    dispatch({ kind: 'busy' });
    const res = await window.aibrowse.research.stop(state.selectedTaskId);
    if (!mounted.current) return;
    if (res.ok) dispatch({ kind: 'stop-ok', task: res.value.task });
    else dispatch({ kind: 'invoke-error', errorCode: res.errorCode });
  }, [state.selectedTaskId]);

  const deleteSelected = useCallback(async (): Promise<void> => {
    if (!mounted.current || state.selectedTaskId === null) return;
    dispatch({ kind: 'busy' });
    const res = await window.aibrowse.research.delete(state.selectedTaskId);
    if (!mounted.current) return;
    if (res.ok) dispatch({ kind: 'delete-ok', taskId: state.selectedTaskId });
    else dispatch({ kind: 'invoke-error', errorCode: res.errorCode });
    void refreshList(1);
  }, [state.selectedTaskId, refreshList]);

  const openResult = useCallback(
    async (taskId: string): Promise<void> => {
      if (!mounted.current) return;
      await loadTaskAndResult(taskId);
    },
    [loadTaskAndResult],
  );

  const selectTask = useCallback(
    async (taskId: string): Promise<void> => {
      if (!mounted.current) return;
      await loadTaskAndResult(taskId);
    },
    [loadTaskAndResult],
  );

  const exportCsv = useCallback(
    async (options: ResearchExportCsvOptions): Promise<ExportCsvResult> => {
      const res = await window.aibrowse.research.exportCsv(options);
      return res;
    },
    [],
  );

  const consumeCanvasCleared = useCallback((): void => {
    dispatch({ kind: 'canvas-cleared-consumed' });
  }, []);

  return {
    state,
    createAndStart,
    stop,
    deleteSelected,
    openResult,
    selectTask,
    refreshList,
    exportCsv,
    consumeCanvasCleared,
  };
}
