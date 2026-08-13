import type { ContextSource } from '../../../shared/types/conversation';

const MODE_LABELS: Record<ContextSource['mode'], string> = {
  selection: '选中文本',
  snapshot: '当前网页',
  none: '无网页上下文',
};

// 追溯卡片（§11.3）：展示 user 消息引用的网页上下文（ContextSource）——模式徽标 + 标题 +
// URL + 采集时间 + 选中摘录 / 降级与薄快照警告。仅摘要展示，不含快照正文（§6.3 红线：
// 快照正文不跨 IPC 到渲染层，除非进入 Provider 请求）。
export function CitationCard({ source }: { source: ContextSource }) {
  if (source.mode === 'none') {
    return (
      <div className="ai-citation">
        <span className="ai-citation-badge ai-citation-none">{MODE_LABELS.none}</span>
        {source.warnings.length > 0 && (
          <ul className="ai-citation-warnings">
            {source.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const capturedAt =
    source.capturedAt === null
      ? null
      : new Date(source.capturedAt).toLocaleTimeString('zh-CN', { hour12: false });

  return (
    <div className="ai-citation">
      <div className="ai-citation-header">
        <span className={`ai-citation-badge ai-citation-${source.mode}`}>
          {MODE_LABELS[source.mode]}
        </span>
        {source.title !== null && <span className="ai-citation-title">{source.title}</span>}
      </div>
      {source.url !== null && <div className="ai-citation-url">{source.url}</div>}
      <div className="ai-citation-meta">
        {capturedAt !== null && <span>采集于 {capturedAt}</span>}
        {source.thin && <span className="ai-citation-flag">内容稀薄</span>}
        {source.degraded && <span className="ai-citation-flag">采集降级</span>}
      </div>
      {source.selectionExcerpt !== null && (
        <blockquote className="ai-citation-excerpt">{source.selectionExcerpt}</blockquote>
      )}
      {source.warnings.length > 0 && (
        <ul className="ai-citation-warnings">
          {source.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
