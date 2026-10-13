import { useId } from 'react';
import { Icon } from './Icon';
import type { Appearance } from './theme';
import './theme-select.css';

interface ThemeSelectProps {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
}

const APPEARANCE_CHOICES: ReadonlyArray<{
  value: Appearance;
  label: string;
  description: string;
  icon: 'monitor' | 'sun' | 'moon';
}> = [
  {
    value: 'system',
    label: '跟随系统',
    description: '随 Windows 颜色模式变化',
    icon: 'monitor',
  },
  { value: 'light', label: '浅色', description: '始终使用明亮界面', icon: 'sun' },
  { value: 'dark', label: '深色', description: '始终使用深色界面', icon: 'moon' },
];

export function ThemeSelect({ appearance, onChange }: ThemeSelectProps) {
  const groupName = `appearance-${useId()}`;

  return (
    <fieldset className="theme-choice-group">
      <legend>界面外观</legend>
      <div className="theme-choice-options">
        {APPEARANCE_CHOICES.map((choice) => (
          <label className="theme-choice" key={choice.value}>
            <input
              type="radio"
              name={groupName}
              value={choice.value}
              checked={appearance === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span className="theme-choice-icon">
              <Icon name={choice.icon} size={20} />
            </span>
            <span className="theme-choice-copy">
              <strong>{choice.label}</strong>
              <span>{choice.description}</span>
            </span>
            <span className="theme-choice-selected" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
