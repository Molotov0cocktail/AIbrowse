import { useEffect, useState } from 'react';
import { PROVIDER_KIND_OPENAI_COMPATIBLE } from '../../../shared/types/conversation';

interface ProviderSettingsProps {
  onClose: () => void;
}

// Provider 设置（§10/§11.3 + 决议 #20）：v1 只配置已注册的 openai-compatible kind——
// 表单目标 providerId 固定为该 kind（与 list() 条目顺序无关），不新增多 Provider 选择 UI。
// API Key 只写不回显（type=password，保存后立即清空；apiKey='' = 删除）；list() 仅提供
// hasKey 布尔——Key 无法经任何通道读回渲染层（§4.2 白名单，无读回方法）。
export function ProviderSettings({ onClose }: ProviderSettingsProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshHasKey = async (): Promise<void> => {
    setHasKey(await window.aibrowse.config.providers.hasKey(PROVIDER_KIND_OPENAI_COMPATIBLE));
  };

  useEffect(() => {
    void (async () => {
      await refreshHasKey();
      const infos = await window.aibrowse.config.providers.list();
      const mine = infos.find((info) => info.providerId === PROVIDER_KIND_OPENAI_COMPATIBLE);
      if (mine !== undefined) {
        setBaseUrl(mine.baseUrl);
        setModel(mine.model);
      }
    })();
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    let keyUpdated = false;
    try {
      if (apiKey.trim() !== '') {
        const keySaved = await window.aibrowse.config.providers.setKey(
          PROVIDER_KIND_OPENAI_COMPATIBLE,
          apiKey.trim(),
        );
        setApiKey('');
        if (!keySaved) {
          setNotice(
            'API Key 未能持久保存，配置未提交。若密钥仅保留在本次运行，可留空后再次保存配置并确认目标；重启后需重新配置',
          );
          await refreshHasKey();
          return;
        }
        keyUpdated = true;
      }
      const saved = await window.aibrowse.config.providers.set({
        providerId: PROVIDER_KIND_OPENAI_COMPATIBLE,
        baseUrl,
        model,
      });
      if (!saved) {
        setNotice(
          (keyUpdated ? '新 API Key 已保存，但发送目标尚未授权。' : '') +
            '配置未提交：请检查地址和模型，并在原生对话框确认目标。取消、配置变更或保存失败时，请重新保存',
        );
        await refreshHasKey();
        return;
      }
      await refreshHasKey();
      setNotice('已保存');
    } catch {
      setNotice('保存未完成，请重新打开设置后重试');
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const deleted = await window.aibrowse.config.providers.setKey(
        PROVIDER_KIND_OPENAI_COMPATIBLE,
        '',
      );
      await refreshHasKey();
      setNotice(deleted ? 'API Key 已删除' : 'API Key 删除失败，原密钥可能仍保留，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-settings">
      <div className="ai-settings-header">
        <span className="ai-settings-title">Provider 设置</span>
        <button type="button" className="ai-settings-close" onClick={onClose}>
          返回
        </button>
      </div>
      <p className="ai-settings-hint">
        v1 支持 OpenAI 兼容接口（任意符合 OpenAI Chat Completions 协议的服务）。
      </p>
      <label className="ai-settings-field">
        <span>接口地址（baseUrl）</span>
        <input
          type="text"
          className="ai-settings-baseurl"
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          disabled={busy}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="ai-settings-field">
        <span>模型（model）</span>
        <input
          type="text"
          className="ai-settings-model"
          placeholder="gpt-4o-mini"
          value={model}
          disabled={busy}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <label className="ai-settings-field">
        <span>API Key（只写不回显）</span>
        <input
          type="password"
          className="ai-settings-key"
          placeholder={hasKey ? '已保存（留空保持不变）' : '输入 API Key'}
          value={apiKey}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="ai-settings-actions">
        <button
          type="button"
          className="ai-settings-save"
          disabled={busy}
          onClick={() => void save()}
        >
          保存
        </button>
        {hasKey && (
          <button
            type="button"
            className="ai-settings-remove-key"
            disabled={busy}
            onClick={() => void removeKey()}
          >
            删除 Key
          </button>
        )}
        <span className={`ai-settings-haskey ${hasKey ? 'saved' : ''}`}>
          {hasKey ? 'API Key 已保存' : '尚未保存 API Key'}
        </span>
      </div>
      {notice !== null && <p className="ai-settings-notice">{notice}</p>}
    </div>
  );
}
