import { useEffect, useRef, useState } from 'react';
import type {
  QualifiedScriptResult,
  QualifiedScriptStatus,
} from '../../../shared/types/qualified-userscripts';

export function QualifiedScriptsPanel() {
  const [scripts, setScripts] = useState<QualifiedScriptStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.aibrowse.qualifiedScripts
      .list()
      .then(
        (items) => {
          if (!cancelled) setScripts(items);
        },
        () => {
          if (!cancelled) setError('指定脚本列表暂不可用，请重新打开工具。');
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      mounted.current = false;
      cancelled = true;
    };
  }, []);

  const run = async (
    operation: () => Promise<QualifiedScriptResult>,
    success: string,
  ): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
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
      const items = await window.aibrowse.qualifiedScripts.list();
      if (!mounted.current) return;
      setScripts(items);
      setNotice(result.cancelled ? '已取消安装。' : success);
    } catch {
      if (mounted.current) setError('脚本操作未完成，请重新查看状态后重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="settings-section-card userscripts-panel" aria-label="指定油猴脚本">
      <div className="userscripts-heading">
        <div>
          <h2>内置网页增强</h2>
          <p>AC-baidu 与 GitHub 中文化已随应用提供，并固定为经过校验的版本。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void window.aibrowse.qualifiedScripts.showMenu().catch(() => {
              if (mounted.current) setError('当前网页的脚本操作暂不可用。');
            });
          }}
        >
          当前网页的脚本菜单
        </button>
      </div>
      <p className="userscripts-note">
        无需联网下载或导入文件。功能只在普通浏览标签运行，研究与监控任务页面不注入；切换后刷新匹配网页生效。
      </p>
      {loading && <p role="status">正在读取脚本状态…</p>}
      {busy && <p role="status">正在保存内置功能状态…</p>}
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
      <div className="userscripts-list">
        {scripts.map((script) => (
          <article className="userscript-card" key={script.id}>
            <div className="userscript-title-row">
              <div>
                <h3>{script.name}</h3>
                <span>
                  版本 {script.version} · 内置 · {script.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              <label className="userscript-toggle">
                启用
                <input
                  type="checkbox"
                  checked={script.enabled}
                  disabled={busy || script.issue !== null}
                  aria-label={`启用 ${script.name}`}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    void run(
                      () => window.aibrowse.qualifiedScripts.setEnabled(script.id, enabled),
                      enabled
                        ? '已启用，请刷新匹配网页。'
                        : '已停用。刷新已打开网页可清除此前的页面改动。',
                    );
                  }}
                />
              </label>
            </div>
            <p>
              {script.id === 'ac-baidu'
                ? '搜索结果增强、去重定向与页面布局；可保存配置并访问公网链接。设置入口在“当前网页的脚本菜单”。'
                : '使用本地词库汉化 GitHub 界面。附带的讯飞简介翻译已禁用，翻译请使用 AI 共读。'}
            </p>
            {script.issue !== null && (
              <p role="alert" className="userscripts-error">
                {script.issue}
              </p>
            )}
          </article>
        ))}
      </div>
      <p className="userscripts-note">
        内置代码会改变匹配网页，AI
        共读会看到这些变化。脚本设置保存在本机；停用不会删除设置，版本随应用更新。
      </p>
    </section>
  );
}
