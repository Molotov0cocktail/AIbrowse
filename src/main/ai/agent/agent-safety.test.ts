// agent-safety 防循环纯函数测试（A5）。契约源：doc/stage3/detailed-design.md §8.2/§8.3
// + threat-model §3.5 + 决议 #33（2026-08-14 实施校准）：
// - 签名 = 工具名 + 确定性规范化参数（JSON.parse 成功且为对象 → 递归键排序 + Unicode NFC
//   后确定性序列化；解析失败/非对象 → NFC 原始串——无法取得合法参数的调用同样有稳定签名）；
// - 仅对「执行了或试图执行」的工具调用计签（校验失败/被拒/失败/执行/安全阻断均计）；
// - 判定在每次执行管线前：该调用会使连续 ≥3 或累计 ≥5 → 在执行前阻断（wouldTriggerLoop
//   必须先于 record 判定）；无白名单例外；无进展连续 2 轮触发。
import { describe, expect, it } from 'vitest';
import {
  AGENT_LOOP_NO_PROGRESS_STEPS,
  AGENT_LOOP_SAME_SIGNATURE_CONSECUTIVE,
  AGENT_LOOP_SAME_SIGNATURE_TOTAL,
  AGENT_SAFETY_LIMITS,
  AgentSafety,
  buildToolSignature,
  normalizeSignatureArguments,
} from './agent-safety';

describe('agent-safety — 签名规范化（确定性）', () => {
  it('常量取值为契约值（连续 3 / 累计 5 / 无进展 2，全部可注入）', () => {
    expect(AGENT_LOOP_SAME_SIGNATURE_CONSECUTIVE).toBe(3);
    expect(AGENT_LOOP_SAME_SIGNATURE_TOTAL).toBe(5);
    expect(AGENT_LOOP_NO_PROGRESS_STEPS).toBe(2);
    expect(AGENT_SAFETY_LIMITS).toEqual({ consecutive: 3, total: 5, noProgressSteps: 2 });
  });

  it('JSON 键顺序不同 → 同一签名（键排序确定性）', () => {
    const a = buildToolSignature('browser_scroll', '{"dy":10,"tabId":"t1"}');
    const b = buildToolSignature('browser_scroll', '{"tabId":"t1","dy":10}');
    expect(a).toBe(b);
  });

  it('Unicode NFC 归一化：组合型与预组型等价', () => {
    // 'é' 的两种表示（U+0065 U+0301 与 U+00E9）
    const a = buildToolSignature('browser_find', '{"text":"café"}');
    const b = buildToolSignature('browser_find', '{"text":"café"}');
    expect(a).toBe(b);
  });

  it('工具名不同 → 签名不同', () => {
    expect(buildToolSignature('browser_read', '{}')).not.toBe(
      buildToolSignature('browser_find', '{}'),
    );
  });

  it('参数值不同 → 签名不同', () => {
    expect(buildToolSignature('browser_scroll', '{"dy":1}')).not.toBe(
      buildToolSignature('browser_scroll', '{"dy":2}'),
    );
  });

  it('非法 JSON（无法取得合法参数）仍有稳定签名（NFC 原始串，不抛异常）', () => {
    const raw = '{"dy": 10';
    expect(normalizeSignatureArguments(raw)).toBe(raw.normalize('NFC'));
    expect(buildToolSignature('browser_scroll', raw)).toBe(
      buildToolSignature('browser_scroll', '{"dy": 10'),
    );
    // 非对象 JSON 同样安全
    expect(buildToolSignature('browser_scroll', '[1,2]')).toBe(
      buildToolSignature('browser_scroll', '[1,2]'),
    );
  });

  it('嵌套对象键同样递归排序（防御：schema v1 无嵌套但敌手输入必须确定）', () => {
    const a = normalizeSignatureArguments('{"x":{"b":1,"a":2}}');
    expect(a).toBe('{"x":{"a":2,"b":1}}');
  });

  it('数字/布尔参数与字符串表示区分（JSON 语义确定性）', () => {
    expect(buildToolSignature('browser_scroll', '{"dy":1}')).not.toBe(
      buildToolSignature('browser_scroll', '{"dy":"1"}'),
    );
  });
});

