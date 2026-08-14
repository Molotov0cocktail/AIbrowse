// 权限决策纯函数测试（红→绿，A2）。契约源：doc/stage3/detailed-design.md §7.1 +
// threat-model §3.3。核心：13 工具全表、click 确定性允许列表（isSubmit 优先升级 L2 →
// href http/https → ariaExpanded 字段存在（true/false 均为展开/折叠控件）→
// checkbox/radio → 否则 L3 fail-closed）、fill password/file 恒 L3、URL scheme L3、
// 历史无语义元数据 fail-closed——同一输入同一决策（确定性纯函数，模型/网页无通道）。
import { describe, expect, it } from 'vitest';
import type { ElementSemantics } from '../../../shared/types/agent';
import { decide, isHttpUrl, TOOL_BASE_RISK } from './permission-policy';

describe('isHttpUrl（URL scheme 判定，复用 Tab 导航白名单同源判定）', () => {
  it('http/https 大小写不敏感通过；其余 scheme 与畸形输入拒绝', () => {
    expect(isHttpUrl('https://example.com/')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('HTTPS://EXAMPLE.COM/a')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'ftp://x',
      'file:///C:/a',
      'data:text/html,x',
      'about:blank',
      'https:example.com',
      '',
      'not a url',
    ]) {
      expect(isHttpUrl(bad), bad).toBe(false);
    }
  });
});

describe('13 工具权限全表（基础级别 + 条件判定）', () => {
  it('L0 工具恒自动：get_tabs/get_active_tab/read/find/scroll/search.web', () => {
    for (const name of [
      'browser.get_tabs',
      'browser.get_active_tab',
      'browser.find',
      'browser.scroll',
      'search.web',
    ]) {
      expect(decide(name, {}, null).level, name).toBe(0);
      expect(TOOL_BASE_RISK[name], name).toBe(0);
    }
    expect(decide('browser.read', { tabId: 'x' }, null).level).toBe(0);
    expect(decide('search.web', { query: 'hello' }, null).level).toBe(0);
  });

  it('back/forward/reload 恒 L1（自动显著展示，无参数条件）', () => {
    for (const name of ['browser.back', 'browser.forward', 'browser.reload']) {
      expect(decide(name, {}, null).level, name).toBe(1);
    }
  });

  it('open：http/https → L1；非 http/https / 缺失 / 非字符串 → L3', () => {
    expect(decide('browser.open', { url: 'https://example.com/' }, null).level).toBe(1);
    expect(decide('browser.open', { url: 'http://example.com/' }, null).level).toBe(1);
    for (const url of [
      'javascript:alert(1)',
      'ftp://files',
      'file:///C:/a',
      'data:text/html,x',
      '',
      'https:example.com',
    ]) {
      expect(decide('browser.open', { url }, null).level, url).toBe(3);
    }
    expect(decide('browser.open', {}, null).level).toBe(3);
    expect(decide('browser.open', { url: 42 }, null).level).toBe(3);
  });

  it('navigate：与 open 同规则（URL 非 http/https 恒 L3）', () => {
    expect(decide('browser.navigate', { url: 'https://x/' }, null).level).toBe(1);
    expect(decide('browser.navigate', { url: 'javascript:void(0)' }, null).level).toBe(3);
    expect(decide('browser.navigate', { tabId: 't', url: 'file:///C:/a' }, null).level).toBe(3);
  });

  it('未知工具 → L3（防御性 fail-closed，正常流程注册表已先拒绝）', () => {
    expect(decide('browser.evil', {}, null).level).toBe(3);
    expect(decide('shell.exec', {}, null).level).toBe(3);
  });
});

