// 审计日志测试（红→绿，A2）。契约源：doc/stage3/detailed-design.md §10.1 +
// threat-model §3.4：每个工具调用恰好一条审计（由 ToolExecutor 保证，见
// tool-executor.test.ts）；参数摘要确定性截断；fill 的 text 只记 len=N（原文零出现）；
// URL 全量；审计内容不含 API Key/请求头/响应体/错误堆栈（logger sanitize 链端到端）。
import { describe, expect, it } from 'vitest';
import {
  createAuditLogger,
  formatAuditMessage,
  summarizeArgs,
  summarizeRawArgs,
  ARGS_SUMMARY_MAX,
  type AuditEntry,
} from './audit-log';
import { sanitize } from '../logger';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    requestId: 'req-1',
    toolCallId: 'call-1',
    tool: 'browser.click',
    argsSummary: '{elementId:el-12}',
    decision: 'confirmed',
    ok: true,
    errorCode: null,
    durationMs: 23,
    ...overrides,
  };
}

describe('summarizeArgs 参数摘要（确定性 + 脱敏）', () => {
  it('browser.fill 的 text 只记录 len=N，原文零出现（含 Key 形态值）', () => {
    const out = summarizeArgs('browser.fill', {
      elementId: 'el-1',
      text: '我的密码是sk-secret-12345678',
    });
    expect(out).toContain('text=len:');
    expect(out).not.toContain('我的密码');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('elementId:el-1');
  });

  it('非字符串 text 防御性处理（len 按字符串化长度）', () => {
    expect(summarizeArgs('browser.fill', { text: 42 })).toContain('text=len:2');
  });

  it('URL 参数全量记录（审计可追溯），超 200 字符不截断', () => {
    const longUrl = 'https://example.com/search?q=' + 'x'.repeat(260);
    const out = summarizeArgs('browser.open', { url: longUrl });
    expect(out).toContain(longUrl);
  });

  it('其余参数确定性截断 ≤ ARGS_SUMMARY_MAX 并带截断标记', () => {
    const out = summarizeArgs('search.web', { query: 'x'.repeat(600) });
    expect(out).toContain('…[已截断]');
    const value = out.slice(out.indexOf('query:') + 'query:'.length, out.indexOf('}'));
    expect(value.length).toBeLessThanOrEqual(ARGS_SUMMARY_MAX + '…[已截断]'.length);
  });

  it('键序确定性：不同插入顺序的同一参数集产出同一摘要', () => {
    const a = summarizeArgs(
      't',
      Object.fromEntries([
        ['b', 1],
        ['a', 'x'],
        ['c', true],
      ]),
    );
    const b = summarizeArgs(
      't',
      Object.fromEntries([
        ['c', true],
        ['a', 'x'],
        ['b', 1],
      ]),
    );
    expect(a).toBe(b);
    expect(a).toBe('{a:x，b:1，c:true}');
  });

  it('无参数 → 空摘要花括号', () => {
    expect(summarizeArgs('browser.get_tabs', {})).toBe('{}');
  });
});

describe('summarizeRawArgs（解析失败路径原文确定性截断）', () => {
  it('短原文原样；长原文确定性截断 + 标记', () => {
    expect(summarizeRawArgs('{broken')).toBe('{broken');
    const out = summarizeRawArgs('x'.repeat(300));
    expect(out.endsWith('…[已截断]')).toBe(true);
    expect(out.length).toBe(ARGS_SUMMARY_MAX); // 总长 ≤ 上限（截断标记计入）
  });
});

describe('formatAuditMessage（确定性中文格式，§10.1 样例同构）', () => {
  it('全字段条目 → 与 §10.1 样例格式一致', () => {
    expect(formatAuditMessage(entry())).toBe(
      'tool-call（requestId=req-1，toolCallId=call-1，tool=browser.click，args={elementId:el-12}，decision=confirmed，ok=true，耗时=23ms，errorCode=无）',
    );
  });

  it('失败条目：ok=false + errorCode；同一输入同一输出（确定性）', () => {
    const msg = formatAuditMessage(
      entry({ ok: false, errorCode: 'forbidden', decision: 'forbidden' }),
    );
    expect(msg).toContain('ok=false');
    expect(msg).toContain('decision=forbidden');
    expect(msg).toContain('errorCode=forbidden');
    expect(
      formatAuditMessage(entry({ ok: false, errorCode: 'forbidden', decision: 'forbidden' })),
    ).toBe(msg);
  });
});

describe('createAuditLogger（logger 薄封装，分层）', () => {
  it('经注入 log 输出 category=audit + 格式化消息', () => {
    const calls: Array<[string, string]> = [];
    const audit = createAuditLogger((category, message) => {
      calls.push([category, message]);
    });
    audit(entry());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('audit');
    expect(calls[0]?.[1]).toBe(formatAuditMessage(entry()));
  });
});

describe('审计脱敏链（logger sanitize 端到端，Key 形态零出现）', () => {
  it('含 sk- 形态的 URL 全量入审计后经 sanitize 零暴露', () => {
    const msg = formatAuditMessage(
      entry({ argsSummary: '{url:https://evil.example/?q=sk-proj-abcdefgh12345678}' }),
    );
    const safe = sanitize(msg);
    expect(safe).not.toMatch(/sk-proj/i);
    expect(safe).toContain('sk-***');
  });

  it('apiKey 键值对形态参数经 sanitize 后零暴露', () => {
    const msg = formatAuditMessage(
      entry({ argsSummary: '{apiKey:sk-ant-api03-ABCDEFGHIJKLMNOP}' }),
    );
    const safe = sanitize(msg);
    expect(safe).not.toMatch(/sk-ant/i);
    expect(safe).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('fill 参数摘要经全链路后原文零出现（len=N 形态保留）', () => {
    const argsSummary = summarizeArgs('browser.fill', { text: '机密输入值12345' });
    const msg = formatAuditMessage(entry({ argsSummary }));
    expect(msg).not.toContain('机密输入值12345');
    expect(sanitize(msg)).not.toContain('机密输入值12345');
  });

  it('审计条目不含错误堆栈形态（错误码归一为枚举值，无堆栈字段）', () => {
    const msg = formatAuditMessage(entry({ ok: false, errorCode: 'execution-failed' }));
    expect(msg).not.toContain('at ');
    expect(msg).not.toContain('Error:');
  });
});
