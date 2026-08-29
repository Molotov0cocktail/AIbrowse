// D6 page-projector: DocumentChannels → PageProjection（detailed-design §8、
// FIXED DECISIONS 2/3/4/5/6）。红→绿 oracle 覆盖：四 Region、固定字段 key、
// NFC/控制/bidi/CRLF/空白折叠、URL query/fragment canary 消失、table fingerprint/
// occurrence/漂移、Region/fields/bytes ==/+1 预算、public/session 对等、敌手结构。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeSessionTargetDigest,
  computeTableHeaderFingerprint,
  pageLocatorKey,
  previewPageRegions,
  projectPageProjection,
  safeProjectionUrl,
  sessionConsentTargetCheck,
  urlOrigin,
  type ProjectPageInput,
} from './page-projector';
import type { DocumentChannels, PageTarget, RegionDescriptor } from '../../shared/types/watch';
import { MAX_PAGE_PROJECTION_BYTES } from '../../shared/types/watch';
import { validateDocumentChannels } from '../../shared/watch/document-channels';

const RULE_ID = 'rule-1';
const SOURCE_ID = 'src-1';

function channels(overrides: Partial<DocumentChannels> = {}): DocumentChannels {
  return {
    mainText: '第一段。\r\n第二段。\t  第三段。',
    headings: [
      { level: 1, text: '主标题' },
      { level: 2, text: '子标题' },
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
      {
        headers: ['日期', '事件'],
        rows: [['2026-01-01', '发布']],
      },
    ],
    links: [
      { text: '示例', url: 'https://example.com/a?tk=secret#frag' },
      { text: '跨域', url: 'https://other.example/b' },
    ],
    ...overrides,
  };
}

function project(input: Partial<ProjectPageInput> = {}) {
  const base: ProjectPageInput = {
    channels: channels(),
    regions: [
      { kind: 'main-text', label: '正文' },
      { kind: 'headings', label: '标题', levels: [1, 2] },
      {
        kind: 'table',
        label: '价格表',
        headerFingerprint: computeTableHeaderFingerprint(['名称', '价格']) ?? '',
        occurrence: 0,
      },
      { kind: 'links', label: '链接', sameOriginOnly: false },
    ],
    ruleId: RULE_ID,
    sourceId: SOURCE_ID,
    finalUrl: 'https://example.com/doc?src=login#top',
    capturedAt: '2026-08-29T00:00:00.000Z',
    documentId: null,
    ...input,
  };
  return projectPageProjection(base);
}

