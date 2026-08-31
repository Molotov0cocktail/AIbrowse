import { serializeCsv } from '../../shared/csv/csv-serializer';
import type { ChangeEvidencePair, DigestFacts } from '../../shared/types/watch';
import type { WatchIpcErrorCode, WatchIpcResult } from '../../shared/types/watch-ipc';
import type { WatchQueryService } from './watch-query-service';

export const MAX_WATCH_EXPORT_ROWS = 5_000;
export const MAX_WATCH_EXPORT_BYTES = 8 * 1024 * 1024;
export const MAX_WATCH_MARKDOWN_BYTES = 262_144;

export interface WatchExportPort {
  showSaveDialog(kind: 'csv' | 'markdown', defaultFileName: string): Promise<string | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

const failure = <T>(errorCode: WatchIpcErrorCode): WatchIpcResult<T> => ({ ok: false, errorCode });

function markdownText(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    cleaned +=
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
        ? ' '
        : character;
  }
  let escaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
  for (const marker of [
    '\\',
    '`',
    '*',
    '_',
    '{',
    '}',
    '[',
    ']',
    '(',
    ')',
    '#',
    '+',
    '.',
    '!',
    '|',
    '~',
    '-',
  ])
    escaped = escaped.replaceAll(marker, `\\${marker}`);
  return escaped;
}

function safeHttpUrl(value: string): string | null {
  if (/\s/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    )
      return null;
    return url.toString().replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  } catch {
    return null;
  }
}

function evidenceLines(pair: ChangeEvidencePair): string[] {
  const beforeUrl = safeHttpUrl(pair.beforeFinalUrl);
  const afterUrl = safeHttpUrl(pair.afterFinalUrl);
  return [
    `- 字段：${markdownText(pair.label)}`,
    `  - 之前：${markdownText(JSON.stringify(pair.before))}`,
    `  - 之后：${markdownText(JSON.stringify(pair.after))}`,
    `  - 之前来源：${beforeUrl === null ? '不可用' : `[链接](${beforeUrl})`}`,
    `  - 之后来源：${afterUrl === null ? '不可用' : `[链接](${afterUrl})`}`,
  ];
}

export function renderDigestMarkdown(input: {
  facts: DigestFacts;
  explanation: unknown;
}): { text: string; bytes: number } | null {
  const lines = [
    '# AIbrowse 监控摘要',
    '',
    `生成时间：${markdownText(input.facts.fetchedAt)}`,
    '',
    `事件数：${input.facts.eventCount}`,
    '',
  ];
  for (const event of input.facts.events) {
    lines.push(`## 事件 ${markdownText(event.eventId)}`, '');
    const state = input.facts.referenceStates[event.eventId];
    if (state !== 'active') {
      lines.push(state === 'user-deleted' ? '该事件已由用户删除。' : '该事件证据已过保留期。', '');
      continue;
    }
    for (const pair of input.facts.evidenceMap[event.eventId] ?? [])
      lines.push(...evidenceLines(pair));
    lines.push('');
  }
  if (input.explanation !== null && typeof input.explanation === 'object') {
    const sections = (input.explanation as { sections?: unknown }).sections;
    if (Array.isArray(sections)) {
      lines.push('## 可选 AI 解释', '');
      for (const section of sections) {
        const ids =
          typeof section === 'object' && section !== null
            ? (section as { eventIds?: unknown }).eventIds
            : null;
        if (
          Array.isArray(ids) &&
          ids.every(
            (id) => typeof id === 'string' && input.facts.referenceStates[id] === 'active',
          ) &&
          typeof (section as { explanation?: unknown }).explanation === 'string'
        )
          lines.push(markdownText((section as { explanation: string }).explanation), '');
      }
    }
  }
  const text = `${lines.join('\n')}\n`;
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes <= MAX_WATCH_MARKDOWN_BYTES ? { text, bytes } : null;
}

export class WatchExportService {
  constructor(
    private readonly query: WatchQueryService,
    private readonly port: WatchExportPort,
  ) {}

  async exportEventsCsv(
    filter: Record<string, unknown>,
  ): Promise<WatchIpcResult<{ exportedRows: number; exportedBytes: number }>> {
    const rows: string[][] = [];
    for (let page = 1; rows.length < MAX_WATCH_EXPORT_ROWS; page += 1) {
      const result = this.query.listEvents({ page, pageSize: 50, filter, selectedEventId: null });
      if (result === null) return failure('unavailable');
      for (const item of result.items)
        rows.push([
          item.id,
          item.sourceName,
          item.eventKind,
          item.importance,
          item.firstObservedAt,
          item.lastObservedAt,
          String(item.itemCount),
          item.read ? '已读' : '未读',
        ]);
      if (result.items.length < 50 || rows.length >= result.total) break;
    }
    if (rows.length >= MAX_WATCH_EXPORT_ROWS) {
      const probe = this.query.listEvents({
        page: 101,
        pageSize: 1,
        filter,
        selectedEventId: null,
      });
      if (probe !== null && probe.total > MAX_WATCH_EXPORT_ROWS) return failure('budget-exceeded');
    }
    const csv = serializeCsv(
      ['事件 ID', '来源', '变化类型', '重要性', '首次观察', '最后观察', '条目数', '状态'],
      rows,
    );
    if (csv.utf8Bytes > MAX_WATCH_EXPORT_BYTES) return failure('budget-exceeded');
    const path = await this.port.showSaveDialog('csv', 'watch-events.csv');
    if (path === null) return failure('cancelled');
    if (!/\.csv$/iu.test(path)) return failure('write-failed');
    try {
      await this.port.write(path, new TextEncoder().encode(csv.text));
    } catch {
      return failure('write-failed');
    }
    return { ok: true, value: { exportedRows: rows.length, exportedBytes: csv.utf8Bytes } };
  }

  async exportDigestMarkdown(digestId: string): Promise<WatchIpcResult<{ exportedBytes: number }>> {
    const digest = this.query.getDigest(digestId);
    if (digest === null) return failure('not-found');
    const rendered = renderDigestMarkdown(digest);
    if (rendered === null) return failure('budget-exceeded');
    const path = await this.port.showSaveDialog('markdown', 'watch-digest.md');
    if (path === null) return failure('cancelled');
    if (!/\.md$/iu.test(path)) return failure('write-failed');
    try {
      await this.port.write(path, new TextEncoder().encode(rendered.text));
    } catch {
      return failure('write-failed');
    }
    return { ok: true, value: { exportedBytes: rendered.bytes } };
  }
}
