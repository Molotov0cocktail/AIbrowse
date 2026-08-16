// C8 决议 #160：TableView 纯函数（排序/筛选/复制）——输入不修改、输出确定性。
// 排序用原始字符串二元比较（非 localeCompare）；相等按原始 row index 稳定收尾；
// 筛选为全行任一单元格包含规范化查询（≤200，无正则）；复制 = header + 当前
// 视图 rows 的 TSV + CRLF；spreadsheet-cell 防护（=,+,-,@、TAB、CR 前缀加
// 单引号）与 CSV 共用。
import { describe, expect, it } from 'vitest';
import {
  applyTableView,
  buildTableCopyText,
  protectSpreadsheetCell,
  TABLE_FILTER_MAX_CHARS,
  type TableViewState,
} from '../../../shared/research/table-utils';

const COLUMNS = ['名称', '数值'];
const ROWS = [
  ['乙', '2'],
  ['甲', '10'],
  ['甲', '1'],
  ['丙', '3'],
];

describe('applyTableView 排序（决议 #160(2)）', () => {
  it('asc：原始字符串二元比较（非 localeCompare——数字字符串不按数值）', () => {
    const view: TableViewState = { sort: { columnIndex: 1, direction: 'asc' }, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    // 二元比较：'1' < '10' < '2' < '3'（非数值序、非 localeCompare 的本地化序）
    expect(rows.map((r) => r[1])).toEqual(['1', '10', '2', '3']);
  });

  it('desc：原始字符串二元比较降序', () => {
    const view: TableViewState = { sort: { columnIndex: 1, direction: 'desc' }, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows.map((r) => r[1])).toEqual(['3', '2', '10', '1']);
  });

  it('相等项按原始 row index 稳定收尾（甲-10 在 甲-1 之前）', () => {
    const view: TableViewState = { sort: { columnIndex: 0, direction: 'asc' }, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    // UTF-16 码元序：丙(U+4E19) < 乙(U+4E59) < 甲(U+7532)——确定性二元比较
    expect(rows.map((r) => r[0])).toEqual(['丙', '乙', '甲', '甲']);
    // 稳定：两个「甲」保持原始相对顺序（10 在 1 之前）
    expect(rows[2]![1]).toBe('10');
    expect(rows[3]![1]).toBe('1');
  });

  it('Unicode/中文：按 UTF-16 码元序二元比较（确定性）', () => {
    const rows = [['中'], ['a'], ['文'], ['A'], ['z']];
    const view: TableViewState = { sort: { columnIndex: 0, direction: 'asc' }, filter: '' };
    const { rows: out } = applyTableView(['列'], rows, view);
    expect(out.map((r) => r[0])).toEqual(['A', 'a', 'z', '中', '文']);
  });

  it('空值（空串）参与排序：空串码元序最前', () => {
    const rows = [['b'], [''], ['a']];
    const view: TableViewState = { sort: { columnIndex: 0, direction: 'asc' }, filter: '' };
    const { rows: out } = applyTableView(['列'], rows, view);
    expect(out.map((r) => r[0])).toEqual(['', 'a', 'b']);
  });

  it('非法 columnIndex（负数/越界/非整数）→ 安全忽略排序（原序）', () => {
    for (const bad of [-1, 99, 1.5, NaN]) {
      const view: TableViewState = {
        sort: { columnIndex: bad, direction: 'asc' },
        filter: '',
      };
      const { rows } = applyTableView(COLUMNS, ROWS, view);
      expect(rows).toEqual(ROWS);
    }
  });

  it('sort=null（无排序）→ 原序', () => {
    const view: TableViewState = { sort: null, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows).toEqual(ROWS);
  });
});

describe('applyTableView 筛选（决议 #160(3)）', () => {
  it('全行任一单元格包含规范化查询即保留（大小写不敏感）', () => {
    const view: TableViewState = { sort: null, filter: '甲' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r[0])).toEqual(['甲', '甲']);
  });

  it('查询匹配其他列（非首列）同样保留', () => {
    const view: TableViewState = { sort: null, filter: '10' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(['甲', '10']);
  });

  it('空查询恢复全部（原序）', () => {
    const view: TableViewState = { sort: null, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows).toEqual(ROWS);
  });

  it('无命中 → 空数组（非错误）', () => {
    const view: TableViewState = { sort: null, filter: '不存在的查询' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows).toEqual([]);
  });

  it('查询长度边界：=TABLE_FILTER_MAX_CHARS 合法；超长确定性截断', () => {
    const exact = 'x'.repeat(TABLE_FILTER_MAX_CHARS);
    expect(applyTableView(COLUMNS, ROWS, { sort: null, filter: exact }).rows.length).toBe(0);
    const over = 'y'.repeat(TABLE_FILTER_MAX_CHARS + 10);
    // 截断后仍确定性执行（不抛异常）
    expect(() => applyTableView(COLUMNS, ROWS, { sort: null, filter: over })).not.toThrow();
  });

  it('输入零修改（rows/columns/view 深冻结语义：调用后原数组不变）', () => {
    const view: TableViewState = { sort: { columnIndex: 0, direction: 'desc' }, filter: '甲' };
    const before = JSON.stringify({ columns: COLUMNS, rows: ROWS, view });
    applyTableView(COLUMNS, ROWS, view);
    expect(JSON.stringify({ columns: COLUMNS, rows: ROWS, view })).toBe(before);
  });

  it('筛选与排序组合：先筛选后排序（确定语义）', () => {
    const view: TableViewState = { sort: { columnIndex: 1, direction: 'asc' }, filter: '甲' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    expect(rows.map((r) => r[1])).toEqual(['1', '10']);
  });
});

describe('buildTableCopyText（决议 #160(5)）', () => {
  it('header + 当前视图 rows 的 TSV + CRLF；行顺序与 UI 逐项一致', () => {
    const view: TableViewState = { sort: { columnIndex: 1, direction: 'desc' }, filter: '' };
    const { rows } = applyTableView(COLUMNS, ROWS, view);
    const text = buildTableCopyText(COLUMNS, rows);
    expect(text).toBe('名称\t数值\r\n丙\t3\r\n乙\t2\r\n甲\t10\r\n甲\t1\r\n');
  });

  it('空 rows → 仅 header 行 + CRLF', () => {
    expect(buildTableCopyText(COLUMNS, [])).toBe('名称\t数值\r\n');
  });

  it('spreadsheet-cell 防护作用于复制文本（=,+,-,@、TAB、CR 前缀加单引号）', () => {
    const rows = [['=cmd'], ['+1'], ['-1'], ['@x'], ['\ttab'], ['\rcr'], ['普通']];
    const text = buildTableCopyText(['值'], rows);
    expect(text).toContain("'=cmd\r\n");
    expect(text).toContain("'+1\r\n");
    expect(text).toContain("'-1\r\n");
    expect(text).toContain("'@x\r\n");
    expect(text).toContain("'\ttab\r\n");
    expect(text).toContain("'\rcr\r\n");
    expect(text).toContain('普通');
  });
});

describe('protectSpreadsheetCell（决议 #160(7)）', () => {
  it('=,+,-,@、TAB、CR 前缀 → 前加单引号', () => {
    expect(protectSpreadsheetCell('=1+1')).toBe("'=1+1");
    expect(protectSpreadsheetCell('+1')).toBe("'+1");
    expect(protectSpreadsheetCell('-1')).toBe("'-1");
    expect(protectSpreadsheetCell('@SUM')).toBe("'@SUM");
    expect(protectSpreadsheetCell('\tx')).toBe("'\tx");
    expect(protectSpreadsheetCell('\rx')).toBe("'\rx");
  });

  it('非危险前缀原样返回；空串/纯空白原样', () => {
    expect(protectSpreadsheetCell('普通文本')).toBe('普通文本');
    expect(protectSpreadsheetCell('')).toBe('');
    expect(protectSpreadsheetCell('  a')).toBe('  a');
    // 前缀位置敏感：不是前缀不加引号
    expect(protectSpreadsheetCell('a=1')).toBe('a=1');
    expect(protectSpreadsheetCell('1+1')).toBe('1+1');
  });
});
