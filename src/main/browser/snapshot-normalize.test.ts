// PageSnapshot 输出校验纯函数测试（零 Electron 依赖）.
// Contract source: doc/detailed-design.md §8.6/§10（页面视为敌手，逐字段校验/限额/二次截断）.
// 红→绿纪律：本测试先于 snapshot-normalize.ts 实现落地（新模块缺失时先行失败）.

import { describe, expect, it } from 'vitest';
import { NORMALIZE_LIMITS, normalizeSnapshot } from './snapshot-normalize';

const FALLBACK = { url: 'https://fallback.example/', title: '兜底标题', documentId: 7 };
const L = NORMALIZE_LIMITS;

// 一个合法的完整脚本输出（L0 基准），字段用 overrides 局部替换
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    url: 'https://page.example/path',
    title: '页面标题',
    readyState: 'complete',
    viewport: { scrollX: 0, scrollY: 10, width: 1280, height: 800 },
    selection: '选中的一段文字',
    visibleText: '可见文本内容',
    headings: [{ level: 1, text: '主标题' }],
    links: [{ id: 'el-0', text: '链接', href: 'https://page.example/next' }],
    buttons: [{ id: 'el-1', text: '按钮' }],
    inputs: [{ id: 'el-2', type: 'text', placeholder: '占位', value: '输入值' }],
    tables: [{ headers: ['列一', '列二'], rows: [['a1', 'b1']] }],
    iframes: { total: 0, crossOrigin: 0 },
    truncated: [],
    ...overrides,
  };
}

describe('normalizeSnapshot — 不可信输入（L2 形状，永不抛异常）', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['字符串', 'hello'],
    ['数组', [1, 2]],
    ['ok:false 对象', { ok: false }],
    ['空对象', {}],
  ])('输入 %s → 返回主进程降级快照（fallback url/title + 空集合 + unknown）', (_name, raw) => {
    const snap = normalizeSnapshot(raw, FALLBACK);
    expect(snap.url).toBe(FALLBACK.url);
    expect(snap.title).toBe(FALLBACK.title);
    expect(snap.headings).toEqual([]);
    expect(snap.links).toEqual([]);
    expect(snap.buttons).toEqual([]);
    expect(snap.meta.degraded).toBe('main-process-only');
    expect(snap.meta.readyState).toBe('unknown');
    expect(snap.meta.warnings.length).toBeGreaterThan(0);
  });

  it('ok:false 且带 error 字符串 → warning 包含脚本失败原因', () => {
    const snap = normalizeSnapshot({ ok: false, error: 'boom' }, FALLBACK);
    expect(snap.meta.warnings[0]).toBe('采集脚本失败：boom');
  });

  it('ok:false 的 error 非字符串 → 忽略，不注入到 warning', () => {
    const snap = normalizeSnapshot({ ok: false, error: { evil: true } }, FALLBACK);
    expect(snap.meta.warnings.join('|')).not.toContain('evil');
  });
});

