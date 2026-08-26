// D2 condition-engine tests: v1 确定性结构化条件校验与求值（detailed-design §5、
// threat-model §3.3；决策 13–19）。all/any、闭合 operator、字段目录、ASCII 十进制
// 数值边界、NFC/控制/bidi/空白折叠文本比较、非修改性。
import { describe, expect, it } from 'vitest';
import {
  CONDITION_ERROR_REASONS,
  evaluateStructuredCondition,
  type ConditionErrorCode,
  type StructuredChangeSet,
} from './condition-engine';

// 闭合字段目录（调用方提供；引擎不得信任目录外的任何 key）
const CATALOG = new Set(['price', 'stock', 'title', 'author', 'release', 'rank']);

function cond(over: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    combine: 'all',
    predicates: [{ fieldKey: 'price', operator: 'increased', operand: 100, caseSensitive: false }],
    ...over,
  };
}

function pred(over: Record<string, unknown>): Record<string, unknown> {
  return {
    fieldKey: 'price',
    operator: 'increased',
    operand: 100,
    caseSensitive: false,
    ...over,
  };
}

function changeSet(over: Record<string, unknown>): Record<string, unknown> {
  return {
    eventKind: 'changed',
    fields: [
      {
        fieldKey: 'price',
        before: { kind: 'present', value: 80 },
        after: { kind: 'present', value: 120 },
      },
    ],
    ...over,
  };
}

function evalInput(condition: unknown, cs: unknown) {
  return evaluateStructuredCondition({ condition, changeSet: cs, fieldCatalog: CATALOG });
}

describe('Condition 形状校验（exact own-key；决策 13/18/19）', () => {
  it('合法：1 条与 10 条 predicates、all/any', () => {
    const one = cond({ predicates: [pred({})] });
    expect(evalInput(one, changeSet({})).ok).toBe(true);
    const ten = cond({
      predicates: Array.from({ length: 10 }, () =>
        pred({ fieldKey: 'title', operator: 'changed', operand: null }),
      ),
    });
    expect(evalInput(ten, changeSet({})).ok).toBe(true);
    expect(evalInput(cond({ combine: 'any' }), changeSet({})).ok).toBe(true);
  });

  it('0 条与 11 条拒绝', () => {
    expect(evalInput(cond({ predicates: [] }), changeSet({})).ok).toBe(false);
    expect(
      evalInput(cond({ predicates: Array.from({ length: 11 }, () => pred({})) }), changeSet({})).ok,
    ).toBe(false);
  });

  it('未来版本 / 额外键 / 原型链字段拒绝', () => {
    expect(evalInput(cond({ version: 2 }), changeSet({})).ok).toBe(false);
    expect(evalInput(cond({ version: 0 }), changeSet({})).ok).toBe(false);
    expect(evalInput(cond({ extra: 1 }), changeSet({})).ok).toBe(false);
    expect(evalInput(cond({ combine: 'ALL' }), changeSet({})).ok).toBe(false);
    expect(evalInput(cond({ combine: 'all', predicates: pred({}) }), changeSet({})).ok).toBe(false);
    // 原型链字段：继承属性不视为自有键（仍因缺 predicates 而拒绝，且不抛）
    const protoCond = Object.create({ version: 1, combine: 'all', predicates: [] });
    expect(evalInput(protoCond, changeSet({})).ok).toBe(false);
  });

  it('嵌套（谓词内含 combine/predicates）拒绝', () => {
    const nested = cond({ predicates: [pred({ nested: { combine: 'all', predicates: [] } })] });
    expect(evalInput(nested, changeSet({})).ok).toBe(false);
    const nestedCombine = cond({ predicates: [pred({ combine: 'all' })] });
    expect(evalInput(nestedCombine, changeSet({})).ok).toBe(false);
  });

  it('predicate 额外键 / 缺键 / 错误类型拒绝', () => {
    expect(evalInput(cond({ predicates: [pred({ extra: 1 })] }), changeSet({})).ok).toBe(false);
    expect(
      evalInput(cond({ predicates: [{ fieldKey: 'price', operator: 'increased' }] }), changeSet({}))
        .ok,
    ).toBe(false);
    expect(
      evalInput(cond({ predicates: [pred({ caseSensitive: 'yes' })] }), changeSet({})).ok,
    ).toBe(false);
    expect(evalInput(cond({ predicates: ['nope'] }), changeSet({})).ok).toBe(false);
  });

  it('未知 operator / 未来 operator 拒绝', () => {
    expect(evalInput(cond({ predicates: [pred({ operator: 'regex' })] }), changeSet({})).ok).toBe(
      false,
    );
    expect(evalInput(cond({ predicates: [pred({ operator: 'equals' })] }), changeSet({})).ok).toBe(
      true,
    );
  });
});

