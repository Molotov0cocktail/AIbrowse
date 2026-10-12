import { useTraySettings } from './useTraySettings';

export function TraySettingsControl() {
  const tray = useTraySettings();
  const disabled = tray.loading || tray.saving || tray.settings?.available !== true;

  return (
    <div className="tray-settings">
      <label className="tray-settings-toggle">
        <span>
          <strong>托盘运行</strong>
          <span>
            关闭主窗口后继续运行监控任务。可从系统托盘重新打开窗口，或选择退出 AIbrowse 结束运行。
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="关闭窗口后在系统托盘运行"
          checked={tray.settings?.runInTray ?? false}
          disabled={disabled}
          onChange={(event) => tray.setRunInTray(event.currentTarget.checked)}
        />
      </label>
      <p className="tray-settings-note">退出 AIbrowse 或关闭 Windows 后，监控任务不会继续运行。</p>
      {tray.notice !== null && (
        <p className="tray-settings-error" role="alert">
          {tray.notice}
        </p>
      )}
    </div>
  );
}
