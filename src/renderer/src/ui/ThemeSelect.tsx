import { Icon } from './Icon';
import type { Appearance } from './theme';

interface ThemeSelectProps {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
}

export function ThemeSelect({ appearance, onChange }: ThemeSelectProps) {
  return (
    <label className="theme-select">
      <Icon name={appearance === 'system' ? 'monitor' : appearance === 'light' ? 'sun' : 'moon'} />
      <select
        aria-label="界面外观"
        title="界面外观"
        value={appearance}
        onChange={(event) => onChange(event.target.value as Appearance)}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
