import { Children, isValidElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  colorContrast,
  createThemePalette,
  THEME_COLOR_PRESETS,
  type ThemeColor,
} from '../../../shared/theme-colors';
import { ThemeColorPicker } from './ThemeColorPicker';

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useId: () => 'color-test',
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = next;
      },
    ];
  },
}));

interface Props {
  children?: ReactNode;
  type?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  role?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  onClick?: () => void;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => void;
}
function nodes(value: ReactNode): Array<{ type: unknown; props: Props }> {
  const found: Array<{ type: unknown; props: Props }> = [];
  for (const child of Children.toArray(value)) {
    if (!isValidElement<Props>(child)) continue;
    found.push({ type: child.type, props: child.props });
    found.push(...nodes(child.props.children));
  }
  return found;
}
function text(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return Children.toArray(value)
    .map((child) => (isValidElement<Props>(child) ? text(child.props.children) : String(child)))
    .join('');
}
function mount(initial: ThemeColor = null, error: string | null = null) {
  let color = initial;
  const onChange = vi.fn((next: ThemeColor) => {
    color = next;
    return true;
  });
  const render = () => {
    hooks.cursor = 0;
    return ThemeColorPicker({ color, error, onChange });
  };
  const field = (type: string) =>
    nodes(render()).find((node) => node.type === 'input' && node.props.type === type)!;
  const submit = () => {
    const event = { preventDefault: vi.fn() };
    nodes(render())
      .find((node) => node.type === 'form')!
      .props.onSubmit?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  };
  return { render, onChange, field, submit };
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
});

it.each([false, true])('AI悬停背景在实际CSS级联中压过通用按钮规则（按下=%s）', (pressed) => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const applicable: Array<{ background: string; specificity: number; selector: string }> = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const background = match[2]!.match(/(?:^|;)\s*background:\s*([^;]+);/)?.[1];
    if (!background) continue;
    for (const part of match[1]!.split(',')) {
      const selector = part.trim();
      if (!pressed && selector.includes("[aria-pressed='true']")) continue;
      const active = selector
        .replaceAll(':not(:disabled)', '')
        .replaceAll(':hover', '')
        .replaceAll("[aria-pressed='true']", '');
      if (!/^(?:button)?(?:\.(?:nav-button|ai-toggle))*$/.test(active) || active === '') continue;
      const specificity =
        (selector.match(/\./g)?.length ?? 0) * 100 +
        (selector.match(/\[[^\]]+\]/g)?.length ?? 0) * 100 +
        (selector.replaceAll(':not(:disabled)', ':disabled').match(/:/g)?.length ?? 0) * 100 +
        (selector.startsWith('button') ? 1 : 0);
      applicable.push({ background, specificity, selector });
    }
  }
  const winning = applicable.reduce((winner, rule) =>
    rule.specificity >= winner.specificity ? rule : winner,
  );
  expect(winning.background, winning.selector).toBe('var(--primary)');
});

