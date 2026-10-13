import { ProviderSettings } from '../ai/ProviderSettings';
import { LocalDataPanel } from '../storage/LocalDataPanel';
import type { LocalDataController } from '../storage/useLocalData';
import { Icon } from '../ui/Icon';
import { ThemeSelect } from '../ui/ThemeSelect';
import { ThemeColorPicker } from '../ui/ThemeColorPicker';
import type { AppearanceController } from '../ui/useAppearance';
import { TraySettingsControl } from './TraySettingsControl';
import { UserScriptsPanel } from './UserScriptsPanel';
import { IdmPanel } from './IdmPanel';
import { QualifiedScriptsPanel } from './QualifiedScriptsPanel';

export type SettingsSection = 'general' | 'appearance' | 'extensions' | 'ai' | 'data' | 'advanced';

interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  appearance: AppearanceController;
  localData: LocalDataController;
  browserDataIssue: string | null;
  onOpenDiagnostics: () => void;
  onOpenPageDebug: () => void;
  onWatchCurrentPage: () => void;
}

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'appearance', label: '外观' },
  { id: 'extensions', label: '下载与脚本' },
  { id: 'ai', label: 'AI 配置' },
  { id: 'data', label: '本地数据' },
  { id: 'advanced', label: '高级' },
];

export function SettingsPage({
  section,
  onSectionChange,
  onBack,
  appearance,
  localData,
  browserDataIssue,
  onOpenDiagnostics,
  onOpenPageDebug,
  onWatchCurrentPage,
}: SettingsPageProps) {
  return (
    <div className="settings-page">
      <header className="workspace-page-header">
        <button type="button" className="workspace-page-back" onClick={onBack}>
          <Icon name="arrow-left" /> 返回浏览
        </button>
        <h1>设置</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => onSectionChange(item.id)}
            >
              {item.label}
              {item.id === 'data' && (localData.issue !== null || browserDataIssue !== null) && (
                <span className="settings-nav-alert" aria-label="需要处理">
                  !
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'extensions' && (
            <>
              <IdmPanel />
              <QualifiedScriptsPanel />
              <UserScriptsPanel />
            </>
          )}
          {section === 'general' && (
            <section className="settings-section-card">
              <h2>常规</h2>
              <TraySettingsControl />
            </section>
          )}
          {section === 'appearance' && (
            <section className="settings-section-card">
              <h2>外观</h2>
              <p>选择界面的浅深模式，再搭配喜欢的主题色。</p>
              <ThemeSelect appearance={appearance.appearance} onChange={appearance.setAppearance} />
              <ThemeColorPicker
                color={appearance.themeColor}
                onChange={appearance.setThemeColor}
                error={appearance.themeColorError}
              />
            </section>
          )}
          {section === 'ai' && (
            <section className="settings-section-card">
              <ProviderSettings />
            </section>
          )}
          {section === 'data' && (
            <>
              {browserDataIssue !== null && (
                <p className="settings-browser-data-alert" role="alert">
                  {browserDataIssue}
                </p>
              )}
              <LocalDataPanel controller={localData} />
            </>
          )}
          {section === 'advanced' && (
            <section className="settings-section-card">
              <h2>高级工具</h2>
              <p>这些工具用于监控与排查问题，不会把浏览历史、书签或诊断内容交给 AI。</p>
              <div className="settings-advanced-actions">
                <button type="button" onClick={onWatchCurrentPage}>
                  监控当前页
                </button>
                <button type="button" onClick={onOpenDiagnostics}>
                  诊断信息
                </button>
                <button type="button" onClick={onOpenPageDebug}>
                  页面快照调试
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
