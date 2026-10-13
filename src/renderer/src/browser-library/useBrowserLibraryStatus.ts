import { useEffect, useState } from 'react';
import type { BrowserLibraryStatus } from '../../../shared/types/browser-library';

const UNAVAILABLE: BrowserLibraryStatus = {
  state: 'unavailable',
  message: '浏览数据状态暂不可用',
};

export function useBrowserLibraryStatus(): BrowserLibraryStatus | null {
  const [status, setStatus] = useState<BrowserLibraryStatus | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      let nextReadMs = 5000;
      try {
        const result = await window.aibrowse.browserLibrary.getStatus();
        if (result.state === 'initializing') nextReadMs = 250;
        if (live) setStatus(result);
      } catch {
        if (live) setStatus(UNAVAILABLE);
      } finally {
        if (live) timer = setTimeout(() => void read(), nextReadMs);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  return status;
}
