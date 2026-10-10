import { contextBridge, ipcRenderer } from 'electron';
import {
  RUNTIME_PING,
  RUNTIME_SAMPLE,
  type RuntimeUiBridge,
} from '../../tools/data-qualification/runtime/ui-protocol';
import type { AibrowseBridge, AppInfo } from '../shared/types/app';
import type { PageSnapshot, TabInfo, TabsState } from '../shared/types/browser';
import type {
  AskResult,
  ContextPreview,
  ConversationMessage,
  ConversationSession,
  ConversationStorageStatus,
  ProviderInfo,
  StreamChunkEvent,
  TurnDoneEvent,
} from '../shared/types/conversation';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentStatusEvent,
  AgentStepEvent,
} from '../shared/types/agent';
import type {
  ManualWriteResult,
  PrepareHardDeleteResult,
  QuickAddResult,
  SourceGroupsResult,
  SourceListResult,
  FtsRebuildResult,
  SourceResult,
  SourceSearchResult,
  SourcesState,
  UndoResult,
  UndoableChange,
} from '../shared/types/sources';
import type {
  SourcesAddPayload,
  SourcesChangedEvent,
  SourcesGetPayload,
  SourcesGroupsPayload,
  SourcesHardDeletePayload,
  SourcesIdPayload,
  SourcesIdVersionPayload,
  SourcesListPayload,
  SourcesSearchPayload,
  SourcesUndoPayload,
  SourcesUpdatePayload,
} from '../shared/types/ipc';
import type {
  ExportCsvResult,
  ResearchIpcListValue,
  ResearchIpcResult,
  ResearchIpcTaskValue,
  ResearchProgressEvent,
  ResearchResultView,
  ResearchTaskDoneEvent,
} from '../shared/types/research';
import type { ResearchExportCsvPayload, ResearchListPayload } from '../shared/types/ipc';
import { IPC } from '../shared/types/ipc';
import type { WatchIpcResult, WatchPushDto, WatchStatusDto } from '../shared/types/watch-ipc';
import { validateWatchIpcOutput } from '../shared/watch/watch-ipc-validator';
import type { WatchIpcChannel } from '../shared/watch/watch-ipc-validator';
import { parseDataTransferStatus } from './data-transfer-status';
import { UiDocumentAuthorization } from './ui-document-authorization';
import type {
  DiagnosticExportPayload,
  DiagnosticExportResult,
  DiagnosticPreviewResult,
} from '../shared/types/diagnostics';

// Minimal-privilege bridge (design §3.2 + stage2 §4.2): only whitelisted methods are
// exposed; the raw ipcRenderer is never handed to the renderer (安全红线：preload bridge
// 最小权限；API Key 只写不回读——无任何读回方法).
// This token remains in the isolated preload and expires on every document navigation.
const documentAuthorization = new UiDocumentAuthorization(
  () => ipcRenderer.invoke(IPC.UiDocumentOpen) as Promise<string | null>,
);
const onDocumentCommitted = (): void => documentAuthorization.documentCommitted();
ipcRenderer.on(IPC.UiDocumentReady, onDocumentCommitted);
const documentToken = documentAuthorization.open();
void documentToken.then(() => ipcRenderer.removeListener(IPC.UiDocumentReady, onDocumentCommitted));
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => documentAuthorization.dispose(), { once: true });
const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
  const token = await documentToken;
  if (typeof token !== 'string' || !documentAuthorization.isAuthorized())
    throw new Error('应用文档尚未授权');
  return ipcRenderer.invoke(channel, payload, token) as Promise<T>;
};
if (__E2_RUNTIME_QUALIFICATION__) {
  const bridge: RuntimeUiBridge = Object.freeze({
    ping: (sequence: number) => invoke<number>(RUNTIME_PING, { sequence }),
    sample: (sequence: number, roundTripMs: number) =>
      invoke<boolean>(RUNTIME_SAMPLE, { sequence, roundTripMs }),
  });
  contextBridge.exposeInMainWorld('e2RuntimeQualification', bridge);
}
const send = (channel: string, payload?: unknown): void => {
  void documentToken
    .then((token) => {
      if (typeof token === 'string' && documentAuthorization.isAuthorized())
        ipcRenderer.send(channel, payload, token);
    })
    .catch(() => undefined);
};

