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
  focusSubject: { type: 'event' | 'digest'; id: string } | null;
  onBack(): void;
}

export function WatchWorkspace({ initialSourceId, focusSubject, onBack }: WatchWorkspaceProps) {
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
  const [intervalMinutes, setIntervalMinutes] = useState<15 | 60 | 360 | 1440>(60);
  const [regionKind, setRegionKind] = useState<'main-text' | 'headings' | 'links'>('main-text');
  const [conditionEnabled, setConditionEnabled] = useState(false);
  const [conditionOperand, setConditionOperand] = useState('');
  const [notificationLevel, setNotificationLevel] = useState<'normal' | 'important'>('normal');
  const [feedCandidates, setFeedCandidates] = useState<
    Array<{ discoveryHandle: string; candidateId: string; targetDisplay: string }>
  >([]);
  const [rebaselineRule, setRebaselineRule] = useState<RuleSummaryDto | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [readState, setReadState] = useState<'all' | 'read' | 'unread'>('all');
  const [digestSchedules, setDigestSchedules] = useState<Array<Record<string, unknown>>>([]);
  const [digestDetail, setDigestDetail] = useState<Record<string, unknown> | null>(null);
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
    readState,
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
    void window.aibrowse.watch.listDigestSchedules({ page: 1, pageSize: 50 }).then((result) => {
      if (result.ok && isObject(result.value) && Array.isArray(result.value['items']))
        setDigestSchedules(result.value['items'] as Array<Record<string, unknown>>);
    });
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
  }, [state.view, readState]);
  useEffect(() => {
    if (focusSubject === null) return;
    if (focusSubject.type === 'event') {
      dispatch({ type: 'select-view', view: 'events' });
      loadEvents(focusSubject.id);
    } else {
      dispatch({ type: 'select-view', view: 'digests' });
      void window.aibrowse.watch.getDigest({ digestId: focusSubject.id }).then((result) => {
        if (result.ok && isObject(result.value)) setDigestDetail(result.value);
      });
    }
  }, [focusSubject]);

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

  const acceptPreview = async (value: unknown): Promise<void> => {
    let handles = readHandles(value);
    if (handles === null) {
      setMessage('预览结果不可用');
      return;
    }
    if (ruleKind === 'page' && accessMode === 'session') {
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

  const createPreview = async (): Promise<void> => {
    setMessage('正在安全采集 Baseline 预览…');
    const result =
      ruleKind === 'feed'
        ? await window.aibrowse.watch.previewFeed({ mode: 'source', sourceId })
        : await window.aibrowse.watch.previewPageRegions({
            sourceId,
            accessMode,
            regions:
              regionKind === 'headings'
                ? [{ kind: 'headings', label: '标题', levels: [1, 2, 3] }]
                : regionKind === 'links'
                  ? [{ kind: 'links', label: '链接', sameOriginOnly: true }]
                  : [{ kind: 'main-text', label: '正文' }],
          });
    if (!result.ok) {
      setMessage(`预览失败：${ERROR_TEXT[result.errorCode]}`);
      return;
    }
    if (
      ruleKind === 'feed' &&
      isObject(result.value) &&
      Array.isArray(result.value['candidates'])
    ) {
      const discoveryHandle = result.value['discoveryHandle'];
      if (typeof discoveryHandle !== 'string') return;
      setFeedCandidates(
        result.value['candidates'].flatMap((candidate) =>
          isObject(candidate) &&
          typeof candidate['candidateId'] === 'string' &&
          typeof candidate['targetDisplay'] === 'string'
            ? [
                {
                  discoveryHandle,
                  candidateId: candidate['candidateId'],
                  targetDisplay: candidate['targetDisplay'],
                },
              ]
            : [],
        ),
      );
      setMessage('请选择发现的 Feed，再完成格式验证');
      return;
    }
    await acceptPreview(result.value);
  };

  const confirmCreate = async (): Promise<void> => {
    if (previewHandle === null) {
      setMessage('请先完成安全 Baseline 预览');
      return;
    }
    const settings = {
      schedule: { kind: 'interval', intervalMinutes },
      condition: conditionEnabled
        ? {
            version: 1,
            combine: 'all',
            predicates: [
              {
                fieldKey: 'content',
                operator: 'contains',
                operand: conditionOperand,
                caseSensitive: false,
              },
            ],
          }
        : null,
      notificationLevel,
      showDetails,
    } as const;
    const result =
      rebaselineRule === null
        ? await window.aibrowse.watch.createRule({
            previewHandle,
            sessionGrantHandle,
            ...settings,
            confirmed: true,
          })
        : await window.aibrowse.watch.updateRule({
            mode: 'rebaseline',
            ruleId: rebaselineRule.id,
            expectedVersion: rebaselineRule.version,
            previewHandle,
            sessionGrantHandle,
            ...settings,
            resumeAfterConfirm: rebaselineRule.desiredEnabled,
            confirmed: true,
          });
    setPreviewHandle(null);
    setSessionGrantHandle(null);
    if (!result.ok) {
      setMessage(`创建失败：${ERROR_TEXT[result.errorCode]}，请重新预览`);
      setWizardStep(5);
      return;
    }
    setMessage(rebaselineRule === null ? '监控规则已创建' : 'Baseline 已重建');
    setRebaselineRule(null);
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
              访问：{rule.accessMode}；健康：{rule.health}；上次检查：
              {rule.lastCheckedAt ?? '尚无'}；上次变化：{rule.lastChangedAt ?? '尚无'}；下次检查：
              {rule.nextDueAt ?? '未安排'}；退避：{rule.backoffUntil ?? '无'}
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
              <button
                type="button"
                onClick={() =>
                  void window.aibrowse.watch
                    .updateRule({
                      mode: 'settings',
                      ruleId: rule.id,
                      expectedVersion: rule.version,
                      schedule: rule.schedule,
                      condition: rule.condition,
                      notificationLevel:
                        rule.notificationLevel === 'normal' ? 'important' : 'normal',
                      showDetails: !rule.showDetails,
                    })
                    .then(reload)
                }
              >
                编辑通知设置
              </button>
              <button
                type="button"
                onClick={() => {
                  setRebaselineRule(rule);
                  setSourceId(rule.sourceId);
                  setRuleKind(rule.kind);
                  setAccessMode(rule.accessMode);
                  setIntervalMinutes(
                    rule.schedule.kind === 'interval' ? rule.schedule.intervalMinutes : 1440,
                  );
                  setWizardStep(0);
                  setWizardOpen(true);
                }}
              >
                重建 Baseline
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
      <label>
        阅读状态
        <select
          value={readState}
          onChange={(event) => setReadState(event.target.value as typeof readState)}
        >
          <option value="all">全部</option>
          <option value="unread">未读</option>
          <option value="read">已读</option>
        </select>
      </label>
      <button
        type="button"
        disabled={selectedEventIds.length === 0}
        onClick={() =>
          void window.aibrowse.watch
            .setEventsRead({ eventIds: selectedEventIds, read: true })
            .then(() => loadEvents())
        }
      >
        批量标为已读
      </button>
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
            <input
              type="checkbox"
              aria-label={`选择事件 ${event.id}`}
              checked={selectedEventIds.includes(event.id)}
              onChange={(change) =>
                setSelectedEventIds((ids) =>
                  change.target.checked
                    ? [...new Set([...ids, event.id])]
                    : ids.filter((id) => id !== event.id),
                )
              }
            />
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
      <button
        type="button"
        disabled={!/^[0-9a-f-]{36}$/.test(sourceId)}
        onClick={() => {
          const toInclusive = new Date().toISOString();
          const fromExclusive = new Date(Date.now() - 7 * 86_400_000).toISOString();
          void window.aibrowse.watch
            .generateDigestPreview({
              selector: { kind: 'sources', sourceIds: [sourceId] },
              fromExclusive,
              toInclusive,
              afterSequence: 0,
            })
            .then((result) => {
              if (
                !result.ok ||
                !isObject(result.value) ||
                typeof result.value['previewHandle'] !== 'string'
              ) {
                setMessage(result.ok ? '摘要预览不可用' : ERROR_TEXT[result.errorCode]);
                return;
              }
              void window.aibrowse.watch
                .saveDigestSchedule({
                  action: 'create',
                  previewHandle: result.value['previewHandle'],
                  localTime: '09:00',
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  aiEnabled: false,
                  confirmed: true,
                })
                .then(loadDigests);
            });
        }}
      >
        创建每日摘要计划
      </button>
      {digestSchedules.map((schedule) => (
        <article key={String(schedule['id'])}>
          <span>
            计划 {String(schedule['localTime'])} · {String(schedule['state'])} · AI：
            {schedule['aiEnabled'] ? '开' : '关'}
          </span>
          <button
            type="button"
            onClick={() =>
              void window.aibrowse.watch
                .saveDigestSchedule({
                  action: 'set-state',
                  scheduleId: schedule['id'],
                  expectedVersion: schedule['version'],
                  state: schedule['state'] === 'active' ? 'paused' : 'active',
                })
                .then(loadDigests)
            }
          >
            暂停 / 恢复
          </button>
          <button
            type="button"
            onClick={() =>
              void window.aibrowse.watch
                .saveDigestSchedule({
                  action: 'set-ai',
                  scheduleId: schedule['id'],
                  expectedVersion: schedule['version'],
                  aiEnabled: !schedule['aiEnabled'],
                })
                .then(loadDigests)
            }
          >
            切换 AI 解释
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('删除此摘要计划及其摘要？'))
                void window.aibrowse.watch
                  .deleteDigestSchedule({
                    scheduleId: schedule['id'],
                    expectedVersion: schedule['version'],
                    confirmed: true,
                  })
                  .then(loadDigests);
            }}
          >
            删除计划
          </button>
        </article>
      ))}
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
            <button
              type="button"
              onClick={() =>
                void window.aibrowse.watch.getDigest({ digestId: digest.id }).then((result) => {
                  if (result.ok && isObject(result.value)) setDigestDetail(result.value);
                })
              }
            >
              查看事实与引用状态
            </button>
          </article>
        ))
      )}
      {digestDetail !== null && (
        <section>
          <h4>摘要事实（只读）</h4>
          <pre>{JSON.stringify(digestDetail['facts'], null, 2)}</pre>
          <p>
            AI 解释：
            {digestDetail['explanation'] === null
              ? '无'
              : JSON.stringify(digestDetail['explanation'])}
          </p>
        </section>
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
            <>
              <label>
                类型
                <select
                  value={ruleKind}
                  onChange={(event) => setRuleKind(event.target.value as 'page' | 'feed')}
                >
                  <option value="page">页面 Region</option>
                  <option value="feed">RSS / Atom</option>
                </select>
              </label>
              {ruleKind === 'page' && (
                <label>
                  Region
                  <select
                    value={regionKind}
                    onChange={(event) => setRegionKind(event.target.value as typeof regionKind)}
                  >
                    <option value="main-text">正文</option>
                    <option value="headings">标题</option>
                    <option value="links">同源链接</option>
                  </select>
                </label>
              )}
            </>
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
          {wizardStep === 2 && (
            <label>
              检查间隔
              <select
                value={intervalMinutes}
                onChange={(event) =>
                  setIntervalMinutes(Number(event.target.value) as typeof intervalMinutes)
                }
              >
                <option value={15}>15 分钟</option>
                <option value={60}>1 小时</option>
                <option value={360}>6 小时</option>
                <option value={1440}>24 小时</option>
              </select>
              <span>应用退出后停止，不支持 cron。</span>
            </label>
          )}
          {wizardStep === 3 && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={conditionEnabled}
                  onChange={(event) => setConditionEnabled(event.target.checked)}
                />
                仅在正文包含指定文本时命中
              </label>
              {conditionEnabled && (
                <label>
                  匹配文本
                  <input
                    value={conditionOperand}
                    onChange={(event) => setConditionOperand(event.target.value)}
                  />
                </label>
              )}
              <p>Event 命中由确定性程序判断，不使用 AI 条件。</p>
            </>
          )}
          {wizardStep === 4 && (
            <>
              <p>登录态内容保留 30 天，锁屏通知默认隐藏详情，可逐规则选择显示安全字段标签。</p>
              <label>
                重要性
                <select
                  value={notificationLevel}
                  onChange={(event) =>
                    setNotificationLevel(event.target.value as typeof notificationLevel)
                  }
                >
                  <option value="normal">普通</option>
                  <option value="important">重要</option>
                </select>
              </label>
            </>
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
          {wizardStep === 5 &&
            feedCandidates.map((candidate) => (
              <button
                type="button"
                key={candidate.candidateId}
                onClick={() =>
                  void window.aibrowse.watch
                    .previewFeed({
                      mode: 'candidate',
                      discoveryHandle: candidate.discoveryHandle,
                      candidateId: candidate.candidateId,
                    })
                    .then((result) =>
                      result.ok
                        ? acceptPreview(result.value)
                        : setMessage(`Feed 验证失败：${ERROR_TEXT[result.errorCode]}`),
                    )
                }
              >
                验证 Feed：{candidate.targetDisplay}
              </button>
            ))}
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
                {rebaselineRule === null ? '确认创建' : '确认重建'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