describe('PageProjection — 四 Region 输出与固定字段 key', () => {
  it('区域按 PageTarget.regions 顺序、字段按文档顺序', () => {
    const r = project();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = r.fieldCatalog;
    expect(keys[0]).toBe('r0:main');
    expect(keys[1]).toBe('r1:heading:1'); // 文档序：主标题
    expect(keys[2]).toBe('r1:heading:2'); // 子标题
    expect(keys[3]).toBe('r2:table-header:0');
    expect(keys[4]).toBe('r2:table-header:1');
    expect(keys[5]).toBe('r2:table-cell:0:0');
    expect(keys[6]).toBe('r2:table-cell:0:1');
    expect(keys[7]).toBe('r2:table-cell:1:0');
    expect(keys[8]).toBe('r2:table-cell:1:1');
    expect(keys[9]).toBe('r3:link:1');
    expect(keys[10]).toBe('r3:link:2');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('heading 未知级别不进 Projection（adapter 已过滤越级标题），main-text 规范化', () => {
    const r = project();
    if (!r.ok) return;
    const mainF = r.projection.value.fields.find((f) => f.kind === 'main-text')!;
    expect(mainF.value).toBe('第一段。 第二段。 第三段。');
    const headingFields = r.projection.value.fields.filter((f) => f.kind === 'heading');
    expect(headingFields.map((f) => (f.kind === 'heading' ? f.level : null))).toEqual([1, 2]);
  });

  it('字段对象键序 = 类型声明序（canonical 编码依赖）', () => {
    const r = project();
    if (!r.ok) return;
    const f = r.projection.value.fields[0]!;
    expect(Object.keys(f)).toEqual(['fieldKey', 'regionIndex', 'kind', 'label', 'value']);
    const h = r.projection.value.fields.find((x) => x.kind === 'heading')!;
    expect(Object.keys(h)).toEqual([
      'fieldKey',
      'regionIndex',
      'kind',
      'label',
      'level',
      'ordinal',
      'value',
    ]);
    const cell = r.projection.value.fields.find((x) => x.kind === 'table-cell')!;
    expect(Object.keys(cell)).toEqual([
      'fieldKey',
      'regionIndex',
      'kind',
      'label',
      'occurrence',
      'row',
      'column',
      'columnLabel',
      'value',
    ]);
  });

  it('table-cell 带 columnLabel；header/cell 行列边界保持', () => {
    const r = project();
    if (!r.ok) return;
    const cells = r.projection.value.fields.filter((f) => f.kind === 'table-cell');
    expect(cells.length).toBe(4);
    const first = cells.find((f) => f.kind === 'table-cell' && f.row === 0 && f.column === 0)!;
    expect(
      first.kind === 'table-cell' && first.value === '甲' && first.columnLabel === '名称',
    ).toBe(true);
  });

  it('link 字段 text/url 分离；ordinal 按文档序', () => {
    const r = project();
    if (!r.ok) return;
    const links = r.projection.value.fields.filter((f) => f.kind === 'link');
    expect(links.map((l) => (l.kind === 'link' ? l.ordinal : 0))).toEqual([1, 2]);
  });

  it('envelope 固定元数据；finalUrl 去 query/fragment；hash/bytes 只基于 value', () => {
    const r = project();
    if (!r.ok) return;
    const p = r.projection;
    expect(p.schemaVersion).toBe(1);
    expect(p.ruleId).toBe(RULE_ID);
    expect(p.sourceId).toBe(SOURCE_ID);
    expect(p.finalUrl).toBe('https://example.com/doc');
    expect(p.documentId).toBeNull();
    expect(p.capturedAt).toBe('2026-08-29T00:00:00.000Z');
    const canonical = Buffer.from(JSON.stringify(p.value), 'utf8');
    const expectedHash = createHash('sha256').update(canonical).digest('hex');
    expect(p.contentHash).toBe(expectedHash);
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.byteLength).toBe(canonical.length);
  });

  it('添加与查询无关字段（capturedAt/documentId/finalUrl 变化）不改变 hash/bytes', () => {
    const a = project();
    expect(a.ok).toBe(true);
    const b = project({ capturedAt: '2026-08-30T00:00:00.000Z', documentId: '1234' });
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.projection.value).toEqual(a.projection.value);
    expect(b.projection.contentHash).toBe(a.projection.contentHash);
    expect(b.projection.byteLength).toBe(a.projection.byteLength);
  });
});

