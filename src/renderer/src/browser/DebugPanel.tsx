import { useState } from 'react';
import type { PageSnapshot } from '../../../shared/types/browser';

interface DebugPanelProps {
  activeTabId: string | null;
}

// 采集状态：区分「尚未读取」/「读取中」/「IPC 异常」/「完成」；null 快照 = L3（tab 不可用）
type CaptureState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; snapshot: PageSnapshot | null };

const DEGRADED_LABEL: Record<PageSnapshot['meta']['degraded'], string> = {
  none: 'L0 完整',
  partial: 'L1 部分降级',
  'main-process-only': 'L2 主进程降级',
};

// 调试面板（First_stage §六，开发用途，以后被 AI Chat 替换）：
// 「读取当前网页」→ 经 bridge 调用 page.snapshot（UI → BrowserController 分层），
// 展示当前活动 Tab 的 PageSnapshot JSON + degraded 等级 + warnings（§4：用户能看出采集受限）。
// 快照是点时刻尽力采样（§8.5），面板保留最近一次结果直至下一次读取。
export function DebugPanel({ activeTabId }: DebugPanelProps) {
  const [capture, setCapture] = useState<CaptureState>({ status: 'idle' });
  const [collapsed, setCollapsed] = useState(false);

  const readSnapshot = (): void => {
    if (activeTabId === null) {
      setCapture({ status: 'error', message: '当前没有活动标签页' });
      return;
    }
    setCapture({ status: 'loading' });
    window.aibrowse.page
      .snapshot(activeTabId)
      .then((snapshot) => setCapture({ status: 'done', snapshot }))
      .catch(() => setCapture({ status: 'error', message: '读取失败（IPC 异常）' }));
  };

  const snapshot = capture.status === 'done' ? capture.snapshot : null;

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span className="debug-panel-title">页面快照调试</span>
        <button
          type="button"
          className="debug-capture"
          disabled={capture.status === 'loading' || activeTabId === null}
          onClick={readSnapshot}
        >
          {capture.status === 'loading' ? '采集中…' : '读取当前网页'}
        </button>
        {snapshot !== null && (
          <span className={`debug-badge debug-badge-${snapshot.meta.degraded}`}>
            {DEGRADED_LABEL[snapshot.meta.degraded]}
          </span>
        )}
        {capture.status === 'done' && capture.snapshot === null && (
          <span className="debug-badge debug-badge-l3">L3 不可用</span>
        )}
        <button
          type="button"
          className="debug-toggle"
          aria-label={collapsed ? '展开调试面板' : '收起调试面板'}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && (
        <div className="debug-panel-body">
          {capture.status === 'error' && <p className="debug-error">{capture.message}</p>}
          {capture.status === 'idle' && (
            <p className="debug-hint">点击「读取当前网页」采集活动标签页的结构化快照</p>
          )}
          {capture.status === 'done' && capture.snapshot === null && (
            <p className="debug-error">快照不可用（L3：标签页不存在或已销毁）</p>
          )}
          {snapshot !== null && (
            <>
              {snapshot.meta.warnings.length > 0 && (
                <ul className="debug-warnings" aria-label="采集警告">
                  {snapshot.meta.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <pre className="debug-json">{JSON.stringify(snapshot, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