describe('normalizeSnapshot — 完整输入（L0）', () => {
  it('合法完整输出逐字段透传，degraded=none，capturedAt 为主进程时间戳', () => {
    const snap = normalizeSnapshot(validRaw(), FALLBACK);
    expect(snap.url).toBe('https://page.example/path');
    expect(snap.title).toBe('页面标题');
    expect(snap.viewport).toEqual({ scrollX: 0, scrollY: 10, width: 1280, height: 800 });
    expect(snap.selection).toBe('选中的一段文字');
    expect(snap.visibleText).toBe('可见文本内容');
    expect(snap.headings).toEqual([{ level: 1, text: '主标题' }]);
    expect(snap.links).toEqual([{ id: 'el-0', text: '链接', href: 'https://page.example/next' }]);
    expect(snap.buttons).toEqual([{ id: 'el-1', text: '按钮' }]);
    expect(snap.inputs).toEqual([
      { id: 'el-2', type: 'text', placeholder: '占位', value: '输入值' },
    ]);
    expect(snap.tables).toEqual([{ headers: ['列一', '列二'], rows: [['a1', 'b1']] }]);
    expect(snap.meta.degraded).toBe('none');
    expect(snap.meta.readyState).toBe('complete');
    expect(snap.meta.warnings).toEqual([]);
    expect(Number.isFinite(snap.meta.capturedAt)).toBe(true);
  });

  it('url/title 非法类型或缺省 → 使用 fallback', () => {
    const snap = normalizeSnapshot(validRaw({ url: 42, title: ['x'] }), FALLBACK);
    expect(snap.url).toBe(FALLBACK.url);
    expect(snap.title).toBe(FALLBACK.title);
  });

  it('url 超长截断到限额；title 空白折叠并截断', () => {
    const snap = normalizeSnapshot(
      validRaw({ url: `https://page.example/${'a'.repeat(L.url)}`, title: `  标题  \n折叠  ` }),
      FALLBACK,
    );
    expect(snap.url.length).toBe(L.url);
    expect(snap.title).toBe('标题 折叠');
  });

  it('空 selection/visibleText/inputs/tables → 省略对应可选字段', () => {
    const snap = normalizeSnapshot(
      validRaw({ selection: '   ', visibleText: '', inputs: [], tables: [] }),
      FALLBACK,
    );
    expect(snap.selection).toBeUndefined();
    expect(snap.visibleText).toBeUndefined();
    expect(snap.inputs).toBeUndefined();
    expect(snap.tables).toBeUndefined();
  });

  it('viewport 任一字段非法/为负/NaN → 整体省略', () => {
    for (const bad of [
      { scrollX: -1, scrollY: 0, width: 100, height: 100 },
      { scrollX: Number.NaN, scrollY: 0, width: 100, height: 100 },
      { scrollX: 0, scrollY: 0, width: '100', height: 100 },
      { scrollX: 0, scrollY: 0, width: 100 },
    ]) {
      const snap = normalizeSnapshot(validRaw({ viewport: bad }), FALLBACK);
      expect(snap.viewport).toBeUndefined();
    }
  });
});

describe('normalizeSnapshot — 降级阶梯判定（L1 partial）', () => {
  it('readyState=loading/interactive → partial', () => {
    expect(normalizeSnapshot(validRaw({ readyState: 'loading' }), FALLBACK).meta.degraded).toBe(
      'partial',
    );
    expect(normalizeSnapshot(validRaw({ readyState: 'interactive' }), FALLBACK).meta.degraded).toBe(
      'partial',
    );
  });

  it('readyState 非法字符串 → unknown + partial', () => {
    const snap = normalizeSnapshot(validRaw({ readyState: 'almost-done' }), FALLBACK);
    expect(snap.meta.readyState).toBe('unknown');
    expect(snap.meta.degraded).toBe('partial');
  });

  it('存在被跳过的 iframe → partial + 中文警告（含跨域计数）', () => {
    const snap = normalizeSnapshot(validRaw({ iframes: { total: 3, crossOrigin: 2 } }), FALLBACK);
    expect(snap.meta.degraded).toBe('partial');
    expect(snap.meta.warnings).toContain('跳过 3 个 iframe（其中 2 个跨域）');
  });

  it('iframe 计数越界 → 收敛（crossOrigin 钳制到 total 内，负数归零）', () => {
    const snap = normalizeSnapshot(validRaw({ iframes: { total: 3, crossOrigin: 9 } }), FALLBACK);
    expect(snap.meta.warnings).toContain('跳过 3 个 iframe（其中 3 个跨域）');
    const neg = normalizeSnapshot(validRaw({ iframes: { total: -2, crossOrigin: -5 } }), FALLBACK);
    expect(neg.meta.degraded).toBe('none'); // 归零后视为无 iframe
  });

  it('iframes 字段非法类型 → 忽略（不产生警告，不降级）', () => {
    const snap = normalizeSnapshot(validRaw({ iframes: 'many' }), FALLBACK);
    expect(snap.meta.degraded).toBe('none');
    expect(snap.meta.warnings).toEqual([]);
  });
});

