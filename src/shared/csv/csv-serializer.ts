// C8 决议 #161/#162：CSV 序列化纯函数（shared 模块——主进程 export-csv
// 与 renderer 展示共用同一实现；依赖方向 UI → main，主进程不反向依赖
// renderer）。字节契约：UTF-8 BOM + CRLF 行尾 + RFC 4180 同族引用（含
// 逗号/引号/换行的单元格整体双引号包裹、内部双引号写成两个双引号）+
// spreadsheet-cell 公式防护在 CSV quoting **前**执行（与 table-utils 共用
// protectSpreadsheetCell——决议 #160(7)）+ MAX_CSV_EXPORT_BYTES 编译期
// 上限（UTF-8 字节；超限零写入由 adapter 层执行，本模块暴露精确字节计数）+
// 空表 + 超长单元格防御性截断 + 输入零修改输出确定性。零 Node/Electron API
// （TextEncoder 为 Web/Node 双环境可用）——renderer 可安全 import。
import { protectSpreadsheetCell } from '../research/table-utils';
import { MAX_TABLE_CELL_CHARS } from '../types/research';

// 编译期 CSV 导出字节上限（决议 #161(6)：按 UTF-8 字节检查；超限零写入）。
// 覆盖最大合法 Table（MAX_TABLE_ROWS × MAX_TABLE_COLUMNS × 单元格 200 字符
// × UTF-8 最多 4 字节）+ 引号/分隔符/CRLF 膨胀余量。
export const MAX_CSV_EXPORT_BYTES = 4_000_000;

export const CSV_BOM = '﻿';
const CSV_TRUNCATION_MARK = '…（已截断）';

// 决议 #160(7)：spreadsheet-cell 防护与 table-utils 共用（单一事实源；
// re-export 供 CSV 模块消费者按需引用）
export { protectSpreadsheetCell } from '../research/table-utils';

// RFC 4180 同族引用：含逗号/引号/换行/CR 时整体双引号包裹 + 内部双引号双写
export function csvQuoteCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// 防御性截断（Validator 已保证 ≤MAX_TABLE_CELL_CHARS；纵深防御覆盖绕过路径；
// 截断不拆 UTF-16 surrogate pair）
function truncateCell(value: string): string {
  if (value.length <= MAX_TABLE_CELL_CHARS) return value;
  let cut = value.slice(0, MAX_TABLE_CELL_CHARS - CSV_TRUNCATION_MARK.length);
  if (cut.length > 0) {
    const code = cut.charCodeAt(cut.length - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut = cut.slice(0, -1); // 高位代理单独截断
  }
  return `${cut}${CSV_TRUNCATION_MARK}`;
}

export interface SerializedCsv {
  text: string;
  utf8Bytes: number; // TextEncoder 字节数（与 Buffer.byteLength 一致）
}

export function serializeCsv(columns: string[], rows: string[][]): SerializedCsv {
  // 空表（columns 为空）：仅 BOM（零行——不产生 header 空行）
  if (columns.length === 0) {
    return { text: CSV_BOM, utf8Bytes: new TextEncoder().encode(CSV_BOM).byteLength };
  }
  const lines: string[] = [];
  const pushRow = (cells: readonly string[]): void => {
    lines.push(cells.map((c) => csvQuoteCell(protectSpreadsheetCell(truncateCell(c)))).join(','));
  };
  pushRow(columns);
  for (const row of rows) pushRow(row);
  const text = `${CSV_BOM}${lines.join('\r\n')}${lines.length > 0 ? '\r\n' : ''}`;
  return { text, utf8Bytes: new TextEncoder().encode(text).byteLength };
}
