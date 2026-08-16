// 决议 #152(6)/(8) + #159：ResultView 只消费已验证 ResearchResult（props 类型 =
// ResearchResult）——Markdown/Table/Cards/Ranking/uncertain 块渲染 +
// evidenceMap/conflicts/coverage 展示 + sourceRefs 来源入口（C8 决议 #159：
// table block 级/cards·ranking item 级/conflict position 级——不伪造逐列
// 来源）+ Evidence drawer（纯文本展示 URL/标题/获取时间/类型/locator/
// excerpt/value/verified 标识）。安全不变量：零 dangerouslySetInnerHTML、
// 零 `<a href>`（链接用无副作用展示元素 + 可选 onOpenUrl 回调——C8 接安全
// 导航）；危险 URL 纵深防御降级纯文本；所有模型文本经 React 纯文本节点转义；
// 控制字符/bidi 防御性剔除（shared 同源规范化）。C7 既有 props 零改动
// （新增 props 全部可选）。
import type { ReactElement } from 'react';
import type {
  ResearchEvidenceDto,
  ResearchResult,
  ResultBlock,
} from '../../../shared/types/research';
import { isSafeMarkdownUrl } from '../../../shared/markdown/markdown-url';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
} from '../../../shared/markdown/parse-markdown';
import { normalizePlainText } from '../../../shared/markdown/markdown-text';

export interface ResultViewProps {
  result: ResearchResult;
  onOpenUrl?: (url: string) => void; // 决议 #152(6)：显式回调（C8 接安全导航）
  // C8 决议 #159：Evidence 下钻——sourceRefs 入口点击 → candidateId
  onSelectSource?: (candidateId: string) => void;
  evidence?: ResearchEvidenceDto[]; // 完整 Evidence DTO（view.evidence；drawer 数据源）
  selectedCandidateId?: string | null; // 非空时渲染 Evidence drawer（该候选的 evidence）
  onCloseEvidence?: () => void;
  // C8 画布模式：table 块由 TableView 交互组件承载（排序/筛选/复制/导出）——
  // ResultView 跳过 table 块避免双渲染（独立展示场景不传）
  skipTableBlocks?: boolean;
}

// 渲染层防御性清洗（已由 Validator 规范化；纵深防御覆盖绕过路径）
function safeText(text: string): string {
  return normalizePlainText(text);
}

// ---------- Markdown 渲染（AST → React 元素；零 HTML 字符串） ----------

function renderInline(
  node: MarkdownInlineNode,
  key: number,
  onOpenUrl?: (u: string) => void,
): ReactElement {
  switch (node.kind) {
    case 'text':
      return <span key={key}>{node.value}</span>;
    case 'emphasis':
      return <em key={key}>{node.children.map((c, i) => renderInline(c, i))}</em>;
    case 'strong':
      return <strong key={key}>{node.children.map((c, i) => renderInline(c, i))}</strong>;
    case 'code':
      return <code key={key}>{node.value}</code>;
    case 'link': {
      // 决议 #152(6)：不渲染 <a href>——无副作用展示元素 + 显式 onOpenUrl 回调；
      // 纵深防御：即使独立收到危险链接（绕过 Validator）也降级纯文本
      if (!isSafeMarkdownUrl(node.url)) {
        return <span key={key}>{`${node.text}(${node.url})`}</span>;
      }
      if (onOpenUrl !== undefined) {
        return (
          <span
            key={key}
            className="research-link"
            onClick={() => onOpenUrl(node.url)}
            role="button"
            title={node.url}
          >
            {node.text}
          </span>
        );
      }
      return (
        <span key={key} className="research-link" title={node.url}>
          {node.text}
        </span>
      );
    }
  }
}