describe('normalizeSnapshot — 限额二次截断与 warnings', () => {
  it('headings 超过限额 → 截断到上限 + 警告', () => {
    const many = Array.from({ length: L.headings + 1 }, () => ({ level: 1, text: 'x' }));
    const snap = normalizeSnapshot(validRaw({ headings: many }), FALLBACK);
    expect(snap.headings.length).toBe(L.headings);
    expect(snap.meta.warnings).toContain('headings 超过采集限额，已截断');
  });

  it('脚本已截断的集合 → 透传对应警告（degraded 仍为 none，截断只加警告）', () => {
    const snap = normalizeSnapshot(validRaw({ truncated: ['links', 'tableRows'] }), FALLBACK);
    expect(snap.meta.warnings).toContain('links 超过采集限额，已截断');
    expect(snap.meta.warnings).toContain('表格行数超过采集限额，已截断');
    expect(snap.meta.degraded).toBe('none');
  });

  it('未知 truncated 键与非字符串条目 → 忽略', () => {
    const snap = normalizeSnapshot(validRaw({ truncated: ['nonsense', 42] }), FALLBACK);
    expect(snap.meta.warnings).toEqual([]);
  });

  it('文本超过限额 → 空白折叠后截断；href 超限截断；selection/visibleText 各自限额', () => {
    const snap = normalizeSnapshot(
      validRaw({
        headings: [{ level: 1, text: `a  ${'b'.repeat(L.text)}` }],
        links: [{ id: 'el-0', text: '', href: `https://x/${'h'.repeat(L.href)}` }],
        selection: 's'.repeat(L.selection + 1),
        visibleText: 'v'.repeat(L.visibleText + 1),
      }),
      FALLBACK,
    );
    expect(snap.headings[0]?.text).toBe(`a ${'b'.repeat(L.text - 2)}`);
    expect(snap.headings[0]?.text.length).toBe(L.text);
    expect(snap.links[0]?.href.length).toBe(L.href);
    expect(snap.selection?.length).toBe(L.selection);
    expect(snap.visibleText?.length).toBe(L.visibleText);
  });

  it('表格行数超限 → 截断 + 警告；tables 超限截断', () => {
    const rows = Array.from({ length: L.tableRows + 1 }, () => ['x']);
    const snap = normalizeSnapshot(validRaw({ tables: [{ headers: [], rows }] }), FALLBACK);
    expect(snap.tables?.[0]?.rows.length).toBe(L.tableRows);
    expect(snap.meta.warnings).toContain('表格行数超过采集限额，已截断');
    const tables = Array.from({ length: L.tables + 1 }, () => ({
      headers: ['h'],
      rows: [['x']],
    }));
    const snap2 = normalizeSnapshot(validRaw({ tables }), FALLBACK);
    expect(snap2.tables?.length).toBe(L.tables);
    expect(snap2.meta.warnings).toContain('tables 超过采集限额，已截断');
  });

  it('同源重复警告去重（脚本标志 + 二次截断合并为一条）', () => {
    const many = Array.from({ length: L.headings + 5 }, () => ({ level: 1, text: 'x' }));
    const snap = normalizeSnapshot(validRaw({ headings: many, truncated: ['headings'] }), FALLBACK);
    expect(snap.meta.warnings.filter((w) => w === 'headings 超过采集限额，已截断')).toHaveLength(1);
  });
});

describe('normalizeSnapshot — elementId 格式过滤（页面是敌手）', () => {
  it.each(['el-0', 'el-42', `el-${'9'.repeat(10)}`])('合法格式 %s → 保留', (id) => {
    const snap = normalizeSnapshot(
      validRaw({ links: [{ id, text: '', href: 'https://x/' }] }),
      FALLBACK,
    );
    expect(snap.links.length).toBe(1);
    expect(snap.links[0]?.id).toBe(id);
  });

  it.each(['abc', 'el-', 'el--1', 'el-1.5', 'el-x', 'EL-1', 'el-12345678901', 42, null])(
    '非法格式 %s → 整条丢弃 + 丢弃警告',
    (id) => {
      const snap = normalizeSnapshot(
        validRaw({ links: [{ id, text: 'x', href: 'https://x/' }] }),
        FALLBACK,
      );
      expect(snap.links).toEqual([]);
      expect(snap.meta.warnings).toContain('丢弃 1 条无效 link');
    },
  );
});

