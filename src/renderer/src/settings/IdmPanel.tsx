import { useEffect, useRef, useState } from 'react';
import './idm.css';

export function IdmPanel() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.aibrowse.downloads.getStatus().then(
      (status) => {
        if (!cancelled) setAvailable(status.available);
      },
      () => {
        if (!cancelled) {
          setAvailable(false);
          setError('暂时无法检测 IDM，请重新打开此页面后重试。');
        }
      },
    );
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, []);

  const send = async (): Promise<void> => {
    if (pending.current || available !== true || url.trim() === '') return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.aibrowse.downloads.sendToIdm(url.trim());
      if (!mounted.current) return;
      if (result.ok) setNotice('已发送请求，请在 IDM 中确认下载。');
      else setError(result.message);
    } catch {
      if (mounted.current) setError('请求未能发送到 IDM，请稍后重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="settings-section-card idm-panel" aria-label="IDM 下载工具">
      <h2>IDM 下载工具</h2>
      <p>复制文件的下载链接，发送到电脑上已安装的 Internet Download Manager。</p>
      <p role="status">
        {available === null ? '正在检测 IDM…' : available ? '已检测到 IDM' : '未检测到 IDM'}
      </p>
      {available === false && (
        <p className="idm-note">请确认 IDM 已安装在 Windows 的默认程序目录，然后重新打开此页面。</p>
      )}
      <form
        className="idm-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="idm-download-url">下载链接</label>
        <input
          id="idm-download-url"
          type="url"
          value={url}
          maxLength={4096}
          placeholder="https://example.com/file.zip"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setUrl(event.currentTarget.value)}
        />
        <button type="submit" disabled={available !== true || busy || url.trim() === ''}>
          {busy ? '正在发送…' : '发送到 IDM'}
        </button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      {notice !== null && <p role="status">{notice}</p>}
      <p className="idm-note">
        支持 HTTP / HTTPS
        文件链接。仅发送链接，不传递本浏览器的登录信息；需要登录的网站可能无法直接下载。
        下载确认与进度在 IDM 中查看。
      </p>
    </section>
  );
}
