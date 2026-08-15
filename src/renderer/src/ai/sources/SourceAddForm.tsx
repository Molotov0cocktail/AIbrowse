import { useState } from 'react';
import type { SourceScope, SourceTrustValue } from '../../../../shared/types/sources';
import type { SourcesAddPayload } from '../../../../shared/types/ipc';
import { trustValueLabel } from './sources-display';

// 手工添加表单（B5）。决议 #52/#75：分享模式缺省「自动」（有备注 → full、无备注 →
// metadata，由主进程确定性生成；blocked 仅本界面可设）；trust 仅 value
// （assertedBy/verification 由主进程确定）。全部文本 React 纯文本渲染（决议 #78）。
interface SourceAddFormProps {
  canWrite: boolean;
  pendingOp: string | null;
  onSubmit(input: SourcesAddPayload): void;
  onCancel(): void;
}

const TRUST_VALUES: SourceTrustValue[] = [
  'official',
  'primary',
  'secondary',
  'community',
  'unknown',
];

export function SourceAddForm({ canWrite, pendingOp, onSubmit, onCancel }: SourceAddFormProps) {
  const [scope, setScope] = useState<SourceScope>('page');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState(3);
  const [shareMode, setShareMode] = useState<'auto' | 'full' | 'metadata' | 'blocked'>('auto');
  const [trustValue, setTrustValue] = useState<SourceTrustValue>('unknown');
  const [userNote, setUserNote] = useState('');

  const busy = pendingOp !== null || !canWrite;

  const submit = (): void => {
    if (busy || url.trim() === '') return;
    onSubmit({
      scope,
      url: url.trim(),
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      ...(groupName.trim() === '' ? {} : { groupName: groupName.trim() }),
      ...(tags.trim() === ''
        ? {}
        : {
            tags: tags
              .split(/[，,]/)
              .map((t) => t.trim())
              .filter((t) => t !== ''),
          }),
      priority,
      ...(shareMode === 'auto' ? {} : { shareMode }),
      ...(userNote === '' ? {} : { userNote }),
      trust: { value: trustValue },
    });
  };

  return (
    <div className="sources-add-form">
      <div className="sources-detail-header">
        <button type="button" className="sources-back" onClick={onCancel}>
          ← 返回列表
        </button>
        <span className="sources-form-title">手工添加信源</span>
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-add-scope">收藏范围</label>
        <select
          id="sources-add-scope"
          className="sources-add-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as SourceScope)}
          disabled={!canWrite}
        >
          <option value="page">具体页面</option>
          <option value="origin">整个站点</option>
        </select>
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-add-url">网址（http/https）</label>
        <input
          id="sources-add-url"
          className="sources-add-url"
          type="text"
          value={url}
          maxLength={2048}
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-add-name">名称（留空由系统按网址生成）</label>
        <input
          id="sources-add-name"
          className="sources-add-name"
          type="text"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-add-group">分组名</label>
        <input
          id="sources-add-group"
          className="sources-add-group"
          type="text"
          value={groupName}
          maxLength={64}
          onChange={(e) => setGroupName(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-field">
        <label htmlFor="sources-add-tags">标签（逗号分隔，最多 20 个，每个 ≤32 字符）</label>
        <input
          id="sources-add-tags"
          className="sources-add-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-form-row">
        <div className="sources-form-field">
          <label htmlFor="sources-add-priority">优先级（1–5）</label>
          <select
            id="sources-add-priority"
            className="sources-add-priority"
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
          <label htmlFor="sources-add-share">分享模式</label>
          <select
            id="sources-add-share"
            className="sources-add-share"
            value={shareMode}
            onChange={(e) =>
              setShareMode(e.target.value as 'auto' | 'full' | 'metadata' | 'blocked')
            }
            disabled={!canWrite}
          >
            <option value="auto">自动（有备注→完整；无备注→仅元数据）</option>
            <option value="full">完整（备注可给 AI）</option>
            <option value="metadata">仅元数据（备注不给 AI）</option>
            <option value="blocked">对 AI 隐藏</option>
          </select>
        </div>
        <div className="sources-form-field">
          <label htmlFor="sources-add-trust">信任类型（你标定）</label>
          <select
            id="sources-add-trust"
            className="sources-add-trust"
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
        <label htmlFor="sources-add-note">你的备注（≤2000 字符）</label>
        <textarea
          id="sources-add-note"
          className="sources-add-note"
          value={userNote}
          maxLength={2000}
          rows={4}
          onChange={(e) => setUserNote(e.target.value)}
          disabled={!canWrite}
        />
      </div>
      <div className="sources-detail-actions">
        <button
          type="button"
          className="sources-save"
          disabled={busy || url.trim() === ''}
          onClick={submit}
        >
          添加
        </button>
      </div>
    </div>
  );
}
