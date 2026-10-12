import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ContentBounds } from '../../../shared/types/ipc';

// 内容区 bounds 上报（design §11.2，决议 Q6 升级）：从「chrome 高度 → 内容区矩形」
// 升级为测量内容容器元素的两维矩形——面板开/关、窗口缩放、DebugPanel 收起都改变
// 容器尺寸并触发 ResizeObserver，经同一路径更新活动 view bounds（通道/契约不变：
// ui:content-bounds 全量覆盖式）。ResizeObserver 已在布局阶段合并通知；直接上报，
// 避免 renderer 被原生 WebContentsView 覆盖后定时器节流造成 bounds 长时间错配。

export function useContentBounds(contentRef: RefObject<HTMLElement | null>): void {
  const lastBounds = useRef<ContentBounds | null>(null);

  useLayoutEffect(() => {
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
      const previous = lastBounds.current;
      if (
        previous !== null &&
        previous.x === bounds.x &&
        previous.y === bounds.y &&
        previous.width === bounds.width &&
        previous.height === bounds.height
      )
        return;
      lastBounds.current = bounds;
      window.aibrowse.ui.reportContentBounds(bounds);
    };

    report(); // 挂载即上报一次：窗口首次显示前的兜底 bounds 立即被校正（§6）

    const observer = new ResizeObserver(report);
    observer.observe(container);
    // ResizeObserver 不保证在仅位置变化、尺寸不变时触发；窗口 resize 兜底重新读取完整矩形。
    window.addEventListener('resize', report);
    // details 的 toggle 会改变 chrome 高度，但后台 renderer 的布局通知可能被节流。
    document.addEventListener('toggle', report, true);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      document.removeEventListener('toggle', report, true);
    };
  });
}
