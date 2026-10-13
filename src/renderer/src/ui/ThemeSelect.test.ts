import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThemeSelect } from './ThemeSelect';

describe('外观模式选择器', () => {
  it('使用三个清晰的单选项并标记当前外观，不依赖原生下拉菜单', () => {
    const markup = renderToStaticMarkup(
      createElement(ThemeSelect, { appearance: 'dark', onChange: vi.fn() }),
    );

    expect(markup).not.toContain('<select');
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).toContain('<legend>界面外观</legend>');
    expect(markup).toContain('value="system"');
    expect(markup).toContain('value="light"');
    expect(markup).toMatch(/<input(?=[^>]*value="dark")(?=[^>]*checked="")[^>]*>/);
    expect(markup).toContain('跟随系统');
    expect(markup).toContain('浅色');
    expect(markup).toContain('深色');
  });
});