function renderBlock(
  block: MarkdownBlockNode,
  key: number,
  onOpenUrl?: (u: string) => void,
): ReactElement {
  switch (block.kind) {
    case 'heading':
      return block.level === 1 ? (
        <h1 key={key}>{block.children.map((c, i) => renderInline(c, i, onOpenUrl))}</h1>
      ) : block.level === 2 ? (
        <h2 key={key}>{block.children.map((c, i) => renderInline(c, i, onOpenUrl))}</h2>
      ) : (
        <h3 key={key}>{block.children.map((c, i) => renderInline(c, i, onOpenUrl))}</h3>
      );
    case 'paragraph':
      return <p key={key}>{block.children.map((c, i) => renderInline(c, i, onOpenUrl))}</p>;
    case 'list':
      return block.ordered ? (
        <ol key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{item.map((c, j) => renderInline(c, j, onOpenUrl))}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{item.map((c, j) => renderInline(c, j, onOpenUrl))}</li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote key={key}>
          {block.children.map((c, i) => renderInline(c, i, onOpenUrl))}
        </blockquote>
      );
    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
  }
}

function MarkdownView({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (u: string) => void;
}): ReactElement {
  const doc = parseMarkdown(text);
  return (
    <div className="research-markdown">
      {doc.children.map((block, i) => renderBlock(block, i, onOpenUrl))}
    </div>
  );
}

// C8 决议 #159(1)：来源入口（candidateId 标识；无 <a> 无 href——按钮形态）
function SourceEntry({
  candidateId,
  onSelectSource,
}: {
  candidateId: string;
  onSelectSource?: (candidateId: string) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="research-source-entry"
      data-candidate-id={candidateId}
      title="查看来源证据"
      onClick={onSelectSource === undefined ? undefined : () => onSelectSource(candidateId)}
    >
      来源
    </button>
  );
}

// ---------- 结果块渲染 ----------

