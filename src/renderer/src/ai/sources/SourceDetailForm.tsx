import { useState } from 'react';
import type { SourceTrustValue, SourceView } from '../../../../shared/types/sources';
import type { SourcesUpdatePayload } from '../../../../shared/types/ipc';
import {
  describeLastUsage,
  shareModeLabel,
  trustFullLabel,
  trustValueLabel,
} from './sources-display';

// 信源详情/编辑表单（B5）。决议 #75/#78：aiNote 只读展示（用户只编辑 user note）；
// trust 仅可设 value（assertedBy/verification 由 main/SourceService 确定）；provenance
// 展示区分「用户标定 / AI 推断·未核验」。全部文本以 React 纯文本节点渲染
// （无 dangerouslySetInnerHTML/Markdown/富文本）。expectedVersion 由 SourceView.version
// 提供（主进程服务层版本）；保存冲突由 hook 提示刷新（决议 #77）。
interface SourceDetailFormProps {
  source: SourceView;
  pendingOp: string | null;
  canWrite: boolean;
  onSave(payload: SourcesUpdatePayload): void;
  onToggleEnabled(): void;
  onDelete(): void;
  onBack(): void;
}

const TRUST_VALUES: SourceTrustValue[] = [
  'official',
  'primary',
  'secondary',
  'community',
  'unknown',
];

export function SourceDetailForm({
  source,
  pendingOp,
  canWrite,
  onSave,
  onToggleEnabled,
  onDelete,
  onBack,
}: SourceDetailFormProps) {
  const [name, setName] = useState(source.name);
  const [url, setUrl] = useState(source.url);
  const [groupName, setGroupName] = useState(source.groupName ?? '');
  const [tags, setTags] = useState(source.tags.join('，'));
  const [priority, setPriority] = useState(source.priority);
  const [shareMode, setShareMode] = useState(source.shareMode);
  const [trustValue, setTrustValue] = useState<SourceTrustValue>(source.trust.value);
  const [userNote, setUserNote] = useState(source.userNote);

  const busy = pendingOp !== null || !canWrite;

  const save = (): void => {
    if (busy) return;
    onSave({
      sourceId: source.id,
      expectedVersion: source.version,
      patch: {
        name,
        url,
        groupName: groupName.trim() === '' ? null : groupName.trim(),
        tags: tags
          .split(/[，,]/)
          .map((t) => t.trim())
          .filter((t) => t !== ''),
        priority,
        shareMode,
        userNote,
        trust: { value: trustValue },
      },
    });
  };

  return (
    <div className="sources-detail">
      <div className="sources-detail-header">
        <button type="button" className="sources-back" onClick={onBack}>
          ← 返回列表
        </button>
        <span className="sources-provenance">{trustFullLabel(source.trust)}</span>
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-edit-name">名称</label>
        <input
          id="sources-edit-name"
          className="sources-edit-name"
          type="text"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-edit-url">网址</label>
        <input
          id="sources-edit-url"
          className="sources-edit-url"
          type="text"
          value={url}
          maxLength={2048}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-edit-group">分组（留空 = 移出分组）</label>
        <input
          id="sources-edit-group"
          className="sources-edit-group"
          type="text"
          value={groupName}
          maxLength={64}
          onChange={(e) => setGroupName(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-edit-tags">标签（逗号分隔，最多 20 个，每个 ≤32 字符）</label>
        <input
          id="sources-edit-tags"
          className="sources-edit-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-row">
        <div className="sources-form-field">
          <label htmlFor="sources-edit-priority">优先级（1–5）</label>
          <select
            id="sources-edit-priority"
            className="sources-edit-priority"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            disabled={!canWrite}
          >
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="sources-form-field">
          <label htmlFor="sources-edit-share">分享模式</label>
          <select
            id="sources-edit-share"
            className="sources-edit-share"
            value={shareMode}
            onChange={(e) => setShareMode(e.target.value as SourceView['shareMode'])}
            disabled={!canWrite}
          >
            <option value="full">{shareModeLabel('full')}（备注可给 AI）</option>
            <option value="metadata">{shareModeLabel('metadata')}（备注不给 AI）</option>
            <option value="blocked">{shareModeLabel('blocked')}（AI 不可见）</option>
          </select>
        </div>
        <div className="sources-form-field">
          <label htmlFor="sources-edit-trust">信任类型（你标定）</label>
          <select
            id="sources-edit-trust"
            className="sources-edit-trust"
            value={trustValue}
            onChange={(e) => setTrustValue(e.target.value as SourceTrustValue)}
            disabled={!canWrite}
          >
            {TRUST_VALUES.map((v) => (
              <option key={v} value={v}>
                {trustValueLabel(v)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-edit-note">你的备注（供 AI 长期使用，≤2000 字符）</label>
        <textarea
          id="sources-edit-note"
          className="sources-edit-note"
          value={userNote}
          maxLength={2000}
          rows={4}
          onChange={(e) => setUserNote(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      {source.aiNote !== '' && (
        <div className="sources-ai-note">
          <span className="sources-ai-note-title">AI 备注（AI 推断·未核验，只读）：</span>
          <span className="sources-ai-note-text">{source.aiNote}</span>
        </div>
      )}
      {/* B7：usage/health 展示边界——「上次使用结果」纯展示（v1 可靠信号仅
          reachable/unreachable，其余如实标暂无可靠信号；不宣称健康/长期可用） */}
      <div className="sources-last-usage">
        {describeLastUsage(source.lastUsedAt, source.lastUsageOutcome)}
      </div>
      <div className="sources-detail-actions">
        <button type="button" className="sources-save" disabled={busy} onClick={save}>
          保存修改
        </button>
        <button
          type="button"
          className="sources-toggle-enabled"
          disabled={busy}
          onClick={onToggleEnabled}
        >
          {source.enabled ? '禁用' : '恢复'}
        </button>
        <button type="button" className="sources-delete-open" disabled={busy} onClick={onDelete}>
          永久删除…
        </button>
      </div>
    </div>
  );
}
