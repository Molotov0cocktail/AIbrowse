import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import {
  createThemePalette,
  normalizeThemeColor,
  THEME_COLOR_PRESETS,
  type ThemeColor,
} from '../../../shared/theme-colors';
import { Icon } from './Icon';
import './theme-color-picker.css';

interface ThemeColorPickerProps {
  color: ThemeColor;
  onChange: (color: ThemeColor) => boolean;
  error: string | null;
}

const PRESET_PREVIEWS = THEME_COLOR_PRESETS.map((preset) => ({
  ...preset,
  preview: createThemePalette(preset.color, false),
}));

export function ThemeColorPicker({ color, onChange, error }: ThemeColorPickerProps) {
  const id = useId();
  const [draft, setDraft] = useState<{ color: ThemeColor; text: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const hex = draft?.color === color ? draft.text : (color ?? '#3d5faa');
  const selected = THEME_COLOR_PRESETS.find((preset) => preset.color === color);
  const issue = validationError ?? error;
  const select = (next: ThemeColor): void => {
    setValidationError(null);
    if (onChange(next)) setDraft(null);
  };
  const applyHex = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = normalizeThemeColor(hex);
    if (next === null) {
      setValidationError('请输入完整的 HEX 颜色，例如 #336699。');
      return;
    }
    select(next);
  };

  return (
    <section className="theme-color-picker" aria-labelledby={`${id}-heading`}>
      <div className="theme-color-heading">
        <h3 id={`${id}-heading`}>主题色</h3>
        <button type="button" onClick={() => select(null)}>
          恢复默认
        </button>
      </div>
      <p className="theme-color-description">
        为标签栏、工具栏和界面强调色换一种配色，浅深模式保持独立。
      </p>
      <fieldset className="theme-color-presets">
        <legend>预设配色</legend>
        <div className="theme-color-grid">
          {PRESET_PREVIEWS.map((preset) => {
            const preview = preset.preview;
            return (
              <label className="theme-color-choice" key={preset.id} title={preset.label}>
                <input
                  type="radio"
                  name={`${id}-preset`}
                  value={preset.id}
                  checked={color === preset.color}
                  aria-label={`主题色：${preset.label}`}
                  onChange={() => select(preset.color)}
                />
                <span
                  className="theme-color-swatch"
                  aria-hidden="true"
                  style={
                    {
                      '--swatch-light': preview.chrome,
                      '--swatch-color': preset.color ?? preview.primary,
                    } as CSSProperties
                  }
                >
                  <span className="theme-color-check">
                    <Icon name="check" size={13} />
                  </span>
                </span>
                <span className="theme-color-name">{preset.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="theme-color-current" aria-live="polite">
        当前颜色：{selected?.label ?? `自定义 ${color}`}
      </p>
      <form className="theme-color-custom" onSubmit={applyHex}>
        <label className="theme-color-native">
          <span>自定义颜色</span>
          <input
            type="color"
            aria-label="选择自定义主题色"
            value={color ?? '#3d5faa'}
            onChange={(event) => {
              const next = normalizeThemeColor(event.currentTarget.value);
              if (next !== null) select(next);
            }}
          />
        </label>
        <label className="theme-color-hex" htmlFor={`${id}-hex`}>
          <span>HEX 颜色</span>
          <input
            id={`${id}-hex`}
            type="text"
            value={hex}
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={validationError !== null}
            aria-describedby={`${id}-help${issue === null ? '' : ` ${id}-error`}`}
            onChange={(event) => {
              setDraft({ color, text: event.currentTarget.value });
              setValidationError(null);
            }}
          />
        </label>
        <button type="submit">应用颜色</button>
      </form>
      <p className="theme-color-help" id={`${id}-help`}>
        输入 # 和六位十六进制颜色值。界面会自动调整配色，保持文字清晰。
      </p>
      {issue !== null && (
        <p className="theme-color-error" id={`${id}-error`} role="alert">
          {issue}
        </p>
      )}
    </section>
  );
}
