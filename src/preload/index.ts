import { contextBridge, ipcRenderer } from 'electron';
import type { AibrowseBridge, AppInfo } from '../shared/types/app';
import type { PageSnapshot, TabInfo, TabsState } from '../shared/types/browser';
import type {
  AskResult,
  ContextPreview,
  ConversationMessage,
  ConversationSession,
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
import { IPC } from '../shared/types/ipc';

// Minimal-privilege bridge (design §3.2 + stage2 §4.2): only whitelisted methods are
// exposed; the raw ipcRenderer is never handed to the renderer (安全红线：preload bridge
// 最小权限；API Key 只写不回读——无任何读回方法).
const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

// 事件推送（tabs:updated + conversation 两通道）：preload 内同一通道只注册一次
// ipcRenderer 监听，由 JS 侧管理 listener 列表（防重复注册；渲染层卸载时退订，§3.2/§4.2）。
function eventRelay<T>(channel: string): {
  subscribe: (listener: (payload: T) => void) => () => void;
} {
  const listeners = new Set<(payload: T) => void>();
  ipcRenderer.on(channel, (_event, payload: T) => {
    for (const listener of listeners) listener(payload);
  });
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
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

const bridge: AibrowseBridge = {
  getAppInfo: () => invoke<AppInfo>(IPC.AppGetInfo),
  notifyRendererReady: () => {
    ipcRenderer.send(IPC.AppRendererReady);
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
      ipcRenderer.send(IPC.UiContentBounds, bounds);
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
      set: (cfg) => invoke<boolean>(IPC.ConfigProvidersSet, cfg),
      // 只写不回读（§10）：无任何读回方法；apiKey='' = 删除
      setKey: (providerId, apiKey) =>
        invoke<boolean>(IPC.ConfigProvidersSetKey, { providerId, apiKey }),
    },
  },
};

contextBridge.exposeInMainWorld('aibrowse', bridge);
