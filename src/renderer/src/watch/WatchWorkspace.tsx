import { useEffect, useReducer, useState } from 'react';
import type {
  EventDetailDto,
  EventListItemDto,
  RuleSummaryDto,
  WatchStatusDto,
} from '../../../shared/types/watch-ipc';
import type { WatchIpcErrorCode } from '../../../shared/types/watch-ipc';
import { INITIAL_WATCH_STATE, WATCH_VIEWS, reduceWatchState, type WatchView } from './watch-state';

const VIEW_LABELS: Record<WatchView, string> = {
  overview: '概览',
  rules: '规则',
  events: '事件',
  digests: '摘要',
  health: '健康',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ERROR_TEXT: Record<WatchIpcErrorCode, string> = {
  'invalid-payload': '请求参数无效',
  'not-found': '目标不存在',
  conflict: '数据已变化，请刷新后重试',
  'invalid-state': '当前状态不允许此操作',
  'budget-exceeded': '内容超过安全上限',
  'security-rejected': '安全检查未通过',
  'consent-required': '需要重新授权',
  'preview-expired': '预览已过期',
  'feature-unavailable': '功能当前不可用',
  cancelled: '操作已取消',
  unavailable: '监控服务暂不可用',
  'write-failed': '文件写入失败',
};

interface WatchWorkspaceProps {
  initialSourceId: string | null;
  onBack(): void;
}

export function WatchWorkspace({ initialSourceId, onBack }: WatchWorkspaceProps) {
  const [state, dispatch] = useReducer(reduceWatchState, INITIAL_WATCH_STATE);
  const [status, setStatus] = useState<WatchStatusDto | null>(null);
  const [rules, setRules] = useState<RuleSummaryDto[]>([]);
  const [events, setEvents] = useState<EventListItemDto[]>([]);
  const [eventDetail, setEventDetail] = useState<EventDetailDto | null>(null);
  const [digests, setDigests] = useState<
    Array<{ id: string; createdAt: string; eventCount: number; providerState: string }>
  >([]);
  const [message, setMessage] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(initialSourceId !== null);
  const [wizardStep, setWizardStep] = useState(0);
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [ruleKind, setRuleKind] = useState<'page' | 'feed'>('page');
  const [accessMode, setAccessMode] = useState<'public' | 'session'>('public');
  const [showDetails, setShowDetails] = useState(false);
  const [sessionAuthorized, setSessionAuthorized] = useState(false);
  const [previewHandle, setPreviewHandle] = useState<string | null>(null);
  const [sessionGrantHandle, setSessionGrantHandle] = useState<string | null>(null);
  const wizardLabels = [
    '类型 / Region',
    '访问方式',
    '计划',
    '条件',
    '通知隐私',
    'Baseline 预览',
    '最终确认',
  ];

  const reload = (): void => {
    void window.aibrowse.watch.getStatus().then((result) => {
      if (result.ok) setStatus(result.value);
    });
    void window.aibrowse.watch
      .listRules({ page: 1, pageSize: 50, filter: { state: null, sourceId: null } })
      .then((result) => {
        if (!result.ok || !isObject(result.value) || !Array.isArray(result.value['items'])) return;
        setRules(result.value['items'] as RuleSummaryDto[]);
      });
  };

  const eventFilter = {
    ruleId: null,
    sourceId: null,
    eventKind: null,
    importance: null,
    readState: 'all',
    fromInclusive: null,
    toExclusive: null,
  } as const;
  const loadEvents = (selectedEventId: string | null = null): void => {
    void window.aibrowse.watch
      .listEvents({ page: 1, pageSize: 50, filter: eventFilter, selectedEventId })
      .then((result) => {
        if (!result.ok || !isObject(result.value) || !Array.isArray(result.value['items'])) return;
        setEvents(result.value['items'] as EventListItemDto[]);
        setEventDetail(
          isObject(result.value['selected'])
            ? (result.value['selected'] as unknown as EventDetailDto)
            : null,
        );
      });
  };
  const loadDigests = (): void => {
    void window.aibrowse.watch
      .listDigests({ page: 1, pageSize: 50, scheduleId: null })
      .then((result) => {
        if (!result.ok || !isObject(result.value) || !Array.isArray(result.value['items'])) return;
        setDigests(
          result.value['items'] as Array<{
            id: string;
            createdAt: string;
            eventCount: number;
            providerState: string;
          }>,
        );
      });
  };

  useEffect(reload, []);
  useEffect(
    () =>
      window.aibrowse.watch.subscribe((push) => {
        dispatch({ type: 'push-revision', revision: push.revision });
        if (push.type === 'status') setStatus(push.status);
        else setMessage(push.notification.body);
      }),
    [],
  );
  useEffect(() => {
    if (state.view === 'events') loadEvents();
    else if (state.view === 'digests') loadDigests();
  }, [state.view]);

  const readHandles = (
    value: unknown,
  ): { previewHandle: string; sessionGrantHandle?: string } | null => {
    if (!isObject(value) || typeof value['previewHandle'] !== 'string') return null;
    return {
      previewHandle: value['previewHandle'],
      ...(typeof value['sessionGrantHandle'] === 'string'
        ? { sessionGrantHandle: value['sessionGrantHandle'] }
        : {}),
    };
  };

  const createPreview = async (): Promise<void> => {
    setMessage('正在安全采集 Baseline 预览…');
    const effectiveAccess = ruleKind === 'feed' ? 'public' : accessMode;
    const result =
      ruleKind === 'feed'
        ? await window.aibrowse.watch.previewFeed({ mode: 'source', sourceId })
        : await window.aibrowse.watch.previewPageRegions({
            sourceId,
            accessMode,
            regions: [{ kind: 'main-text', label: '正文' }],
          });
    if (!result.ok) {
      setMessage(`预览失败：${ERROR_TEXT[result.errorCode]}`);
      return;
    }
    let handles = readHandles(result.value);
    if (handles === null) {
      setMessage('预览结果不可用');
      return;
    }
    if (effectiveAccess === 'session') {
      if (!sessionAuthorized) {
        setMessage('请先明确授权本次 Session 预览');
        return;
      }
      const grant = await window.aibrowse.watch.issueSessionGrant({
        previewHandle: handles.previewHandle,
      });
      if (!grant.ok) {
        setMessage(`授权失败：${ERROR_TEXT[grant.errorCode]}`);
        return;
      }
      handles = readHandles(grant.value);
      if (handles === null || handles.sessionGrantHandle === undefined) {
        setMessage('授权结果不可用');
        return;
      }
      setSessionGrantHandle(handles.sessionGrantHandle);
    }
    setPreviewHandle(handles.previewHandle);
    setMessage('Baseline 预览已完成，可最终确认');
    setWizardStep(6);
  };

  const confirmCreate = async (): Promise<void> => {
    if (previewHandle === null) {
      setMessage('请先完成安全 Baseline 预览');
      return;
    }
    const result = await window.aibrowse.watch.createRule({
      previewHandle,
      sessionGrantHandle,
      schedule: { kind: 'interval', intervalMinutes: 60 },
      condition: null,
      notificationLevel: 'normal',
      showDetails,
      confirmed: true,
    });
    setPreviewHandle(null);
    setSessionGrantHandle(null);
    if (!result.ok) {
      setMessage(`创建失败：${ERROR_TEXT[result.errorCode]}，请重新预览`);
      setWizardStep(5);
      return;
    }
    setMessage('监控规则已创建');
    setWizardOpen(false);
    setWizardStep(0);
    reload();
  };

  const renderOverview = () => (
    <div className="watch-grid" data-watch-view="overview">
      <article>
        <strong>{status?.ruleCount ?? rules.length}</strong>
        <span>规则</span>
      </article>
      <article>
        <strong>{status?.eventCount ?? 0}</strong>
        <span>事件</span>
      </article>
      <article>
        <strong>{status?.unreadCount ?? 0}</strong>
        <span>未读</span>
      </article>
      <article>
        <strong>{status?.digestCount ?? 0}</strong>
        <span>摘要</span>
      </article>
      <p>监控仅在 AIbrowse 打开时运行；页面采集目前只覆盖主文档。</p>
      <p>
        公开事件保留 {status?.publicRetentionDays ?? 90} 天；登录态事件保留{' '}
        {status?.sessionRetentionDays ?? 30} 天。
      </p>
    </div>
  );

  const renderRules = () => (
    <div data-watch-view="rules">
      <button type="button" onClick={() => setWizardOpen(true)}>
        创建监控
      </button>
      {rules.length === 0 ? (
        <p>暂无监控规则。</p>
      ) : (
        rules.map((rule) => (
          <article className="watch-rule-card" key={rule.id}>
            <strong>{rule.sourceName}</strong>
            <span>{rule.targetDisplay}</span>
            <span>
              状态：{rule.state} / {rule.pauseReason ?? '正常'} / {rule.muted ? '已静音' : '未静音'}
            </span>
            <span>
              下次检查：{rule.nextDueAt ?? '未安排'}；退避：{rule.backoffUntil ?? '无'}
            </span>
            <div>
              <button
                type="button"
                onClick={() =>
                  void window.aibrowse.watch
                    .setPaused({
                      ruleId: rule.id,
                      expectedVersion: rule.version,
                      paused: rule.state !== 'paused',
                    })
                    .then(reload)
                }
              >
                {rule.state === 'paused' ? '恢复' : '暂停'}
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.aibrowse.watch
                    .setMuted({
                      ruleId: rule.id,
                      expectedVersion: rule.version,
                      muted: !rule.muted,
                    })
                    .then(reload)
                }
              >
                {rule.muted ? '取消静音' : '静音'}
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.aibrowse.watch
                    .runNow({ ruleId: rule.id })
                    .then(() => setMessage('已提交手动检查'))
                }
              >
                立即检查
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('永久删除此监控规则？'))
                    void window.aibrowse.watch
                      .deleteRule({
                        ruleId: rule.id,
                        expectedVersion: rule.version,
                        confirmed: true,
                      })
                      .then(reload);
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))
      )}
    </div>
  );

  const renderEvents = () => (
    <div data-watch-view="events">
      <h3>变化事件</h3>
      <p>old / new Evidence 只读；事件事实不能在此编辑。</p>
      <button
        type="button"
        onClick={() => void window.aibrowse.watch.exportEventsCsv({ filter: eventFilter })}
      >
        导出当前事件 CSV
      </button>
      {events.length === 0 ? (
        <p>暂无事件。</p>
      ) : (
        events.map((event) => (
          <article key={event.id} className="watch-event-row">
            <button type="button" onClick={() => loadEvents(event.id)}>
              {event.sourceName} · {event.eventKind} · {event.itemCount} 项
            </button>
            <span>
              {event.read ? '已读' : '未读'} · {event.lastObservedAt}
            </span>
            <button
              type="button"
              onClick={() =>
                void window.aibrowse.watch
                  .setEventsRead({ eventIds: [event.id], read: !event.read })
                  .then(() => loadEvents(event.id))
              }
            >
              {event.read ? '标为未读' : '标为已读'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('删除事件不可撤销，并会清除摘要中的相关证据，继续吗？'))
                  void window.aibrowse.watch
                    .deleteEvent({ eventId: event.id, confirmed: true })
                    .then(() => loadEvents());
              }}
            >
              永久删除
            </button>
          </article>
        ))
      )}
      {eventDetail !== null && (
        <section className="watch-evidence">
          <h4>Evidence（只读）</h4>
          {eventDetail.evidence.map((pair, index) => (
            <article key={`${pair.itemId}-${pair.fieldKey}-${index}`}>
              <strong>{pair.label}</strong>
              <div>old：{JSON.stringify(pair.before)}</div>
              <div>new：{JSON.stringify(pair.after)}</div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
  const renderDigests = () => (
    <div data-watch-view="digests">
      <h3>更新摘要</h3>
      <p>摘要引用会明确显示 active、expired 或 user-deleted；已删除 Evidence 不可恢复。</p>
      {digests.length === 0 ? (
        <p>暂无摘要。</p>
      ) : (
        digests.map((digest) => (
          <article key={digest.id}>
            <span>
              {digest.createdAt} · {digest.eventCount} 个事件 · {digest.providerState}
            </span>
            <button
              type="button"
              onClick={() =>
                void window.aibrowse.watch.exportDigestMarkdown({ digestId: digest.id })
              }
            >
              导出 Markdown
            </button>
          </article>
        ))
      )}
    </div>
  );
  const renderHealth = () => (
    <div data-watch-view="health">
      <h3>运行健康</h3>
      <p>Watch：{status?.mode ?? '读取中'}</p>
      <p>
        Windows 通知：{status?.windowsNotification ?? 'unavailable'}（
        {status?.windowsReason ?? '可用'}）
      </p>
      <p>
        调度：{status?.schedulerRunning ? '运行中' : '未运行'}；活动任务：{status?.activeRuns ?? 0}
      </p>
      <p>诚实限制：应用退出后不运行；跨域 iframe 不在主文档采集范围内。</p>
    </div>
  );

  return (
    <section className="watch-workspace" aria-label="监控工作区">
      <header className="watch-header">
        <button type="button" onClick={onBack}>
          ← 返回浏览
        </button>
        <h2>监控</h2>
        {status !== null && <span className="watch-badge">{status.unreadCount}</span>}
      </header>
      <nav>
        {WATCH_VIEWS.map((view) => (
          <button
            type="button"
            key={view}
            aria-pressed={state.view === view}
            onClick={() => dispatch({ type: 'select-view', view })}
          >
            {VIEW_LABELS[view]}
          </button>
        ))}
      </nav>
      {message !== null && (
        <div className="watch-toast" role="status">
          {message}
        </div>
      )}
      <main>
        {state.view === 'overview'
          ? renderOverview()
          : state.view === 'rules'
            ? renderRules()
            : state.view === 'events'
              ? renderEvents()
              : state.view === 'digests'
                ? renderDigests()
                : renderHealth()}
      </main>
      {wizardOpen && (
        <div className="watch-wizard" role="dialog" aria-modal="true" aria-label="创建监控">
          <h3>创建监控 · {wizardLabels[wizardStep]}</h3>
          <ol>
            {wizardLabels.map((label, index) => (
              <li key={label} aria-current={index === wizardStep}>
                {label}
              </li>
            ))}
          </ol>
          <label>
            信源 ID
            <input value={sourceId} onChange={(event) => setSourceId(event.target.value)} />
          </label>
          {wizardStep === 0 && (
            <label>
              类型
              <select
                value={ruleKind}
                onChange={(event) => setRuleKind(event.target.value as 'page' | 'feed')}
              >
                <option value="page">页面正文</option>
                <option value="feed">RSS / Atom</option>
              </select>
            </label>
          )}
          {wizardStep === 1 && ruleKind === 'page' && (
            <label>
              访问方式
              <select
                value={accessMode}
                onChange={(event) => setAccessMode(event.target.value as 'public' | 'session')}
              >
                <option value="public">公开</option>
                <option value="session">Session 登录态</option>
              </select>
            </label>
          )}
          {wizardStep === 1 && <p>公开模式不携带 Cookie；Session 模式需要逐规则授权。</p>}
          {wizardStep === 2 && <p>每 60 分钟检查一次；应用退出后停止，不支持 cron。</p>}
          {wizardStep === 3 && <p>当前使用“任意确定性变化”；Event 命中由程序判断。</p>}
          {wizardStep === 4 && (
            <p>登录态内容保留 30 天，锁屏通知默认隐藏详情，可逐规则选择显示安全字段标签。</p>
          )}
          {wizardStep === 4 && (
            <label>
              <input
                type="checkbox"
                checked={showDetails}
                onChange={(event) => setShowDetails(event.target.checked)}
              />
              通知显示安全来源名和字段标签（不显示 before/after 值）
            </label>
          )}
          {wizardStep === 5 && (
            <p>确认预览后才会建立 Baseline；Source 或 origin 变化将要求重新预览。</p>
          )}
          {wizardStep === 5 && ruleKind === 'page' && accessMode === 'session' && (
            <label>
              <input
                type="checkbox"
                checked={sessionAuthorized}
                onChange={(event) => setSessionAuthorized(event.target.checked)}
              />
              我授权读取当前登录页进行一次性预览；授权 5 分钟后失效
            </label>
          )}
          <div>
            <button type="button" onClick={() => setWizardOpen(false)}>
              取消
            </button>
            <button
              type="button"
              disabled={wizardStep === 0}
              onClick={() => setWizardStep((step) => Math.max(0, step - 1))}
            >
              上一步
            </button>
            {wizardStep < 5 ? (
              <button type="button" onClick={() => setWizardStep((step) => step + 1)}>
                下一步
              </button>
            ) : wizardStep === 5 ? (
              <button
                type="button"
                disabled={
                  sourceId === '' ||
                  (ruleKind === 'page' && accessMode === 'session' && !sessionAuthorized)
                }
                onClick={() => void createPreview()}
              >
                采集 Baseline 预览
              </button>
            ) : (
              <button type="button" onClick={() => void confirmCreate()}>
                确认创建
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
