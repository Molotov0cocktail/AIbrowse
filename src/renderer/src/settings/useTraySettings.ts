import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraySettings } from '../../../shared/types/app';

const LOAD_ERROR = '托盘设置暂不可用，请稍后重试';
const SAVE_ERROR = '托盘设置保存失败，请稍后重试';

export interface TraySettingsController {
  settings: TraySettings | null;
  loading: boolean;
  saving: boolean;
  notice: string | null;
  setRunInTray: (enabled: boolean) => void;
}

export function useTraySettings(): TraySettingsController {
  const [settings, setSettings] = useState<TraySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void window.aibrowse.appPreferences
      .get()
      .then((current) => {
        if (!mounted.current) return;
        setSettings(current);
        setNotice(current.available && current.error === null ? null : LOAD_ERROR);
      })
      .catch(() => {
        if (mounted.current) setNotice(LOAD_ERROR);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const setRunInTray = useCallback((enabled: boolean): void => {
    setSaving(true);
    setNotice(null);
    void window.aibrowse.appPreferences
      .setRunInTray(enabled)
      .then((current) => {
        if (!mounted.current) return;
        setSettings(current);
        setNotice(
          current.available && current.error === null && current.runInTray === enabled
            ? null
            : SAVE_ERROR,
        );
      })
      .catch(async () => {
        try {
          const current = await window.aibrowse.appPreferences.get();
          if (mounted.current) setSettings(current);
        } catch {
          // The prior main-process state remains the only state we can honestly display.
        }
        if (mounted.current) setNotice(SAVE_ERROR);
      })
      .finally(() => {
        if (mounted.current) setSaving(false);
      });
  }, []);

  return { settings, loading, saving, notice, setRunInTray };
}
