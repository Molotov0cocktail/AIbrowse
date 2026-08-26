// D3 corpus manifest: 受控小型 XML/HTML 测试语料清单（detailed-design §6.4/§6.5、
// threat-model WRT-06～WRT-08/WRT-19）。语料文件随仓库提交（小型、确定性、无大文件）。
// corpus.test.ts 逐条读取并断言。任何新语料必须登记于此 manifest。
import type { FeedFormat } from '../../../shared/types/watch';

export type CorpusExpectation =
  | { kind: 'feed'; format: FeedFormat; itemCount: number; titleText: string }
  | {
      kind: 'page';
      mainTextContains: string;
      excluded: string[]; // 必须零出现的敌手 canary/正文
      linkCount: number;
    };

export interface CorpusEntry {
  name: string;
  file: string; // 相对本 manifest 的文件名
  expectation: CorpusExpectation;
}

export const CORPUS_MANIFEST: CorpusEntry[] = [
  {
    name: 'rss2-basic',
    file: 'rss2-basic.xml',
    expectation: { kind: 'feed', format: 'rss2', itemCount: 2, titleText: 'AIbrowse Test Feed' },
  },
  {
    name: 'atom-basic',
    file: 'atom-basic.xml',
    expectation: { kind: 'feed', format: 'atom', itemCount: 2, titleText: 'AIbrowse Atom Feed' },
  },
  {
    name: 'page-basic',
    file: 'page-basic.html',
    expectation: {
      kind: 'page',
      mainTextContains: 'Hello corpus world 中文.',
      excluded: [],
      linkCount: 2,
    },
  },
  {
    name: 'page-hostile',
    file: 'page-hostile.html',
    expectation: {
      kind: 'page',
      mainTextContains: 'CORPUS_OK',
      excluded: ['CORPUS_CANARY_SID', 'CORPUS_CANARY_ONERROR', 'CORPUS_CANARY_TOKEN'],
      linkCount: 1,
    },
  },
];
