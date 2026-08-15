// ToolRegistry 校验矩阵测试（红→绿，A2）。契约源：doc/stage3/detailed-design.md §4.1/§4.2。
// 校验器确定性：JSON.parse 失败/未知工具/缺必填/类型/enum/未知键/长度上限/tabId、
// elementId 格式 → {ok:false, reason}；任何非法输入不抛异常（越界安全返回）。
// listTools 只从程序注册表生成模型可见 schema，输出顺序与序列化结果确定、可测试。
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from './tool-types';
import {
  getTool,
  listTools,
  registerTool,
  resetToolRegistry,
  TOOL_NAME_PATTERN,
  validateToolArgs,
  VALIDATION_LIMITS,
} from './tool-registry';

function makeDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_echo',
    description: '测试工具：回显参数',
    parameters: {
      properties: {
        text: { type: 'string' },
        count: { type: 'number' },
        flag: { type: 'boolean' },
      },
      required: ['text'],
    },
    baseRisk: 0,
    executor: async ({ id }) => ({ toolCallId: id, ok: true, content: '' }),
    ...overrides,
  };
}

describe('工具注册表', () => {
  beforeEach(() => resetToolRegistry());

  it('重复注册同名工具确定性拒绝（抛出中文错误，装配期失败）', () => {
    registerTool(makeDef());
    expect(() => registerTool(makeDef())).toThrow(/重复注册/);
    expect(() => registerTool(makeDef())).toThrow('test_echo');
  });

  it('getTool：已注册返回定义、未注册返回 null', () => {
    registerTool(makeDef({ name: 'browser_get_tabs' }));
    expect(getTool('browser_get_tabs')?.name).toBe('browser_get_tabs');
    expect(getTool('no_such_tool')).toBeNull();
  });

  it('listTools 只从注册表生成模型可见 schema（executor 不进输出）', () => {
    registerTool(makeDef({ name: 'test_echo', description: '回显' }));
    const listed = listTools();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      type: 'function',
      function: {
        name: 'test_echo',
        description: '回显',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            count: { type: 'number' },
            flag: { type: 'boolean' },
          },
          required: ['text'],
        },
      },
    });
    expect(JSON.stringify(listed)).not.toContain('executor');
  });

  it('listTools 输出顺序确定（按工具名排序）且重复调用恒等', () => {
    registerTool(makeDef({ name: 'browser_zzz' }));
    registerTool(makeDef({ name: 'browser_aaa' }));
    registerTool(makeDef({ name: 'browser_mmm' }));
    const first = listTools();
    const second = listTools();
    expect(first.map((t) => t.function.name)).toEqual([
      'browser_aaa',
      'browser_mmm',
      'browser_zzz',
    ]);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('listTools 返回新对象：外部修改不影响注册表（模型/调用方无写入通道）', () => {
    registerTool(makeDef());
    const listed = listTools();
    const first = listed[0];
    if (first !== undefined) {
      first.function.name = '被篡改';
      first.function.description = '被篡改';
    }
    const relisted = listTools();
    expect(relisted[0]?.function.name).toBe('test_echo');
    expect(relisted[0]?.function.description).toBe('测试工具：回显参数');
  });
});