describe('normalizeSnapshot — 非法条目丢弃', () => {
  it('heading：level 非 1–6 整数或 text 非字符串/空文本 → 丢弃', () => {
    const headings = [
      { level: 0, text: 'x' },
      { level: 7, text: 'x' },
      { level: 2.5, text: 'x' },
      { level: '2', text: 'x' },
      { level: 2, text: 42 },
      { level: 2, text: '   ' },
      'not-an-object',
      { level: 3, text: '合法' },
    ];
    const snap = normalizeSnapshot(validRaw({ headings }), FALLBACK);
    expect(snap.headings).toEqual([{ level: 3, text: '合法' }]);
    expect(snap.meta.warnings).toContain('丢弃 7 条无效 heading');
  });

  it('link：href 非字符串或空 → 丢弃；按钮 text 非字符串 → 丢弃', () => {
    const snap = normalizeSnapshot(
      validRaw({
        links: [
          { id: 'el-0', text: 'x', href: 42 },
          { id: 'el-1', text: 'x', href: '' },
          { id: 'el-2', text: 'ok', href: 'https://x/' },
        ],
        buttons: [
          { id: 'el-3', text: 42 },
          { id: 'el-4', text: 'ok' },
        ],
      }),
      FALLBACK,
    );
    expect(snap.links).toEqual([{ id: 'el-2', text: 'ok', href: 'https://x/' }]);
    expect(snap.buttons).toEqual([{ id: 'el-4', text: 'ok' }]);
    expect(snap.meta.warnings).toContain('丢弃 2 条无效 link');
    expect(snap.meta.warnings).toContain('丢弃 1 条无效 button');
  });

  it('input：type 非字符串或空 → 丢弃；空 placeholder/value → 省略字段（条目保留）', () => {
    const snap = normalizeSnapshot(
      validRaw({
        inputs: [
          { id: 'el-0', type: 42 },
          { id: 'el-1', type: 'text', placeholder: '', value: '  ' },
          { id: 'el-2', type: 'text', placeholder: 'p', value: 'v' },
        ],
      }),
      FALLBACK,
    );
    expect(snap.inputs).toEqual([
      { id: 'el-1', type: 'text' },
      { id: 'el-2', type: 'text', placeholder: 'p', value: 'v' },
    ]);
  });

  it('table：headers/rows 非数组 → 整表丢弃', () => {
    const snap = normalizeSnapshot(
      validRaw({
        tables: [
          { headers: 'x', rows: [] },
          { headers: [], rows: 'y' },
          { headers: [], rows: [] },
        ],
      }),
      FALLBACK,
    );
    expect(snap.tables).toBeUndefined(); // 全部丢弃后字段省略
    expect(snap.meta.warnings).toContain('丢弃 3 条无效 table');
  });
});

describe('normalizeSnapshot — 表格行列对齐（补齐/截断）', () => {
  it('短行补空串、长行截断到列数；列数 = max(表头, 各行)', () => {
    const snap = normalizeSnapshot(
      validRaw({
        tables: [
          {
            headers: ['h1'],
            rows: [['a', 'b'], ['c'], ['d', 'e', 'f']],
          },
        ],
      }),
      FALLBACK,
    );
    expect(snap.tables?.[0]).toEqual({
      headers: ['h1', '', ''],
      rows: [
        ['a', 'b', ''],
        ['c', '', ''],
        ['d', 'e', 'f'],
      ],
    });
  });

  it('无表头 → headers 补空串占位对齐；单元格非法类型按空串处理', () => {
    const snap = normalizeSnapshot(
      validRaw({
        tables: [
          {
            headers: [],
            rows: [['a', 42, null], ['b']],
          },
        ],
      }),
      FALLBACK,
    );
    expect(snap.tables?.[0]).toEqual({
      headers: ['', '', ''],
      rows: [
        ['a', '', ''],
        ['b', '', ''],
      ],
    });
  });

  it('单元格文本空白折叠并截断到限额', () => {
    const snap = normalizeSnapshot(
      validRaw({ tables: [{ headers: [], rows: [[`  a  \n b  `]] }] }),
      FALLBACK,
    );
    expect(snap.tables?.[0]?.rows[0]?.[0]).toBe('a b');
  });
});

describe('normalizeSnapshot — warnings 上限与 capturedAt', () => {
  it('warnings 数量封顶 20，保持顺序', () => {
    const rows = Array.from({ length: 30 }, () => ['x']);
    // 行数截断 + 30 个非法 heading 条目各产生一条？不——非法条目聚合为一条；构造多种来源：
    const snap = normalizeSnapshot(
      validRaw({
        truncated: [
          'headings',
          'links',
          'buttons',
          'inputs',
          'tables',
          'tableRows',
          'visibleText',
          'selection',
        ],
        iframes: { total: 1, crossOrigin: 1 },
        tables: [{ headers: [], rows }],
      }),
      FALLBACK,
    );
    expect(snap.meta.warnings.length).toBeLessThanOrEqual(20);
    expect(snap.meta.warnings[0]).toBe('跳过 1 个 iframe（其中 1 个跨域）');
  });

  it('capturedAt 始终为有限数字（主进程盖章）', () => {
    expect(Number.isFinite(normalizeSnapshot(null, FALLBACK).meta.capturedAt)).toBe(true);
    expect(Number.isFinite(normalizeSnapshot(validRaw(), FALLBACK).meta.capturedAt)).toBe(true);
  });
});

