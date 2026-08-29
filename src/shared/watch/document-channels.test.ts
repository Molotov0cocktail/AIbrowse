// D6 document-channels: DocumentChannels 严格验证器红态/绿态（detailed-design
// §3.2/§8、FIXED DECISIONS 6）。敌手矩阵：原型链键、getter/proxy、稀疏数组、
// symbol、未知字段、非法 level、非字符串、超预算。== 接受、+1 fail-closed。
import { describe, expect, it } from 'vitest';
import { validateDocumentChannels } from './document-channels';
import type { DocumentChannels } from '../types/watch';
import { MAX_PAGE_PROJECTION_BYTES } from '../types/watch';

function validChannels(overrides: Partial<DocumentChannels> = {}): DocumentChannels {
  return {
    mainText: '正文内容',
    headings: [
      { level: 1, text: '主标题' },
      { level: 2, text: '二级标题' },
      { level: 3, text: '三级标题' },
    ],
    tables: [
      {
        headers: ['名称', '价格'],
        rows: [
          ['甲', '100'],
          ['乙', '200'],
        ],
      },
    ],
    links: [
      { text: '示例', url: 'https://example.com/a' },
      { text: '跨域', url: 'https://other.example/b' },
    ],
    ...overrides,
  };
}

describe('validateDocumentChannels — 结构与形状', () => {
  it('合法通道通过并深拷贝返回', () => {
    const r = validateDocumentChannels(validChannels());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(r.channels.tables[0]!.headers).toEqual(['名称', '价格']);
  });

  it('非 plain object / null / 数组拒绝', () => {
    for (const raw of [null, undefined, 42, 'str', [], new Date()]) {
      expect(validateDocumentChannels(raw).ok).toBe(false);
    }
  });

  it('外层未知键 / 缺失键 / symbol 键拒绝', () => {
    const extra = validChannels() as unknown as Record<string, unknown>;
    extra['evil'] = 'x';
    expect(validateDocumentChannels(extra).ok).toBe(false);
    const { mainText, ...missing } = validChannels();
    void mainText;
    expect(validateDocumentChannels(missing).ok).toBe(false);
    const sym = validChannels() as unknown as Record<symbol | string, unknown>;
    sym[Symbol('s')] = 'x';
    expect(validateDocumentChannels(sym).ok).toBe(false);
  });

  it('原型链 inherited 字段不通过（plain object 检查）', () => {
    const proto = { mainText: '原型正文', headings: [], tables: [], links: [] };
    const obj = Object.create(proto);
    expect(validateDocumentChannels(obj).ok).toBe(false);
  });

  it('getter 属性（访问器）拒绝，零副作用调用', () => {
    let getterCalls = 0;
    const raw = validChannels() as unknown as Record<string, unknown> & { mainText: string };
    Object.defineProperty(raw, 'mainText', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return 'getter 正文';
      },
    });
    const r = validateDocumentChannels(raw);
    expect(r.ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('setter 属性拒绝', () => {
    const raw = validChannels() as unknown as Record<string, unknown> & { mainText: string };
    Object.defineProperty(raw, 'mainText', {
      enumerable: true,
      configurable: true,
      set: () => {
        // 仅访问器存在即拒绝
      },
    });
    expect(validateDocumentChannels(raw).ok).toBe(false);
  });

  it('非字符串字段拒绝', () => {
    expect(validateDocumentChannels(validChannels({ mainText: 42 as unknown as string })).ok).toBe(
      false,
    );
    expect(
      validateDocumentChannels(
        validChannels({ headings: [{ level: 1, text: 7 as unknown as string }] }),
      ).ok,
    ).toBe(false);
    expect(validateDocumentChannels(validChannels({ links: [{ text: 'a' } as never] })).ok).toBe(
      false,
    );
  });
});

describe('validateDocumentChannels — 数组敌手矩阵', () => {
  it('稀疏数组（洞）拒绝', () => {
    const sparse = new Array(2) as never[];
    const raw = validChannels({ headings: sparse as never });
    expect(validateDocumentChannels(raw).ok).toBe(false);
  });

  it('数组自定义额外属性 / symbol 属性拒绝', () => {
    const headings: DocumentChannels['headings'] = [{ level: 1, text: 'a' }];
    (headings as unknown as Record<string, unknown>)['evil'] = 1;
    expect(validateDocumentChannels(validChannels({ headings })).ok).toBe(false);
    const links = [{ text: 'a', url: 'https://example.com' }];
    const symLinks = links as unknown as Record<symbol, unknown>;
    symLinks[Symbol('x')] = 1;
    expect(validateDocumentChannels(validChannels({ links: links as never })).ok).toBe(false);
  });

  it('heading 子对象未知键 / 非法 level / 额外字段拒绝', () => {
    expect(
      validateDocumentChannels(
        validChannels({ headings: [{ level: 1, text: 'a', extra: true } as never] }),
      ).ok,
    ).toBe(false);
    expect(
      validateDocumentChannels(validChannels({ headings: [{ level: 5, text: 'a' } as never] })).ok,
    ).toBe(false);
    expect(
      validateDocumentChannels(validChannels({ headings: [{ level: '1' as never, text: 'a' }] }))
        .ok,
    ).toBe(false);
  });

  it('table 子对象 shape / 行列类型拒绝', () => {
    expect(
      validateDocumentChannels(validChannels({ tables: [{ headers: 5 as never, rows: [] }] })).ok,
    ).toBe(false);
    expect(
      validateDocumentChannels(
        validChannels({ tables: [{ headers: ['a'], rows: [[1 as never]] }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateDocumentChannels(validChannels({ tables: [{ headers: ['a'], rows: {} as never }] }))
        .ok,
    ).toBe(false);
  });

  it('link 子对象未知键 / 缺失 url 拒绝', () => {
    expect(
      validateDocumentChannels(validChannels({ links: [{ text: 'a', url: 'u', x: 1 } as never] }))
        .ok,
    ).toBe(false);
    expect(validateDocumentChannels(validChannels({ links: [{ text: 'a' } as never] })).ok).toBe(
      false,
    );
  });

  it('超长字符串（单串超整体预算码元数）拒绝', () => {
    const long = 'x'.repeat(MAX_PAGE_PROJECTION_BYTES + 1);
    expect(validateDocumentChannels(validChannels({ mainText: long })).ok).toBe(false);
  });
});

describe('validateDocumentChannels — UTF-8 结构预算预检', () => {
  it('== MAX_PAGE_PROJECTION_BYTES 总字节接受', () => {
    // 单一 mainText 承载全部字节（其余通道为空）：预检 == 64 KiB 接受
    const text = 'a'.repeat(MAX_PAGE_PROJECTION_BYTES);
    expect(
      validateDocumentChannels(
        validChannels({ mainText: text, headings: [], tables: [], links: [] }),
      ).ok,
    ).toBe(true);
  });

  it('MAX+1 字节整份拒绝', () => {
    const text = 'a'.repeat(MAX_PAGE_PROJECTION_BYTES + 1);
    expect(
      validateDocumentChannels(
        validChannels({ mainText: text, headings: [], tables: [], links: [] }),
      ).ok,
    ).toBe(false);
  });

  it('分组累计（headings+tables+links）同样计入预检', () => {
    const half = 'a'.repeat(Math.floor(MAX_PAGE_PROJECTION_BYTES / 2));
    const raw = validChannels({
      mainText: half,
      headings: [{ level: 1, text: half }],
      tables: [],
      links: [{ text: 'x', url: 'https://example.com/' }],
    });
    // 两段各占一半已触顶，link 追加后必然超
    expect(validateDocumentChannels(raw).ok).toBe(false);
  });
});