describe('validateToolArgs 校验矩阵', () => {
  beforeEach(() => {
    resetToolRegistry();
    registerTool(makeDef());
    registerTool(
      makeDef({
        name: 'browser_open',
        description: '',
        parameters: { properties: { url: { type: 'string' } }, required: ['url'] },
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_read',
        description: '',
        parameters: { properties: { tabId: { type: 'string' } }, required: [] },
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_click',
        description: '',
        parameters: {
          properties: { elementId: { type: 'string' }, tabId: { type: 'string' } },
          required: ['elementId'],
        },
      }),
    );
    registerTool(
      makeDef({
        name: 'test_enum',
        description: '',
        parameters: {
          properties: {
            mode: { type: 'string', enum: ['a', 'b'] },
            n: { type: 'number', enum: [1, 2] },
          },
          required: [],
        },
      }),
    );
  });

  it('未知工具 → ok:false（reason 含中文说明）', () => {
    const r = validateToolArgs('no_such_tool', '{}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未知工具');
  });

  it('JSON.parse 失败 / 非对象 / 数组 / 数字 / 字符串 / null → ok:false 不抛异常', () => {
    for (const raw of ['{', 'not json', '', 'null', '42', '"text"', '[]', '{"text":']) {
      expect(validateToolArgs('test_echo', raw).ok, raw).toBe(false);
    }
  });

  it('缺少必填参数 → ok:false（reason 指名参数）', () => {
    expect(validateToolArgs('test_echo', '{"count":1}')).toEqual({
      ok: false,
      reason: '缺少必填参数：text',
    });
    expect(validateToolArgs('browser_open', '{}').ok).toBe(false);
    expect(validateToolArgs('browser_click', '{"tabId":"a"}').ok).toBe(false);
  });

  it('未知键拒绝（模型不能注入 schema 外参数）', () => {
    const r = validateToolArgs('test_echo', '{"text":"a","extra":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未知参数：extra');
  });

  it('类型不符（string/number/boolean 逐一，含 null）→ ok:false', () => {
    expect(validateToolArgs('test_echo', '{"text":123}').ok).toBe(false);
    expect(validateToolArgs('test_echo', '{"text":"a","count":"5"}').ok).toBe(false);
    expect(validateToolArgs('test_echo', '{"text":"a","flag":1}').ok).toBe(false);
    expect(validateToolArgs('test_echo', '{"text":"a","count":null}').ok).toBe(false);
    expect(validateToolArgs('test_echo', '{"text":"a","flag":"true"}').ok).toBe(false);
  });

  it('enum 越界 → ok:false；合法枚举值（含数字枚举）→ ok:true', () => {
    expect(validateToolArgs('test_enum', '{"mode":"c"}').ok).toBe(false);
    expect(validateToolArgs('test_enum', '{"n":3}').ok).toBe(false);
    expect(validateToolArgs('test_enum', '{"mode":"b"}').ok).toBe(true);
    expect(validateToolArgs('test_enum', '{"n":2}').ok).toBe(true);
    expect(validateToolArgs('test_enum', '{"mode":"a","n":1}').ok).toBe(true);
  });

  it('字符串长度上限：普通参数 500、url 参数 2048（上限本身合法，超一字符拒绝）', () => {
    const ok500 = 'a'.repeat(VALIDATION_LIMITS.stringMax);
    const okUrl = 'https://example.com/' + 'a'.repeat(VALIDATION_LIMITS.urlMax - 20);
    expect(validateToolArgs('test_echo', JSON.stringify({ text: ok500 })).ok).toBe(true);
    expect(validateToolArgs('test_echo', JSON.stringify({ text: ok500 + 'x' })).ok).toBe(false);
    expect(validateToolArgs('browser_open', JSON.stringify({ url: okUrl })).ok).toBe(true);
    expect(validateToolArgs('browser_open', JSON.stringify({ url: okUrl + 'x' })).ok).toBe(false);
  });

  it('tabId 必须为 UUID 形状（大小写不敏感）', () => {
    const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect(validateToolArgs('browser_read', JSON.stringify({ tabId: uuid })).ok).toBe(true);
    expect(validateToolArgs('browser_read', JSON.stringify({ tabId: uuid.toUpperCase() })).ok).toBe(
      true,
    );
    for (const bad of [
      'abc',
      '12345678-1234-1234-1234-12345678901g',
      `${uuid}x`,
      '',
      'not-a-uuid',
    ]) {
      expect(validateToolArgs('browser_read', JSON.stringify({ tabId: bad })).ok, bad).toBe(false);
    }
  });

  it('elementId 必须为 el-N 形状（N 为 1–10 位十进制整数）', () => {
    expect(validateToolArgs('browser_click', JSON.stringify({ elementId: 'el-1' })).ok).toBe(true);
    expect(
      validateToolArgs('browser_click', JSON.stringify({ elementId: 'el-0123456789' })).ok,
    ).toBe(true);
    for (const bad of ['el-', 'el-x', 'el-1.5', 'el-01234567890', 'EL-1', '1', 'el--1', 'el- 1']) {
      expect(validateToolArgs('browser_click', JSON.stringify({ elementId: bad })).ok, bad).toBe(
        false,
      );
    }
  });

  it('合法输入 → ok:true 且 args 解析正确', () => {
    const r = validateToolArgs('test_echo', '{"text":"你好","count":3,"flag":true}');
    expect(r).toEqual({ ok: true, args: { text: '你好', count: 3, flag: true } });
  });

  it('可选参数缺省 OK（read 无参数、click 缺 tabId）', () => {
    expect(validateToolArgs('browser_read', '{}').ok).toBe(true);
    expect(validateToolArgs('browser_click', '{"elementId":"el-1"}').ok).toBe(true);
  });

  it('任意垃圾输入不抛异常（越界安全返回）', () => {
    const garbage = [
      '{',
      '',
      'null',
      '{"text":1}',
      '{"a":"b"}',
      '[]',
      ' ',
      '{"text":"' + 'x'.repeat(100000) + '"}',
    ];
    for (const raw of garbage) {
      expect(() => validateToolArgs('test_echo', raw)).not.toThrow();
      expect(() => validateToolArgs('browser_open', raw)).not.toThrow();
      expect(() => validateToolArgs('不存在的工具', raw)).not.toThrow();
    }
  });
});