describe('click 确定性允许列表（§7.1 + 决议 #29，fail-closed 不回落到基础 L1）', () => {
  it('导航链接：href http/https → L1；href 非 http/https → L3', () => {
    expect(
      decide('browser.click', { elementId: 'el-1' }, { href: 'https://example.com/x' }).level,
    ).toBe(1);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { href: 'http://example.com' }).level,
    ).toBe(1);
    for (const href of ['javascript:void(0)', 'ftp://x', 'mailto:a@b.c', '', 'data:text/html,x']) {
      expect(decide('browser.click', { elementId: 'el-1' }, { href }).level, href).toBe(3);
    }
  });

  it('展开/折叠控件：ariaExpanded=true 与 false 均为 L1（字段存在即证明）', () => {
    expect(decide('browser.click', { elementId: 'el-1' }, { ariaExpanded: true }).level).toBe(1);
    expect(decide('browser.click', { elementId: 'el-1' }, { ariaExpanded: false }).level).toBe(1);
  });

  it('切换控件：checkbox/radio → L1；其他输入类型 → L3', () => {
    expect(decide('browser.click', { elementId: 'el-1' }, { inputType: 'checkbox' }).level).toBe(1);
    expect(decide('browser.click', { elementId: 'el-1' }, { inputType: 'radio' }).level).toBe(1);
    for (const t of ['text', 'button', 'submit', 'file', 'password', '']) {
      expect(decide('browser.click', { elementId: 'el-1' }, { inputType: t }).level, t).toBe(3);
    }
  });

  it('提交类：isSubmit=true → L2（升级优先于一切其他特征，不降回 L1）', () => {
    expect(decide('browser.click', { elementId: 'el-1' }, { isSubmit: true }).level).toBe(2);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: true, href: 'https://x/' }).level,
    ).toBe(2);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: true, ariaExpanded: false }).level,
    ).toBe(2);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: true, inputType: 'checkbox' })
        .level,
    ).toBe(2);
  });

  it('特征冲突：isSubmit=false 不升级，其余特征正常判定', () => {
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: false, href: 'https://x/' }).level,
    ).toBe(1);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: false, ariaExpanded: true }).level,
    ).toBe(1);
    expect(decide('browser.click', { elementId: 'el-1' }, { isSubmit: false }).level).toBe(3);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { isSubmit: false, inputType: 'button' })
        .level,
    ).toBe(3);
  });

  it('危险特征不因并存低风险特征放行（href 非 http 即 L3）', () => {
    expect(
      decide('browser.click', { elementId: 'el-1' }, { href: 'javascript:x', ariaExpanded: true })
        .level,
    ).toBe(3);
    expect(
      decide('browser.click', { elementId: 'el-1' }, { href: 'ftp://x', inputType: 'checkbox' })
        .level,
    ).toBe(3);
  });

  it('语义元数据缺失/历史无该 elementId → L3 fail-closed（不得以执行时检查代替）', () => {
    expect(decide('browser.click', { elementId: 'el-1' }, null).level).toBe(3);
    expect(decide('browser.click', { elementId: 'el-1' }, {}).level).toBe(3);
    expect(decide('browser.click', { elementId: 'el-1' }, { ariaExpanded: undefined }).level).toBe(
      3,
    );
  });

  it('普通按钮/语义不明 → L3（无法排除购买/发送/删除/发布等远程写副作用）', () => {
    expect(decide('browser.click', { elementId: 'el-1' }, { inputType: 'button' }).level).toBe(3);
    expect(decide('browser.click', { elementId: 'el-1' }, { inputType: 'submit' }).level).toBe(3);
  });

  it('同一输入同一决策（确定性纯函数）', () => {
    const inputs = [
      { href: 'https://x/', isSubmit: true },
      { href: 'javascript:x', ariaExpanded: true },
      { inputType: 'checkbox' },
      null,
    ];
    for (const semantics of inputs) {
      const a = decide('browser.click', { elementId: 'el-1' }, semantics);
      const b = decide('browser.click', { elementId: 'el-1' }, semantics);
      expect(b).toEqual(a);
    }
  });
});

describe('fill 权限（password/file 目标恒 L3）', () => {
  it('普通输入字段 → L1；password/file → L3（恒禁）', () => {
    for (const t of ['text', 'search', 'email', 'number', 'url']) {
      expect(
        decide('browser.fill', { elementId: 'el-1', text: 'x' }, { inputType: t }).level,
        t,
      ).toBe(1);
    }
    expect(
      decide('browser.fill', { elementId: 'el-1', text: 'x' }, { inputType: 'password' }).level,
    ).toBe(3);
    expect(
      decide('browser.fill', { elementId: 'el-1', text: 'x' }, { inputType: 'file' }).level,
    ).toBe(3);
  });

  it('语义元数据缺失 → L3（无法证明目标不是密码/文件字段，fail-closed）', () => {
    expect(decide('browser.fill', { elementId: 'el-1', text: 'x' }, null).level).toBe(3);
    expect(decide('browser.fill', { elementId: 'el-1', text: 'x' }, {}).level).toBe(3);
  });
});

describe('决策输出形状与确定性', () => {
  it('13 工具全部返回 {level ∈ 0..3, reason 非空中文}，同一输入同一输出', () => {
    const cases: Array<[string, Record<string, unknown>, ElementSemantics | null]> = [
      ['browser.get_tabs', {}, null],
      ['browser.get_active_tab', {}, null],
      ['browser.read', {}, null],
      ['browser.find', { text: 'x' }, null],
      ['browser.scroll', { dy: 10 }, null],
      ['search.web', { query: 'q' }, null],
      ['browser.open', { url: 'https://x/' }, null],
      ['browser.navigate', { url: 'https://x/' }, null],
      ['browser.back', {}, null],
      ['browser.forward', {}, null],
      ['browser.reload', {}, null],
      ['browser.click', { elementId: 'el-1' }, { href: 'https://x/' }],
      ['browser.fill', { elementId: 'el-1', text: 'x' }, { inputType: 'text' }],
    ];
    for (const [name, args, semantics] of cases) {
      const d = decide(name, args, semantics);
      expect([0, 1, 2, 3], name).toContain(d.level);
      expect(d.reason.length, name).toBeGreaterThan(0);
      expect(decide(name, args, semantics)).toEqual(d);
    }
  });
});
