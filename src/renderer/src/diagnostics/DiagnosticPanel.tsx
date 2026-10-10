import { useState } from 'react';
import type { DiagnosticPreviewDto } from '../../../shared/types/diagnostics';
import { diagnosticErrorLabel, shortDiagnosticDigest } from './diagnostic-display';
import './diagnostic-panel.css';

export interface DiagnosticPanelProps {
  readonly onClose: () => void;
}

export function DiagnosticPanel({ onClose }: DiagnosticPanelProps) {
  const [preview, setPreview] = useState<DiagnosticPreviewDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = (): void => {
    setLoading(true);
    setPreview(null);
    setMessage(null);
    void window.aibrowse.diagnostics
      .preview()
      .then((result) => {
        if (result.ok) setPreview(result.preview);
        else setMessage(diagnosticErrorLabel(result.errorCode));
      })
      .catch(() => setMessage('诊断信息当前不可用'))
      .finally(() => setLoading(false));
  };

  const exportPreview = (): void => {
    if (preview === null || loading) return;
    setLoading(true);
    setMessage(null);
    const capability = { sequence: preview.sequence, digest: preview.digest };
    void window.aibrowse.diagnostics
      .export(capability)
      .then((result) => {
        if (result.ok) setMessage('诊断文件已保存');
        else {
          setMessage(diagnosticErrorLabel(result.errorCode));
          if (result.errorCode === 'stale' || result.errorCode === 'expired') setPreview(null);
        }
      })
      .catch(() => setMessage('诊断文件保存失败'))
      .finally(() => setLoading(false));
  };

  return (
    <aside className="diagnostic-panel" aria-label="诊断信息">
      <div className="diagnostic-panel-header">
        <h2>诊断信息</h2>
        <button type="button" onClick={onClose} aria-label="关闭诊断信息">
          ×
        </button>
      </div>
      <p className="diagnostic-panel-note">
        仅包含版本、功能状态、错误分类和有界统计，不包含网页正文、地址、Cookie、密钥或本地路径。
        统计来自本次应用进程，null 表示未采集。
      </p>
      <div className="diagnostic-panel-actions">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? '处理中…' : '生成预览'}
        </button>
        <button type="button" onClick={exportPreview} disabled={preview === null || loading}>
          保存此预览
        </button>
      </div>
      {message !== null && <p className="diagnostic-panel-message">{message}</p>}
      {preview !== null && (
        <div className="diagnostic-preview">
          <div className="diagnostic-preview-meta">
            <span>SHA-256 {shortDiagnosticDigest(preview.digest)}…</span>
            <span>{preview.byteLength} 字节</span>
          </div>
          <pre tabIndex={0}>{preview.json}</pre>
        </div>
      )}
    </aside>
  );
}