it('实际AI按钮悬停与按下背景对比在预设和极端颜色中保持可读', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const rule = css.match(/[^{}]*\.ai-toggle:hover[^{}]*\{([^}]+)\}/)?.[1];
  const background = rule?.match(/background:\s*([^;]+);/)?.[1];
  expect(background).toBeDefined();
  for (const seed of [
    ...THEME_COLOR_PRESETS.map((preset) => preset.color),
    '#000000',
    '#ffffff',
    '#ffff00',
    '#777777',
  ]) {
    for (const dark of [false, true]) {
      const palette = createThemePalette(seed, dark);
      let rendered = palette.primary;
      if (background !== 'var(--primary)') {
        const mix = background?.match(
          /^color-mix\(in srgb, var\(--primary\) (\d+)%, var\(--surface\)\)$/,
        );
        if (mix === null || mix === undefined)
          throw new Error('未知悬停背景表达式，请更新实际颜色解析');
        const amount = Number(mix[1]) / 100;
        rendered =
          '#' +
          [1, 3, 5]
            .map((offset) =>
              Math.round(
                parseInt(palette.primary.slice(offset, offset + 2), 16) * amount +
                  parseInt(palette.surface.slice(offset, offset + 2), 16) * (1 - amount),
              )
                .toString(16)
                .padStart(2, '0'),
            )
            .join('');
      }
      expect(
        colorContrast(palette.onPrimary, rendered),
        `${seed ?? '默认'}/${dark ? '深' : '浅'}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

describe('主题色色卡与自定义输入', () => {
  it('16个预设使用带名称的同组原生单选项，当前默认唯一选中', () => {
    const panel = mount();
    const radios = nodes(panel.render()).filter((node) => node.props.type === 'radio');
    expect(radios).toHaveLength(16);
    expect(new Set(radios.map((node) => node.props.name)).size).toBe(1);
    expect(radios.filter((node) => node.props.checked).map((node) => node.props.value)).toEqual([
      'default',
    ]);
    for (const preset of THEME_COLOR_PRESETS)
      expect(radios.some((node) => node.props['aria-label'] === `主题色：${preset.label}`)).toBe(
        true,
      );
    expect(text(panel.render())).toContain('当前颜色：默认');
    expect(panel.onChange).not.toHaveBeenCalled();
  });

  it('选择预设后勾选状态与HEX同步，恢复默认只回传null', () => {
    const panel = mount('#123456');
    nodes(panel.render())
      .find((node) => node.props.value === 'blue')!
      .props.onChange?.({ currentTarget: { value: 'blue' } });
    expect(panel.onChange).toHaveBeenLastCalledWith(
      THEME_COLOR_PRESETS.find((preset) => preset.id === 'blue')!.color,
    );
    expect(panel.field('text').props.value).toBe(
      THEME_COLOR_PRESETS.find((preset) => preset.id === 'blue')!.color,
    );
    nodes(panel.render())
      .find((node) => node.type === 'button' && text(node.props.children) === '恢复默认')!
      .props.onClick?.();
    expect(panel.onChange).toHaveBeenLastCalledWith(null);
    expect(text(panel.render())).toContain('当前颜色：默认');
  });

  it('HEX草稿不即时应用，提交非法值反馈错误，合法大写值按小写保存', () => {
    const panel = mount();
    panel.field('text').props.onChange?.({ currentTarget: { value: '#123' } });
    expect(panel.onChange).not.toHaveBeenCalled();
    panel.submit();
    expect(panel.onChange).not.toHaveBeenCalled();
    expect(panel.field('text').props['aria-invalid']).toBe(true);
    expect(panel.field('text').props['aria-describedby']).toContain('color-test-error');
    expect(nodes(panel.render()).some((node) => node.props.role === 'alert')).toBe(true);
    panel.field('text').props.onChange?.({ currentTarget: { value: '#ABCDEF' } });
    panel.submit();
    expect(panel.onChange).toHaveBeenCalledExactlyOnceWith('#abcdef');
    expect(panel.field('text').props.value).toBe('#abcdef');
    expect(text(panel.render())).toContain('当前颜色：自定义 #abcdef');
  });

  it('系统取色器接受合法颜色且有可访问名称', () => {
    const panel = mount();
    expect(panel.field('color').props['aria-label']).toBe('选择自定义主题色');
    panel.field('color').props.onChange?.({ currentTarget: { value: '#fedcba' } });
    expect(panel.onChange).toHaveBeenCalledExactlyOnceWith('#fedcba');
  });

  it('保存失败显示原色和错误，失败HEX草稿保留供重试', () => {
    const panel = mount('#123456', '主题色保存失败，已保留原来的颜色。请重试。');
    panel.onChange.mockReturnValue(false);
    panel.field('text').props.onChange?.({ currentTarget: { value: '#ABCDEF' } });
    panel.submit();
    expect(panel.field('text').props.value).toBe('#ABCDEF');
    expect(text(panel.render())).toContain('当前颜色：自定义 #123456');
    expect(
      text(nodes(panel.render()).find((node) => node.props.role === 'alert')!.props.children),
    ).toContain('保存失败');
  });
});
