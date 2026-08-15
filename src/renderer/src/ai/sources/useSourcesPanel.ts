import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManualWriteResult,
  QuickAddResult,
  SourceGroupsResult,
  SourceListItem,
  SourceListResult,
  SourceSearchResult,
  SourcesState,
  UndoableChange,
  SourceView,
} from '../../../../shared/types/sources';
import type { SourcesAddPayload, SourcesUpdatePayload } from '../../../../shared/types/ipc';
import { sourceErrorLabel } from './sources-display';

// Sources 面板数据 hook（B5，决议 #69/#70/#77）：
// - 异步请求序号守卫：每次加载取递增序号，仅最新序号的结果落地（迟到响应忽略）；
// - 卸载退订 sources:changed（bridge 订阅返回退订函数，effect cleanup 调用）；
// - sources:changed 仅在主进程成功变更后到达（最小 payload）→ 收到后重新读取当前视图；
// - 写操作 pending 互斥（重复提交受控）；expectedVersion 冲突 → 中文提示 + 自动
//   刷新（严禁静默覆盖）；
// - 状态门控：state.mode !== 'normal' 时 UI 禁用全部写入口（本 hook 的 canWrite 由
//   面板消费；主进程侧写入口同样拒绝——纵深防御）。
interface GroupFilterAll {
  kind: 'all';
}
interface GroupFilterUngrouped {
  kind: 'ungrouped';
}
interface GroupFilterGroup {
  kind: 'group';
  groupId: string;
  groupName: string;
}
export type SourcesGroupFilter = GroupFilterAll | GroupFilterUngrouped | GroupFilterGroup;

export interface SourcesPanelData {
  state: SourcesState | null;
  groups: SourceGroupsResult | null;
  list: SourceListResult | null;
  page: number;
  groupFilter: SourcesGroupFilter;
  searchMode: boolean;
  searchQuery: string;
  searchResult: SourceSearchResult | null;
  detail: SourceView | null;
  undoable: UndoableChange[];
  notice: string | null;
  quickAddMessage: string | null;
  quickAddRelated: SourceListItem[];
  pendingOp: string | null; // 写操作进行中（重复提交受控：面板禁用写按钮）
  setSearchMode(mode: boolean): void;
  setSearchQuery(query: string): void;
  setGroupFilter(filter: SourcesGroupFilter): void;
  setPage(page: number): void;
  openDetail(id: string): void;
  closeDetail(): void;
  refreshAll(): void;
  add(input: SourcesAddPayload): Promise<ManualWriteResult>;
  update(payload: SourcesUpdatePayload): Promise<ManualWriteResult>;
  disable(sourceId: string, expectedVersion: number): Promise<ManualWriteResult>;
  restore(sourceId: string, expectedVersion: number): Promise<ManualWriteResult>;
  quickAdd(): Promise<QuickAddResult>;
  undo(idempotencyKey: string): Promise<void>;
  prepareHardDelete(
    sourceId: string,
  ): Promise<{ ok: true; token: string } | { ok: false; errorCode: string }>;
  hardDelete(sourceId: string, token: string): Promise<ManualWriteResult>;
  canWrite: boolean;
}

const PAGE_SIZE = 20;

