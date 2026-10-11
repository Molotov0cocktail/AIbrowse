import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { readAppearance, saveAppearance } from './theme';

export function ThemeSelect() {
  const [appearance, setAppearance] = useState(() => readAppearance(window));

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
  }, [appearance]);

  return (
    <label className="theme-select">
      <Icon name={appearance === 'system' ? 'monitor' : appearance === 'light' ? 'sun' : 'moon'} />
      <select
        aria-label="界面外观"
        title="界面外观"
        value={appearance}
        onChange={(event) => setAppearance(saveAppearance(window, event.target.value))}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
