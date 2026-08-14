// 权限决策纯函数测试（红→绿，A2）。契约源：doc/stage3/detailed-design.md §7.1 +
// threat-model §3.3。核心：13 工具全表、click 确定性允许列表（isSubmit 优先升级 L2 →
// href http/https → ariaExpanded 字段存在（true/false 均为展开/折叠控件）→
// checkbox/radio → 否则 L3 fail-closed）、fill password/file 恒 L3、URL scheme L3、
// 历史无语义元数据 fail-closed——同一输入同一决策（确定性纯函数，模型/网页无通道）。
import { describe, expect, it } from 'vitest';
import type { ElementSemantics } from '../../../shared/types/agent';
import { classifyClickTarget, decide, isHttpUrl, TOOL_BASE_RISK } from './permission-policy';

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
  it('L0 工具恒自动：get_tabs/get_active_tab/read/find/scroll/search_web', () => {
    for (const name of [
      'browser_get_tabs',
      'browser_get_active_tab',
      'browser_find',
      'browser_scroll',
      'search_web',
    ]) {
      expect(decide(name, {}, null).level, name).toBe(0);
      expect(TOOL_BASE_RISK[name], name).toBe(0);
    }
    expect(decide('browser_read', { tabId: 'x' }, null).level).toBe(0);
    expect(decide('search_web', { query: 'hello' }, null).level).toBe(0);
  });

  it('back/forward/reload 恒 L1（自动显著展示，无参数条件）', () => {
    for (const name of ['browser_back', 'browser_forward', 'browser_reload']) {
      expect(decide(name, {}, null).level, name).toBe(1);
    }
  });

  it('open：http/https → L1；非 http/https / 缺失 / 非字符串 → L3', () => {
    expect(decide('browser_open', { url: 'https://example.com/' }, null).level).toBe(1);
    expect(decide('browser_open', { url: 'http://example.com/' }, null).level).toBe(1);
    for (const url of [
      'javascript:alert(1)',
      'ftp://files',
      'file:///C:/a',
      'data:text/html,x',
      '',
      'https:example.com',
    ]) {
      expect(decide('browser_open', { url }, null).level, url).toBe(3);
    }
    expect(decide('browser_open', {}, null).level).toBe(3);
    expect(decide('browser_open', { url: 42 }, null).level).toBe(3);
  });

  it('navigate：与 open 同规则（URL 非 http/https 恒 L3）', () => {
    expect(decide('browser_navigate', { url: 'https://x/' }, null).level).toBe(1);
    expect(decide('browser_navigate', { url: 'javascript:void(0)' }, null).level).toBe(3);
    expect(decide('browser_navigate', { tabId: 't', url: 'file:///C:/a' }, null).level).toBe(3);
  });

  it('未知工具 → L3（防御性 fail-closed，正常流程注册表已先拒绝）', () => {
    expect(decide('browser.evil', {}, null).level).toBe(3);
    expect(decide('shell.exec', {}, null).level).toBe(3);
  });
});

describe('click 确定性允许列表（§7.1 + 决议 #29，fail-closed 不回落到基础 L1）', () => {
  it('导航链接：href http/https → L1；href 非 http/https → L3', () => {
    expect(
      decide('browser_click', { elementId: 'el-1' }, { href: 'https://example.com/x' }).level,
    ).toBe(1);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { href: 'http://example.com' }).level,
    ).toBe(1);
    for (const href of ['javascript:void(0)', 'ftp://x', 'mailto:a@b.c', '', 'data:text/html,x']) {
      expect(decide('browser_click', { elementId: 'el-1' }, { href }).level, href).toBe(3);
    }
  });

  it('展开/折叠控件：ariaExpanded=true 与 false 均为 L1（字段存在即证明）', () => {
    expect(decide('browser_click', { elementId: 'el-1' }, { ariaExpanded: true }).level).toBe(1);
    expect(decide('browser_click', { elementId: 'el-1' }, { ariaExpanded: false }).level).toBe(1);
  });

  it('切换控件：checkbox/radio → L1；其他输入类型 → L3', () => {
    expect(decide('browser_click', { elementId: 'el-1' }, { inputType: 'checkbox' }).level).toBe(1);
    expect(decide('browser_click', { elementId: 'el-1' }, { inputType: 'radio' }).level).toBe(1);
    for (const t of ['text', 'button', 'submit', 'file', 'password', '']) {
      expect(decide('browser_click', { elementId: 'el-1' }, { inputType: t }).level, t).toBe(3);
    }
  });

  it('提交类：isSubmit=true → L2（升级优先于一切其他特征，不降回 L1）', () => {
    expect(decide('browser_click', { elementId: 'el-1' }, { isSubmit: true }).level).toBe(2);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: true, href: 'https://x/' }).level,
    ).toBe(2);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: true, ariaExpanded: false }).level,
    ).toBe(2);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: true, inputType: 'checkbox' })
        .level,
    ).toBe(2);
  });

  it('特征冲突：isSubmit=false 不升级，其余特征正常判定', () => {
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: false, href: 'https://x/' }).level,
    ).toBe(1);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: false, ariaExpanded: true }).level,
    ).toBe(1);
    expect(decide('browser_click', { elementId: 'el-1' }, { isSubmit: false }).level).toBe(3);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { isSubmit: false, inputType: 'button' })
        .level,
    ).toBe(3);
  });

  it('危险特征不因并存低风险特征放行（href 非 http 即 L3）', () => {
    expect(
      decide('browser_click', { elementId: 'el-1' }, { href: 'javascript:x', ariaExpanded: true })
        .level,
    ).toBe(3);
    expect(
      decide('browser_click', { elementId: 'el-1' }, { href: 'ftp://x', inputType: 'checkbox' })
        .level,
    ).toBe(3);
  });

  it('语义元数据缺失/历史无该 elementId → L3 fail-closed（不得以执行时检查代替）', () => {
    expect(decide('browser_click', { elementId: 'el-1' }, null).level).toBe(3);
    expect(decide('browser_click', { elementId: 'el-1' }, {}).level).toBe(3);
    expect(decide('browser_click', { elementId: 'el-1' }, { ariaExpanded: undefined }).level).toBe(
      3,
    );
  });

  it('普通按钮/语义不明 → L3（无法排除购买/发送/删除/发布等远程写副作用）', () => {
    expect(decide('browser_click', { elementId: 'el-1' }, { inputType: 'button' }).level).toBe(3);
    expect(decide('browser_click', { elementId: 'el-1' }, { inputType: 'submit' }).level).toBe(3);
  });

  it('同一输入同一决策（确定性纯函数）', () => {
    const inputs = [
      { href: 'https://x/', isSubmit: true },
      { href: 'javascript:x', ariaExpanded: true },
      { inputType: 'checkbox' },
      null,
    ];
    for (const semantics of inputs) {
      const a = decide('browser_click', { elementId: 'el-1' }, semantics);
      const b = decide('browser_click', { elementId: 'el-1' }, semantics);
      expect(b).toEqual(a);
    }
  });
});