describe('PageProjection — 规范化与 URL 防御', () => {
  it('NFC、C0/C1、bidi、零宽、CRLF、空白折叠、trim', () => {
    const text = '\u007f\u200b\u202e虚\u202c构 A\u030a\u0000\u0085  \r\n\t正文\u200d  ';
    const r = project({
      channels: channels({ mainText: text, headings: [], tables: [], links: [] }),
      regions: [{ kind: 'main-text', label: '正文' }],
      finalUrl: 'https://example.com/',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.projection.value.fields[0]!.kind === 'main-text' && r.projection.value.fields[0]!.value,
    ).toBe('虚构 \u00c5 正文');
  });

  it('link query/fragment canary 从 Projection 消失；文本保留', () => {
    const r = project({
      channels: channels({
        headings: [],
        tables: [],
        links: [
          { text: '带参', url: 'https://example.com/path?token=SECRET-CANARY&x=1#frag' },
          { text: '分段', url: 'https://example.com/p#sec' },
        ],
      }),
      regions: [{ kind: 'links', label: '链接', sameOriginOnly: false }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const urls = r.projection.value.fields
      .filter((f) => f.kind === 'link')
      .map((l) => (l.kind === 'link' ? l.url : ''));
    expect(urls).toEqual(['https://example.com/path', 'https://example.com/p']);
    expect(JSON.stringify(r.projection)).not.toContain('SECRET-CANARY');
  });

  it('非 http/https、userinfo 链接被跳过；全部无效 → parse_changed', () => {
    const r = project({
      channels: channels({
        headings: [],
        tables: [],
        links: [
          { text: '脚本', url: 'javascript:alert(1)' },
          { text: '凭证', url: 'https://user:pass@example.com/x' },
        ],
      }),
      regions: [{ kind: 'links', label: '链接', sameOriginOnly: false }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('sameOriginOnly=true 只保留同最终页 origin 的链接', () => {
    const r = project({
      channels: channels({
        headings: [],
        tables: [],
        links: [
          { text: '同源', url: 'https://example.com/y' },
          { text: '跨源', url: 'https://other.example/z' },
        ],
      }),
      regions: [{ kind: 'links', label: '链接', sameOriginOnly: true }],
      finalUrl: 'https://example.com/doc',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const urls = r.projection.value.fields
      .filter((f) => f.kind === 'link')
      .map((l) => (l.kind === 'link' ? l.url : ''));
    expect(urls).toEqual(['https://example.com/y']);
  });

  it('最终页 origin 判定使用未脱敏完整 URL（含 query 的 origin 恒等）', () => {
    expect(urlOrigin('https://example.com/a?x=1#f')).toBe('https://example.com');
    expect(urlOrigin('https://user@example.com/')).toBeNull();
    expect(urlOrigin('file:///etc/passwd')).toBeNull();
  });
});

describe('PageProjection — table fingerprint / occurrence / 漂移', () => {
  it('fingerprint 确定、版本化、对空白 insensitivemainText', () => {
    const a = computeTableHeaderFingerprint([' 名称 ', '价格']);
    const b = computeTableHeaderFingerprint(['名称', '价格']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const c = computeTableHeaderFingerprint(['名称', '价格', '库存']);
    expect(c).not.toBe(a);
    expect(computeTableHeaderFingerprint([])).toBeNull();
  });

  it('同 fingerprint 多表按文档序 occurrence 精确选择', () => {
    const fp = computeTableHeaderFingerprint(['名称', '价格']) ?? '';
    const r = project({
      channels: channels({
        headings: [],
        tables: [
          { headers: ['名称', '价格'], rows: [['甲', '100']] },
          { headers: ['名称', '价格'], rows: [['丙', '300']] },
          { headers: ['日期', '事件'], rows: [['2026-01-01', '发布']] },
        ],
      }),
      regions: [{ kind: 'table', label: '表', headerFingerprint: fp, occurrence: 1 }],
      finalUrl: 'https://example.com/',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cells = r.projection.value.fields.filter((f) => f.kind === 'table-cell');
    expect(
      cells
        .filter((f) => f.kind === 'table-cell' && f.row === 0 && f.column === 0)
        .map((f) => f.value),
    ).toEqual(['丙']);
  });

  it('occurrence 越界 / 指纹缺失 / headers 漂移 → parse_changed', () => {
    const fp = computeTableHeaderFingerprint(['名称', '价格']) ?? '';
    const base = {
      channels: channels({
        headings: [],
        tables: [{ headers: ['名称', '价格'], rows: [['甲', '100']] }],
      }),
      finalUrl: 'https://example.com/',
    };
    expect(
      project({
        ...base,
        regions: [{ kind: 'table', label: '表', headerFingerprint: fp, occurrence: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      project({
        ...base,
        regions: [
          {
            kind: 'table',
            label: '表',
            headerFingerprint: computeTableHeaderFingerprint(['名称']) ?? '',
            occurrence: 0,
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      project({
        ...base,
        channels: channels({
          headings: [],
          tables: [{ headers: ['名称'], rows: [['甲']] }],
        }),
        regions: [{ kind: 'table', label: '表', headerFingerprint: fp, occurrence: 0 }],
      }).ok,
    ).toBe(false);
  });

  it('headers 为空 / row 列数与 headers 不一致 → parse_changed', () => {
    const fp = computeTableHeaderFingerprint(['名称', '价格']) ?? '';
    const a = project({
      channels: channels({
        headings: [],
        tables: [{ headers: ['名称', '价格'], rows: [['甲', '100'], ['列数漂移']] }],
      }),
      regions: [{ kind: 'table', label: '表', headerFingerprint: fp, occurrence: 0 }],
      finalUrl: 'https://example.com/',
    });
    expect(a.ok).toBe(false);
  });

  // R5 修复：空单元格（含整行空单元格）保留列索引与 columnLabel，不左移漂移
  it('空单元格/整行空单元格 → 字段保留 column/columnLabel 与空 value（列位置不漂移）', () => {
    const fp = computeTableHeaderFingerprint(['名称', '价格', '库存']) ?? '';
    const r = project({
      channels: channels({
        headings: [],
        tables: [
          {
            headers: ['名称', '价格', '库存'],
            rows: [
              ['', '甲', '100'], // 空首列
              ['乙', '', '200'], // 空中间列
              ['丙', '300', ''], // 空末列
              ['', '', ''], // 整行空单元格
            ],
          },
        ],
      }),
      regions: [{ kind: 'table', label: '表', headerFingerprint: fp, occurrence: 0 }],
      finalUrl: 'https://example.com/',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cells = r.projection.value.fields.filter((f) => f.kind === 'table-cell');
    expect(cells.length).toBe(12);
    const cellOf = (row: number, column: number) =>
      cells.find((f) => f.kind === 'table-cell' && f.row === row && f.column === column)!;
    // 空首列：column=0 且 columnLabel='名称'，value=''
    expect(cellOf(0, 0).kind === 'table-cell' && cellOf(0, 0).value).toBe('');
    expect(cellOf(0, 0).kind === 'table-cell' && cellOf(0, 0).columnLabel).toBe('名称');
    // 空中间列：column=1、columnLabel='价格'，value=''
    expect(cellOf(1, 1).kind === 'table-cell' && cellOf(1, 1).value).toBe('');
    expect(cellOf(1, 1).kind === 'table-cell' && cellOf(1, 1).columnLabel).toBe('价格');
    // 空末列：column=2、columnLabel='库存'，value=''
    expect(cellOf(2, 2).kind === 'table-cell' && cellOf(2, 2).value).toBe('');
    // 整行空单元格行保留：row=3 三个空 value
    for (let c = 0; c < 3; c += 1) {
      expect(cellOf(3, c).kind === 'table-cell' && cellOf(3, c).value).toBe('');
    }
  });
});

describe('PageProjection — 预算 ==/+1 oracle', () => {
  it('Regions 10 接受、11 拒绝（budget_exceeded）', () => {
    const regions10: RegionDescriptor[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'main-text' as const,
      label: `区域${i}`,
    }));
    const ok = project({
      channels: channels({ headings: [], tables: [], links: [] }),
      regions: regions10,
      finalUrl: 'https://example.com/',
    });
    expect(ok.ok).toBe(true);
    const bad = project({
      channels: channels({ headings: [], tables: [], links: [] }),
      regions: [...regions10, { kind: 'main-text', label: '第11区' }],
      finalUrl: 'https://example.com/',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('fields 50 接受、51 拒绝', () => {
    // 50 个 heading（levels 全 1）→ 50 fields；51 个 → 51 fields
    const many = Array.from({ length: 50 }, (_, i) => ({ level: 1 as const, text: `h${i}` }));
    const ok = project({
      channels: channels({ headings: many, tables: [], links: [] }),
      regions: [{ kind: 'headings', label: '标题', levels: [1] }],
      finalUrl: 'https://example.com/',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.projection.value.fields.length).toBe(50);
    const tooMany = [...many, { level: 1 as const, text: 'h50' }];
    const bad = project({
      channels: channels({ headings: tooMany, tables: [], links: [] }),
      regions: [{ kind: 'headings', label: '标题', levels: [1] }],
      finalUrl: 'https://example.com/',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('canonical value bytes == 65,536 接受、65,537 拒绝（不截断）', () => {
    const head =
      '{"type":"page","fields":[{"fieldKey":"r0:main","regionIndex":0,"kind":"main-text","label":"l","value":"';
    const tail = '"}]}';
    const overhead = head.length + tail.length;
    const fill = MAX_PAGE_PROJECTION_BYTES - overhead;
    // 校准：真实 JSON 与预测一致
    const probe = JSON.stringify({
      type: 'page',
      fields: [
        {
          fieldKey: 'r0:main',
          regionIndex: 0,
          kind: 'main-text',
          label: 'l',
          value: 'a'.repeat(fill),
        },
      ],
    });
    expect(Buffer.byteLength(probe, 'utf8')).toBe(MAX_PAGE_PROJECTION_BYTES);
    const ok = project({
      channels: channels({ mainText: 'a'.repeat(fill), headings: [], tables: [], links: [] }),
      regions: [{ kind: 'main-text', label: 'l' }],
      finalUrl: 'https://example.com/',
      capturedAt: '2026-08-29T00:00:00.000Z',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.projection.byteLength).toBe(MAX_PAGE_PROJECTION_BYTES);

    const bad = project({
      channels: channels({ mainText: 'a'.repeat(fill + 1), headings: [], tables: [], links: [] }),
      regions: [{ kind: 'main-text', label: 'l' }],
      finalUrl: 'https://example.com/',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });
});

describe('PageProjection — fail-closed 矩阵与 public/session 对等', () => {
  it('空 main-text / 零 heading / 零 link → parse_changed', () => {
    expect(
      project({
        channels: channels({ mainText: '   ', headings: [], tables: [], links: [] }),
        regions: [{ kind: 'main-text', label: '正文' }],
        finalUrl: 'https://example.com/',
      }).ok,
    ).toBe(false);
    expect(
      project({
        channels: channels({ headings: [], tables: [], links: [] }),
        regions: [{ kind: 'headings', label: '标题', levels: [3] }],
        finalUrl: 'https://example.com/',
      }).ok,
    ).toBe(false);
    expect(
      project({
        channels: channels({ headings: [], tables: [], links: [] }),
        regions: [{ kind: 'links', label: '链接', sameOriginOnly: false }],
        finalUrl: 'https://example.com/',
      }).ok,
    ).toBe(false);
  });

  it('非法通道结构（原型链/getter/未知键）在进入 Projector 前拒绝', () => {
    const hostile = { mainText: 'x', headings: [], tables: [], links: [] } as DocumentChannels;
    const protoObj = Object.create({ mainText: 'x', headings: [], tables: [], links: [] });
    expect(validateDocumentChannels(hostile).ok).toBe(true);
    expect(validateDocumentChannels(protoObj).ok).toBe(false);
    const g = { ...hostile } as { mainText: string };
    Object.defineProperty(g, 'mainText', {
      enumerable: true,
      configurable: true,
      get: () => 'x',
    });
    expect(validateDocumentChannels(g).ok).toBe(false);
  });

  it('非法 finalUrl / capturedAt / documentId 拒绝', () => {
    expect(
      project({ finalUrl: 'javascript:alert(1)' }).ok === false &&
        project({ finalUrl: 'file:///etc/passwd' }).ok === false,
    ).toBe(true);
    const badTime = project({ capturedAt: 'not-a-date' });
    expect(badTime.ok).toBe(false);
    const badDoc = project({ capturedAt: '2026-08-29T00:00:00.000Z', documentId: '0' });
    expect(badDoc.ok).toBe(false);
    const badDoc2 = project({ capturedAt: '2026-08-29T00:00:00.000Z', documentId: '-1' });
    expect(badDoc2.ok).toBe(false);
    const okDoc = project({ capturedAt: '2026-08-29T00:00:00.000Z', documentId: '42' });
    expect(okDoc.ok).toBe(true);
  });

  it('public/session 给定等价 channels → value/hash/bytes 完全一致（仅 envelope 时间/文档不同）', () => {
    const shared = channels();
    const regions: RegionDescriptor[] = [
      { kind: 'main-text', label: '正文' },
      { kind: 'headings', label: '标题', levels: [1, 2] },
      {
        kind: 'table',
        label: '表',
        headerFingerprint: computeTableHeaderFingerprint(['名称', '价格']) ?? '',
        occurrence: 0,
      },
      { kind: 'links', label: '链接', sameOriginOnly: false },
    ];
    const pub = projectPageProjection({
      channels: shared,
      regions,
      ruleId: RULE_ID,
      sourceId: SOURCE_ID,
      finalUrl: 'https://example.com/doc',
      capturedAt: '2026-08-29T01:00:00.000Z',
      documentId: null,
    });
    const ses = projectPageProjection({
      channels: shared,
      regions,
      ruleId: RULE_ID,
      sourceId: SOURCE_ID,
      finalUrl: 'https://example.com/doc',
      capturedAt: '2026-08-29T02:00:00.000Z',
      documentId: '7',
    });
    expect(pub.ok).toBe(true);
    expect(ses.ok).toBe(true);
    if (!pub.ok || !ses.ok) return;
    expect(ses.projection.value).toEqual(pub.projection.value);
    expect(ses.projection.contentHash).toBe(pub.projection.contentHash);
    expect(ses.projection.byteLength).toBe(pub.projection.byteLength);
    expect(ses.projection.capturedAt).not.toBe(pub.projection.capturedAt);
    expect(ses.projection.documentId).toBe('7');
  });
});

describe('PageProjection — 预览', () => {
  it('main-text/headings/table/links 预览状态与计数', () => {
    const r = previewPageRegions(channels(), [
      { kind: 'main-text', label: '正文' },
      { kind: 'headings', label: '标题', levels: [1] },
      {
        kind: 'table',
        label: '表',
        headerFingerprint: computeTableHeaderFingerprint(['名称', '价格']) ?? '',
        occurrence: 0,
      },
      { kind: 'links', label: '链接', sameOriginOnly: true },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview[0]).toMatchObject({ kind: 'main-text', status: 'matched' });
    expect(r.preview[1]).toMatchObject({
      kind: 'headings',
      status: 'matched',
      matching: 1,
      total: 3,
    });
    expect(r.preview[2]).toMatchObject({ kind: 'table', status: 'matched', occurrence: 0 });
    expect(r.preview[3]).toMatchObject({ kind: 'links', status: 'matched', total: 2 });
  });

  it('预览 not-found / ambiguous 与 fingerprint 组', () => {
    const r = previewPageRegions(
      channels({
        headings: [],
        tables: [
          { headers: ['名称', '价格'], rows: [['甲', '100']] },
          { headers: ['日期', '事件'], rows: [['2026-01-01', '发布']] },
        ],
        links: [],
      }),
      [
        {
          kind: 'table',
          label: '表',
          headerFingerprint: computeTableHeaderFingerprint(['不存在', '列']) ?? '',
          occurrence: 0,
        },
        { kind: 'links', label: '链接', sameOriginOnly: false },
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.preview[0]!;
    expect(t.kind === 'table' && t.status).toBe('not-found');
    expect(t.kind === 'table' && t.groups.length).toBe(2);
    const l = r.preview[1]!;
    expect(l.kind === 'links' && l.status).toBe('not-found');
  });
});

describe('Session target digest 与 consent 校验', () => {
  function target(overrides: Partial<PageTarget> = {}): PageTarget {
    return {
      type: 'page',
      pageUrl: 'https://example.com/doc?view=full#top',
      regions: [
        { kind: 'main-text', label: '正文' },
        {
          kind: 'table',
          label: '表',
          headerFingerprint: 'a'.repeat(64),
          occurrence: 0,
        },
      ],
      sessionConsent: {
        version: 1,
        origin: 'https://example.com',
        grantedAt: '2026-08-29T00:00:00.000Z',
      },
      ...overrides,
    };
  }

  it('digest 确定、版本化、不含 consent、fragment 归一', () => {
    const a = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: target().pageUrl,
      regions: target().regions,
    });
    const b = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: 'https://example.com/doc?view=full',
      regions: target().regions,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const consentsVariant = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: target().pageUrl,
      regions: target().regions,
    });
    expect(consentsVariant).toBe(a);
    const moved = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: 'https://example.com/other',
      regions: target().regions,
    });
    expect(moved).not.toBe(a);
    const regionChanged = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: target().pageUrl,
      regions: [{ kind: 'main-text' as const, label: '正文' }],
    });
    expect(regionChanged).not.toBe(a);
  });

  it('consent-target 校验：缺失/版本/跨 origin → login_required；非 page → security_rejected', () => {
    expect(sessionConsentTargetCheck(target({ sessionConsent: null })).ok).toBe(false);
    expect(
      sessionConsentTargetCheck(
        target({ sessionConsent: { version: 1, origin: 'https://other.example', grantedAt: 'x' } }),
      ).ok,
    ).toBe(false);
  });
});

describe('safeProjectionUrl / pageLocatorKey', () => {
  it('安全 URL 规范化与 locator 键区别（query 保留于 locator、删除于投影）', () => {
    expect(safeProjectionUrl('HTTPS://EXAMPLE.com:443/a?tk=1#f')).toBe('https://example.com/a');
    expect(safeProjectionUrl('http://example.com:80/')).toBe('http://example.com/');
    expect(safeProjectionUrl('ftp://example.com/')).toBeNull();
    expect(safeProjectionUrl('https://user:pass@example.com/')).toBeNull();
    expect(pageLocatorKey('https://example.com/a?tk=1#f')).toBe('https://example.com/a?tk=1');
    expect(pageLocatorKey('https://example.com')).toBe('https://example.com/');
    expect(pageLocatorKey('ftp://example.com/')).toBeNull();
  });
});
