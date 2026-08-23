// smoke-ui-atomic unit tests（8.13 B-06 UI 时序修复，2026-08-23）：原子
// 「存在即点击」脚本的纯逻辑验证（零 Electron import；node:vm 在隔离
// 上下文模拟 renderer 的 document）。红态 oracle 直接编码 8.13 失败机理：
// 旧 panelGoBack 把 uiHas 与 clickUi 分成两次脚本执行，Undo 引发的 React
// 重渲染可在两次调用之间移除 .sources-back（详情异步自动关闭），第二次
// 脚本抛错 → executeJavaScript 以通用 renderer 错误拒绝；新脚本把检查与
// 条件点击放在同一次执行内同步完成，元素不存在时安全返回 false。
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { clickIfPresentScript } from './smoke-ui-atomic';

interface FakeEl {
  clickCalls: number;
  click(): void;
}

function makeElement(): FakeEl {
  return {
    clickCalls: 0,
    click() {
      this.clickCalls += 1;
    },
  };
}

function runScript(script: string, document: unknown): unknown {
  const ctx = { document };
  vm.createContext(ctx);
  // runInContext 直接返回脚本完成值（IIFE 的返回值）
  return vm.runInContext(script, ctx, { timeout: 1000 });
}

describe('clickIfPresentScript — 原子「存在即点击」（8.13 TOCTOU 竞态修复）', () => {
  it('元素存在 → 点击一次并返回 true（同一次脚本执行内同步完成）', () => {
    const el = makeElement();
    const doc = { querySelector: (s: string) => (s === '.sources-back' ? el : null) };
    const result = runScript(clickIfPresentScript('.sources-back'), doc);
    expect(result).toBe(true);
    expect(el.clickCalls).toBe(1);
  });

  it('元素不存在 → 安全返回 false 且不抛错（旧脚本在此抛「UI 元素不存在」）', () => {
    const doc = { querySelector: () => null };
    expect(() => runScript(clickIfPresentScript('.sources-back'), doc)).not.toThrow();
    const result = runScript(clickIfPresentScript('.sources-back'), doc);
    expect(result).toBe(false);
  });

  it('红态机理直测：两次独立脚本执行之间元素消失 → 旧式点击抛错，新脚本单次执行不抛错', () => {
    // 旧 panelGoBack 等价实现：脚本 1 检查存在（true），脚本 2 点击时元素已被
    // React 重渲染移除 → 第二次 executeJavaScript 抛错。
    const checkPresentScript = `document.querySelector('.sources-back') !== null`;
    const oldClickScript = `(() => {
      const el = document.querySelector('.sources-back');
      if (!el) throw new Error('UI 元素不存在：.sources-back');
      el.click();
    })()`;
    const presentDoc = { querySelector: () => makeElement() };
    const goneDoc = { querySelector: () => null };

    // 脚本 1 检查通过…
    expect(runScript(checkPresentScript, presentDoc)).toBe(true);
    // …但到脚本 2 执行时元素已消失（重渲染）→ 抛错（executeJavaScript 以
    // 通用 renderer 错误拒绝的根因）。
    expect(() => runScript(oldClickScript, goneDoc)).toThrow(/UI 元素不存在/);

    // 修复后：检查与点击在同一次脚本执行内原子完成，不存在“两步之间”窗口——
    // 单次执行要么拿到元素点击（返回 true），要么拿到 null 安全返回 false。
    expect(runScript(clickIfPresentScript('.sources-back'), presentDoc)).toBe(true);
    expect(runScript(clickIfPresentScript('.sources-back'), goneDoc)).toBe(false);
  });

  it('selector 经 JSON.stringify 引用——任意选择器安全注入且结果正确', () => {
    const el = makeElement();
    const selector = 'button[aria-label="收起信源面板"]';
    const doc = { querySelector: (s: string) => (s === selector ? el : null) };
    const result = runScript(clickIfPresentScript(selector), doc);
    expect(result).toBe(true);
    expect(el.clickCalls).toBe(1);
    // 引号/括号正确编码：脚本文本可被 node:vm 正常解析执行（语法有效性）
    expect(clickIfPresentScript(selector)).toContain('收起信源面板');
  });
});
