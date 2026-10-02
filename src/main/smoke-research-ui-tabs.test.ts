import { describe, expect, it, vi } from 'vitest';
import type { TabInfo } from '../shared/types/browser';
import { researchUiTabSnapshot, waitForResearchUiLinkReady } from './smoke-research-ui-tabs';

const expected = {
  id: 'safe-link-tab',
  url: 'http://127.0.0.1:12345/research-capture',
  title: '研究采集页',
};
const ready: TabInfo = { ...expected, active: true, state: 'ready' };

describe('Research UI 受控链接加载门', () => {
  it('元数据连续 100ms 相同仍 loading 时继续等，收到目标标题与 ready 才返回', async () => {
    let poll = 0;
    const sleep = vi.fn(async () => {
      poll += 1;
    });
    const result = await waitForResearchUiLinkReady({
      expected,
      sleep,
      readTabs: async () => [poll < 3 ? { ...ready, title: '', state: 'loading' } : ready],
    });
    expect(result).toEqual(ready);
    expect(poll).toBe(3);
  });

  it('目标标题先到但主框架仍 loading 时不提前放行', async () => {
    let poll = 0;
    const result = await waitForResearchUiLinkReady({
      expected,
      sleep: async () => {
        poll += 1;
      },
      readTabs: async () => [poll < 3 ? { ...ready, state: 'loading' } : ready],
    });
    expect(result.state).toBe('ready');
    expect(poll).toBe(3);
  });

  it.each([
    { ...ready, id: 'other-tab' },
    { ...ready, url: 'http://127.0.0.1:12345/other' },
    { ...ready, title: '另一个页面' },
    { ...ready, state: 'error' as const },
  ])('稳定但不是已加载的目标文档不能放行：%j', async (tab) => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      waitForResearchUiLinkReady({ expected, sleep, readTabs: async () => [tab] }),
    ).rejects.toThrow('受控链接 Tab 未完成加载');
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(100);
  });
});

describe('Research UI 往返不变量', () => {
  it.each([
    { ...ready, id: 'changed-id' },
    { ...ready, url: 'http://127.0.0.1:12345/changed' },
    { ...ready, title: '变化标题' },
    { ...ready, active: false },
  ])('保持 id/url/title/active 的每个变化均可甄别：%j', (changed) => {
    expect(researchUiTabSnapshot([changed])).not.toBe(researchUiTabSnapshot([ready]));
  });
});
