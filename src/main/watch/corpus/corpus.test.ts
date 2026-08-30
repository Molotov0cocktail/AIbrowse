// D3 corpus tests: 逐条验证 manifest 语料经 FeedParser / PublicHtmlSaxReader 的确定性
// 结果（详细设计 §6.4/§6.5、threat-model WRT-06～WRT-08/WRT-19）。敌手 canary 逐字节
// 零出现；语料文件小型、随仓库提交。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORPUS_MANIFEST } from './manifest';
import { parseFeedXml } from '../feed-parser';
import { readPublicHtml } from '../public-html-sax-reader';

function load(file: string): Buffer {
  const url = new URL(`./${file}`, import.meta.url);
  return readFileSync(fileURLToPath(url));
}

describe('corpus manifest — 受控 XML/HTML 语料', () => {
  for (const entry of CORPUS_MANIFEST) {
    it(entry.name, async () => {
      const bytes = load(entry.file);
      if (entry.expectation.kind === 'feed') {
        const r = await parseFeedXml(bytes);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.format).toBe(entry.expectation.format);
        expect(r.value.items.length).toBe(entry.expectation.itemCount);
        expect(r.value.title.text).toBe(entry.expectation.titleText);
        return;
      }
      const r = readPublicHtml(bytes, 'https://example.com/page');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.channels.mainText).toContain(entry.expectation.mainTextContains);
      expect(r.channels.links.length).toBe(entry.expectation.linkCount);
      const all = JSON.stringify(r.channels);
      for (const canary of entry.expectation.excluded) {
        expect(all, canary).not.toContain(canary);
      }
    });
  }
});
