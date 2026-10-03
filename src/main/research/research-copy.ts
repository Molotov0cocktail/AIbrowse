import type { ResearchService } from '../../shared/types/research';
import { applyTableView, buildTableCopyText } from '../../shared/research/table-utils';
import { validateResearchExportCsvPayload } from './research-ipc';
import { normalizePlainText } from '../../shared/markdown/markdown-text';

/** Only a verified persisted table can reach the clipboard; renderer supplies its view. */
export async function copyResearchTable(
  payload: unknown,
  service: Pick<ResearchService, 'getResearchResultView'> | null,
  writeText: (text: string) => void,
  isCurrent: () => boolean,
): Promise<boolean> {
  const parsed = validateResearchExportCsvPayload(payload);
  if (!parsed.ok || service === null || !isCurrent()) return false;
  const result = await service.getResearchResultView(parsed.value.taskId);
  if (!result.ok || !isCurrent()) return false;
  const block = result.view.result.blocks[parsed.value.tableBlockIndex];
  if (block === undefined || block.kind !== 'table') return false;
  const projected = applyTableView(block.columns, block.rows, parsed.value.view);
  try {
    writeText(
      buildTableCopyText(
        projected.columns.map(normalizePlainText),
        projected.rows.map((row) => row.map(normalizePlainText)),
      ),
    );
    return true;
  } catch {
    return false;
  }
}