describe('normalizeSnapshot — click 语义元数据（A3：buttons isSubmit/ariaExpanded、inputs isSubmit、documentId 主进程盖章）', () => {
  it('buttons 条目的 isSubmit/ariaExpanded 严格布尔透传（true 与 false 均保留）', () => {
    const snap = normalizeSnapshot(
      validRaw({
        buttons: [
          { id: 'el-1', text: '提交', isSubmit: true },
          { id: 'el-2', text: '展开', ariaExpanded: true },
          { id: 'el-3', text: '折叠', ariaExpanded: false },
          { id: 'el-4', text: '普通' },
        ],
      }),
      FALLBACK,
    );
    expect(snap.buttons).toEqual([
      { id: 'el-1', text: '提交', isSubmit: true },
      { id: 'el-2', text: '展开', ariaExpanded: true },
      { id: 'el-3', text: '折叠', ariaExpanded: false },
      { id: 'el-4', text: '普通' },
    ]);
  });

  it('布尔形状非法（字符串 "true"/数字/对象/数组）→ 按敌手输入纪律丢弃字段，不整条丢弃、不抛异常', () => {
    const snap = normalizeSnapshot(
      validRaw({
        buttons: [
          { id: 'el-1', text: '甲', isSubmit: 'true' },
          { id: 'el-2', text: '乙', isSubmit: 1 },
          { id: 'el-3', text: '丙', ariaExpanded: 'false' },
          { id: 'el-4', text: '丁', ariaExpanded: { value: false } },
          { id: 'el-5', text: '戊', isSubmit: [true] },
        ],
      }),
      FALLBACK,
    );
    expect(snap.buttons.map((b) => ({ id: b.id, text: b.text }))).toEqual([
      { id: 'el-1', text: '甲' },
      { id: 'el-2', text: '乙' },
      { id: 'el-3', text: '丙' },
      { id: 'el-4', text: '丁' },
      { id: 'el-5', text: '戊' },
    ]);
    expect(
      snap.buttons.every((b) => b.isSubmit === undefined && b.ariaExpanded === undefined),
    ).toBe(true);
  });

  it('inputs 条目 isSubmit 严格布尔透传（normalize 不合成：脚本未证明则字段缺失，字段缺失 ≠ false）', () => {
    const snap = normalizeSnapshot(
      validRaw({
        inputs: [
          { id: 'el-2', type: 'text', placeholder: '占位', value: '输入值' },
          { id: 'el-3', type: 'submit', isSubmit: true },
          { id: 'el-4', type: 'submit' }, // 脚本未产出 isSubmit → 透传后缺失（fail-closed）
        ],
      }),
      FALLBACK,
    );
    expect(snap.inputs).toEqual([
      { id: 'el-2', type: 'text', placeholder: '占位', value: '输入值' },
      { id: 'el-3', type: 'submit', isSubmit: true },
      { id: 'el-4', type: 'submit' },
    ]);
  });

  it('inputs isSubmit 非法形状 → 字段丢弃（fail-closed：无法证明提交类即不升级 L2）', () => {
    const snap = normalizeSnapshot(
      validRaw({ inputs: [{ id: 'el-2', type: 'submit', isSubmit: 'yes' }] }),
      FALLBACK,
    );
    expect(snap.inputs).toEqual([{ id: 'el-2', type: 'submit' }]);
  });

  it('meta.documentId 由主进程 fallback 盖章（页面无法伪造——即使脚本伪造 documentId 字段也被忽略）', () => {
    const good = normalizeSnapshot(validRaw(), FALLBACK);
    expect(good.meta.documentId).toBe(FALLBACK.documentId);
    // 敌手在脚本输出中伪造 documentId：必须被主进程侧值覆盖
    const hostile = normalizeSnapshot(
      validRaw({ meta: { documentId: 999 }, documentId: 999 }),
      FALLBACK,
    );
    expect(hostile.meta.documentId).toBe(FALLBACK.documentId);
    // L2 降级路径同样盖章
    const l2 = normalizeSnapshot(null, FALLBACK);
    expect(l2.meta.documentId).toBe(FALLBACK.documentId);
  });
});
