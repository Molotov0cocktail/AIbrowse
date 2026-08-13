import { useEffect, type RefObject } from 'react';
import type { ContentBounds } from '../../../shared/types/ipc';

// 内容区 bounds 上报（design §11.2，决议 Q6 升级）：从「chrome 高度 → 内容区矩形」
// 升级为测量内容容器元素的两维矩形——面板开/关、窗口缩放、DebugPanel 收起都改变
// 容器尺寸并触发 ResizeObserver，经同一路径更新活动 view bounds（通道/契约不变：
// ui:content-bounds 全量覆盖式）。防抖 50ms 不变。
const DEBOUNCE_MS = 50;

export function useContentBounds(contentRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = contentRef.current;
    if (container === null) return;

    const report = (): void => {
      // 容器矩形即 WebContentsView 覆盖区（视图 x/y 相对窗口内容区，与 CSS 像素一致）
      const rect = container.getBoundingClientRect();
      const bounds: ContentBounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      window.aibrowse.ui.reportContentBounds(bounds);
    };

    report(); // 挂载即上报一次：窗口首次显示前的兜底 bounds 立即被校正（§6）

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [contentRef]);
}
