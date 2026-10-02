import type { TabInfo } from '../shared/types/browser';

export function researchUiTabSnapshot(tabs: readonly TabInfo[]): string {
  return JSON.stringify(tabs.map(({ id, url, title, active }) => ({ id, url, title, active })));
}

export async function waitForResearchUiLinkReady(options: {
  readTabs: () => Promise<readonly TabInfo[]>;
  expected: Pick<TabInfo, 'id' | 'url' | 'title'>;
  sleep: (ms: number) => Promise<void>;
}): Promise<TabInfo> {
  // Unchanged metadata is not evidence that an in-flight navigation has finished.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tabs = await options.readTabs();
    const tab = tabs.find((entry) => entry.id === options.expected.id);
    if (
      tab?.state === 'ready' &&
      tab.url === options.expected.url &&
      tab.title === options.expected.title
    ) {
      return tab;
    }
    await options.sleep(100);
  }
  throw new Error('8.19-B：受控链接 Tab 未完成加载');
}