describe('fieldKey 字段目录与危险键（决策 14）', () => {
  it('目录外字段拒绝（condition 与 changeSet 双面）', () => {
    expect(evalInput(cond({ predicates: [pred({ fieldKey: 'unknown' })] }), changeSet({})).ok).toBe(
      false,
    );
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'unknown',
          before: { kind: 'present', value: 1 },
          after: { kind: 'present', value: 2 },
        },
      ],
    });
    expect(evalInput(cond({}), cs).ok).toBe(false);
  });

  it('危险键拒绝：__proto__/prototype/constructor/通配符/数组索引/嵌套路径', () => {
    for (const key of [
      '__proto__',
      'prototype',
      'constructor',
      '*',
      'price*',
      '0',
      '12',
      'a.b',
      'a[0]',
      'a[b]',
      'a b',
      'constructor.prototype',
    ]) {
      expect(
        evalInput(cond({ predicates: [pred({ fieldKey: key })] }), changeSet({})).ok,
        `fieldKey=${key} 应拒绝`,
      ).toBe(false);
      const cs = changeSet({
        fields: [
          {
            fieldKey: key,
            before: { kind: 'present', value: 1 },
            after: { kind: 'present', value: 2 },
          },
        ],
      });
      expect(evalInput(cond({}), cs).ok, `changeSet fieldKey=${key} 应拒绝`).toBe(false);
    }
  });
});

describe('operand 数值形态（决策 15：规范 ASCII 十进制）', () => {
  it('数值 operator 拒绝 NaN/Infinity/指数/单位/locale/空', () => {
    const numericOps = ['increased', 'decreased', 'crosses-above', 'crosses-below'];
    for (const op of numericOps) {
      for (const operand of [Number.NaN, Number.POSITIVE_INFINITY, '1e3', '1,000', '10 USD', '']) {
        expect(
          evalInput(cond({ predicates: [pred({ operator: op, operand })] }), changeSet({})).ok,
          `op=${op} operand=${String(operand)} 应拒绝`,
        ).toBe(false);
      }
      expect(
        evalInput(cond({ predicates: [pred({ operator: op, operand: '100' })] }), changeSet({})).ok,
      ).toBe(true);
      expect(
        evalInput(cond({ predicates: [pred({ operator: op, operand: -12.5 })] }), changeSet({})).ok,
      ).toBe(true);
    }
  });

  it('changed 要求 operand 为 null；event-kind-is 要求合法事件种类', () => {
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'changed', operand: 1 })] }), changeSet({}))
        .ok,
    ).toBe(false);
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'changed', operand: null })] }), changeSet({}))
        .ok,
    ).toBe(true);
    expect(
      evalInput(
        cond({ predicates: [pred({ operator: 'event-kind-is', operand: 'bogus' })] }),
        changeSet({}),
      ).ok,
    ).toBe(false);
    expect(
      evalInput(
        cond({ predicates: [pred({ operator: 'event-kind-is', operand: 'added' })] }),
        changeSet({}),
      ).ok,
    ).toBe(true);
  });
});

describe('ChangeSet 形状校验（决策 17/18）', () => {
  it('事件种类非法 / 额外键 / 字段形状非法拒绝', () => {
    expect(evalInput(cond({}), changeSet({ eventKind: 'bogus' })).ok).toBe(false);
    expect(evalInput(cond({}), changeSet({ extra: 1 })).ok).toBe(false);
    expect(evalInput(cond({}), changeSet({ fields: [{ fieldKey: 'price' }] })).ok).toBe(false);
    expect(
      evalInput(cond({}), changeSet({ fields: [{ fieldKey: 'price', before: {}, after: {} }] })).ok,
    ).toBe(false);
  });

  it('before/after 值形状：present 需有限数值或字符串；absent 仅 kind', () => {
    const goodAbsent = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 100 },
        },
      ],
    });
    expect(evalInput(cond({}), goodAbsent).ok).toBe(true);
    const badValue = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: Number.NaN },
          after: { kind: 'present', value: 100 },
        },
      ],
    });
    expect(evalInput(cond({}), badValue).ok).toBe(false);
    const badAbsent = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'absent', value: 1 },
          after: { kind: 'present', value: 100 },
        },
      ],
    });
    expect(evalInput(cond({}), badAbsent).ok).toBe(false);
  });
});

