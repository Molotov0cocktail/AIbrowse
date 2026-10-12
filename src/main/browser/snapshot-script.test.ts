import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_SCRIPT_SOURCE } from './snapshot-script';
import { normalizeSnapshot } from './snapshot-normalize';

function element(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagName: 'DIV',
    textContent: text,
    offsetParent: {},
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    getClientRects: () => [{}],
    setAttribute: () => undefined,
    ...extra,
  };
}

function collect(groups: Record<string, unknown[]>): Record<string, unknown> {
  const raw: unknown = runInNewContext(SNAPSHOT_SCRIPT_SOURCE, {
    document: {
      title: '采集测试',
      readyState: 'complete',
      body: { innerText: '正文完整' },
      querySelectorAll: (selector: string) => groups[selector] ?? [],
    },
    location: { href: 'https://example.com/' },
    window: { scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600, getSelection: () => null },
  });
  expect(raw).toMatchObject({ ok: true });
  return raw as Record<string, unknown>;
}

const buttonSelector =
  'button, input[type=button], input[type=submit], input[type=reset], [role=button]';
const inputSelector = 'input:not([type=hidden]), textarea, select';
const long = 'x'.repeat(1001);

describe('采集脚本字段截断覆盖', () => {
  it.each([
    ['headings', 'h1, h2, h3, h4, h5, h6', element(long, { tagName: 'H1' })],
    ['links', 'a[href]', element(long, { href: 'https://example.com/next' })],
    ['links', 'a[href]', element('链接', { href: 'https://example.com/' + 'x'.repeat(2000) })],
    ['buttons', buttonSelector, element(long, { tagName: 'BUTTON' })],
    ['inputs', inputSelector, element('', { tagName: 'INPUT', type: 'text', value: long })],
    [
      'inputs',
      inputSelector,
      element('', {
        tagName: 'INPUT',
        type: 'text',
        value: '',
        getAttribute: (name: string) => (name === 'placeholder' ? long : null),
      }),
    ],
  ])('%s 字段在脚本内裁剪后仍明确标记不完整', (channel, selector, item) => {
    const raw = collect({ [selector]: [item], iframe: [{ contentDocument: null }] });
    expect(raw['truncated']).toContain(channel);
    expect(
      normalizeSnapshot(raw, { url: 'https://example.com/', title: '', documentId: 1 }).meta
        .mainDocument,
    ).toBe('incomplete');
  });

  it.each([true, false])('表格字段截断，含表头=%s，不因脚本先裁剪而丢失标志', (hasHeader) => {
    const row = {
      querySelector: () => (hasHeader ? {} : null),
      querySelectorAll: () => [element(long)],
    };
    const raw = collect({
      'table, [role=table]': [element('', { querySelectorAll: () => [row] })],
    });
    expect(raw['truncated']).toContain('tables');
    expect(
      normalizeSnapshot(raw, { url: 'https://example.com/', title: '', documentId: 1 }).meta
        .mainDocument,
    ).toBe('incomplete');
  });

  it('无截断主文档加 iframe 只产生范围限制', () => {
    const raw = collect({
      'a[href]': [element('链接', { href: 'https://example.com/next' })],
      iframe: [{ contentDocument: null }],
    });
    expect(raw['truncated']).toEqual([]);
    expect(
      normalizeSnapshot(raw, { url: 'https://example.com/', title: '', documentId: 1 }).meta,
    ).toMatchObject({ degraded: 'partial', mainDocument: 'complete' });
  });
});
