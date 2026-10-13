import { useEffect, useRef, useState } from 'react';
import type { UserScriptResult, UserScriptSummary } from '../../../shared/types/userscripts';
import './userscripts.css';

export function UserScriptsPanel() {
  const [scripts, setScripts] = useState<UserScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const mounted = useRef(false);
  const operationPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.aibrowse.userscripts
      .list()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setScripts(result.value);
        else setError(result.message);
      })
      .catch(() => {
        if (!cancelled) setError('用户脚本列表暂不可用，请稍后重新打开设置。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, []);

  const run = async (
    operation: () => Promise<UserScriptResult<unknown>>,
    success: string | ((value: unknown) => string),
  ): Promise<void> => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const refreshed = await window.aibrowse.userscripts.list();
      if (!mounted.current) return;
      if (refreshed.ok) setScripts(refreshed.value);
      else {
        setError(refreshed.message);
        return;
      }
      setPendingRemoval(null);
      setNotice(typeof success === 'string' ? success : success(result.value));
    } catch {
      if (mounted.current) setError('操作未完成，请重新查看脚本列表后再试。');
    } finally {
      operationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="settings-section-card userscripts-panel" aria-label="用户脚本管理">
      <div className="userscripts-heading">
        <div>
          <h2>其他用户脚本</h2>
          <p>为常用网站添加你需要的样式和功能。</p>
        </div>
        <button
          type="button"
          disabled={loading || busy}
          onClick={() =>
            void run(
              () => window.aibrowse.userscripts.importScript(),
              (value) =>
                value === null ? '已取消导入。' : '脚本已安装并启用。刷新匹配网页后生效。',
            )
          }
        >
          导入脚本
        </button>
      </div>
      <p className="userscripts-note">
        选择本地 .user.js
        文件，查看适用网站并确认后安装。脚本可读取和修改匹配网页，请仅安装你信任的脚本。
      </p>
      {loading && <p role="status">正在读取脚本…</p>}
      {error !== null && (
        <p role="alert" className="userscripts-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="userscripts-notice">
          {notice}
        </p>
      )}
      {!loading && scripts.length === 0 && error === null && (
        <div className="userscripts-empty">
          <strong>还没有安装脚本</strong>
          <p>点击“导入脚本”，添加你的第一个网页增强脚本。</p>
        </div>
      )}
      <div className="userscripts-list">
        {scripts.map((script) => (
          <article className="userscript-card" key={script.id}>
            <div className="userscript-title-row">
              <div>
                <h3>{script.name}</h3>
                <span>
                  {script.version ? `版本 ${script.version} · ` : ''}
                  {script.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              <label className="userscript-toggle">
                启用
                <input
                  type="checkbox"
                  checked={script.enabled}
                  disabled={busy}
                  aria-label={`启用脚本 ${script.name}`}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    void run(
                      () => window.aibrowse.userscripts.setEnabled(script.id, enabled),
                      enabled
                        ? '已启用。刷新匹配网页后生效。'
                        : '已停用。刷新已打开的网页，清除脚本此前的效果。',
                    );
                  }}
                />
              </label>
            </div>
            {script.description && <p>{script.description}</p>}
            <details>
              <summary>适用网站与权限</summary>
              <dl>
                <dt>适用网站</dt>
                <dd>
                  {[...script.matches, ...script.includes].map((rule) => (
                    <code key={rule}>{rule}</code>
                  ))}
                </dd>
                {script.excludes.length + script.excludeGlobs.length > 0 && (
                  <>
                    <dt>排除网站</dt>
                    <dd>
                      {[...script.excludes, ...script.excludeGlobs].map((rule) => (
                        <code key={rule}>{rule}</code>
                      ))}
                    </dd>
                  </>
                )}
                <dt>脚本权限</dt>
                <dd>{script.grants.length === 0 ? '网页 DOM' : script.grants.join('、')}</dd>
                <dt>运行时机</dt>
                <dd>页面加载完成后</dd>
              </dl>
            </details>
            <div className="userscript-remove">
              {pendingRemoval === script.id ? (
                <>
                  <span>确定删除这个脚本？</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => window.aibrowse.userscripts.remove(script.id),
                        '脚本已删除。刷新已打开的网页，清除脚本此前的效果。',
                      )
                    }
                  >
                    确认删除
                  </button>
                  <button type="button" disabled={busy} onClick={() => setPendingRemoval(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingRemoval(script.id)}
                  aria-label={`删除脚本 ${script.name}`}
                >
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <details className="userscripts-compatibility">
        <summary>其他脚本的兼容范围</summary>
        <p>
          手动导入的其他脚本支持在页面加载后修改 DOM 和样式。支持
          @match、@include、@exclude、@exclude-match，以及
          GM_addStyle、GM.addStyle、GM_info、GM.info。
        </p>
        <p>
          此导入入口暂不支持 @require、@resource、GM 存储、跨域请求、unsafeWindow 或 document-start
          / document-end。导入不兼容脚本时会显示原因。
        </p>
        <p>
          此处导入的脚本均隔离运行，包括 @grant none；不能直接访问网页 JavaScript
          变量。只在普通浏览标签页运行，不向研究或监控任务页面注入。脚本仍可能通过网页正常能力影响同源登录或存储状态。
        </p>
        <p>
          禁用或删除后，已执行的页面改动需要刷新清除。脚本保存在本机，不自动下载依赖或更新，也不包含在业务数据备份中。
        </p>
      </details>
      <div className="userscripts-extension-status">
        <h3>Chrome 扩展</h3>
        <p>这里提供内置脚本支持与 IDM 链接交接，不安装 Chrome 扩展或 Tampermonkey 本体。</p>
      </div>
    </section>
  );
}