describe('求值 — 无 Condition 等价全部匹配（决策 17）', () => {
  it('condition=null 且 ChangeSet 有效 → matched=true', () => {
    const r = evalInput(null, changeSet({}));
    expect(r).toEqual({ ok: true, matched: true });
  });

  it('condition=undefined 亦视为无 Condition', () => {
    expect(evalInput(undefined, changeSet({})).ok).toBe(true);
  });

  it('ChangeSet 非法时无 Condition 也 fail-closed', () => {
    const r = evalInput(null, changeSet({ eventKind: 'bogus' }));
    expect(r.ok).toBe(false);
  });
});

describe('求值 — all/any 与 operator 真/假', () => {
  it('increased：双侧数值 after>before', () => {
    expect(evalInput(cond({}), changeSet({})).ok).toBe(true);
    const r = evalInput(cond({}), changeSet({}));
    expect(r.ok && r.matched).toBe(true);
    // 下降 → increased 不匹配
    const down = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 120 },
          after: { kind: 'present', value: 80 },
        },
      ],
    });
    const rd = evalInput(cond({}), down);
    expect(rd.ok && rd.matched).toBe(false);
  });

  it('decreased / equals / not-equals', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'stock',
          before: { kind: 'present', value: 10 },
          after: { kind: 'present', value: 3 },
        },
      ],
    });
    expect(
      evalInput(cond({ predicates: [pred({ fieldKey: 'stock', operator: 'decreased' })] }), cs),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'stock', operator: 'equals', operand: 3 })] }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'stock', operator: 'not-equals', operand: 3 })] }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'stock', operator: 'equals', operand: 5 })] }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false });
  });

  it('crosses-above / crosses-below：阈值边界与双侧缺失', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 90 },
          after: { kind: 'present', value: 110 },
        },
      ],
    });
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'crosses-above', operand: 100 })] }), cs),
    ).toEqual({ ok: true, matched: true });
    // before == 阈值 90（≤100）+ after 110 > 100 → true
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'crosses-above', operand: 90 })] }), cs),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'crosses-above', operand: 95 })] }), cs),
    ).toEqual({ ok: true, matched: true });
    // after 不 > 阈值
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'crosses-above', operand: 120 })] }), cs),
    ).toEqual({ ok: true, matched: false });
    const down = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 110 },
          after: { kind: 'present', value: 90 },
        },
      ],
    });
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'crosses-below', operand: 100 })] }), down),
    ).toEqual({ ok: true, matched: true });
    // 双侧缺失不能冒充 0：before 缺失 → no-match
    const missingBefore = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 110 },
        },
      ],
    });
    expect(
      evalInput(
        cond({ predicates: [pred({ operator: 'crosses-above', operand: 100 })] }),
        missingBefore,
      ),
    ).toEqual({ ok: true, matched: false });
    const missingAfter = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 90 },
          after: { kind: 'absent' },
        },
      ],
    });
    expect(
      evalInput(
        cond({ predicates: [pred({ operator: 'crosses-below', operand: 100 })] }),
        missingAfter,
      ),
    ).toEqual({ ok: true, matched: false });
  });

  it('changed：值或存在性变化即匹配；等值不匹配', () => {
    const r = evalInput(
      cond({ predicates: [pred({ operator: 'changed', operand: null })] }),
      changeSet({}),
    );
    expect(r).toEqual({ ok: true, matched: true });
    const same = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 120 },
          after: { kind: 'present', value: 120 },
        },
      ],
    });
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'changed', operand: null })] }), same),
    ).toEqual({ ok: true, matched: false });
    const added = changeSet({
      fields: [
        {
          fieldKey: 'release',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 'v2' },
        },
      ],
    });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'release', operator: 'changed', operand: null })] }),
        added,
      ),
    ).toEqual({ ok: true, matched: true });
  });

  it('event-kind-is：整体事件种类匹配（不要求字段在场）', () => {
    const cs = changeSet({ eventKind: 'added' });
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'event-kind-is', operand: 'added' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'event-kind-is', operand: 'removed' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false });
  });

  it('字段不在 ChangeSet → 谓词 no-match（all/any 均如此）', () => {
    const cs = changeSet({});
    const p = pred({ fieldKey: 'title', operator: 'changed', operand: null });
    expect(evalInput(cond({ predicates: [p] }), cs)).toEqual({ ok: true, matched: false });
    expect(
      evalInput(
        cond({
          combine: 'any',
          predicates: [p],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false });
  });

  it('all 需全部匹配；any 至少一条', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 80 },
          after: { kind: 'present', value: 120 },
        },
        {
          fieldKey: 'title',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 'Release v2' },
        },
      ],
    });
    const r = evalInput(
      cond({
        predicates: [pred({}), pred({ fieldKey: 'title', operator: 'changed', operand: null })],
      }),
      cs,
    );
    expect(r).toEqual({ ok: true, matched: true });
    const r2 = evalInput(
      cond({
        predicates: [pred({}), pred({ fieldKey: 'title', operator: 'equals', operand: 'None' })],
      }),
      cs,
    );
    expect(r2).toEqual({ ok: true, matched: false }); // all：第二谓词不匹配
    const r3 = evalInput(
      cond({
        combine: 'any',
        predicates: [pred({}), pred({ fieldKey: 'title', operator: 'equals', operand: 'None' })],
      }),
      cs,
    );
    expect(r3).toEqual({ ok: true, matched: true }); // any：第一谓词匹配
  });
});