// 事件推送（tabs:updated + conversation 两通道）：preload 内同一通道只注册一次
// ipcRenderer 监听，由 JS 侧管理 listener 列表（防重复注册；渲染层卸载时退订，§3.2/§4.2）。
function eventRelay<T>(channel: string): {
  subscribe: (listener: (payload: T) => void) => () => void;
} {
  const listeners = new Set<(payload: T) => void>();
  const receive = (_event: Electron.IpcRendererEvent, payload: T): void => {
    if (!documentAuthorization.isAuthorized()) return;
    for (const listener of listeners) listener(payload);
  };
  return {
    subscribe: (listener) => {
      if (listeners.size === 0) ipcRenderer.on(channel, receive);
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) ipcRenderer.removeListener(channel, receive);
      };
    },
  };
}

const tabsUpdatedRelay = eventRelay<TabsState>(IPC.TabsUpdated);
const streamChunkRelay = eventRelay<StreamChunkEvent>(IPC.ConversationStreamChunk);
const turnDoneRelay = eventRelay<TurnDoneEvent>(IPC.ConversationTurnDone);
// A6：Agent 可见性事件（每个通道只注册一次 ipcRenderer 监听，JS 侧 Set 分发与退订）
const agentStepRelay = eventRelay<AgentStepEvent>(IPC.AgentStep);
const agentConfirmRequestRelay = eventRelay<AgentConfirmRequest>(IPC.AgentConfirmRequest);
const agentRunDoneRelay = eventRelay<AgentRunDoneEvent>(IPC.AgentRunDone);
const agentStatusRelay = eventRelay<AgentStatusEvent>(IPC.AgentStatus);
// B5：sources:changed 事件（同一 eventRelay 模式：单次注册 + JS 侧 Set 分发/退订）
const sourcesChangedRelay = eventRelay<SourcesChangedEvent>(IPC.SourcesChanged);
// C8：research:progress / research:task-done 事件（同一 eventRelay 模式）
const researchProgressRelay = eventRelay<ResearchProgressEvent>(IPC.ResearchProgress);
const researchTaskDoneRelay = eventRelay<ResearchTaskDoneEvent>(IPC.ResearchTaskDone);

const watchListeners = new Set<(push: WatchPushDto) => void>();
const receiveWatchPush = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
  if (!documentAuthorization.isAuthorized()) return;
  if (!validateWatchIpcOutput(payload)) return;
  for (const listener of watchListeners) listener(payload as WatchPushDto);
};
const subscribeWatch = (listener: (push: WatchPushDto) => void): (() => void) => {
  if (watchListeners.size === 0) {
    ipcRenderer.on(IPC.WatchSubscribe, receiveWatchPush);
    send(IPC.WatchSubscribe, { action: 'start' });
  }
  watchListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    watchListeners.delete(listener);
    if (watchListeners.size === 0) {
      ipcRenderer.removeListener(IPC.WatchSubscribe, receiveWatchPush);
      send(IPC.WatchSubscribe, { action: 'stop' });
    }
  };
};

const invokeWatch = async <T>(
  channel: WatchIpcChannel,
  payload: unknown,
): Promise<WatchIpcResult<T>> => {
  const result = await invoke<unknown>(channel, payload);
  return validateWatchIpcOutput(result, channel)
    ? (result as WatchIpcResult<T>)
    : { ok: false, errorCode: 'unavailable' };
};