export function useSourcesPanel(): SourcesPanelData {
  const [state, setState] = useState<SourcesState | null>(null);
  const [groups, setGroups] = useState<SourceGroupsResult | null>(null);
  const [list, setList] = useState<SourceListResult | null>(null);
  const [page, setPageState] = useState(0);
  const [groupFilter, setGroupFilterState] = useState<SourcesGroupFilter>({ kind: 'all' });
  const [searchMode, setSearchModeState] = useState(false);
  const [searchQuery, setSearchQueryState] = useState('');
  const [searchResult, setSearchResult] = useState<SourceSearchResult | null>(null);
  const [detail, setDetail] = useState<SourceView | null>(null);
  const [undoable, setUndoable] = useState<UndoableChange[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [quickAddMessage, setQuickAddMessage] = useState<string | null>(null);
  const [quickAddRelated, setQuickAddRelated] = useState<SourceListItem[]>([]);
  const [pendingOp, setPendingOp] = useState<string | null>(null);

  // 决议 #77：序号守卫——迟到响应忽略。**每种加载独立计数**（同一批次 refreshAll
  // 内 state/groups/list/undoable 并行发出，共享计数器会把批次内先发出的响应全部
  // 误判为「迟到」——B-05 dev 冒烟实测抓出：分组/状态/列表恒空。仅同种类响应
  // 互相竞争，新响应覆盖旧的同种类响应。
  const seqRef = useRef<{
    state: number;
    groups: number;
    list: number;
    undoable: number;
    search: number;
    detail: number;
  }>({ state: 0, groups: 0, list: 0, undoable: 0, search: 0, detail: 0 });
  const nextSeq = (
    kind: 'state' | 'groups' | 'list' | 'undoable' | 'search' | 'detail',
  ): number => {
    seqRef.current[kind] += 1;
    return seqRef.current[kind];
  };
  const isCurrent = (
    kind: 'state' | 'groups' | 'list' | 'undoable' | 'search' | 'detail',
    seq: number,
  ): boolean => seq === seqRef.current[kind];

  const groupIdOf = useCallback(
    (filter: SourcesGroupFilter): string | null | undefined =>
      filter.kind === 'all' ? undefined : filter.kind === 'ungrouped' ? null : filter.groupId,
    [],
  );

  const loadState = useCallback((): void => {
    const seq = nextSeq('state');
    void window.aibrowse.sources.state().then((s) => {
      if (isCurrent('state', seq)) setState(s);
    });
  }, []);

  const loadGroups = useCallback((): void => {
    const seq = nextSeq('groups');
    void window.aibrowse.sources.groups({ page: 0, pageSize: PAGE_SIZE }).then((res) => {
      if (isCurrent('groups', seq)) setGroups(res);
    });
  }, []);

  const loadList = useCallback(
    (targetPage: number, filter: SourcesGroupFilter): void => {
      const seq = nextSeq('list');
      void window.aibrowse.sources
        .list({ page: targetPage, pageSize: PAGE_SIZE, groupId: groupIdOf(filter) })
        .then((res) => {
          if (isCurrent('list', seq)) setList(res);
        });
    },
    [groupIdOf],
  );

  const loadUndoable = useCallback((): void => {
    const seq = nextSeq('undoable');
    void window.aibrowse.sources.undoable().then((res) => {
      if (isCurrent('undoable', seq)) setUndoable(res);
    });
  }, []);

  const loadSearch = useCallback((query: string): void => {
    const seq = nextSeq('search');
    void window.aibrowse.sources.search({ query }).then((res) => {
      if (isCurrent('search', seq)) setSearchResult(res);
    });
  }, []);

  const loadDetail = useCallback((id: string): void => {
    const seq = nextSeq('detail');
    void window.aibrowse.sources.get({ sourceId: id }).then((res) => {
      if (isCurrent('detail', seq)) {
        if (res.ok) setDetail(res.source);
        else setDetail(null);
      }
    });
  }, []);

  const refreshAll = useCallback((): void => {
    loadState();
    loadGroups();
    loadList(page, groupFilter);
    loadUndoable();
    if (searchMode && searchQuery.trim() !== '') loadSearch(searchQuery);
    if (detail !== null) loadDetail(detail.id);
  }, [
    loadState,
    loadGroups,
    loadList,
    loadUndoable,
    loadSearch,
    loadDetail,
    page,
    groupFilter,
    searchMode,
    searchQuery,
    detail,
  ]);

  // 决议 #70/#77：订阅 sources:changed → 重新读取；卸载时退订（无泄漏）
  useEffect(() => {
    const off = window.aibrowse.sources.onChanged(() => {
      refreshAll();
    });
    return off;
  }, [refreshAll]);

  // 首次加载
  useEffect(() => {
    refreshAll();
  }, []);

  // 决议 #77：重复提交受控——在途写操作存在时拒绝（返回 null；面板按钮禁用为
  // 第一道防线，此为程序内兜底）。不抛异常（调用方安全返回结构化结果）。
  const write = useCallback(
    async <T>(op: string, fn: () => Promise<T>): Promise<T | null> => {
      if (pendingOp !== null) {
        setNotice('已有操作进行中，请稍候');
        return null;
      }
      setPendingOp(op);
      try {
        return await fn();
      } finally {
        setPendingOp(null);
      }
    },
    [pendingOp],
  );

  const setPage = useCallback(
    (p: number): void => {
      setPageState(p);
      loadList(p, groupFilter);
    },
    [groupFilter, loadList],
  );

  const setGroupFilter = useCallback(
    (filter: SourcesGroupFilter): void => {
      setGroupFilterState(filter);
      setPageState(0);
      loadList(0, filter);
    },
    [loadList],
  );

  const setSearchMode = useCallback(
    (mode: boolean): void => {
      setSearchModeState(mode);
      if (mode && searchQuery.trim() !== '') loadSearch(searchQuery);
    },
    [searchQuery, loadSearch],
  );

  const setSearchQuery = useCallback(
    (query: string): void => {
      setSearchQueryState(query);
      if (query.trim() === '') {
        setSearchResult(null);
        return;
      }
      loadSearch(query);
    },
    [loadSearch],
  );

  const openDetail = useCallback(
    (id: string): void => {
      setNotice(null);
      loadDetail(id);
    },
    [loadDetail],
  );

  const closeDetail = useCallback((): void => {
    setDetail(null);
  }, []);

  const add = useCallback(
    async (input: SourcesAddPayload): Promise<ManualWriteResult> => {
      setNotice(null);
      const result = await write('add', () => window.aibrowse.sources.add(input));
      if (result === null) return { ok: false, errorCode: 'source-conflict' };
      if (!result.ok) {
        setNotice(sourceErrorLabel(result.errorCode));
      } else {
        refreshAll();
        loadDetail(result.source.id);
      }
      return result;
    },
    [write, refreshAll, loadDetail],
  );

  const update = useCallback(
    async (payload: SourcesUpdatePayload): Promise<ManualWriteResult> => {
      setNotice(null);
      const result = await write('update', () => window.aibrowse.sources.update(payload));
      if (result === null) return { ok: false, errorCode: 'source-conflict' };
      if (!result.ok) {
        // 决议 #77：expectedVersion 冲突提示刷新，严禁静默覆盖
        setNotice(sourceErrorLabel(result.errorCode));
        refreshAll();
      } else {
        refreshAll();
        loadDetail(result.source.id);
      }
      return result;
    },
    [write, refreshAll, loadDetail],
  );

  const disable = useCallback(
    async (sourceId: string, expectedVersion: number): Promise<ManualWriteResult> => {
      setNotice(null);
      const result = await write('disable', () =>
        window.aibrowse.sources.disable({ sourceId, expectedVersion }),
      );
      if (result === null) return { ok: false, errorCode: 'source-conflict' };
      if (!result.ok) {
        setNotice(sourceErrorLabel(result.errorCode));
        refreshAll();
      } else {
        refreshAll();
        loadDetail(result.source.id);
      }
      return result;
    },
    [write, refreshAll, loadDetail],
  );

  const restore = useCallback(
    async (sourceId: string, expectedVersion: number): Promise<ManualWriteResult> => {
      setNotice(null);
      const result = await write('restore', () =>
        window.aibrowse.sources.restore({ sourceId, expectedVersion }),
      );
      if (result === null) return { ok: false, errorCode: 'source-conflict' };
      if (!result.ok) {
        setNotice(sourceErrorLabel(result.errorCode));
        refreshAll();
      } else {
        refreshAll();
        loadDetail(result.source.id);
      }
      return result;
    },
    [write, refreshAll, loadDetail],
  );

  const quickAdd = useCallback(async (): Promise<QuickAddResult> => {
    setNotice(null);
    setQuickAddMessage(null);
    setQuickAddRelated([]);
    const result = await write('quick-add', () => window.aibrowse.sources.quickAdd());
    if (result === null) return { status: 'error', errorCode: 'source-conflict' };
    if (result.status === 'added') {
      setQuickAddMessage(`已添加：${result.source.name}`);
      setQuickAddRelated(result.related);
      refreshAll(); // 停留列表视图（消息 + 可能相关提示；用户自行点击条目查看详情）
    } else if (result.status === 'duplicate') {
      setQuickAddMessage(`已存在：${result.existing.name}（未重复添加）`);
      setQuickAddRelated(result.related);
      refreshAll();
    } else if (result.status === 'no-active-page') {
      setQuickAddMessage('当前没有活动标签页，无法快速添加');
    } else if (result.status === 'unsupported-url') {
      setQuickAddMessage('当前页面不是 http/https 网址，无法添加');
    } else {
      setQuickAddMessage(`添加失败：${sourceErrorLabel(result.errorCode)}`);
    }
    return result;
  }, [write, refreshAll, loadDetail]);

  const undo = useCallback(
    async (idempotencyKey: string): Promise<void> => {
      setNotice(null);
      const result = await write('undo', () => window.aibrowse.sources.undo({ idempotencyKey }));
      if (result === null) return;
      if (!result.ok) {
        setNotice(sourceErrorLabel(result.errorCode));
        refreshAll();
        return;
      }
      refreshAll();
    },
    [write, refreshAll],
  );

  const prepareHardDelete = useCallback(
    async (
      sourceId: string,
    ): Promise<{ ok: true; token: string } | { ok: false; errorCode: string }> => {
      setNotice(null);
      const result = await window.aibrowse.sources.prepareHardDelete({ sourceId });
      if (!result.ok) {
        setNotice(sourceErrorLabel(result.errorCode));
        return { ok: false, errorCode: result.errorCode };
      }
      return { ok: true, token: result.token };
    },
    [],
  );

  const hardDelete = useCallback(
    async (sourceId: string, token: string): Promise<ManualWriteResult> => {
      setNotice(null);
      const result = await write('hard-delete', () =>
        window.aibrowse.sources.hardDelete({ sourceId, token }),
      );
      if (result === null) return { ok: false, errorCode: 'source-conflict' };
      if (!result.ok) {
        // 令牌过期/错绑定/重放（决议 #73）：提示重新发起
        setNotice(
          result.errorCode === 'source-conflict'
            ? '确认已失效或过期，未删除任何数据，请重新发起永久删除'
            : sourceErrorLabel(result.errorCode),
        );
        refreshAll();
      } else {
        refreshAll();
        setDetail(null); // 已删除 → 返回列表
      }
      return result;
    },
    [write, refreshAll],
  );

  return {
    state,
    groups,
    list,
    page,
    groupFilter,
    searchMode,
    searchQuery,
    searchResult,
    detail,
    undoable,
    notice,
    quickAddMessage,
    quickAddRelated,
    pendingOp,
    setSearchMode,
    setSearchQuery,
    setGroupFilter,
    setPage,
    openDetail,
    closeDetail,
    refreshAll,
    add,
    update,
    disable,
    restore,
    quickAdd,
    undo,
    prepareHardDelete,
    hardDelete,
    canWrite: state === null || state.mode === 'normal',
  };
}