function renderResultBlock(
  block: ResultBlock,
  key: number,
  onOpenUrl?: (u: string) => void,
  onSelectSource?: (candidateId: string) => void,
): ReactElement {
  switch (block.kind) {
    case 'markdown':
      return <MarkdownView key={key} text={block.text} onOpenUrl={onOpenUrl} />;
    case 'table':
      // 决议 #159(1)：table 使用 block 级 sourceRefs（v1 无逐列来源映射——
      // 不伪造逐列来源）
      return (
        <div key={key} className="research-table-wrap">
          <table className="research-table">
            <thead>
              <tr>
                {block.columns.map((col, i) => (
                  <th key={i}>{safeText(col)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{safeText(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.sourceRefs.length > 0 && (
            <div className="research-source-refs">
              {block.sourceRefs.map((ref) => (
                <SourceEntry key={ref} candidateId={ref} onSelectSource={onSelectSource} />
              ))}
            </div>
          )}
        </div>
      );
    case 'cards':
      return (
        <div key={key} className="research-cards">
          {block.items.map((item, i) => (
            <div key={i} className="research-card">
              <div className="research-card-title">{safeText(item.title)}</div>
              {item.subtitle !== null && (
                <div className="research-card-subtitle">{safeText(item.subtitle)}</div>
              )}
              <div className="research-card-body">{safeText(item.body)}</div>
              {item.sourceRefs.length > 0 && (
                <div className="research-source-refs">
                  {item.sourceRefs.map((ref) => (
                    <SourceEntry key={ref} candidateId={ref} onSelectSource={onSelectSource} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    case 'ranking':
      return (
        <ol key={key} className="research-ranking">
          {block.items.map((item, i) => (
            <li key={i}>
              <div className="research-ranking-title">{safeText(item.title)}</div>
              <div className="research-ranking-detail">{safeText(item.detail)}</div>
              {item.sourceRefs.length > 0 && (
                <div className="research-source-refs">
                  {item.sourceRefs.map((ref) => (
                    <SourceEntry key={ref} candidateId={ref} onSelectSource={onSelectSource} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      );
    case 'uncertain':
      return (
        <div key={key} className="research-uncertain">
          <div className="research-uncertain-text">{safeText(block.text)}</div>
          <div className="research-uncertain-reason">{safeText(block.reason)}</div>
        </div>
      );
  }
}

// C8 决议 #159(2)：Evidence drawer/detail——纯文本展示 URL/标题/获取时间/
// 类型/locator/excerpt/value/verified 标识（零 HTML、零 dangerouslySet
// InnerHTML）；按 candidateId 过滤下钻（一候选多 evidence 全列出）
function EvidenceDrawer({
  candidateId,
  evidence,
  onClose,
  onOpenUrl,
}: {
  candidateId: string;
  evidence: ResearchEvidenceDto[];
  onClose: () => void;
  onOpenUrl?: (url: string) => void;
}): ReactElement {
  const items = evidence.filter((e) => e.candidateId === candidateId);
  return (
    <div className="research-evidence-drawer" data-candidate-id={candidateId}>
      <div className="research-evidence-drawer-header">
        <span>来源证据</span>
        <button type="button" className="research-evidence-close" onClick={onClose}>
          关闭
        </button>
      </div>
      {items.length === 0 && <div className="research-evidence-empty">该来源暂无证据详情</div>}
      {items.map((ev) => (
        <div key={ev.evidenceId} className="research-evidence-item">
          <div className="research-evidence-title">{safeText(ev.title)}</div>
          <div className="research-evidence-url">
            {isSafeMarkdownUrl(ev.url) && onOpenUrl !== undefined ? (
              <span
                className="research-link"
                role="button"
                title={ev.url}
                onClick={() => onOpenUrl(ev.url)}
              >
                {safeText(ev.url)}
              </span>
            ) : (
              <span>{safeText(ev.url)}</span>
            )}
          </div>
          <div className="research-evidence-meta">
            获取时间：{safeText(ev.accessTime)} · 类型：{safeText(ev.type)}
          </div>
          <div className="research-evidence-locator">{safeText(JSON.stringify(ev.locator))}</div>
          <div className="research-evidence-excerpt">{safeText(ev.excerpt)}</div>
          {ev.value !== null && (
            <div className="research-evidence-value">值：{safeText(ev.value)}</div>
          )}
          <div className="research-evidence-verified">已验证</div>
        </div>
      ))}
    </div>
  );
}

// ---------- 主组件 ----------

export function ResultView(props: ResultViewProps): ReactElement {
  const {
    result,
    onOpenUrl,
    onSelectSource,
    evidence,
    selectedCandidateId,
    onCloseEvidence,
    skipTableBlocks = false,
  } = props;
  const evidenceEntries = Object.entries(result.evidenceMap);
  return (
    <div className="research-result-view">
      <h2 className="research-result-title">{safeText(result.title)}</h2>
      <p className="research-result-summary">{safeText(result.summary)}</p>
      {result.blocks
        .filter((block) => !(skipTableBlocks && block.kind === 'table'))
        .map((block, i) => renderResultBlock(block, i, onOpenUrl, onSelectSource))}
      {result.conflicts.length > 0 && (
        <div className="research-conflicts">
          <h3>冲突（未解决）</h3>
          {result.conflicts.map((conflict) => (
            <div key={conflict.conflictId} className="research-conflict">
              <div className="research-conflict-topic">{safeText(conflict.topic)}</div>
              <ul>
                {conflict.positions.map((pos, i) => (
                  <li key={i}>
                    {safeText(pos.positionText)}
                    {pos.sourceRefs.length > 0 && (
                      <span className="research-source-refs">
                        {pos.sourceRefs.map((ref) => (
                          <SourceEntry
                            key={ref}
                            candidateId={ref}
                            onSelectSource={onSelectSource}
                          />
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {evidenceEntries.length > 0 && (
        <div className="research-evidence">
          <h3>证据来源</h3>
          <ul>
            {evidenceEntries.map(([evidenceId, meta]) => (
              <li key={evidenceId}>
                {safeText(meta.title)}（{safeText(meta.url)}，获取时间 {safeText(meta.accessTime)}）
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="research-coverage">
        结论 {result.coverage.total} 条 / 多源 {result.coverage.multiSource} / 单源{' '}
        {result.coverage.singleSource} / 厂商 {result.coverage.vendor} / 第三方{' '}
        {result.coverage.thirdParty} / 社区 {result.coverage.community}
      </div>
      <div className="research-fetched-at">数据获取时间：{safeText(result.fetchedAt)}</div>
      {selectedCandidateId !== null &&
        selectedCandidateId !== undefined &&
        onCloseEvidence !== undefined && (
          <EvidenceDrawer
            candidateId={selectedCandidateId}
            evidence={evidence ?? []}
            onClose={onCloseEvidence}
            onOpenUrl={onOpenUrl}
          />
        )}
    </div>
  );
}
