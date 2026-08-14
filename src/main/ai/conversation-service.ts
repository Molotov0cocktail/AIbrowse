// ConversationService: session orchestration — lifecycle (create/list/history/delete/
// ephemeral), per-session in-flight state machine (busy / idempotent abort), ask pipeline
// (§6.1 时序即契约: real-time snapshot at ask time → buildContext → persist the user
// message FIRST → provider stream → event forwarding → terminal persistence) and
// previewContext (§6.3). Contract source: doc/stage2/detailed-design.md §3.1/§6/§8/§9.
// Failure semantics (§5): parameter/state problems return safely (null/false/AskResult
// ok:false), never throw; unexpected exceptions → error log + normalized internal.
// The browser surface is a minimal injected seam (SnapshotSource) so the service never
// touches Electron APIs directly — 分层纪律; BrowserControllerImpl satisfies it structurally.
import { randomUUID } from 'node:crypto';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';
import type { BrowserController } from '../browser/browser-controller';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentRunSummary,
  AgentStatusEvent,
  AgentStepEvent,
} from '../../shared/types/agent';
import type {
  AskResult,
  ContextPreview,
  ContextSource,
  ConversationMessage,
  ConversationSession,
  NormalizedProviderError,
  ProviderRequest,
  ProviderToolCall,
  StreamChunkEvent,
  TurnDoneEvent,
} from '../../shared/types/conversation';
import { logError, logInfo, logWarn } from '../logger';
import type { ConfigStore, ProviderInfo } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import {
  ConversationStore,
  SESSION_LIMIT,
  cropMessagesToLimit,
  deriveTitle,
} from './conversation-store';
import {
  SYSTEM_PROMPT,
  buildContext,
  buildContextSource,
  deriveContextMode,
  isThinSnapshot,
} from './context-builder';
import { CONTEXT_BUDGET, trimHistory, truncateWithMark } from './context-budget';
import { normalizeProviderError } from './provider/error-normalize';
import { listProviderKinds, resolveProvider, type LLMProvider } from './provider/llm-provider';
// Third Stage A5：Agent Runtime 接线（AgentLoop 纯核心 + 上下文/历史纯函数 + 审计 run 条目）
import { formatAgentRunAuditMessage, type AuditEntry } from './audit-log';
import { buildAgentGoalMessage } from './agent/agent-context-builder';
import {
  buildFinalAgentMessage,
  buildRoundAssistantMessage,
  buildToolStepMessage,
  replayToProviderMessages,
} from './agent/agent-history';
import { AGENT_LOOP_LIMITS, AgentLoop, type AgentLoopLimits } from './agent/agent-loop';
import type { ConfirmManager } from './confirm-manager';
import type { SearchProvider } from './search/search-provider';
import { listTools } from './tools/tool-registry';

// v1 单 Provider 选择契约（决议 #20，§6.1）：返回 providerId 属于已注册工厂 kind 的
// 配置。v1 仅注册 PROVIDER_KIND_OPENAI_COMPATIBLE 一种 kind，且 ConfigStore 以
// providerId 为键 upsert（同键恒唯一）——选择唯一且与 list() 文件条目顺序无关，
// 不依赖任何隐含排序规则；无已注册 kind 配置 → null（调用方 → not-configured，
// 不发起网络请求）。hasKey 不参与选择（无 Key 由 resolveProvider → not-configured
// 兜底，§3.3）。多 kind 并存是 Third Stage+ 的扩展点，届时必须先定选择规则再扩展。
export function selectRegisteredProviderInfo(
  infos: ProviderInfo[],
  kinds: string[],
): ProviderInfo | null {
  for (const info of infos) {
    if (kinds.includes(info.providerId)) return info;
  }
  return null;
}

// 网页上下文快照来源（提问/预览时刻实时采集，禁止缓存复用——防串页核心，§6.1/§6.3）
export interface SnapshotSource {
  getActiveTab(): Promise<TabInfo | null>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>; // null = L3（tab 不可用）
}

// Third Stage A5：Agent Runtime 装配（§8.1/§8.5 + 决议 #33）——browser 为完整
// BrowserController（ToolExecutionContext 唯一浏览器通道）；confirmManager/audit 复用
// A2 装配实例；searchProvider 为工具层注入点（决议 #32⑥）；limits 可注入（冒烟/测试）。
export interface AgentRuntimeOptions {
  browser: BrowserController;
  confirmManager: ConfirmManager;
  searchProvider?: SearchProvider;
  audit: (entry: AuditEntry) => void; // 工具审计出口（每次调用恰好一条由 ToolExecutor 保证）
  auditRun?: (message: string) => void; // run 开始/终止条目（§10.1）
  limits?: Partial<AgentLoopLimits>; // 冒烟/测试注入（生产用默认 12 步/420s）
}

