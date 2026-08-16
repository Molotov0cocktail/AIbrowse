// C8 决议 #161/#162：CSV 序列化纯函数（shared/main 可复用模块——主进程
// export-csv 与 renderer 不得各自实现；依赖方向 UI → main）。字节契约：
// UTF-8 BOM + CRLF + RFC 4180 同族引用（含分隔符/引号/换行单元格整体双引号
// 包裹、内部双引号双写）+ spreadsheet-cell 公式防护在 quoting 前执行 +
// MAX_CSV_EXPORT_BYTES 编译期上限（超限零写入由 adapter 层执行，此处暴露
// 字节计数）+ 空表 + 超长单元格截断 + 输入零修改输出确定性。
import { describe, expect, it } from 'vitest';
import {
  MAX_CSV_EXPORT_BYTES,
  csvQuoteCell,
  protectSpreadsheetCell,
  serializeCsv,
} from './csv-serializer';

describe('serializeCsv 字节契约（决议 #161(5)）', () => {
  it('BOM + header + CRLF 行尾', () => {
    const out = serializeCsv(['名称', '数值'], [['甲', '1']]);
    expect(out.text.startsWith('﻿')).toBe(true);
    expect(out.text).toBe('﻿名称,数值\r\n甲,1\r\n');
    // UTF-8 字节：BOM 3 字节（TextEncoder——shared 零 Node API 依赖）
    expect(out.utf8Bytes).toBe(new TextEncoder().encode(out.text).byteLength);
  });

  it('逗号/引号/换行按 RFC 4180 同族引用（整体双引号包裹、内部双引号双写）', () => {
    const out = serializeCsv(
      ['a', 'b'],
      [
        ['含,逗号', '含"引号'],
        ['含\n换行', '含\r\n换行'],
      ],
    );
    expect(out.text).toContain('"含,逗号"');
    expect(out.text).toContain('"含""引号"');
    expect(out.text).toContain('"含\n换行"');
    expect(out.text).toContain('"含\r\n换行"');
    expect(out.text).toContain('\r\n');
  });

  it('公式注入防护在 quoting 前执行（=,+,-,@、TAB、CR 前缀加单引号）', () => {
    const out = serializeCsv(['值'], [['=cmd|/C calc'], ['+1+2'], ['-1+1'], ['@SUM'], ['\tx']]);
    expect(out.text).toContain("'=cmd|/C calc");
    expect(out.text).toContain("'+1+2");
    expect(out.text).toContain("'-1+1");
    expect(out.text).toContain("'@SUM");
    expect(out.text).toContain("'\tx");
    // 防护后的单元格无需再引号包裹（无分隔符/引号/换行）
    expect(out.text).not.toContain('"\'');
  });

  it('空表：columns/rows 空 → 仅 BOM（零行）', () => {
    const out = serializeCsv([], []);
    expect(out.text).toBe('﻿');
    expect(out.utf8Bytes).toBe(3);
  });

  it('columns 非空 rows 空 → header 行 + CRLF（尾行仍 CRLF）', () => {
    const out = serializeCsv(['a', 'b'], []);
    expect(out.text).toBe('﻿a,b\r\n');
  });

  it('超长单元格确定性截断（≤MAX_TABLE_CELL_CHARS 由 Validator 保证——serializer 纵深防御）', () => {
    const long = '长'.repeat(500);
    const out = serializeCsv(['c'], [[long]]);
    // 截断至 200 字符 + 截断标记
    expect(out.text.length).toBeLessThan('﻿c\r\n'.length + 500);
    expect(out.text).toContain('已截断');
  });

  it('MAX_CSV_EXPORT_BYTES 边界：合法输入恒低于上限；超限输入字节计数正确暴露', () => {
    expect(MAX_CSV_EXPORT_BYTES).toBeGreaterThan(0);
    const big = serializeCsv(['c'], [[ 'x'.repeat(200) ]]);
    expect(big.utf8Bytes).toBeLessThan(MAX_CSV_EXPORT_BYTES);
    // 多字节字符字节计数准确（中文 3 字节/字符）
    const zh = serializeCsv(['中'], [['文']]);
    expect(zh.utf8Bytes).toBe(new TextEncoder().encode(zh.text).byteLength);
    expect(zh.utf8Bytes).toBeGreaterThan(zh.text.length);
  });

  it('输入零修改输出确定性（同一输入两次序列化字节恒等）', () => {
    const columns = ['a'];
    const rows = [['=x'], ['y,y'], ['z']];
    const a = serializeCsv(columns, rows);
    const b = serializeCsv(columns, rows);
    expect(a.text).toBe(b.text);
    expect(a.utf8Bytes).toBe(b.utf8Bytes);
  });
});

describe('csvQuoteCell（RFC 4180 同族）', () => {
  it('普通单元格原样（无分隔符/引号/换行不加引号）', () => {
    expect(csvQuoteCell('普通')).toBe('普通');
    expect(csvQuoteCell('')).toBe('');
  });

  it('含逗号/引号/换行/CR → 整体双引号包裹 + 内部双引号双写', () => {
    expect(csvQuoteCell('a,b')).toBe('"a,b"');
    expect(csvQuoteCell('a"b')).toBe('"a""b"');
    expect(csvQuoteCell('a\nb')).toBe('"a\nb"');
    expect(csvQuoteCell('a\r\nb')).toBe('"a\r\nb"');
    expect(csvQuoteCell('a,b"c\nd')).toBe('"a,b""c\nd"');
  });
});

describe('protectSpreadsheetCell（与 table-utils 共用语义）', () => {
  it('=,+,-,@、TAB、CR 前缀加单引号', () => {
    expect(protectSpreadsheetCell('=1')).toBe("'=1");
    expect(protectSpreadsheetCell('+1')).toBe("'+1");
    expect(protectSpreadsheetCell('-1')).toBe("'-1");
    expect(protectSpreadsheetCell('@1')).toBe("'@1");
    expect(protectSpreadsheetCell('\t1')).toBe("'\t1");
    expect(protectSpreadsheetCell('\r1')).toBe("'\r1");
  });

  it('非危险前缀原样返回', () => {
    expect(protectSpreadsheetCell('普通')).toBe('普通');
    expect(protectSpreadsheetCell('a=1')).toBe('a=1');
    expect(protectSpreadsheetCell('')).toBe('');
  });
});
