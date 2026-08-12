import { useEffect, type RefObject } from 'react';
import type { ContentBounds } from '../../../shared/types/ipc';

// 内容区 bounds 上报（design §6）：ResizeObserver 测量 chrome（工具栏+标签栏）高度，
// 防抖 50ms 后经 ui:content-bounds 上报；main 侧应用到当前活动 WebContentsView。
// chrome 为块级容器：窗口 resize 改变其宽度时同样触发 ResizeObserver（无需单独监听 resize），
// 宽度取 window.innerWidth、高度为窗口内容高减去 chrome 高。
const DEBOUNCE_MS = 50;

export function useContentBounds(chromeRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const chrome = chromeRef.current;
    if (chrome === null) return;

    const report = (): void => {
      const y = Math.round(chrome.getBoundingClientRect().height);
      const bounds: ContentBounds = {
        x: 0,
        y,
        width: Math.round(window.innerWidth),
        height: Math.max(Math.round(window.innerHeight) - y, 0),
      };
      window.aibrowse.ui.reportContentBounds(bounds);
    };

    report(); // 挂载即上报一次：窗口首次显示前的兜底 bounds（y=0）立即被校正（§6）

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(chrome);

    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [chromeRef]);
}