export interface ConversationServiceOptions {
  browser: SnapshotSource;
  store: ConversationStore;
  configStore: ConfigStore;
  credentials: SecureCredentialStore;
  // 冒烟/单测注入点（FakeProvider）；缺省为生产 resolveProvider（决议 #17 async 签名）
  resolveProviderFn?: typeof resolveProvider;
  // 事件输出（§3.1，构造时注入；由 index.ts 转发主窗口 send，事件只发主窗口 §4）
  onStreamChunk?: (e: StreamChunkEvent) => void;
  onTurnDone?: (e: TurnDoneEvent) => void; // 终态恰好一次（共读与 Agent 共用）
  // A5：Agent 运行时装配与事件出口（主进程回调 + 冒烟驱动；IPC/UI 属 A6）
  agent?: AgentRuntimeOptions;
  onAgentStep?: (e: AgentStepEvent) => void;
  onAgentConfirmRequest?: (e: AgentConfirmRequest) => void;
  onAgentRunDone?: (e: AgentRunDoneEvent) => void; // 终态恰好一次（与 onTurnDone 同路径）
  // A6：实时状态事件（确定性运行事实——starting/thinking/executing/waiting-confirm/
  // confirm-resolved/finalizing；不含思维过程/模型解释；A5 计数直出）
  onAgentStatus?: (e: AgentStatusEvent) => void;
}

export interface ConversationService {
  // 决议 #19（2026-08-13）：达 50 会话上限拒绝新建 → null（§9 定稿「拒绝新建 + 提示」；
  // §4.2 bridge 本就按可空返回建模）——原草图签名无失败通道，属校准而非变更。
  createSession(opts?: { ephemeral?: boolean }): Promise<ConversationSession | null>;
  listSessions(): Promise<ConversationSession[]>; // 新→旧
  getHistory(sessionId: string): Promise<ConversationMessage[] | null>; // null=会话不存在
  deleteSession(sessionId: string): Promise<boolean>; // 中止其进行中生成 → 删内存+落盘
  setEphemeral(sessionId: string, ephemeral: boolean): Promise<boolean>;
  ask(input: { sessionId: string; question: string }): Promise<AskResult>;
  // A5：Agent 任务入口（复用 ask 校验语义：会话存在/共读与 Agent 共享每会话单在途互斥/
  // goal 非字符串或空串安全拒绝、超 16000 确定性截断 + warn——§8.5 + 决议 #33）
  agentAsk(input: { sessionId: string; goal: string }): Promise<AskResult>;
  confirmTool(toolCallId: string, approve: boolean): Promise<boolean>; // L2 确认决定（A6 IPC 转发）
  abort(requestId: string): boolean; // 无匹配在途 → false（幂等）
  previewContext(): Promise<ContextPreview>; // 实时快照摘要（§6.3，不含正文）
  dispose(): void; // 退出：中止全部在途生成
}

interface SessionEntry {
  session: ConversationSession;
  messages: ConversationMessage[] | null; // null = 尚未从磁盘加载（懒加载）
}

interface InFlight {
  requestId: string;
  controller: AbortController;
}

const DEFAULT_TITLE = '新对话';

const SERVICE_ERROR_MESSAGES: Record<'busy' | 'not-found' | 'internal', string> = {
  busy: '上一条回答还在生成中',
  'not-found': '会话不存在或已删除',
  internal: '内部错误，详情见日志',
};