describe('求值 — 文本比较（决策 16：NFC/控制-bidi/空白折叠/线性字面）', () => {
  it('equals 文本：NFC 与空白折叠等价', () => {
    // 值用分解形式 'Re\u0301lease' + 多个空白；operand 用已组合 'Rélease v2'
    // 两侧 NFC 归一为同一字符串且空白折叠后相等。
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'title',
          before: { kind: 'absent' },
          after: { kind: 'present', value: '  Re\u0301lease   v2  ' },
        },
      ],
    });
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'equals', operand: 'Rélease v2' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({
          predicates: [
            pred({ fieldKey: 'title', operator: 'equals', operand: 'Re\u0301lease v2' }),
          ],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
  });

  it('caseSensitive=false 大小写不敏感；true 敏感', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'title',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 'Release V2' },
        },
      ],
    });
    expect(
      evalInput(
        cond({
          predicates: [
            pred({
              fieldKey: 'title',
              operator: 'equals',
              operand: 'release v2',
              caseSensitive: false,
            }),
          ],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({
          predicates: [
            pred({
              fieldKey: 'title',
              operator: 'equals',
              operand: 'release v2',
              caseSensitive: true,
            }),
          ],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false });
  });

  it('contains 线性字面匹配：regex-like 文本按字面', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'title',
          before: { kind: 'absent' },
          after: { kind: 'present', value: 'price: a+b*c' },
        },
      ],
    });
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'contains', operand: 'a+b*c' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'contains', operand: 'a.*b' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: false }); // 不是正则
    expect(
      evalInput(
        cond({
          predicates: [pred({ fieldKey: 'title', operator: 'not-contains', operand: 'a.*b' })],
        }),
        cs,
      ),
    ).toEqual({ ok: true, matched: true });
  });

  it('contains/not-contains 空 operand 校验拒绝；after 缺失 no-match', () => {
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'title', operator: 'contains', operand: '' })] }),
        changeSet({}),
      ).ok,
    ).toBe(false);
    const absent = changeSet({
      fields: [
        { fieldKey: 'title', before: { kind: 'present', value: 'x' }, after: { kind: 'absent' } },
      ],
    });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'title', operator: 'contains', operand: 'x' })] }),
        absent,
      ),
    ).toEqual({ ok: true, matched: false });
    expect(
      evalInput(
        cond({ predicates: [pred({ fieldKey: 'title', operator: 'equals', operand: 'x' })] }),
        absent,
      ),
    ).toEqual({ ok: true, matched: false });
  });
});

