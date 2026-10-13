import type { InputHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabInfo } from '../../../shared/types/browser';
import { AddressBar } from './AddressBar';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  dependencies: [] as (readonly unknown[])[],
  effects: [] as (() => void)[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
}));

vi.mock('react', () => {
  const effect = (callback: () => void, dependencies: readonly unknown[]) => {
    const index = hooks.effectIndex++;
    const previous = hooks.dependencies[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
      hooks.dependencies[index] = [...dependencies];
      hooks.effects.push(callback);
    }
  };
  return {
    useState: (initial: unknown) => {
      const index = hooks.stateIndex++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (next: unknown) => (hooks.values[index] = next)];
    },
    useRef: (initial: unknown) => {
      const index = hooks.refIndex++;
      return (hooks.refs[index] ??= { current: initial });
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

const page = (id = 'a', url = 'https://example.test/login'): TabInfo => ({
  id,
  url,
  title: '测试页',
  state: 'ready',
  active: true,
});

function harness() {
  const navigate = vi.fn();
  let activeTab: TabInfo | null = page();
  let props: InputHTMLAttributes<HTMLInputElement>;
  const input = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    select() {
      this.selectionStart = 0;
      this.selectionEnd = this.value.length;
    },
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  function render(tab = activeTab) {
    activeTab = tab;
    for (let pass = 0; pass < 2; pass++) {
      hooks.stateIndex = hooks.refIndex = hooks.effectIndex = 0;
      props = AddressBar({ activeTab, onNavigate: navigate }).props;
      for (const effect of hooks.effects.splice(0)) effect();
    }
    input.value = String(props.value ?? '');
  }
  function dispatch<K extends keyof InputHTMLAttributes<HTMLInputElement>>(
    name: K,
    extra: Record<string, unknown> = {},
  ) {
    const handler = props[name];
    if (typeof handler === 'function') {
      (handler as (event: unknown) => void)({
        currentTarget: input,
        target: input,
        button: 0,
        detail: 1,
        ...extra,
      });
    }
    render();
  }
  render();
  return { input, render, dispatch, navigate };
}

beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.dependencies = [];
  hooks.effects = [];
});

describe('地址栏草稿归属与点击选择', () => {
  it('新建空白标签即使地址栏已聚焦也清空旧网址', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.render(page('blank', 'about:blank'));
    expect(h.input.value).toBe('');
  });

  it('同URL不同标签也丢弃上一个标签的编辑草稿', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.input.value = '未提交的输入';
    h.dispatch('onChange');
    h.render(page('b'));
    expect(h.input.value).toBe(page().url);
  });

  it('同一标签更新URL时保留正在输入的草稿，失焦恢复新URL', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.input.value = '编辑中的网址';
    h.dispatch('onChange');
    h.render(page('a', 'https://example.test/redirected'));
    expect(h.input.value).toBe('编辑中的网址');
    h.dispatch('onBlur');
    expect(h.input.value).toBe('https://example.test/redirected');
  });

  it('活动标签消失时清空草稿', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.render(null);
    expect(h.input.value).toBe('');
  });

  it('单击全选，双击恢复第一次点击的原生插入位置', () => {
    const h = harness();
    h.input.setSelectionRange(12, 12);
    h.dispatch('onClick');
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([0, h.input.value.length]);
    h.input.setSelectionRange(8, 15);
    h.dispatch('onClick', { detail: 2 });
    h.dispatch('onDoubleClick', { detail: 2 });
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([12, 12]);
  });

  it('已聚焦时后续单击仍全选', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.input.setSelectionRange(5, 5);
    h.dispatch('onClick');
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([0, h.input.value.length]);
  });

  it('拖动选区与右键选择不被强制全选', () => {
    const h = harness();
    h.input.setSelectionRange(4, 9);
    h.dispatch('onClick');
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([4, 9]);
    h.input.setSelectionRange(3, 3);
    h.dispatch('onClick', { button: 2 });
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([3, 3]);
  });

  it('右键与Shift按下保留原选区，双击第二次按下保持原生序列', () => {
    const h = harness();
    for (const event of [{ button: 2 }, { shiftKey: true }, { detail: 2 }]) {
      h.input.setSelectionRange(4, 9);
      h.dispatch('onMouseDown', event);
      expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([4, 9]);
    }
  });

  it('Enter保持原始输入提交，空输入不导航', () => {
    const h = harness();
    h.dispatch('onFocus');
    h.input.value = '  example.test/other  ';
    h.dispatch('onChange');
    h.dispatch('onKeyDown', { key: 'Enter' });
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith('example.test/other');
    h.input.value = ' ';
    h.dispatch('onChange');
    h.dispatch('onKeyDown', { key: 'Enter' });
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.input.value).toBe(page().url);
  });
});