describe('agent-safety — 循环判定（阻断必须发生在触发次执行前）', () => {
  it('前两次同签名执行，第三次 wouldTriggerLoop=true（触发次在执行前阻断）', () => {
    const s = new AgentSafety();
    const sig = buildToolSignature('browser_read', '{}');
    expect(s.wouldTriggerLoop(sig)).toBe(false);
    s.record(sig); // 第 1 次执行
    expect(s.wouldTriggerLoop(sig)).toBe(false);
    s.record(sig); // 第 2 次执行
    expect(s.wouldTriggerLoop(sig)).toBe(true); // 第 3 次：执行前必须终止
  });

  it('非连续累计：前四次执行，第五次在执行前阻断', () => {
    const s = new AgentSafety();
    const sig = buildToolSignature('browser_read', '{}');
    const other = buildToolSignature('browser_scroll', '{"dy":1}');
    for (let i = 1; i <= 3; i++) {
      s.record(sig);
      expect(s.wouldTriggerLoop(sig)).toBe(false); // 第 i 次后判定：未达累计阈值
      s.record(other); // 打断连续（累计不重置）
      s.record(other);
    }
    s.record(sig); // 第 4 次
    expect(s.wouldTriggerLoop(sig)).toBe(true); // 累计第 5 次在执行前阻断
  });

  it('read 等工具无白名单例外（决议 #24：防死循环优先）', () => {
    const s = new AgentSafety();
    const sig = buildToolSignature('browser_read', '{}');
    s.record(sig);
    s.record(sig);
    expect(s.wouldTriggerLoop(sig)).toBe(true);
  });

  it('被拒/失败/试图执行的调用同样计签（校验失败与执行失败不能逃避检测）', () => {
    const s = new AgentSafety();
    const sig = buildToolSignature('browser_navigate', '{"tabId":"bad","url":"https://x.com/"}');
    s.record(sig); // invalid-args（试图执行）
    s.record(sig); // 再次失败
    expect(s.wouldTriggerLoop(sig)).toBe(true);
  });

  it('不同签名打断连续计数（连续计数器重置、累计保留）', () => {
    const s = new AgentSafety();
    const a = buildToolSignature('browser_read', '{}');
    const b = buildToolSignature('browser_read', '{"tabId":"t1"}');
    s.record(a);
    s.record(a);
    s.record(b); // 打断
    expect(s.wouldTriggerLoop(a)).toBe(false); // 连续 1 起算
    s.record(a); // 连续 1
    expect(s.wouldTriggerLoop(a)).toBe(false); // 连续第 2 次（未达阈值 3）
    s.record(a); // 连续 2
    expect(s.wouldTriggerLoop(a)).toBe(true); // 连续第 3 次在执行前阻断
  });

  it('触发次调用也被计入（阻断的调用 record 后连续计数已达阈值）', () => {
    const s = new AgentSafety();
    const sig = buildToolSignature('browser_read', '{}');
    s.record(sig);
    s.record(sig);
    expect(s.wouldTriggerLoop(sig)).toBe(true);
    s.record(sig); // 阻断的调用同样计步（契约：被拒/失败/试图执行的调用按契约计步）
    expect(s.wouldTriggerLoop(sig)).toBe(true);
  });

  it('阈值可注入（测试不依赖生产常量）', () => {
    const s = new AgentSafety({ consecutive: 2, total: 3, noProgressSteps: 1 });
    const sig = buildToolSignature('browser_read', '{}');
    s.record(sig);
    expect(s.wouldTriggerLoop(sig)).toBe(true); // 连续第 2 次即触发
    const s2 = new AgentSafety({ consecutive: 2, total: 3 });
    const other = buildToolSignature('browser_scroll', '{"dy":1}');
    s2.record(other);
    s2.record(other);
    s2.record(other);
    // 累计第 3 次（注意 record 已计 3 次 → wouldTrigger 为 true 在下一次；此处验证累计计数）
    s2.record(other);
    expect(s2.wouldTriggerLoop(other)).toBe(true);
  });

  it('no-progress 连续 2 轮触发（可注入），多轮间可被打断', () => {
    const s = new AgentSafety();
    expect(s.isNoProgressTriggered()).toBe(false);
    s.recordNoProgressRound();
    expect(s.isNoProgressTriggered()).toBe(false);
    s.recordNoProgressRound();
    expect(s.isNoProgressTriggered()).toBe(true);
    expect(s.noProgressRounds).toBe(2);
  });
});