describe('求值 — 数值边界（决策 15）', () => {
  it('locale 数值 / 单位 / 指数字符串在 ChangeSet 值中不冒充数值', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: '1,000' },
          after: { kind: 'present', value: '2,000' },
        },
      ],
    });
    const r = evalInput(cond({}), cs);
    expect(r).toEqual({ ok: true, matched: false }); // increased 无法解析 → no-match
    const unit = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: '10 USD' },
          after: { kind: 'present', value: '20 USD' },
        },
      ],
    });
    expect(evalInput(cond({}), unit)).toEqual({ ok: true, matched: false });
    const exp = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: '1e3' },
          after: { kind: 'present', value: '2e3' },
        },
      ],
    });
    expect(evalInput(cond({}), exp)).toEqual({ ok: true, matched: false });
  });

  it('字符串规范 ASCII 十进制可解析为数值', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: '90' },
          after: { kind: 'present', value: '110' },
        },
      ],
    });
    expect(evalInput(cond({}), cs)).toEqual({ ok: true, matched: true });
  });

  it('数值 equals 支持字符串值与数字 operand 的规范比较', () => {
    const cs = changeSet({
      fields: [
        {
          fieldKey: 'price',
          before: { kind: 'present', value: 80 },
          after: { kind: 'present', value: '120' },
        },
      ],
    });
    expect(
      evalInput(cond({ predicates: [pred({ operator: 'equals', operand: 120 })] }), cs),
    ).toEqual({ ok: true, matched: true });
  });
});

describe('非修改性与深冻结输入', () => {
  it('condition/changeSet/目录深冻结后求值结果与未冻结一致', () => {
    function deepFreeze<T>(value: T): T {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const k of Object.getOwnPropertyNames(value)) {
          deepFreeze((value as Record<string, unknown>)[k]);
        }
      }
      return value;
    }
    const c = cond({});
    const cs = changeSet({});
    const frozenC = deepFreeze(JSON.parse(JSON.stringify(c)));
    const frozenCs = deepFreeze(JSON.parse(JSON.stringify(cs)));
    const frozenCat = new Set(CATALOG);
    const a = evaluateStructuredCondition({
      condition: c,
      changeSet: cs,
      fieldCatalog: CATALOG,
    });
    const b = evaluateStructuredCondition({
      condition: frozenC,
      changeSet: frozenCs,
      fieldCatalog: frozenCat,
    });
    expect(b).toEqual(a);
    // 冻结输入未被修改
    expect(frozenC).toEqual(c);
    expect(frozenCs).toEqual(cs);
  });

  it('错误原因映射为闭合安全中文（零敌手正文回显）', () => {
    const codes = [
      'condition-shape-invalid',
      'condition-version-future',
      'condition-combine-invalid',
      'condition-predicates-range',
      'predicate-shape-invalid',
      'predicate-field-key-invalid',
      'predicate-operator-invalid',
      'predicate-operand-invalid',
      'predicate-case-invalid',
      'change-set-shape-invalid',
      'change-set-event-kind-invalid',
      'change-field-shape-invalid',
      'change-field-key-invalid',
      'change-value-invalid',
    ] as const;
    for (const code of codes) {
      expect(typeof CONDITION_ERROR_REASONS[code]).toBe('string');
      expect(CONDITION_ERROR_REASONS[code].length).toBeGreaterThan(0);
      expect(CONDITION_ERROR_REASONS[code].length).toBeLessThanOrEqual(200);
    }
    // 闭合键集合自检
    expect(Object.keys(CONDITION_ERROR_REASONS).sort()).toEqual([...codes].sort());
  });

  it('返回的 ok=false reason 是闭合 code', () => {
    const r = evalInput(cond({ version: 9 }), changeSet({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((CONDITION_ERROR_REASONS as Record<string, string>)[r.reason]).toBeDefined();
    }
  });
});

describe('evaluateStructuredCondition 返回类型闭合', () => {
  it('changeSet 事件种类类型别名与 §9.4 一致', () => {
    const cs: StructuredChangeSet = {
      eventKind: 'reversal',
      fields: [
        {
          fieldKey: 'title',
          before: { kind: 'present', value: 'v2' },
          after: { kind: 'present', value: 'v1' },
        },
      ],
    };
    const r = evaluateStructuredCondition({
      condition: null,
      changeSet: cs,
      fieldCatalog: CATALOG,
    });
    expect(r).toEqual({ ok: true, matched: true });
    expect((cs.fields[0]?.before as { value: string }).value).toBe('v2');
  });

  it('ConditionErrorCode 全部枚举在类型层可用（闭合 code 编译期自检）', () => {
    const code: ConditionErrorCode = 'predicate-field-key-invalid';
    expect(code).toBe('predicate-field-key-invalid');
  });
});

