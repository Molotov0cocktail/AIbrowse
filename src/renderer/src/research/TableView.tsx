// C8 决议 #160：TableView 交互组件——表头点击排序（asc/desc 循环）、基础筛选、
// 清除筛选、复制当前视图（navigator.clipboard 仅明确用户点击后调用；失败显示
// 固定中文诊断，不记录单元格内容——FT-16）、CSV 导出触发（受限 view state）。
// 排序/筛选/复制文本由 shared 纯函数（table-utils）承担——本组件只做 UI 状态
// 与事件接线；输入（columns/rows）零修改。
import { useMemo, useState, type ReactElement } from 'react';
import {
  applyTableView,
  buildTableCopyText,
  TABLE_FILTER_MAX_CHARS,
  type TableViewState,
} from '../../../shared/research/table-utils';
import type { ExportCsvErrorCode, ExportCsvResult } from '../../../shared/types/research';
import { normalizePlainText } from '../../../shared/markdown/markdown-text';

export interface TableViewProps {
  columns: string[];
  rows: string[][];
  sourceRefs: string[];
  onSelectSource?: (candidateId: string) => void;
  onExportCsv?: (view: TableViewState) => Promise<ExportCsvResult> | ExportCsvResult;
  title?: string;
}

export function TableView({
  columns,
  rows,
  sourceRefs,
  onSelectSource,
  onExportCsv,
  title = '表格',
}: TableViewProps): ReactElement {
  const [sort, setSort] = useState<TableViewState['sort']>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null); // 固定中文诊断（复制/导出结果）

  const view: TableViewState = useMemo(() => ({ sort, filter }), [sort, filter]);
  const projected = useMemo(() => applyTableView(columns, rows, view), [columns, rows, view]);

  const toggleSort = (columnIndex: number): void => {
    setSort((prev) => {
      if (prev === null || prev.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'asc' };
      }
      return prev.direction === 'asc' ? { columnIndex, direction: 'desc' } : null; // desc → 清除排序（恢复原序）
    });
  };

  const clearFilter = (): void => {
    setFilter('');
    setNotice(null);
  };

  // 决议 #160(6)：Clipboard 只能在明确用户点击后调用 navigator.clipboard.writeText；
  // 失败显示固定中文诊断，不记录单元格内容
  const copyView = async (): Promise<void> => {
    setNotice(null);
    try {
      const text = buildTableCopyText(projected.columns, projected.rows);
      await navigator.clipboard.writeText(text);
      setNotice('已复制当前视图');
    } catch {
      setNotice('复制失败，请重试');
    }
  };

  const exportCsv = async (): Promise<void> => {
    setNotice(null);
    if (onExportCsv === undefined) return;
    try {
      const res = await onExportCsv(view);
      if (res.ok) {
        setNotice(`已导出 CSV（${res.rows} 行 × ${res.columns} 列）`);
      } else {
        setNotice(exportCsvErrorText(res.errorCode));
      }
    } catch {
      setNotice('导出失败，请重试');
    }
  };

  return (
    <div className="research-table-view">
      <div className="research-table-toolbar">
        <span className="research-table-title">{title}</span>
        <input
          type="text"
          className="research-table-filter"
          placeholder="筛选（≤200 字符）"
          maxLength={TABLE_FILTER_MAX_CHARS}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="表格筛选"
        />
        {filter !== '' && (
          <button type="button" className="research-table-clear" onClick={clearFilter}>
            清除筛选
          </button>
        )}
        <button type="button" className="research-table-copy" onClick={() => void copyView()}>
          复制当前视图
        </button>
        {onExportCsv !== undefined && (
          <button type="button" className="research-table-export" onClick={() => void exportCsv()}>
            导出 CSV
          </button>
        )}
      </div>
      {notice !== null && <div className="research-table-notice">{notice}</div>}
      <div className="research-table-scroll">
        <table className="research-table">
          <thead>
            <tr>
              {projected.columns.map((col, i) => (
                <th key={i}>
                  <button
                    type="button"
                    className="research-table-th"
                    onClick={() => toggleSort(i)}
                    title={`按「${col}」排序`}
                  >
                    {normalizePlainText(col)}
                    {sort !== null && sort.columnIndex === i && (
                      <span className="research-table-sort">
                        {sort.direction === 'asc' ? ' ↑' : ' ↓'}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projected.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{normalizePlainText(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sourceRefs.length > 0 && (
        <div className="research-source-refs">
          {sourceRefs.map((ref) => (
            <button
              key={ref}
              type="button"
              className="research-source-entry"
              data-candidate-id={ref}
              title="查看来源证据"
              onClick={onSelectSource === undefined ? undefined : () => onSelectSource(ref)}
            >
              来源
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function exportCsvErrorText(code: ExportCsvErrorCode): string {
  switch (code) {
    case 'cancelled':
      return '已取消导出';
    case 'invalid-block':
      return '表格不存在，请刷新结果';
    case 'not-found':
      return '任务不存在或已删除';
    case 'invalid-state':
      return '任务未完成，无法导出';
    case 'budget-exceeded':
      return '导出内容过大，无法导出';
    case 'write-failed':
      return '文件保存失败，请重试';
    case 'invalid-payload':
      return '导出失败，请重试';
    default:
      return '导出失败，请重试';
  }
}
