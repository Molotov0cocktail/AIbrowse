// C8 决议 #160：TableView 纯函数（排序/筛选/复制）——shared 模块（renderer
// UI 与主进程 CSV 重投影共用同一实现；依赖方向 UI → main，主进程不反向依赖
// renderer）。输入不修改、输出确定性、幂等。排序用原始字符串二元比较
// （< / >，与 SQLite BINARY 排序一致——不用 localeCompare）；相等按原始
// row index 稳定收尾。筛选为全行任一单元格包含规范化（小写）查询；查询
// ≤TABLE_FILTER_MAX_CHARS（超长确定性截断）；空查询恢复全部；不使用无界
// 正则。spreadsheet-cell 防护（=,+,-,@、TAB、CR 前缀加单引号）与 CSV
// serializer 共用（决议 #160(7)/#161(5)）。
export const TABLE_FILTER_MAX_CHARS = 200;

export interface TableSortState {
  columnIndex: number; // 非负整数（< columns.length；非法安全忽略排序）
  direction: 'asc' | 'desc';
}

export interface TableViewState {
  sort: TableSortState | null;
  filter: string; // 空串 = 全部；超长确定性截断
}

export interface TableViewResult {
  columns: string[];
  rows: string[][];
}

// 决议 #160(7)：spreadsheet-cell 防护——以 =、+、-、@、TAB、CR 开头时加单引号
// （防复制/导出后直接粘贴进电子表格执行公式）
export function protectSpreadsheetCell(value: string): string {
  if (value.length === 0) return value;
  const first = value.charCodeAt(0);
  if (
    first === 0x3d || // =
    first === 0x2b || // +
    first === 0x2d || // -
    first === 0x40 || // @
    first === 0x09 || // TAB
    first === 0x0d // CR
  ) {
    return `'${value}`;
  }
  return value;
}

// 原始字符串二元比较（决议 #160(2)：非 localeCompare）
function compareCells(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 决议 #160(2)/(3)：筛选 + 排序。输入零修改；非法 columnIndex 安全忽略排序
// （原序）；筛选为全行任一单元格包含规范化查询（小写）。稳定排序：相等项
// 按原始 row index 收尾。
export function applyTableView(
  columns: string[],
  rows: string[][],
  view: TableViewState,
): TableViewResult {
  const filter =
    typeof view?.filter === 'string' ? view.filter.slice(0, TABLE_FILTER_MAX_CHARS) : '';
  const normalized = filter.toLocaleLowerCase();
  const filtered: Array<{ row: string[]; index: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (normalized === '') {
      filtered.push({ row, index: i });
      continue;
    }
    let hit = false;
    for (const cell of row) {
      if (cell.toLocaleLowerCase().includes(normalized)) {
        hit = true;
        break;
      }
    }
    if (hit) filtered.push({ row, index: i });
  }
  const sort = view?.sort ?? null;
  if (
    sort !== null &&
    Number.isInteger(sort.columnIndex) &&
    sort.columnIndex >= 0 &&
    sort.columnIndex < columns.length &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    const col = sort.columnIndex;
    const dir = sort.direction === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const av = a.row[col] ?? '';
      const bv = b.row[col] ?? '';
      const cmp = compareCells(av, bv);
      if (cmp !== 0) return cmp * dir;
      return a.index - b.index; // 稳定收尾（原始 row index）
    });
  }
  return { columns, rows: filtered.map((f) => f.row) };
}

// 决议 #160(5)：复制内容 = header + 当前排序/筛选后的 rows，TSV + CRLF；
// 每个单元格经 spreadsheet-cell 防护（TSV 与 CSV 共用）
export function buildTableCopyText(columns: string[], rows: string[][]): string {
  const lines: string[] = [columns.map(protectSpreadsheetCell).join('\t')];
  for (const row of rows) {
    lines.push(row.map(protectSpreadsheetCell).join('\t'));
  }
  return `${lines.join('\r\n')}\r\n`;
}
