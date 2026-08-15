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
  SOURCE_ARGS_SUMMARY_MAX,
  type AuditEntry,
} from './audit-log';
import { sanitize } from '../logger';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    requestId: 'req-1',
    toolCallId: 'call-1',
    tool: 'browser_click',
    argsSummary: '{elementId:el-12}',
    decision: 'confirmed',
    ok: true,
    errorCode: null,
    durationMs: 23,
    ...overrides,
  };
}

describe('summarizeArgs 参数摘要（确定性 + 脱敏）', () => {
  it('browser_fill 的 text 只记录 len=N，原文零出现（含 Key 形态值）', () => {
    const out = summarizeArgs('browser_fill', {
      elementId: 'el-1',
      text: '我的密码是sk-secret-12345678',
    });
    expect(out).toContain('text=len:');
    expect(out).not.toContain('我的密码');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('elementId:el-1');
  });

  it('非字符串 text 防御性处理（len 按字符串化长度）', () => {
    expect(summarizeArgs('browser_fill', { text: 42 })).toContain('text=len:2');
  });

  it('URL 参数全量记录（审计可追溯），超 200 字符不截断', () => {
    const longUrl = 'https://example.com/search?q=' + 'x'.repeat(260);
    const out = summarizeArgs('browser_open', { url: longUrl });
    expect(out).toContain(longUrl);
  });

  it('其余参数确定性截断 ≤ ARGS_SUMMARY_MAX 并带截断标记', () => {
    const out = summarizeArgs('browser_find', { text: 'x'.repeat(600) });
    expect(out).toContain('…[已截断]');
    const value = out.slice(out.indexOf('text:') + 'text:'.length, out.indexOf('}'));
    expect(value.length).toBeLessThanOrEqual(ARGS_SUMMARY_MAX + '…[已截断]'.length);
  });

  it('search_web 查询串全量记录（T-03 外发审查可追溯，决议 #32；校验上限 500 有界）', () => {
    const query = 'x'.repeat(500);
    const out = summarizeArgs('search_web', { query });
    expect(out).toContain(query);
    expect(out).not.toContain('…[已截断]');
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
    expect(summarizeArgs('browser_get_tabs', {})).toBe('{}');
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
      'tool-call（requestId=req-1，toolCallId=call-1，tool=browser_click，args={elementId:el-12}，decision=confirmed，ok=true，耗时=23ms，errorCode=无）',
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
    const argsSummary = summarizeArgs('browser_fill', { text: '机密输入值12345' });
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

// —— B4 决议 #67：Source 工具审计摘要（note 零出现/URL query 值脱敏/幂等键由执行器追加）——
describe('summarizeArgs — Source 工具（B4 决议 #67 隐私边界）', () => {
  it('source_apply_changes：ops 计数/字段名/长度/版本确定性摘要；note 正文零出现', () => {
    const args = {
      ops: [
        {
          kind: 'add',
          scope: 'page',
          url: 'https://example.com/new?token=TOKEN_SECRET_VALUE',
          name: '新站',
          userNote: 'PRIVATE_NOTE_BODY_12345',
          trust: { value: 'unknown', assertedBy: 'ai' },
        },
        {
          kind: 'update',
          sourceId: '11111111-1111-4111-8111-111111111111',
          expectedVersion: 2,
          patch: { name: '改名', aiNote: 'SECOND_PRIVATE_NOTE' },
        },
      ],
    };
    const summary = summarizeArgs('source_apply_changes', args);
    expect(summary).toMatch(/ops=2 add=1 update=1 disable=0 restore=0/);
    expect(summary).toContain('fields=[');
    expect(summary).toContain('lens=[');
    expect(summary).toContain('versions=[2]');
    expect(summary).not.toContain('PRIVATE_NOTE_BODY_12345');
    expect(summary).not.toContain('SECOND_PRIVATE_NOTE');
    expect(summary).not.toContain('TOKEN_SECRET_VALUE');
    expect(summary).not.toContain('token=');
    expect(summary.length).toBeLessThanOrEqual(SOURCE_ARGS_SUMMARY_MAX);
  });

  it('source_search：普通查询全量（≤500）；URL 形态查询的 query 值脱敏', () => {
    expect(summarizeArgs('source_search', { query: '大模型 benchmark' })).toBe(
      '{query:大模型 benchmark}',
    );
    const urlQuery = summarizeArgs('source_search', {
      query: 'https://example.com/deep/path?token=SECRET_123&key=sk-live-abc',
    });
    expect(urlQuery).toContain('https://example.com/deep/path');
    expect(urlQuery).toContain('已脱敏');
    expect(urlQuery).not.toContain('SECRET_123');
    expect(urlQuery).not.toContain('sk-live-abc');
    expect(urlQuery).not.toContain('token=');
  });

  it('source_list/get：分页参数与 id 正常记录（无敏感形态）', () => {
    expect(summarizeArgs('source_list', { page: 0, pageSize: 20 })).toBe('{page:0，pageSize:20}');
    expect(summarizeArgs('source_get', { sourceId: '11111111-1111-4111-8111-111111111111' })).toBe(
      '{sourceId:11111111-1111-4111-8111-111111111111}',
    );
  });
});
