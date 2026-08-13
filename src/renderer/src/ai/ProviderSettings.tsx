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
    const infos = await window.aibrowse.config.providers.list();
    const mine = infos.find((info) => info.providerId === PROVIDER_KIND_OPENAI_COMPATIBLE);
    setHasKey(mine?.hasKey ?? false);
  };

  useEffect(() => {
    void (async () => {
      const infos = await window.aibrowse.config.providers.list();
      const mine = infos.find((info) => info.providerId === PROVIDER_KIND_OPENAI_COMPATIBLE);
      if (mine !== undefined) {
        setBaseUrl(mine.baseUrl);
        setModel(mine.model);
        setHasKey(mine.hasKey);
      }
    })();
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await window.aibrowse.config.providers.set({
        providerId: PROVIDER_KIND_OPENAI_COMPATIBLE,
        baseUrl,
        model,
      });
      if (!saved) {
        setNotice('保存失败：地址仅支持 http/https，且模型名不能为空');
        return;
      }
      if (apiKey.trim() !== '') {
        const keySaved = await window.aibrowse.config.providers.setKey(
          PROVIDER_KIND_OPENAI_COMPATIBLE,
          apiKey.trim(),
        );
        if (!keySaved) {
          setNotice('配置已保存，但 API Key 保存失败（当前环境可能无法安全保存，仅本次运行有效）');
          setApiKey(''); // 只写不回显：无论成败都不保留明文
          await refreshHasKey();
          return;
        }
        setApiKey(''); // 只写不回显：保存后立即清空（§10）
      }
      await refreshHasKey();
      setNotice('已保存');
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await window.aibrowse.config.providers.setKey(PROVIDER_KIND_OPENAI_COMPATIBLE, '');
      await refreshHasKey();
      setNotice('API Key 已删除');
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
