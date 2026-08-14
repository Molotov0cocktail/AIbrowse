// A3 交互结果形状校验测试（红→绿先写）：页面脚本返回值视为敌手输入，逐字段验证；
// 畸形返回/页面原型篡改/未知代码只能得到结构化失败，异常、堆栈或页面原文不穿透。
// 契约源：doc/stage3/detailed-design.md §5.1/§5.3 + Third_stage.md §5.2。
import { describe, expect, it } from 'vitest';
import { normalizeInteractionResult } from './interaction-normalize';

describe('A3 交互结果形状校验（页面视为敌手）', () => {
  it('click 成功形状：tag/text 必须为字符串，text ≤100 字符', () => {
    const r = normalizeInteractionResult({ ok: true, tag: 'a', text: '  导航 \n链接  ' }, 'click');
    expect(r).toEqual({ ok: true, tag: 'a', text: '导航 链接' });
  });

  it('click 成功但 tag 非字符串 / 缺失 / text 非字符串 → 结构化失败（execution-failed）', () => {
    for (const raw of [
      { ok: true, tag: 42, text: 'x' },
      { ok: true, text: 'x' },
      { ok: true, tag: 'a', text: { toString: () => 'x' } },
      { ok: true, tag: 'a', text: null },
    ]) {
      const r = normalizeInteractionResult(raw, 'click');
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('execution-failed');
      expect(r.reason).toBe('页面返回异常，交互结果不可用');
    }
  });

  it('click 成功超长 text 确定性截断 ≤100 字符', () => {
    const r = normalizeInteractionResult(
      { ok: true, tag: 'button', text: '长'.repeat(300) },
      'click',
    );
    expect(r.ok).toBe(true);
    expect((r.text ?? '').length).toBe(100);
  });

  it('fill 成功形状：tag/type 必须为字符串；结果不含输入值（无 value 通道）', () => {
    const r = normalizeInteractionResult({ ok: true, tag: 'input', type: 'text' }, 'fill');
    expect(r).toEqual({ ok: true, tag: 'input', type: 'text' });
    const hostile = normalizeInteractionResult(
      { ok: true, tag: 'input', type: 'text', value: '泄露的输入原文' },
      'fill',
    );
    expect(hostile.ok).toBe(true);
    expect(hostile).not.toHaveProperty('value');
    expect(JSON.stringify(hostile)).not.toContain('泄露的输入原文');
  });

  it('fill 成功但 type 缺失/非字符串 → 结构化失败', () => {
    for (const raw of [
      { ok: true, tag: 'input' },
      { ok: true, tag: 'input', type: 42 },
      { ok: true, tag: 'input', type: '' },
    ]) {
      expect(normalizeInteractionResult(raw, 'fill').ok).toBe(false);
    }
  });

  it('scroll 成功形状：viewport 四数字（有限、≥0），畸形 → 结构化失败', () => {
    const good = normalizeInteractionResult(
      { ok: true, viewport: { scrollX: 0, scrollY: 100, width: 800, height: 600 } },
      'scroll',
    );
    expect(good).toEqual({
      ok: true,
      viewport: { scrollX: 0, scrollY: 100, width: 800, height: 600 },
    });
    for (const raw of [
      { ok: true },
      { ok: true, viewport: { scrollX: 0, scrollY: 100, width: 800 } },
      { ok: true, viewport: { scrollX: -1, scrollY: 100, width: 800, height: 600 } },
      { ok: true, viewport: { scrollX: NaN, scrollY: 100, width: 800, height: 600 } },
      { ok: true, viewport: { scrollX: '0', scrollY: 100, width: 800, height: 600 } },
      { ok: true, viewport: { scrollX: Infinity, scrollY: 100, width: 800, height: 600 } },
    ]) {
      const r = normalizeInteractionResult(raw, 'scroll');
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('execution-failed');
    }
  });

  it('失败代码映射（闭合枚举）：not-found → element-not-found / not-interactable → not-interactable / 其余与未知 → execution-failed', () => {
    expect(
      normalizeInteractionResult({ ok: false, code: 'not-found', reason: '未找到' }, 'click'),
    ).toMatchObject({
      ok: false,
      errorCode: 'element-not-found',
      reason: '未找到',
    });
    expect(
      normalizeInteractionResult(
        { ok: false, code: 'not-interactable', reason: '不可交互' },
        'click',
      ),
    ).toMatchObject({ ok: false, errorCode: 'not-interactable' });
    for (const code of [
      'kind-mismatch',
      'forbidden-type',
      'not-fillable',
      'bad-args',
      'error',
      'hacked-code',
      undefined,
      42,
    ]) {
      const r = normalizeInteractionResult({ ok: false, code, reason: 'x' }, 'click');
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('execution-failed');
    }
  });

  it('失败 reason：字符串校验 + 空白折叠 + ≤200 截断；缺失/非字符串 → 固定中文文案', () => {
    const r = normalizeInteractionResult(
      { ok: false, code: 'not-found', reason: `  原\n文 ${'长'.repeat(400)}` },
      'click',
    );
    expect(r.ok).toBe(false);
    expect((r.reason ?? '').length).toBeLessThanOrEqual(200);
    expect(r.reason).toContain('原 文'); // 空白折叠后单空格
    expect(normalizeInteractionResult({ ok: false, code: 'not-found' }, 'click').reason).toBe(
      '未找到目标元素',
    );
    expect(
      normalizeInteractionResult({ ok: false, code: 'not-found', reason: ['x'] }, 'click').reason,
    ).toBe('未找到目标元素');
  });

  it('失败代码非法时 reason 仍按敌手输入处理（不穿透页面原文）', () => {
    const r = normalizeInteractionResult(
      { ok: false, code: 'hacked', reason: '恶意页面原文 <script>' },
      'click',
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(r.reason).toBe('恶意页面原文 <script>'); // 固定结构内，截断/折叠已应用，无执行通道
  });

  it('整体畸形输入（null/数组/字符串/数字/ok 非布尔）→ 结构化失败，不抛异常', () => {
    for (const raw of [null, undefined, 'x', 42, [], { ok: 'true' }, { ok: true }]) {
      const r = normalizeInteractionResult(raw, 'click');
      expect(r).toMatchObject({ ok: false, errorCode: 'execution-failed' });
      expect(r.reason).toBe('页面返回异常，交互结果不可用');
    }
  });

  it('错误码枚举闭合：全部可能错误码 ∈ ToolResultErrorCode 集合', () => {
    const allowed = new Set([
      'element-not-found',
      'stale-element',
      'not-interactable',
      'execution-failed',
    ]);
    const r1 = normalizeInteractionResult({ ok: false, code: 'not-found' }, 'click');
    const r2 = normalizeInteractionResult({ ok: false, code: 'not-interactable' }, 'fill');
    const r3 = normalizeInteractionResult({ ok: false, code: 'kind-mismatch' }, 'click');
    const r4 = normalizeInteractionResult(null, 'scroll');
    for (const r of [r1, r2, r3, r4]) {
      expect(r.ok).toBe(false);
      expect(r.errorCode === undefined || allowed.has(r.errorCode)).toBe(true);
    }
  });
});
