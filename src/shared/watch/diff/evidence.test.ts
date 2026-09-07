import { describe, expect, it } from 'vitest';
import type { PageProjectionField } from '../../types/watch';
import { isValidPageProjectionValue } from './evidence';

const base = { fieldKey: 'r0:main', regionIndex: 0, label: '测试区域' };
const fields: PageProjectionField[] = [
  { ...base, kind: 'main-text', value: '正文' },
  { ...base, fieldKey: 'r0:heading:1', kind: 'heading', level: 1, ordinal: 1, value: '标题' },
  {
    ...base,
    fieldKey: 'r0:table-header:0',
    kind: 'table-header',
    occurrence: 0,
    column: 0,
    value: '价格',
  },
  {
    ...base,
    fieldKey: 'r0:table-cell:0:0',
    kind: 'table-cell',
    occurrence: 0,
    row: 0,
    column: 0,
    columnLabel: '价格',
    value: '99',
  },
  {
    ...base,
    fieldKey: 'r0:link:1',
    kind: 'link',
    ordinal: 1,
    text: '来源',
    url: 'https://example.com/news?q=1#section',
  },
];
const valid = (field: unknown): boolean =>
  isValidPageProjectionValue({ type: 'page', fields: [field] });

describe('PageProjection 按字段种类闭合验证', () => {
  it.each(fields)('接受合法 $kind 字段及其独有元数据', (field) => {
    expect(valid(field)).toBe(true);
  });

  it('接受正式资格投影中的零序号 heading', () => {
    expect(valid({ ...base, kind: 'heading', level: 1, ordinal: 0, value: '有界填充' })).toBe(true);
  });

  it.each(['heading', 'table-header', 'table-cell', 'link'])(
    '拒绝缺少 %s 独有字段的五键伪投影',
    (kind) => {
      expect(valid({ ...base, kind, value: '伪字段' })).toBe(false);
    },
  );

  it.each(fields)('拒绝 $kind 的额外字段和缺少必需字段', (field) => {
    expect(valid({ ...field, unexpected: true })).toBe(false);
    for (const key of Object.keys(field)) {
      const missing: Record<string, unknown> = { ...field };
      delete missing[key];
      expect(valid(missing), key).toBe(false);
    }
  });

  it('拒绝非法枚举、坐标、类型、链接与原型', () => {
    const heading = fields[1]!;
    for (const level of [0, 4, '1', null]) expect(valid({ ...heading, level })).toBe(false);
    for (const ordinal of [-1, 0.5, NaN, Infinity, '1'])
      expect(valid({ ...heading, ordinal })).toBe(false);
    for (const regionIndex of [-1, 0.5, '0'])
      expect(valid({ ...heading, regionIndex })).toBe(false);
    const cell = fields[3]!;
    for (const key of ['occurrence', 'row', 'column']) {
      expect(valid({ ...cell, [key]: -1 })).toBe(false);
      expect(valid({ ...cell, [key]: 0.5 })).toBe(false);
    }
    expect(valid({ ...cell, columnLabel: 7 })).toBe(false);
    const link = fields[4]!;
    expect(valid({ ...link, text: null })).toBe(false);
    expect(valid({ ...link, url: 'javascript:alert(1)' })).toBe(false);
    expect(valid({ ...link, url: 'https://user:secret@example.com/' })).toBe(false);
    expect(valid({ ...heading, level: 1, value: 42 })).toBe(false);
    expect(valid(Object.assign(Object.create({ injected: true }), fields[0]))).toBe(false);
    expect(valid({ ...fields[0], kind: 'unknown' })).toBe(false);
  });
});
