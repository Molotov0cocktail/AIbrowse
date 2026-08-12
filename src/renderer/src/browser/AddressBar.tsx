import { useEffect, useRef, useState, type Ref } from 'react';
import type { TabInfo } from '../../../shared/types/browser';

interface AddressBarProps {
  activeTab: TabInfo | null;
  // 原始输入交给 main 侧统一规范化（§9），UI 不做 URL 判断（First_stage §十）
  onNavigate: (input: string) => void;
  ref?: Ref<HTMLInputElement>; // React 19 ref-as-prop：新建 Tab 后由 App 聚焦
}

// 地址栏：显示活动 Tab 的 URL（about:blank 显示为空）。聚焦期间不随 URL 变化
// 刷新草稿（避免打断输入）；失焦时与页面实际 URL 同步。Enter 提交原始输入。
export function AddressBar({ activeTab, onNavigate, ref }: AddressBarProps) {
  const [draft, setDraft] = useState('');
  const focused = useRef(false);

  const displayUrl = activeTab === null || activeTab.url === 'about:blank' ? '' : activeTab.url;

  useEffect(() => {
    if (!focused.current) setDraft(displayUrl);
  }, [displayUrl]);

  return (
    <input
      ref={ref}
      className="address-bar"
      type="text"
      value={draft}
      placeholder="输入网址或搜索内容"
      spellCheck={false}
      aria-label="地址栏"
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(displayUrl);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const input = draft.trim();
        if (input === '') {
          setDraft(displayUrl); // 空输入还原为当前 URL，不发起导航
          return;
        }
        onNavigate(input);
      }}
    />
  );
}
