import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { TabInfo } from '../../../shared/types/browser';

interface AddressBarProps {
  activeTab: TabInfo | null;
  // Main normalizes raw input; the UI does not classify URLs.
  onNavigate: (input: string) => void;
  ref?: Ref<HTMLInputElement>; // App focuses this input after creating a tab.
}

// A focused draft belongs only to its tab. Tab changes synchronize before paint.
export function AddressBar({ activeTab, onNavigate, ref }: AddressBarProps) {
  const [draft, setDraft] = useState('');
  const focused = useRef(false);
  const tabId = activeTab?.id ?? null;
  const previousTabId = useRef(tabId);
  const clickCaret = useRef<number | null>(null);

  const displayUrl = activeTab === null || activeTab.url === 'about:blank' ? '' : activeTab.url;

  useLayoutEffect(() => {
    if (previousTabId.current !== tabId || !focused.current) {
      setDraft(displayUrl);
      clickCaret.current = null;
    }
    previousTabId.current = tabId;
  }, [tabId, displayUrl]);

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
        clickCaret.current = null;
        setDraft(displayUrl);
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || e.detail !== 1 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey)
          return;
        const input = e.currentTarget;
        // Focus first: Chromium may restore the previous selection when gaining focus.
        input.focus();
        // Avoid Chromium's deferred deselection when pressing inside an existing selection.
        // The default mouse-down action then places the caret or begins a fresh drag selection.
        if (input.selectionStart !== input.selectionEnd && input.selectionEnd !== null) {
          input.setSelectionRange(input.selectionEnd, input.selectionEnd);
        }
      }}
      onClick={(e) => {
        if (e.button !== 0 || e.detail !== 1) return;
        const input = e.currentTarget;
        // Preserve drag selections; remember Chromium's caret before selecting all.
        clickCaret.current =
          input.selectionStart === input.selectionEnd ? input.selectionStart : null;
        if (clickCaret.current !== null) input.select();
      }}
      onDoubleClick={(e) => {
        if (e.button !== 0 || clickCaret.current === null) return;
        // Replace native word selection with the caret from the first click.
        e.currentTarget.setSelectionRange(clickCaret.current, clickCaret.current);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const input = draft.trim();
        if (input === '') {
          setDraft(displayUrl); // Empty input restores the URL without navigating.
          return;
        }
        onNavigate(input);
      }}
    />
  );
}
