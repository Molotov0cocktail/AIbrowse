// Sixth Stage D10: WRT-01..19 与 Sixth_stage §7/§9/§10 的机器证据清单。
// 这是验证设施的单一事实源；它不改变 Watch 产品事实判定，也不包含运行时正文。

export type WatchEvidenceKind =
  'structural-proof' | 'real-observation' | 'honest-limit' | 'not-run';

export interface WatchWrtEntry {
  id: string;
  name: string;
  oracle: string;
  evidenceKind: WatchEvidenceKind;
  stageClauses: readonly string[];
  evidenceAnchor: string;
}

export interface WatchWrtOutcome {
  id: string;
  ok: boolean;
  evidenceKind: WatchEvidenceKind;
  detail: string;
}

export interface WatchStageMapping {
  id: string;
  section: '§7' | '§9' | '§10';
  item: string;
  evidenceAnchor: string;
  evidenceKind: WatchEvidenceKind;
}

export const WATCH_WRT_MANIFEST: readonly WatchWrtEntry[] = [
  {
    id: 'WRT-01',
    name: '公网地址与特殊地址拒绝',
    oracle: '普通 GUA allowlist；特殊/未分配地址零 socket、security_rejected、零正文日志',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 RSS', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt01：validatePublicUrl/classifyIpAddress',
  },
  {
    id: 'WRT-02',
    name: 'DNS 公私混合与连接时换绑',
    oracle: '整次拒绝；连接 lookup 只返回已批准地址',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt02：地址集合 fail-closed',
  },
  {
    id: 'WRT-03',
    name: '端口、重定向与降级拒绝',
    oracle: '非 80/443、私网/file/javascript/HTTPS→HTTP 每跳拒绝且零后续请求',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 RSS', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt03：URL/redirect 目标矩阵',
  },
  {
    id: 'WRT-04',
    name: 'deadline、静默 body 与 transport drain',
    oracle: '共享更早 deadline；业务立即结算；close 后 drain 归零；Node 24 子进程无未处理异常',
    evidenceKind: 'real-observation',
    stageClauses: ['§9 Watch', '§9 Resource', '§10'],
    evidenceAnchor: 'D10 redteam wrt04：deadline/drain 夹具与 Node 24 观察',
  },
  {
    id: 'WRT-05',
    name: 'robots 预算、语法与同 host 频率',
    oracle: '512000 字节接受、512001 字节销毁；robots gate 唯一且同 host 起点间隔至少 5 秒',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.1', '§9 RSS', '§9 Resource', '§10'],
    evidenceAnchor: 'D10 redteam wrt05：robots parser/预算/gate 夹具',
  },
  {
    id: 'WRT-06',
    name: 'XML 外部实体与 XInclude',
    oracle: 'XXE/外部 DTD/XInclude/Billion Laughs 零文件零网络，后续正常 feed 可解析',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 RSS', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt06：FeedParser 安全夹具',
  },
  {
    id: 'WRT-07',
    name: 'XML 各独立预算边界',
    oracle: 'depth/name/attr/text/node/total/projection 各自 == limit 接受、+1 fail-closed',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 RSS', '§9 Engineering'],
    evidenceAnchor: 'D10 redteam wrt07：预算常量与边界探针',
  },
  {
    id: 'WRT-08',
    name: 'Feed 身份、顺序噪声与 fingerprint 循环',
    oracle: '重复项稳定去重、重排零事件；A→B→A→B→A 保留观察和中间 pair',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.2', '§9 RSS', '§9 Watch'],
    evidenceAnchor: 'D10 redteam wrt08：Feed parser 与事件身份夹具',
  },
  {
    id: 'WRT-09',
    name: '未授权 Session 与 task-tab 越权',
    oracle: '未授权/跨 origin/敌手返回用户 tabId 时零导航、创建或关闭用户 Tab',
    evidenceKind: 'real-observation',
    stageClauses: ['§7.3', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt09：Session consent 与 Workspace 夹具',
  },
  {
    id: 'WRT-10',
    name: 'Session 重启、登录跳转与清理失败',
    oracle: '重建 task-owned Tab 或受控失败；不建 Event/覆盖 Baseline；用户 Tab/焦点恒等',
    evidenceKind: 'real-observation',
    stageClauses: ['§7.3', '§9 Watch', '§9 Resource', '§10'],
    evidenceAnchor: 'D10 redteam wrt10：跨进程 Session lifecycle 夹具',
  },
  {
    id: 'WRT-11',
    name: 'DOM 噪声、table 歧义与跨域 iframe',
    oracle: '零假 Event；结构变化进入 parse_changed 或诚实限制',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.3', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt11：公开 HTML DocumentChannels 夹具',
  },
  {
    id: 'WRT-12',
    name: 'Evidence、Condition warning 与错误状态分离',
    oracle:
      '无 Evidence 不建 Event/不推进；typed warning 全量求值；condition_error 保留旧 Baseline 并暂停',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.4', '§9 Rules', '§9 Watch'],
    evidenceAnchor: 'D10 redteam wrt12：typed Evidence/validator 夹具',
  },
  {
    id: 'WRT-13',
    name: 'Digest 模型注入与 canonical 输出',
    oracle: '零工具；duplicate/extra/non-canonical/未知或错序 eventId 的整份解释拒绝；facts 保留',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.6', '§9 Digest', '§10'],
    evidenceAnchor: 'D10 redteam wrt13：Digest prompt/validator 夹具',
  },
  {
    id: 'WRT-14',
    name: 'sharing、Source note 与迟到 Provider 写回',
    oracle: 'metadata/blocked/note 不进入请求；factsRevision CAS 拒绝 scrub 后迟到写回',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.6', '§9 Digest', '§10'],
    evidenceAnchor: 'D10 redteam wrt14：分享投影与 CAS 证据',
  },
  {
    id: 'WRT-15',
    name: '通知隐私与内部 UUID 路由',
    oracle: '默认隐藏敏感详情；标题/正文不可伪造 URL/query；点击只携带内部 UUID',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.7', '§9 Digest', '§10'],
    evidenceAnchor: 'D10 redteam wrt15：NotificationPolicy/DTO 夹具',
  },
  {
    id: 'WRT-16',
    name: '时钟回拨、DST、missed 与 reservation',
    oracle: '三写原子；每规则最多一次 catch-up；已消费 slot 零重放',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 Resource', '§10'],
    evidenceAnchor: 'D10 redteam wrt16：FakeClock/Scheduler reservation 夹具',
  },
  {
    id: 'WRT-17',
    name: 'Source 生命周期与 orphan 清理',
    oracle: 'rowVersion 单调；metadata 不丢有效结果；CAS 整体失败；orphan 最终级联且不可 Undo',
    evidenceKind: 'structural-proof',
    stageClauses: ['§7.2', '§9 Watch', '§10'],
    evidenceAnchor: 'D10 redteam wrt17：Source observation/cleanup 夹具',
  },
  {
    id: 'WRT-18',
    name: 'Watch 数据库迁移、预算与崩溃恢复',
    oracle: 'v4→v5 逐语句失败完整回滚；新列默认 1/0；重开成功；future=6 零写入并停 Scheduler',
    evidenceKind: 'structural-proof',
    stageClauses: ['§9 Engineering', '§10'],
    evidenceAnchor: 'D10 redteam wrt18：独立 node:sqlite v4→v5 迁移矩阵',
  },
  {
    id: 'WRT-19',
    name: '公开 HTML 执行面、子资源与 Cookie',
    oracle:
      'script/iframe/私网子资源不执行不请求不带 Cookie；预算内产出 DocumentChannels 或受控失败',
    evidenceKind: 'real-observation',
    stageClauses: ['§7.3', '§9 Watch', '§9 Engineering', '§10'],
    evidenceAnchor: 'D10 redteam wrt19：HTML SAX + Session 网络边界夹具',
  },
];

const SECTION7_ITEMS: readonly string[] = [
  '添加带 RSS 的新闻/博客来源，可发现并订阅。',
  'RSS 更新后出现在 Source 更新视图。',
  '无 RSS 页面可以正常 Snapshot/Diff。',
  '“价格低于 X”类结构化规则可触发。',
  '页面结构变化导致提取失败时显示 Source Health，而不是生成错误结论。',
  '多 Source 生成每日 Digest。',
  '重复内容不会连续通知。',
];

const SECTION9_ITEMS: readonly string[] = [
  'RSS：可发现/添加/读取 RSS 或 Atom；feed 去重和 health 正常。',
  'Watch：无 RSS 页面可定期检查；Diff 可识别实际变化；失败不会制造假变化。',
  'Rules：支持至少一类结构化条件；规则触发有 Evidence。',
  'Digest：可按分组生成更新摘要；区分 changed / unchanged / failed。',
  'Resource：有并发和频率限制；有退避；不进行高频无控制访问。',
  'Engineering：scheduler/diff/feed 全量测试通过；重启和真实网络环境冒烟通过。',
];

const SECTION10_ITEMS: readonly string[] = [
  'Watch 不会因页面噪声制造大量误报。',
  '失败和真正变化能区分。',
  '调度不会产生明显资源问题。',
  'RSS 和浏览器 fallback 边界稳定。',
  '数据保留策略已经明确。',
];

export const WATCH_SIXTH_SECTION_MAPPING: readonly WatchStageMapping[] = [
  ...SECTION7_ITEMS.map((item, index) => ({
    id: `S6-7-${index + 1}`,
    section: '§7' as const,
    item,
    evidenceAnchor: `D10 cohesive 8.27 §7.${index + 1}`,
    evidenceKind: 'structural-proof' as const,
  })),
  ...SECTION9_ITEMS.map((item, index) => ({
    id: `S6-9-${index + 1}`,
    section: '§9' as const,
    item,
    evidenceAnchor: `D10 gate §9.${index + 1}`,
    evidenceKind: 'structural-proof' as const,
  })),
  ...SECTION10_ITEMS.map((item, index) => ({
    id: `S6-10-${index + 1}`,
    section: '§10' as const,
    item,
    evidenceAnchor: `D10 gate §10.${index + 1}`,
    evidenceKind: 'structural-proof' as const,
  })),
];

export function validateWatchWrtManifest(manifest: readonly WatchWrtEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const kinds = new Set<WatchEvidenceKind>([
    'structural-proof',
    'real-observation',
    'honest-limit',
    'not-run',
  ]);
  if (manifest.length !== 19) errors.push(`manifest 必须恰好 19 项（实际 ${manifest.length}）`);
  manifest.forEach((entry, index) => {
    const expected = `WRT-${String(index + 1).padStart(2, '0')}`;
    if (entry.id !== expected)
      errors.push(`第 ${index + 1} 项编号应为 ${expected}（实际 ${entry.id}）`);
    if (seen.has(entry.id)) errors.push(`${entry.id}：编号重复`);
    seen.add(entry.id);
    if (entry.name.trim() === '') errors.push(`${entry.id}：名称不得为空`);
    if (entry.oracle.trim() === '') errors.push(`${entry.id}：oracle 不得为空`);
    if (!kinds.has(entry.evidenceKind)) errors.push(`${entry.id}：evidenceKind 非法`);
    if (
      entry.stageClauses.length === 0 ||
      entry.stageClauses.some((clause) => clause.trim() === '')
    ) {
      errors.push(`${entry.id}：至少需要一个 Stage 条款映射`);
    }
    if (entry.evidenceAnchor.trim() === '') errors.push(`${entry.id}：证据落点不得为空`);
  });
  return errors;
}

export function aggregateWatchWrtOutcomes(
  outcomes: readonly WatchWrtOutcome[],
  manifest: readonly WatchWrtEntry[] = WATCH_WRT_MANIFEST,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const ids = manifest.map((entry) => entry.id);
  for (const id of ids) {
    const matches = outcomes.filter((outcome) => outcome.id === id);
    if (matches.length !== 1) {
      failures.push(`${id}：结果缺失或重复（${matches.length} 条）`);
      continue;
    }
    if (!matches[0]!.ok) failures.push(`${id}：${matches[0]!.detail}`);
  }
  for (const outcome of outcomes) {
    if (!ids.includes(outcome.id)) failures.push(`${outcome.id}：未知 WRT 编号`);
  }
  return { ok: failures.length === 0, failures };
}

export function validateWatchSixthMapping(mapping: readonly WatchStageMapping[]): string[] {
  const errors: string[] = [];
  const expected = [
    ...SECTION7_ITEMS.map((item, index) => `S6-7-${index + 1}:${item}`),
    ...SECTION9_ITEMS.map((item, index) => `S6-9-${index + 1}:${item}`),
    ...SECTION10_ITEMS.map((item, index) => `S6-10-${index + 1}:${item}`),
  ];
  const actual = mapping.map((entry) => `${entry.id}:${entry.item}`);
  if (actual.length !== expected.length) {
    errors.push(`Sixth §7/§9/§10 映射数量错误（实际 ${actual.length}，期望 ${expected.length}）`);
  }
  const seen = new Set<string>();
  for (const entry of mapping) {
    if (seen.has(entry.id)) errors.push(`${entry.id}：映射重复`);
    seen.add(entry.id);
    if (entry.item.trim() === '' || entry.evidenceAnchor.trim() === '') {
      errors.push(`${entry.id}：映射字段不得为空`);
    }
    if (entry.section !== '§7' && entry.section !== '§9' && entry.section !== '§10') {
      errors.push(`${entry.id}：section 非法`);
    }
  }
  for (const item of expected) {
    if (!actual.includes(item)) errors.push(`缺少映射：${item}`);
  }
  return errors;
}