describe('fill 权限（password/file 目标恒 L3）', () => {
  it('普通输入字段 → L1；password/file → L3（恒禁）', () => {
    for (const t of ['text', 'search', 'email', 'number', 'url']) {
      expect(
        decide('browser_fill', { elementId: 'el-1', text: 'x' }, { inputType: t }).level,
        t,
      ).toBe(1);
    }
    expect(
      decide('browser_fill', { elementId: 'el-1', text: 'x' }, { inputType: 'password' }).level,
    ).toBe(3);
    expect(
      decide('browser_fill', { elementId: 'el-1', text: 'x' }, { inputType: 'file' }).level,
    ).toBe(3);
  });

  it('语义元数据缺失 → L3（无法证明目标不是密码/文件字段，fail-closed）', () => {
    expect(decide('browser_fill', { elementId: 'el-1', text: 'x' }, null).level).toBe(3);
    expect(decide('browser_fill', { elementId: 'el-1', text: 'x' }, {}).level).toBe(3);
  });
});

describe('决策输出形状与确定性', () => {
  it('13 工具全部返回 {level ∈ 0..3, reason 非空中文}，同一输入同一输出', () => {
    const cases: Array<[string, Record<string, unknown>, ElementSemantics | null]> = [
      ['browser_get_tabs', {}, null],
      ['browser_get_active_tab', {}, null],
      ['browser_read', {}, null],
      ['browser_find', { text: 'x' }, null],
      ['browser_scroll', { dy: 10 }, null],
      ['search_web', { query: 'q' }, null],
      ['browser_open', { url: 'https://x/' }, null],
      ['browser_navigate', { url: 'https://x/' }, null],
      ['browser_back', {}, null],
      ['browser_forward', {}, null],
      ['browser_reload', {}, null],
      ['browser_click', { elementId: 'el-1' }, { href: 'https://x/' }],
      ['browser_fill', { elementId: 'el-1', text: 'x' }, { inputType: 'text' }],
    ];
    for (const [name, args, semantics] of cases) {
      const d = decide(name, args, semantics);
      expect([0, 1, 2, 3], name).toContain(d.level);
      expect(d.reason.length, name).toBeGreaterThan(0);
      expect(decide(name, args, semantics)).toEqual(d);
    }
  });
});

// —— A3 扩展：classifyClickTarget 单一事实源（权限级别与 allowedKind 同源派生） ——
describe('classifyClickTarget：allowedKind 单一事实源（A3，执行器内部参数派生）', () => {
  it('与 decide 同源一致：classify 结果 ⇔ decide 级别映射（submit→L2、nav/expand/toggle→L1、null→L3）', () => {
    const cases: Array<[ElementSemantics | null, string | null, number]> = [
      [null, null, 3],
      [{ isSubmit: true, href: 'https://x/' }, 'submit', 2], // isSubmit 优先，不因并存特征降回
      [{ href: 'https://example.com/' }, 'nav', 1],
      [{ href: '/relative' }, null, 3], // 快照 href 恒为解析后的绝对 URL；非 http/https 一律不放行
      [{ href: 'javascript:alert(1)' }, null, 3],
      [{ ariaExpanded: true }, 'expand', 1],
      [{ ariaExpanded: false }, 'expand', 1], // 显式 false 同样是展开/折叠控件
      [{ inputType: 'checkbox' }, 'toggle', 1],
      [{ inputType: 'radio' }, 'toggle', 1],
      [{ inputType: 'text' }, null, 3],
      [{}, null, 3],
    ];
    for (const [semantics, kind, level] of cases) {
      expect(classifyClickTarget(semantics), JSON.stringify(semantics)).toBe(kind);
      expect(decide('browser_click', { elementId: 'el-1' }, semantics).level).toBe(level);
    }
  });

  it('语义缺失（null）与语义空对象 → null（权限层 L3，执行器无 allowedKind 可派生）', () => {
    expect(classifyClickTarget(null)).toBeNull();
    expect(classifyClickTarget({})).toBeNull();
    expect(classifyClickTarget({ inputType: 'submit' })).toBeNull(); // 只有 isSubmit 布尔才升级
  });

  it('确定性：同一输入同一分类（无随机、无模型/网页通道）', () => {
    const semantics = { href: 'https://x/', isSubmit: false };
    for (let i = 0; i < 5; i++) {
      expect(classifyClickTarget(semantics)).toBe('nav');
    }
  });
});