const bridge: AibrowseBridge = {
  getAppInfo: () => invoke<AppInfo>(IPC.AppGetInfo),
  getConversationStorageStatus: () =>
    invoke<ConversationStorageStatus>(IPC.ConversationStorageStatus),
  dataTransfer: {
    getStatus: () => invoke<unknown>(IPC.DataTransferStatus).then(parseDataTransferStatus),
    start: (action) =>
      invoke<unknown>(IPC.DataTransferStart, { action }).then(parseDataTransferStatus),
    cancel: (operationId) =>
      invoke<unknown>(IPC.DataTransferCancel, { operationId }).then(parseDataTransferStatus),
    recoverOriginal: (operationId) =>
      invoke<unknown>(IPC.DataTransferRecoverOriginal, { operationId }).then(
        parseDataTransferStatus,
      ),
  },
  diagnostics: {
    preview: () => invoke<DiagnosticPreviewResult>(IPC.DiagnosticPreview),
    export: (payload: DiagnosticExportPayload) =>
      invoke<DiagnosticExportResult>(IPC.DiagnosticExport, payload),
  },
  notifyRendererReady: () => {
    send(IPC.AppRendererReady);
  },
  tabs: {
    list: () => invoke<TabInfo[]>(IPC.TabsList),
    create: (url) => invoke<TabInfo | null>(IPC.TabsCreate, { url }),
    close: (tabId) => invoke<boolean>(IPC.TabsClose, { tabId }),
    activate: (tabId) => invoke<boolean>(IPC.TabsActivate, { tabId }),
    onUpdated: tabsUpdatedRelay.subscribe,
  },
  nav: {
    navigate: (tabId, input) => invoke<boolean>(IPC.NavNavigate, { tabId, input }),
    back: (tabId) => invoke<boolean>(IPC.NavBack, { tabId }),
    forward: (tabId) => invoke<boolean>(IPC.NavForward, { tabId }),
    reload: (tabId) => invoke<boolean>(IPC.NavReload, { tabId }),
  },
  page: {
    snapshot: (tabId) => invoke<PageSnapshot | null>(IPC.PageSnapshot, { tabId }),
  },
  ui: {
    reportContentBounds: (bounds) => {
      send(IPC.UiContentBounds, bounds);
    },
    // C8 决议 #158(5)：受控 send（payload 白名单在主进程校验；不暴露 Electron 对象）
    setBrowserContentVisible: (visible) => {
      send(IPC.UiBrowserContentVisible, { visible });
    },
  },
  // —— Second Stage（§4.2）：AI 共读白名单（invoke 全部经 main 侧 sender+主帧校验） ——
  conversation: {
    list: () => invoke<ConversationSession[]>(IPC.ConversationList),
    create: (opts) => invoke<ConversationSession | null>(IPC.ConversationCreate, opts),
    getHistory: (sessionId) =>
      invoke<ConversationMessage[] | null>(IPC.ConversationHistory, { sessionId }),
    remove: (sessionId) => invoke<boolean>(IPC.ConversationDelete, { sessionId }),
    setEphemeral: (sessionId, ephemeral) =>
      invoke<boolean>(IPC.ConversationSetEphemeral, { sessionId, ephemeral }),
    ask: (sessionId, question) => invoke<AskResult>(IPC.ConversationAsk, { sessionId, question }),
    abort: (requestId) => invoke<boolean>(IPC.ConversationAbort, { requestId }),
    preview: () => invoke<ContextPreview | null>(IPC.ConversationPreview),
    // —— Third Stage（A6，§11.1）：Agent 任务与可见性（invoke 经 main 侧 sender+主帧校验） ——
    agentAsk: (sessionId, goal) => invoke<AskResult>(IPC.AgentAsk, { sessionId, goal }),
    confirmTool: (toolCallId, approve) =>
      invoke<boolean>(IPC.AgentConfirm, { toolCallId, approve }),
    onStreamChunk: streamChunkRelay.subscribe,
    onTurnDone: turnDoneRelay.subscribe,
    onAgentStep: agentStepRelay.subscribe,
    onAgentConfirmRequest: agentConfirmRequestRelay.subscribe,
    onAgentRunDone: agentRunDoneRelay.subscribe,
    onAgentStatus: agentStatusRelay.subscribe,
  },
  config: {
    providers: {
      list: () => invoke<ProviderInfo[]>(IPC.ConfigProvidersList),
      hasKey: (providerId) => invoke<boolean>(IPC.ConfigProvidersHasKey, { providerId }),
      set: (cfg) => invoke<boolean>(IPC.ConfigProvidersSet, cfg),
      // 只写不回读（§10）：无任何读回方法；apiKey='' = 删除
      setKey: (providerId, apiKey) =>
        invoke<boolean>(IPC.ConfigProvidersSetKey, { providerId, apiKey }),
    },
  },
  // —— Fourth Stage B5（决议 #69/#70/#72/#73/#74）：Sources 面板白名单 ——
  // invoke 全部经 main 侧 handle() sender+主帧校验 + 严格白名单验证；audience 由
  // 主进程适配器硬编码 'user'（renderer 无 audience/路径/SQL 通道）；quick-add 无
  // 参数（main 读取当前活动 Tab）；sources:changed 仅成功变更后推送最小 payload。
  sources: {
    list: (payload: SourcesListPayload) => invoke<SourceListResult>(IPC.SourcesList, payload),
    get: (payload: SourcesGetPayload) => invoke<SourceResult>(IPC.SourcesGet, payload),
    search: (payload: SourcesSearchPayload) =>
      invoke<SourceSearchResult>(IPC.SourcesSearch, payload),
    groups: (payload: SourcesGroupsPayload) =>
      invoke<SourceGroupsResult>(IPC.SourcesGroups, payload),
    add: (input: SourcesAddPayload) => invoke<ManualWriteResult>(IPC.SourcesAdd, input),
    update: (payload: SourcesUpdatePayload) =>
      invoke<ManualWriteResult>(IPC.SourcesUpdate, payload),
    disable: (payload: SourcesIdVersionPayload) =>
      invoke<ManualWriteResult>(IPC.SourcesDisable, payload),
    restore: (payload: SourcesIdVersionPayload) =>
      invoke<ManualWriteResult>(IPC.SourcesRestore, payload),
    quickAdd: () => invoke<QuickAddResult>(IPC.SourcesQuickAdd),
    undoable: () => invoke<UndoableChange[]>(IPC.SourcesUndoable),
    undo: (payload: SourcesUndoPayload) => invoke<UndoResult>(IPC.SourcesUndo, payload),
    state: () => invoke<SourcesState>(IPC.SourcesState),
    prepareHardDelete: (payload: SourcesIdPayload) =>
      invoke<PrepareHardDeleteResult>(IPC.SourcesPrepareHardDelete, payload),
    hardDelete: (payload: SourcesHardDeletePayload) =>
      invoke<ManualWriteResult>(IPC.SourcesHardDelete, payload),
    rebuildIndex: () => invoke<FtsRebuildResult>(IPC.SourcesRebuildIndex), // B7：无 payload 诊断入口
    onChanged: sourcesChangedRelay.subscribe,
  },
  // —— Fifth Stage C8（决议 #156/#158）：Research 白名单 ——
  research: {
    create: (goal) => invoke<ResearchIpcResult<ResearchIpcTaskValue>>(IPC.ResearchCreate, { goal }),
    start: (taskId) =>
      invoke<ResearchIpcResult<ResearchIpcTaskValue>>(IPC.ResearchStart, { taskId }),
    stop: (taskId) => invoke<ResearchIpcResult<ResearchIpcTaskValue>>(IPC.ResearchStop, { taskId }),
    get: (taskId) => invoke<ResearchIpcResult<ResearchIpcTaskValue>>(IPC.ResearchGet, { taskId }),
    result: (taskId) =>
      invoke<ResearchIpcResult<{ view: ResearchResultView }>>(IPC.ResearchResult, { taskId }),
    list: (payload: ResearchListPayload) =>
      invoke<ResearchIpcResult<ResearchIpcListValue>>(IPC.ResearchList, payload),
    delete: (taskId) =>
      invoke<ResearchIpcResult<{ deleted: true }>>(IPC.ResearchDelete, { taskId }),
    copyTable: (payload) => invoke<boolean>(IPC.ResearchCopyTable, payload),
    exportCsv: (payload: ResearchExportCsvPayload) =>
      invoke<ExportCsvResult>(IPC.ResearchExportCsv, payload),
    onProgress: researchProgressRelay.subscribe,
    onTaskDone: researchTaskDoneRelay.subscribe,
  },
  watch: {
    listRules: (p) => invokeWatch(IPC.WatchListRules, p),
    getRule: (p) => invokeWatch(IPC.WatchGetRule, p),
    createRule: (p) => invokeWatch(IPC.WatchCreateRule, p),
    updateRule: (p) => invokeWatch(IPC.WatchUpdateRule, p),
    setPaused: (p) => invokeWatch(IPC.WatchSetPaused, p),
    setMuted: (p) => invokeWatch(IPC.WatchSetMuted, p),
    deleteRule: (p) => invokeWatch(IPC.WatchDeleteRule, p),
    runNow: (p) => invokeWatch(IPC.WatchRunNow, p),
    previewFeed: (p) => invokeWatch(IPC.WatchPreviewFeed, p),
    previewPageRegions: (p) => invokeWatch(IPC.WatchPreviewPageRegions, p),
    issueSessionGrant: (p) => invokeWatch(IPC.WatchIssueSessionGrant, p),
    listEvents: (p) => invokeWatch(IPC.WatchListEvents, p),
    setEventsRead: (p) => invokeWatch(IPC.WatchSetEventsRead, p),
    deleteEvent: (p) => invokeWatch(IPC.WatchDeleteEvent, p),
    listDigestSchedules: (p) => invokeWatch(IPC.WatchListDigestSchedules, p),
    saveDigestSchedule: (p) => invokeWatch(IPC.WatchSaveDigestSchedule, p),
    deleteDigestSchedule: (p) => invokeWatch(IPC.WatchDeleteDigestSchedule, p),
    listDigests: (p) => invokeWatch(IPC.WatchListDigests, p),
    getDigest: (p) => invokeWatch(IPC.WatchGetDigest, p),
    generateDigestPreview: (p) => invokeWatch(IPC.WatchGenerateDigestPreview, p),
    exportEventsCsv: (p) => invokeWatch(IPC.WatchExportEventsCsv, p),
    exportDigestMarkdown: (p) => invokeWatch(IPC.WatchExportDigestMarkdown, p),
    getStatus: () => invokeWatch<WatchStatusDto>(IPC.WatchGetStatus, {}),
    subscribe: subscribeWatch,
  },
};

contextBridge.exposeInMainWorld('aibrowse', bridge);