describe('敌手安全 — accessor/Proxy 探针（own-data-property；getter 零执行）', () => {
  // 把 base 的某个键改写为 getter accessor，返回探针对象与执行计数读取器。
  function withAccessor(
    base: Record<string, unknown>,
    key: string,
  ): { obj: Record<string, unknown>; executed: () => number } {
    let count = 0;
    const obj = { ...base };
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get() {
        count += 1;
        return undefined;
      },
    });
    return { obj, executed: () => count };
  }

  it('condition：version/combine/predicates accessor getter 零执行 → condition-shape-invalid', () => {
    for (const key of ['version', 'combine', 'predicates']) {
      const { obj, executed } = withAccessor(cond({}), key);
      const r = evalInput(obj, changeSet({}));
      expect(r, `key=${key}`).toEqual({ ok: false, reason: 'condition-shape-invalid' });
      expect(executed()).toBe(0);
    }
  });

  it('predicate：fieldKey/operator/caseSensitive/operand accessor getter 零执行 → predicate-shape-invalid', () => {
    for (const key of ['fieldKey', 'operator', 'caseSensitive', 'operand']) {
      const { obj, executed } = withAccessor(pred({}), key);
      const r = evalInput(cond({ predicates: [obj] }), changeSet({}));
      expect(r, `key=${key}`).toEqual({ ok: false, reason: 'predicate-shape-invalid' });
      expect(executed()).toBe(0);
    }
  });

  it('changeSet：eventKind/fields accessor getter 零执行 → change-set-shape-invalid', () => {
    for (const key of ['eventKind', 'fields']) {
      const { obj, executed } = withAccessor(changeSet({}), key);
      const r = evalInput(cond({}), obj);
      expect(r, `key=${key}`).toEqual({ ok: false, reason: 'change-set-shape-invalid' });
      expect(executed()).toBe(0);
    }
  });

  it('changeField：fieldKey/before/after accessor getter 零执行 → change-field-shape-invalid', () => {
    const fieldBase = {
      fieldKey: 'price',
      before: { kind: 'present', value: 80 },
      after: { kind: 'present', value: 120 },
    };
    for (const key of ['fieldKey', 'before', 'after']) {
      const { obj, executed } = withAccessor(fieldBase, key);
      const r = evalInput(cond({}), changeSet({ fields: [obj] }));
      expect(r, `key=${key}`).toEqual({ ok: false, reason: 'change-field-shape-invalid' });
      expect(executed()).toBe(0);
    }
  });

  it('present value：kind/value accessor getter 零执行 → change-value-invalid', () => {
    const presentBase = { kind: 'present', value: 100 };
    for (const key of ['kind', 'value']) {
      const { obj, executed } = withAccessor(presentBase, key);
      const field = {
        fieldKey: 'price',
        before: obj,
        after: { kind: 'present', value: 120 },
      };
      const r = evalInput(cond({}), changeSet({ fields: [field] }));
      expect(r, `key=${key}`).toEqual({ ok: false, reason: 'change-value-invalid' });
      expect(executed()).toBe(0);
    }
  });

  it('Proxy ownKeys/getOwnPropertyDescriptor/get trap 抛错：不抛穿，返回闭合错误', () => {
    // condition 侧：ownKeys / getOwnPropertyDescriptor / get trap 抛错均不抛穿
    const ownKeysEvil = new Proxy(cond({}), {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(() => evalInput(ownKeysEvil, changeSet({}))).not.toThrow();
    const gopdEvil = new Proxy(cond({}), {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    });
    expect(() => evalInput(gopdEvil, changeSet({}))).not.toThrow();
    const getEvil = new Proxy(cond({}), {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => evalInput(getEvil, changeSet({}))).not.toThrow();
    expect(evalInput(getEvil, changeSet({})).ok).toBe(true);
    // changeSet 侧：ownKeys / getOwnPropertyDescriptor trap 抛错均不抛穿
    const csOwnKeys = new Proxy(changeSet({}), {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(() => evalInput(cond({}), csOwnKeys)).not.toThrow();
    const csGopd = new Proxy(changeSet({}), {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    });
    expect(() => evalInput(cond({}), csGopd)).not.toThrow();
  });

  it('普通 JSON.parse 对象继续通过', () => {
    const c = JSON.parse(JSON.stringify(cond({}))) as Record<string, unknown>;
    const cs = JSON.parse(JSON.stringify(changeSet({}))) as Record<string, unknown>;
    expect(evalInput(c, cs)).toEqual({ ok: true, matched: true });
  });
});