describe('A3 参数规则扩展（paramRules：长度/非空/整数/数值范围，交互工具）', () => {
  beforeEach(() => {
    resetToolRegistry();
  });

  function makeInteractionDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
    return makeDef({
      name: 'browser_scroll',
      parameters: {
        properties: { dy: { type: 'number' } },
        required: ['dy'],
      },
      paramRules: { dy: { integer: true, min: -50000, max: 50000 } },
      ...overrides,
    });
  }

  it('dy 整数与 ±50000 边界通过；越界/非整数 → 安全拒绝', () => {
    registerTool(makeInteractionDef());
    expect(validateToolArgs('browser_scroll', '{"dy":0}').ok).toBe(true);
    expect(validateToolArgs('browser_scroll', '{"dy":-50000}').ok).toBe(true);
    expect(validateToolArgs('browser_scroll', '{"dy":50000}').ok).toBe(true);
    for (const bad of [50001, -50001, 0.5, -0.1]) {
      const r = validateToolArgs('browser_scroll', JSON.stringify({ dy: bad }));
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toContain('dy');
    }
  });

  it('paramRules.maxLength 优先于全局上限（find text ≤200 / fill text ≤2000 可共存于同名字段）', () => {
    registerTool(
      makeDef({
        name: 'browser_find',
        parameters: { properties: { text: { type: 'string' } }, required: ['text'] },
        paramRules: { text: { maxLength: 200, nonEmpty: true } },
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_fill',
        parameters: { properties: { text: { type: 'string' } }, required: ['text'] },
        paramRules: { text: { maxLength: 2000 } },
      }),
    );
    expect(validateToolArgs('browser_find', JSON.stringify({ text: 'x'.repeat(200) })).ok).toBe(
      true,
    );
    expect(validateToolArgs('browser_find', JSON.stringify({ text: 'x'.repeat(201) })).ok).toBe(
      false,
    );
    expect(validateToolArgs('browser_fill', JSON.stringify({ text: 'x'.repeat(2000) })).ok).toBe(
      true,
    );
    expect(validateToolArgs('browser_fill', JSON.stringify({ text: 'x'.repeat(2001) })).ok).toBe(
      false,
    );
  });

  it('nonEmpty：空串与纯空白 → 拒绝；无规则工具不受影响', () => {
    registerTool(
      makeDef({
        name: 'browser_find',
        parameters: { properties: { text: { type: 'string' } }, required: ['text'] },
        paramRules: { text: { nonEmpty: true } },
      }),
    );
    for (const text of ['', '   ', '\n\t']) {
      const r = validateToolArgs('browser_find', JSON.stringify({ text }));
      expect(r.ok).toBe(false);
    }
    registerTool(makeDef({ name: 'test_echo2' }));
    expect(validateToolArgs('test_echo2', JSON.stringify({ text: '' })).ok).toBe(true);
  });

  it('paramRules 非法输入（超长字符串仍走 maxLength；数字规则不适用于字符串）安全返回不抛异常', () => {
    registerTool(makeInteractionDef());
    const r = validateToolArgs('browser_scroll', JSON.stringify({ dy: '100' }));
    expect(r.ok).toBe(false);
    expect(() => validateToolArgs('browser_scroll', 'not json')).not.toThrow();
  });
});