export class ConversationServiceImpl implements ConversationService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly inFlight = new Map<string, InFlight>(); // 每会话单在途（决议 Q8）
  private disposed = false;
  // A6：ConfirmManager 多监听者（Set 分发）——dispose 时退订（多 Service 共享同一
  // ConfirmManager 时互不覆盖、互不串扰；A5 计划内限制「最后构造实例所有权」关闭）
  private unsubscribePendingChange: (() => void) | null = null;

  constructor(private readonly options: ConversationServiceOptions) {
    // 启动加载磁盘会话（index.json 损坏容错在 store 内 fail-closed）
    for (const session of options.store.loadSessions()) {
      this.sessions.set(session.id, { session, messages: null });
    }
    // A5/A6：确认请求可见性事件源——ConfirmManager.addPendingChangeListener 在 Service
    // 层接线一次（映射 runId → sessionId 经在途注册表查找；多会话并行 run 不串事件；
    // 非在途 runId 不发出——防串 run）。判别联合：pending → confirm-request 事件 +
    // waiting-confirm 状态；settled（approve/deny/cancelAll 作废）→ confirm-resolved
    // 状态（确认 UI 自动关闭源）。
    const agent = options.agent;
    if (agent !== undefined) {
      this.unsubscribePendingChange = agent.confirmManager.addPendingChangeListener((change) => {
        // 判别联合：runId 在两种形态下的位置不同（pending 在 request 内、settled 在顶层）
        const runId = change.kind === 'pending' ? change.request.runId : change.runId;
        for (const [sessionId, inflight] of this.inFlight) {
          if (inflight.requestId !== runId) continue;
          if (change.kind === 'pending') {
            const request = change.request;
            this.options.onAgentConfirmRequest?.({
              requestId: request.runId,
              sessionId,
              toolCallId: request.toolCallId,
              toolName: request.toolName,
              summary: request.summary,
              createdAt: request.createdAt,
            });
            this.options.onAgentStatus?.({
              requestId: request.runId,
              sessionId,
              phase: 'waiting-confirm',
              toolName: request.toolName,
            });
          } else {
            this.options.onAgentStatus?.({
              requestId: change.runId,
              sessionId,
              phase: 'confirm-resolved',
              confirmOutcome: change.outcome,
            });
          }
          return;
        }
      });
    }
  }

  async createSession(opts?: { ephemeral?: boolean }): Promise<ConversationSession | null> {
    if (this.disposed) return null;
    const ephemeral = opts?.ephemeral ?? false;
    const persistedCount = [...this.sessions.values()].filter((e) => !e.session.ephemeral).length;
    if (!ephemeral && persistedCount >= SESSION_LIMIT) {
      // §9 定稿：达上限拒绝新建 + 提示（删除显式归用户，不自动淘汰最旧会话）
      logWarn('conversation', `会话数已达上限 ${SESSION_LIMIT}，拒绝新建（请用户清理会话）`);
      return null;
    }
    const now = Date.now();
    const session: ConversationSession = {
      id: randomUUID(),
      title: DEFAULT_TITLE, // 首问后按 §2 推导（deriveTitle）
      createdAt: now,
      updatedAt: now,
      ephemeral,
    };
    this.sessions.set(session.id, { session, messages: [] });
    if (!ephemeral) this.options.store.saveSessions(this.sessionList());
    logInfo(
      'conversation',
      `会话已创建（sessionId=${session.id}，ephemeral=${String(ephemeral)}）`,
    );
    return session;
  }

  async listSessions(): Promise<ConversationSession[]> {
    // 新→旧（createdAt 降序；同刻稳定按创建顺序）
    return [...this.sessions.values()]
      .map((e) => e.session)
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  }

  async getHistory(sessionId: string): Promise<ConversationMessage[] | null> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return null;
    return [...this.ensureMessages(entry)];
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    // §9：先中止其进行中生成 → 删内存 + 删文件（含残留 tmp）→ 更新索引
    const inFlight = this.inFlight.get(sessionId);
    if (inFlight !== undefined) inFlight.controller.abort();
    this.sessions.delete(sessionId);
    this.options.store.deleteFiles(sessionId);
    this.options.store.saveSessions(this.sessionList());
    logInfo('conversation', `会话已删除（sessionId=${sessionId}）`);
    return true;
  }

  async setEphemeral(sessionId: string, ephemeral: boolean): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    entry.session.ephemeral = ephemeral;
    if (ephemeral) {
      // 「不保存」全程不落盘：移除既有文件与索引条目（§9）
      this.options.store.deleteFiles(sessionId);
      this.options.store.saveSessions(this.sessionList());
    } else {
      // 现有消息落盘（写入索引与消息文件）
      this.options.store.saveSessions(this.sessionList());
      this.options.store.saveMessages(sessionId, this.ensureMessages(entry));
    }
    logInfo(
      'conversation',
      `会话保存模式变更（sessionId=${sessionId}，ephemeral=${String(ephemeral)}）`,
    );
    return true;
  }

  // ask 同步完成参数/状态校验并注册在途（JS 单线程内原子），随后后台执行生成、
  // 经事件回调推送——立即返回 {ok:true, requestId}，终态由 turn-done 通知（§3.1/§8.1）。
  async ask(input: { sessionId: string; question: string }): Promise<AskResult> {
    if (this.disposed) return this.failResult('internal');
    const entry = this.sessions.get(input.sessionId);
    if (entry === undefined) return this.failResult('not-found');
    if (this.inFlight.has(input.sessionId)) return this.failResult('busy');
    if (typeof input.question !== 'string' || input.question.trim() === '') {
      // §4.1：空串/非串 → 参数无效安全返回（internal），不抛异常
      logWarn('conversation', `ask 参数无效（sessionId=${input.sessionId}，question 为空或非串）`);
      return this.failResult('internal');
    }
    const requestId = randomUUID();
    const controller = new AbortController();
    this.inFlight.set(input.sessionId, { requestId, controller });
    // 生成在后台执行；内部异常已归一化并保证 turn-done 恰好一次，此处兜底日志
    void this.runAsk(entry, input.question, requestId, controller).catch((err: unknown) => {
      logError('conversation', `ask 编排未预期失败（requestId=${requestId}）`, err);
    });
    return { ok: true, requestId };
  }

  // A5：Agent 任务入口（§8.5 + 决议 #33）。同步段完成参数/状态校验并注册在途（与共读 ask
  // 共享同一 in-flight 注册表——决议 #25 互斥）；生成后台执行经事件回调推送。
  async agentAsk(input: { sessionId: string; goal: string }): Promise<AskResult> {
    if (this.disposed) return this.failResult('internal');
    const entry = this.sessions.get(input.sessionId);
    if (entry === undefined) return this.failResult('not-found');
    if (this.inFlight.has(input.sessionId)) return this.failResult('busy');
    let goal = input.goal;
    if (typeof goal !== 'string' || goal.trim() === '') {
      logWarn('conversation', `agentAsk 参数无效（sessionId=${input.sessionId}，goal 为空或非串）`);
      return this.failResult('internal');
    }
    if (goal.length > CONTEXT_BUDGET.questionMaxChars) {
      // §8.5/§11.1：> 16000 确定性截断 + 非敏感 warn（buildAgentGoalMessage 内为纵深防御）
      goal = truncateWithMark(goal, CONTEXT_BUDGET.questionMaxChars);
      logWarn(
        'conversation',
        `agentAsk 任务目标超长，已确定性截断（上限 ${CONTEXT_BUDGET.questionMaxChars} 字符）`,
      );
    }
    const requestId = randomUUID();
    const controller = new AbortController();
    this.inFlight.set(input.sessionId, { requestId, controller });
    // A6：run 已启动（在途注册后的确定性事实；先于 IPC 返回到达 renderer——reducer 以
    // starting 相位收养 run）。stepsUsed=0/maxSteps 取装配 limits（单事实源）。
    this.options.onAgentStatus?.({
      requestId,
      sessionId: input.sessionId,
      phase: 'starting',
      stepsUsed: 0,
      maxSteps: this.options.agent?.limits?.maxSteps ?? AGENT_LOOP_LIMITS.maxSteps,
    });
    void this.runAgentRun(entry, goal, requestId, controller).catch((err: unknown) => {
      logError('conversation', `agentAsk 编排未预期失败（requestId=${requestId}）`, err);
    });
    return { ok: true, requestId };
  }

  // A5：L2 确认决定（A6 起经 IPC 转发；未知/已终结 id → false 幂等，由 ConfirmManager 保证）
  async confirmTool(toolCallId: string, approve: boolean): Promise<boolean> {
    const manager = this.options.agent?.confirmManager;
    if (manager === undefined) return false;
    return approve ? manager.approve(toolCallId) : manager.deny(toolCallId);
  }

  abort(requestId: string): boolean {
    for (const entry of this.inFlight.values()) {
      if (entry.requestId === requestId) {
        entry.controller.abort(); // 流/工具等待以 aborted 终态结束（保留部分 + 标记）
        // A5：pending 确认作废由 AgentLoop 终态路径统一执行（finish → cancelAll，幂等）
        logInfo('conversation', `已请求中止（requestId=${requestId}）`);
        return true;
      }
    }
    return false; // 无匹配在途 / 已终态 → 幂等安全返回 false
  }

  async previewContext(): Promise<ContextPreview> {
    // §6.3：每次调用实时采集（与提问同一路径，不共享缓存），只回摘要不含快照正文
    const activeTab = await this.options.browser.getActiveTab();
    const snapshot =
      activeTab === null ? null : await this.options.browser.getPageSnapshot(activeTab.id);
    const thin = snapshot !== null && isThinSnapshot(snapshot);
    const mode = deriveContextMode(snapshot, thin);
    const selectionTrimmed = (snapshot?.selection ?? '').trim();
    return {
      tabId: activeTab?.id ?? null,
      url: snapshot?.url ?? null,
      title: snapshot?.title ?? null,
      readyState: snapshot?.meta.readyState ?? null,
      mode,
      hasSelection: selectionTrimmed !== '',
      selectionLength: selectionTrimmed.length,
      thin,
      degraded: snapshot !== null && snapshot.meta.degraded !== 'none',
    };
  }

  dispose(): void {
    if (this.disposed) return; // 幂等（before-quit 与窗口 closed 可能重复调用）
    this.disposed = true;
    this.unsubscribePendingChange?.(); // A6：退订确认事件监听（多 Service 共享状态机不泄漏）
    this.unsubscribePendingChange = null;
    let aborted = 0;
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
      aborted += 1;
    }
    this.inFlight.clear(); // runAsk 终态路径的 delete 为幂等，互不冲突
    logInfo('conversation', `conversation-service 已释放（中止 ${aborted} 个在途生成）`);
  }

  // ---------- ask 编排（§6.1 时序即契约） ----------

  private async runAsk(
    entry: SessionEntry,
    question: string,
    requestId: string,
    controller: AbortController,
  ): Promise<void> {
    const sessionId = entry.session.id;
    const startedAt = performance.now();
    let contextSource = buildContextSource(null, 'none', false, null);
    let userAppended = false;
    try {
      // 1. 实时采集（防串页核心）：提问时刻 getPageSnapshot(activeTabId)，禁止复用缓存
      //    快照（调试面板快照与 AI 上下文零关联——决议 #13）；L3 → null
      const activeTab = await this.options.browser.getActiveTab();
      const snapshot =
        activeTab === null ? null : await this.options.browser.getPageSnapshot(activeTab.id);
      const thin = snapshot !== null && isThinSnapshot(snapshot);
      const mode = deriveContextMode(snapshot, thin);
      contextSource = buildContextSource(snapshot, mode, thin, activeTab?.id ?? null);

      // 2. Provider 配置（决议 #20：v1 单 Provider 选择契约——providerId 属于已注册
      //    工厂 kind 的唯一配置，与文件条目顺序无关；决议 #18：model 来自该配置）
      const info = selectRegisteredProviderInfo(
        await this.options.configStore.list(),
        listProviderKinds(),
      );
      const config = info === null ? null : this.options.configStore.get(info.providerId);

      // 3. buildContext（requestId 先生成、model 来自配置——决议 #18）
      let request: ProviderRequest | null = null;
      if (config !== null) {
        const built = buildContext({
          question,
          snapshot,
          history: trimHistory(this.ensureMessages(entry)), // §7.6：S3 先裁剪再传入
          system: SYSTEM_PROMPT,
          requestId,
          model: config.model,
        });
        request = built.request;
        // §6.1：contextSource = buildContextSource(…)+ meta.warnings（含薄快照/截断等提示）
        contextSource.warnings = [...built.meta.warnings];
      }

      // 4. 先持久化 user 消息（含 ContextSource）——引用链先于生成落地，生成失败时
      //    追溯卡片依然可见；ephemeral 跳过落盘（§9）
      if (this.ensureMessages(entry).length === 0) {
        entry.session.title = deriveTitle(question); // §2：首问截断（≤ 30 字符）
      }
      this.appendMessage(entry, {
        id: randomUUID(),
        role: 'user',
        content: question,
        createdAt: Date.now(),
        status: 'complete',
        contextSource,
      });
      userAppended = true;

      // 5. resolveProvider → null → 立即 turn-done error（not-configured，无网络请求）
      const provider =
        config === null
          ? null
          : await (this.options.resolveProviderFn ?? resolveProvider)(
              config,
              this.options.credentials,
            );
      if (provider === null) {
        logWarn(
          'conversation',
          `本轮无可用 Provider（requestId=${requestId}，sessionId=${sessionId}）`,
        );
        this.emitTerminal(entry, {
          requestId,
          sessionId,
          contextSource,
          text: '',
          status: 'error',
          error: normalizeProviderError({ kind: 'not-configured', requestId }),
          startedAt,
        });
        return;
      }

      // 6. provider.stream：delta 逐块转发（不聚合）；error/done → 终态（§8.1）
      logInfo(
        'conversation',
        `开始生成（requestId=${requestId}，sessionId=${sessionId}，providerId=${provider.metadata.id}，model=${request?.model ?? ''}，mode=${contextSource.mode}，url=${contextSource.url ?? '无'}）`,
      );
      const stream = await this.runStream(
        provider,
        request,
        controller.signal,
        requestId,
        sessionId,
      );

      // 7. 终态组装 assistant 消息（complete 全文 / aborted 保留部分 / error 保留部分 +
      //    errorCode）→ 持久化（ephemeral 跳过）→ onTurnDone 转发 → 注销在途
      this.emitTerminal(entry, {
        requestId,
        sessionId,
        contextSource,
        text: stream.text,
        status: stream.status,
        error: stream.error,
        startedAt,
      });
    } catch (err) {
      // 未预期异常（§5）：error 日志 + 归一化 internal；尽力保住引用链与终态事件
      logError(
        'conversation',
        `ask 编排未预期异常（requestId=${requestId}，sessionId=${sessionId}）`,
        err,
      );
      if (!userAppended) {
        try {
          this.appendMessage(entry, {
            id: randomUUID(),
            role: 'user',
            content: question,
            createdAt: Date.now(),
            status: 'complete',
            contextSource,
          });
        } catch (appendErr) {
          logError('conversation', '异常路径 user 消息落盘失败', appendErr);
        }
      }
      this.emitTerminal(entry, {
        requestId,
        sessionId,
        contextSource,
        text: '',
        status: 'error',
        error: normalizeProviderError({
          kind: 'internal',
          context: { requestId, providerId: null, model: null },
        }),
        startedAt,
      });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  // ---------- agentAsk 编排（§8.5 时序即契约 + 决议 #33） ----------
  // 实时快照（防串页）→ 先持久化 goal user 消息 → 跨 run 重放（完整交互组裁剪/过滤）→
  // Provider 解析（null → not-configured 零工具执行；不支持 tool calling → 请求无 tools）→
  // AgentLoop 运行（ToolStep 逐步持久化 + step 事件）→ 终态组装（assistant 终态消息 +
  // AgentRunSummary + turn-done/agent-run-done 恰好一次）。
  private async runAgentRun(
    entry: SessionEntry,
    goal: string,
    requestId: string,
    controller: AbortController,
  ): Promise<void> {
    const sessionId = entry.session.id;
    const startedAt = performance.now();
    let contextSource = buildContextSource(null, 'none', false, null);
    let userAppended = false;
    try {
      // 1. 启动时刻实时采集（防串页契约，与共读 ask 同路径）
      const activeTab = await this.options.browser.getActiveTab();
      const snapshot =
        activeTab === null ? null : await this.options.browser.getPageSnapshot(activeTab.id);
      const thin = snapshot !== null && isThinSnapshot(snapshot);
      const mode = deriveContextMode(snapshot, thin);
      contextSource = buildContextSource(snapshot, mode, thin, activeTab?.id ?? null);

      // 2. Provider 配置（决议 #20 同 ask；model 来自配置）
      const info = selectRegisteredProviderInfo(
        await this.options.configStore.list(),
        listProviderKinds(),
      );
      const config = info === null ? null : this.options.configStore.get(info.providerId);

      // 3. 先持久化 goal user 消息（含 ContextSource）——引用链先于生成落地；
      //    重放历史取 append 之前的既有消息（不含本轮 goal——goal 由 AgentLoop 装入 transcript）
      if (this.ensureMessages(entry).length === 0) {
        entry.session.title = deriveTitle(goal);
      }
      const prior = [...this.ensureMessages(entry)];
      this.appendMessage(entry, {
        id: randomUUID(),
        role: 'user',
        content: goal,
        createdAt: Date.now(),
        status: 'complete',
        contextSource,
      });
      userAppended = true;

      // 4. Agent 运行时未装配 → 参数级失败（终态仍恰好一次）
      const agent = this.options.agent;
      if (agent === undefined) {
        logWarn(
          'conversation',
          `Agent 运行时未装配，agentAsk 以内部错误终止（requestId=${requestId}）`,
        );
        this.emitAgentTerminal(entry, {
          requestId,
          sessionId,
          contextSource,
          finalText: '',
          finalToolCalls: [],
          status: 'error',
          error: normalizeProviderError({
            kind: 'internal',
            context: { requestId, providerId: null, model: null },
          }),
          summary: {
            requestId,
            sessionId,
            status: 'error',
            stepsUsed: 0,
            maxSteps: 0,
            finalText: '',
            toolStepCount: 0,
          },
          startedAt,
        });
        return;
      }

      // 5. resolveProvider → null → not-configured 终态（零网络请求零工具执行）
      const provider =
        config === null
          ? null
          : await (this.options.resolveProviderFn ?? resolveProvider)(
              config,
              this.options.credentials,
            );
      if (provider === null) {
        logWarn(
          'conversation',
          `本轮无可用 Provider（requestId=${requestId}，sessionId=${sessionId}）`,
        );
        this.emitAgentTerminal(entry, {
          requestId,
          sessionId,
          contextSource,
          finalText: '',
          finalToolCalls: [],
          status: 'error',
          error: normalizeProviderError({ kind: 'not-configured', requestId }),
          summary: {
            requestId,
            sessionId,
            status: 'error',
            stepsUsed: 0,
            maxSteps: 0,
            finalText: '',
            toolStepCount: 0,
          },
          startedAt,
        });
        return;
      }

      // 6. 首轮上下文：goal 消息（启动快照块，构建一次——后续轮不重复插入）+ 跨 run 重放
      //    （完整交互组裁剪/孤立过滤，决议 #33③）
      const goalBuilt = buildAgentGoalMessage({ goal, snapshot });
      contextSource.warnings = [
        ...contextSource.warnings,
        ...goalBuilt.warnings.filter((w) => !contextSource.warnings.includes(w)),
      ];

      agent.auditRun?.(
        formatAgentRunAuditMessage({
          requestId,
          status: 'running',
          stepsUsed: 0,
          maxSteps: agent.limits?.maxSteps ?? 12,
        }),
      );
      logInfo(
        'conversation',
        `开始生成（agent，requestId=${requestId}，sessionId=${sessionId}，providerId=${provider.metadata.id}，model=${config?.model ?? ''}，mode=${contextSource.mode}，url=${contextSource.url ?? '无'}）`,
      );

      // 7. AgentLoop 运行（纯核心状态机；ToolStep 逐步持久化 + 事件转发）
      const loop = new AgentLoop({
        requestId,
        model: config?.model ?? '',
        goalMessage: goalBuilt.message,
        replayMessages: replayToProviderMessages(prior),
        tools: listTools(), // 注册表 13 工具模型可见 schema（Provider 不支持 tool calling 时不发送）
        providerResolver: async () => provider,
        confirmManager: agent.confirmManager,
        browser: agent.browser,
        ...(agent.searchProvider !== undefined ? { searchProvider: agent.searchProvider } : {}),
        audit: agent.audit,
        limits: agent.limits,
        callbacks: {
          onStreamChunk: (delta) => {
            this.options.onStreamChunk?.({ requestId, sessionId, delta });
          },
          onAgentRound: (e) => {
            // 每轮 assistant 消息（轮次文本 + 脱敏 toolCalls）先于其 tool 消息持久化（协议合法序）
            this.appendMessage(
              entry,
              buildRoundAssistantMessage({
                id: randomUUID(),
                text: e.roundText,
                toolCalls: e.toolCalls,
                now: Date.now(),
              }),
            );
          },
          onAgentStep: (e) => {
            // 每步终态：ToolStep 持久化（§9.3 精简版，fill 值/快照正文/内部参数零落盘）+ 可见性事件
            // （argsSummary 为 A6 非持久化字段——审计同源脱敏摘要，渲染层不得自行解析参数）
            this.appendMessage(
              entry,
              buildToolStepMessage({ id: randomUUID(), step: e.step, now: Date.now() }),
            );
            this.options.onAgentStep?.({
              requestId,
              sessionId,
              step: e.step,
              argsSummary: e.argsSummary,
            });
          },
          onStatus: (e) => {
            // A6：循环内相位直出（thinking/executing/finalizing，计数为 A5 实际值）
            this.options.onAgentStatus?.({
              requestId,
              sessionId,
              phase: e.phase,
              ...(e.toolName !== null ? { toolName: e.toolName } : {}),
              stepsUsed: e.stepsUsed,
              maxSteps: e.maxSteps,
            });
          },
        },
      });
      const result = await loop.run(controller.signal);

      // 8. 终态组装（决议 #33⑤ 映射：done→complete；cancelled→aborted；其余→error，
      //    权威终止理由在 AgentRunSummary.status——timeout 错误码直传）
      const mapped = mapAgentTerminal(result);
      const summary: AgentRunSummary = {
        requestId,
        sessionId,
        status: result.status,
        stepsUsed: result.stepsUsed,
        maxSteps: result.maxSteps,
        finalText: result.finalText,
        toolStepCount: result.toolStepCount,
      };
      agent.auditRun?.(
        formatAgentRunAuditMessage({
          requestId,
          status: result.status,
          stepsUsed: result.stepsUsed,
          maxSteps: result.maxSteps,
        }),
      );
      this.emitAgentTerminal(entry, {
        requestId,
        sessionId,
        contextSource,
        finalText: result.finalText,
        finalToolCalls: result.finalToolCalls,
        status: mapped.status,
        error: mapped.error,
        summary,
        startedAt,
      });
    } catch (err) {
      // 未预期异常（§5）：error 日志 + 归一化 internal；尽力保住引用链与终态事件恰好一次
      logError(
        'conversation',
        `agentAsk 编排未预期异常（requestId=${requestId}，sessionId=${sessionId}）`,
        err,
      );
      if (!userAppended) {
        try {
          this.appendMessage(entry, {
            id: randomUUID(),
            role: 'user',
            content: goal,
            createdAt: Date.now(),
            status: 'complete',
            contextSource,
          });
        } catch (appendErr) {
          logError('conversation', 'agent 异常路径 user 消息落盘失败', appendErr);
        }
      }
      this.emitAgentTerminal(entry, {
        requestId,
        sessionId,
        contextSource,
        finalText: '',
        finalToolCalls: [],
        status: 'error',
        error: normalizeProviderError({
          kind: 'internal',
          context: { requestId, providerId: null, model: null },
        }),
        summary: {
          requestId,
          sessionId,
          status: 'error',
          stepsUsed: 0,
          maxSteps: 0,
          finalText: '',
          toolStepCount: 0,
        },
        startedAt,
      });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  // Agent 终态组装 + 持久化 + 事件转发（turn-done/agent-run-done 恰好一次——所有路径必经此处）
  private emitAgentTerminal(
    entry: SessionEntry,
    e: {
      requestId: string;
      sessionId: string;
      contextSource: ContextSource;
      finalText: string;
      finalToolCalls: ProviderToolCall[];
      status: 'complete' | 'aborted' | 'error';
      error: NormalizedProviderError | null;
      summary: AgentRunSummary;
      startedAt: number;
    },
  ): void {
    const message: ConversationMessage = buildFinalAgentMessage({
      id: randomUUID(),
      text: e.finalText, // aborted/error 保留终止轮部分文本（决议 #33④：每轮文本恰好落盘一次）
      status: e.status,
      ...(e.status === 'error' && e.error !== null ? { errorCode: e.error.code } : {}),
      ...(e.finalToolCalls.length > 0 ? { toolCalls: e.finalToolCalls } : {}),
      agentRun: e.summary,
      now: Date.now(),
    });
    // 会话可能已在生成中被删除 → appendMessage 内部跳过持久化（存活守卫），事件仍发送
    this.appendMessage(entry, message);

    const elapsed = Math.round(performance.now() - e.startedAt);
    logInfo(
      'conversation',
      `生成结束（agent，requestId=${e.requestId}，耗时=${elapsed}ms，status=${e.summary.status}，步数=${e.summary.stepsUsed}/${e.summary.maxSteps}${e.error !== null ? `，errorCode=${e.error.code}` : ''}）`,
    );
    const turnDone: TurnDoneEvent = {
      requestId: e.requestId,
      sessionId: e.sessionId,
      status: e.status,
      message,
      error: e.error,
      contextSource: e.contextSource,
    };
    this.options.onTurnDone?.(turnDone);
    this.options.onAgentRunDone?.({ ...turnDone, run: e.summary });
  }

  private async runStream(
    provider: LLMProvider,
    request: ProviderRequest | null,
    signal: AbortSignal,
    requestId: string,
    sessionId: string,
  ): Promise<{
    text: string;
    status: 'complete' | 'aborted' | 'error';
    error: NormalizedProviderError | null;
  }> {
    const context = {
      requestId,
      providerId: provider.metadata.id,
      model: request?.model ?? null,
    };
    let text = '';
    try {
      // request 为 null 时 provider 必为 null（runAsk 已分叉），此处仅防御类型收窄
      for await (const event of provider.stream(request as ProviderRequest, signal)) {
        if (event.type === 'delta') {
          text += event.text;
          this.options.onStreamChunk?.({ requestId, sessionId, delta: event.text });
        } else if (event.type === 'reasoning') {
          // 供应商思维增量：共读不消费、不回传 UI、不记录（思维过程零暴露红线，决议 #35）
          // —— thinking 模式 Provider 的正常事件，不视为异常
        } else if (event.type === 'done') {
          return { text, status: 'complete', error: null };
        } else if (event.type === 'error') {
          // 中止归一：aborted 终态保留部分回答（§8.3），不发错误标记
          const status = event.error.code === 'aborted' ? 'aborted' : 'error';
          return { text, status, error: event.error };
        } else {
          // A1：共读路径从不请求工具（未传 tools）；出现 toolCalls 事件属供应商异常
          // 行为——共读不消费工具调用，fail-closed 归一化 internal（不把工具调用
          // 误当作成功回答；Agent 路径的工具消费在 A5 落地）。
          logWarn('conversation', `共读流出现未预期的工具调用事件（requestId=${requestId}）`);
          return {
            text,
            status: 'error',
            error: normalizeProviderError({ kind: 'internal', context }),
          };
        }
      }
    } catch (err) {
      // Provider 迭代抛异常（未走事件协议的供应商缺陷）→ 归一化 internal，保留已生成文本
      logError('conversation', `Provider 流异常（requestId=${requestId}）`, err);
      return {
        text,
        status: 'error',
        error: normalizeProviderError({ kind: 'internal', context }),
      };
    }
    // 流未产出终态事件即结束 → 归一化 internal（保留已生成文本）
    logWarn('conversation', `Provider 流未产出终态事件即结束（requestId=${requestId}）`);
    return { text, status: 'error', error: normalizeProviderError({ kind: 'internal', context }) };
  }

  // 终态组装 + 持久化 + 事件转发（turn-done 恰好一次——所有路径必经此处）
  private emitTerminal(
    entry: SessionEntry,
    e: {
      requestId: string;
      sessionId: string;
      contextSource: ContextSource;
      text: string;
      status: 'complete' | 'aborted' | 'error';
      error: NormalizedProviderError | null;
      startedAt: number;
    },
  ): void {
    const message: ConversationMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: e.text, // aborted/error 保留已生成部分（决议 Q7）
      createdAt: Date.now(),
      status: e.status,
    };
    if (e.status === 'error' && e.error !== null) message.errorCode = e.error.code;
    // 会话可能已在生成中被删除（deleteSession 中止路径）→ appendMessage 内部跳过持久化，
    // 终态事件仍发送（turn-done 恰好一次）
    this.appendMessage(entry, message);

    const elapsed = Math.round(performance.now() - e.startedAt);
    logInfo(
      'conversation',
      `生成结束（requestId=${e.requestId}，耗时=${elapsed}ms，status=${e.status}${e.error !== null ? `，errorCode=${e.error.code}` : ''}）`,
    );
    this.options.onTurnDone?.({
      requestId: e.requestId,
      sessionId: e.sessionId,
      status: e.status,
      message,
      error: e.error,
      contextSource: e.contextSource,
    });
  }

  // 追加消息（200 条上限确定性裁剪 + 非 ephemeral 原子落盘；updatedAt 同步）。
  // 会话存活守卫：deleteSession 中止在途生成后，runAsk 终态路径不得复活已删会话的文件
  // （§9「删除即消失」——删内存 + 删文件后，在途编排的后续落盘一律跳过）。
  private appendMessage(entry: SessionEntry, message: ConversationMessage): void {
    if (this.sessions.get(entry.session.id) !== entry) return;
    let messages = this.ensureMessages(entry);
    messages.push(message);
    const cropped = cropMessagesToLimit(messages);
    if (cropped.dropped > 0) {
      logWarn(
        'conversation',
        `会话消息超出上限，已裁掉最早 ${cropped.dropped} 条（sessionId=${entry.session.id}）`,
      );
      // 落盘必须用裁剪后的数组（crop 超限时返回新数组，原引用已含超限条目）
      entry.messages = cropped.kept;
      messages = cropped.kept;
    }
    entry.session.updatedAt = Date.now();
    if (!entry.session.ephemeral) {
      this.options.store.saveMessages(entry.session.id, messages);
      this.options.store.saveSessions(this.sessionList());
    }
  }

  private ensureMessages(entry: SessionEntry): ConversationMessage[] {
    if (entry.messages === null) {
      entry.messages = this.options.store.loadMessages(entry.session.id);
    }
    return entry.messages;
  }

  private sessionList(): ConversationSession[] {
    return [...this.sessions.values()].map((e) => e.session);
  }

  private failResult(code: 'busy' | 'not-found' | 'internal'): AskResult {
    // 无本轮生成，requestId 为空串（NormalizedProviderError 类型要求）；仅状态/参数拒绝
    return {
      ok: false,
      error: {
        code,
        message: SERVICE_ERROR_MESSAGES[code],
        retryable: false,
        providerId: null,
        model: null,
        requestId: '',
      },
    };
  }
}

// A5 终态映射（决议 #33⑤，机器可验证）：done→complete；cancelled→aborted；timeout→error
// （errorCode=timeout 直传）；step-limit/loop-detected/no-progress/error→error（错误直传；
// 安全终止的权威理由在 AgentRunSummary.status，A6 UI 以 run.status 为准）。
function mapAgentTerminal(result: { status: string; error: NormalizedProviderError | null }): {
  status: 'complete' | 'aborted' | 'error';
  error: NormalizedProviderError | null;
} {
  if (result.status === 'done') return { status: 'complete', error: null };
  if (result.status === 'cancelled') return { status: 'aborted', error: result.error };
  return { status: 'error', error: result.error };
}