describe('wire 名称契约（A7 补验校准：Provider 侧 function.name 仅允许字母/数字/下划线/连字符 ≤64）', () => {
  beforeEach(() => resetToolRegistry());

  it('TOOL_NAME_PATTERN 与 wire 契约一致（1–64 位，拒绝点号/空白/非 ASCII/超长）', () => {
    expect(TOOL_NAME_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,64}$');
    for (const ok of ['a', 'A1_b-2', 'browser_get_tabs', 'search_web', 'x'.repeat(64)]) {
      expect(TOOL_NAME_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['', 'a.b', 'x'.repeat(65), '中文工具', 'a b', 'a/b', 'tool.name']) {
      expect(TOOL_NAME_PATTERN.test(bad)).toBe(false);
    }
  });

  it('注册阶段确定性拒绝违反 wire 名称契约的工具名（点号/超长/空/非 ASCII），合法名可注册', () => {
    expect(() => registerTool(makeDef({ name: 'test.echo' }))).toThrow(/工具名.*wire|wire.*工具名/);
    expect(() => registerTool(makeDef({ name: 'x'.repeat(65) }))).toThrow();
    expect(() => registerTool(makeDef({ name: '' }))).toThrow();
    expect(() => registerTool(makeDef({ name: '中文工具' }))).toThrow();
    expect(() => registerTool(makeDef({ name: 'valid-name_123' }))).not.toThrow();
  });

  it('listTools 序列化阶段纵深防御：全部输出名符合 wire 契约（防未来再向 Provider 发非法名）', () => {
    registerTool(makeDef({ name: 'test_echo' }));
    registerTool(makeDef({ name: 'browser_get_tabs' }));
    const listed = listTools();
    expect(listed).toHaveLength(2);
    for (const tool of listed) {
      expect(tool.function.name).toMatch(TOOL_NAME_PATTERN);
    }
  });
});

// —— B4 决议 #64：递归 object/array schema（ProviderToolParameter 最小递归扩展）——
describe('工具注册表 — 递归 object/array schema（B4 决议 #64）', () => {
  beforeEach(() => resetToolRegistry());

  const nestedDef = (overrides: Partial<ToolDefinition> = {}): ToolDefinition =>
    makeDef({
      name: 'nested_probe',
      parameters: {
        properties: {
          config: {
            type: 'object',
            properties: {
              level: { type: 'number', enum: [1, 2] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['level'],
          },
          rows: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
          },
        },
        required: ['config'],
      },
      ...overrides,
    });

  it('嵌套 object/array 合法值通过；基础类型行为零变化（既有用例语义不变）', () => {
    registerTool(nestedDef());
    expect(
      validateToolArgs('nested_probe', JSON.stringify({ config: { level: 1, tags: ['a'] } })).ok,
    ).toBe(true);
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: { level: 2 } })).ok).toBe(
      true,
    );
    expect(
      validateToolArgs(
        'nested_probe',
        JSON.stringify({ config: { level: 2 }, rows: [{ id: 'x' }] }),
      ).ok,
    ).toBe(true);
  });

  it('嵌套 unknown 字段拒绝（additionalProperties=false，与顶层同语义）', () => {
    registerTool(nestedDef());
    expect(
      validateToolArgs('nested_probe', JSON.stringify({ config: { level: 1, evil: true } })).ok,
    ).toBe(false);
    expect(
      validateToolArgs(
        'nested_probe',
        JSON.stringify({ config: { level: 1 }, rows: [{ id: 'x', extra: 1 }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateToolArgs(
        'nested_probe',
        JSON.stringify({ config: { level: 1, tags: ['a'] }, unknownTop: 1 }),
      ).ok,
    ).toBe(false);
  });

  it('嵌套 required/类型/enum 校验；非对象/非数组形状拒绝', () => {
    registerTool(nestedDef());
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: {} })).ok).toBe(false);
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: { level: 3 } })).ok).toBe(
      false,
    );
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: { level: '1' } })).ok).toBe(
      false,
    );
    expect(
      validateToolArgs('nested_probe', JSON.stringify({ config: { level: 1, tags: [1] } })).ok,
    ).toBe(false);
    expect(
      validateToolArgs('nested_probe', JSON.stringify({ config: { level: 1, tags: 'x' } })).ok,
    ).toBe(false);
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: null })).ok).toBe(false);
    expect(validateToolArgs('nested_probe', JSON.stringify({ config: [] })).ok).toBe(false);
  });

  it('数组上限：缺省 20、maxItems 可定制、逐项校验', () => {
    registerTool(nestedDef());
    expect(
      validateToolArgs(
        'nested_probe',
        JSON.stringify({ config: { level: 1, tags: Array(20).fill('x') } }),
      ).ok,
    ).toBe(true);
    expect(
      validateToolArgs(
        'nested_probe',
        JSON.stringify({ config: { level: 1, tags: Array(21).fill('x') } }),
      ).ok,
    ).toBe(false);
    registerTool(
      makeDef({
        name: 'capped_array',
        parameters: {
          properties: {
            items: { type: 'array', maxItems: 2, items: { type: 'number' } },
          },
          required: [],
        },
      }),
    );
    expect(validateToolArgs('capped_array', '{"items":[1,2]}').ok).toBe(true);
    expect(validateToolArgs('capped_array', '{"items":[1,2,3]}').ok).toBe(false);
    expect(validateToolArgs('capped_array', '{"items":["a"]}').ok).toBe(false);
  });

  it('嵌套深度上限防御：超出深度确定性拒绝、安全返回不抛异常', () => {
    registerTool(
      makeDef({
        name: 'deep_probe',
        parameters: {
          properties: {
            root: {
              type: 'object',
              properties: {
                a: {
                  type: 'object',
                  properties: {
                    b: {
                      type: 'object',
                      properties: {
                        c: {
                          type: 'object',
                          properties: {
                            d: {
                              type: 'object',
                              properties: { e: { type: 'string' } },
                              required: [],
                            },
                          },
                          required: [],
                        },
                      },
                      required: [],
                    },
                  },
                  required: [],
                },
              },
              required: [],
            },
          },
          required: [],
        },
      }),
    );
    const deepOk = { root: { a: { b: { c: { d: { e: 'x' } } } } } };
    // root(0) → a(1) → b(2) → c(3) → d(4) → e(5)：超过深度上限 4 → 拒绝
    expect(validateToolArgs('deep_probe', JSON.stringify(deepOk)).ok).toBe(false);
    const okValue = { root: { a: { b: { c: { d: { e: 1 } } } } } };
    void okValue;
    // 深度上限内形态（root → a → b → c 共 4 层容器内）安全返回
    const shallow = { root: { a: { b: { c: 'x' } } } };
    const res = validateToolArgs('deep_probe', JSON.stringify(shallow));
    expect(typeof res.ok).toBe('boolean'); // 非法深度安全返回（不抛异常）
  });

  it('listTools 序列化：嵌套 schema 原样透传（含 properties/items/enum）；基础工具序列化零变化', () => {
    registerTool(nestedDef());
    registerTool(makeDef({ name: 'test_echo' }));
    const listed = listTools();
    const nested = listed.find((t) => t.function.name === 'nested_probe');
    expect(nested?.function.parameters.properties['config']).toEqual({
      type: 'object',
      properties: {
        level: { type: 'number', enum: [1, 2] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['level'],
    });
    const basic = listed.find((t) => t.function.name === 'test_echo');
    expect(basic?.function.parameters.properties['text']).toEqual({ type: 'string' });
  });
});
