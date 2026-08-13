// PageSnapshot 采集脚本源：自安装 IIFE 字符串（经 executeJavaScript 注入页面主世界）.
// Contract source: doc/detailed-design.md §8.1–§8.4（只读遍历 DOM、纯 JSON 返回、elementId 双层映射）.
// 保持 TS 检查：采集逻辑为真实函数（下方 collectSnapshot），经 .toString() 序列化——
// 本文件用 <reference lib="dom" /> 单独引入 DOM 类型（已验证与 @types/node 共存无冲突），
// 编译期完整类型检查，运行时得到与源码一致的字符串（target ES2023 不降级语法）.
// 约束：函数必须自包含（不引用任何模块级标识符，序列化后独立运行）.
/// <reference lib="dom" />

function collectSnapshot(): unknown {
  'use strict';

  // ---------- 限额（§8.2，与 normalize 的第二道校验一致） ----------
  const LIMITS = {
    text: 1000,
    href: 2000,
    selection: 10000,
    visibleText: 100000,
    headings: 1000,
    links: 2000,
    buttons: 2000,
    inputs: 500,
    tables: 100,
    tableRows: 500,
  } as const;
  const MAX_ELEMENT_ID = 9999999999; // 与 normalize 的 el-<1–10 位数字> 格式一致

  try {
    const doc = document;
    const win = window;

    // ---------- elementId 双层映射（§8.4）：属性烙印 + 每次快照重建的有界 Map ----------
    // elementMap 仅包含本次快照的交互元素；usedIds 保证一次快照内 id 唯一（页面篡改重复属性时重分配）.
    const elementMap = new Map<number, Element>();

    // 扫描页面已有烙印，取最大 n（跨快照续用计数器；被篡改成非法值的属性不参与）
    let maxExistingId = -1;
    const branded = doc.querySelectorAll('[data-aibrowse-el]');
    for (const el of branded) {
      const match = /^(\d{1,10})$/.exec(el.getAttribute('data-aibrowse-el') ?? '');
      if (match !== null) {
        const n = Number(match[1]);
        if (n > maxExistingId) maxExistingId = n;
      }
    }

    // 优先信任本机制自己的持久计数器（__aibrowsePage），其次按烙印最大值续用
    let nextId = maxExistingId + 1;
    try {
      const stored = (win as { __aibrowsePage?: unknown }).__aibrowsePage;
      if (typeof stored === 'object' && stored !== null) {
        const n = (stored as { nextId?: unknown }).nextId;
        if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
          nextId = Math.min(n, MAX_ELEMENT_ID);
        }
      }
    } catch {
      // 页面可能封死属性读取（敌手行为）：忽略，回退到烙印扫描结果
    }
    if (nextId > MAX_ELEMENT_ID) nextId = 0;
    if (nextId < maxExistingId + 1) nextId = maxExistingId + 1;

    function elementIdOf(el: Element): string {
      const attrMatch = /^(\d{1,10})$/.exec(el.getAttribute('data-aibrowse-el') ?? '');
      if (attrMatch !== null) {
        const n = Number(attrMatch[1]);
        if (!elementMap.has(n)) {
          elementMap.set(n, el);
          return `el-${n}`;
        }
        // 重复烙印（页面篡改）→ 落入下方重新分配
      }
      let n = nextId;
      while (elementMap.has(n)) n++;
      elementMap.set(n, el);
      nextId = n + 1;
      try {
        el.setAttribute('data-aibrowse-el', String(n)); // 幂等写回（§8.3 唯一写操作）
      } catch {
        // 只读/异常元素：本次快照内 id 仍有效（Map 持有），仅不持久
      }
      return `el-${n}`;
    }

    // ---------- 通用工具 ----------
    const textOf = (el: Element): string => (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

    // 可见性粗筛（§8.2，O(n) 零副作用）：aria-hidden/hidden 属性跳过；
    // 无 offsetParent 且无布局盒跳过（position:fixed 无 offsetParent 但有盒，保留）.
    function isSkippable(el: Element): boolean {
      const ariaHidden = el.getAttribute('aria-hidden');
      if (ariaHidden !== null && ariaHidden.toLowerCase() === 'true') return true;
      if (el.hasAttribute('hidden')) return true;
      if (el.closest('svg') !== null) return true; // svg 内文不采集（§8.2）
      const html = el as HTMLElement;
      return html.offsetParent === null && el.getClientRects().length === 0;
    }

    // ---------- 基础字段 ----------
    const viewport = {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      width: win.innerWidth,
      height: win.innerHeight,
    };
    const rawSelection = win.getSelection()?.toString() ?? '';
    const selection =
      rawSelection.length > LIMITS.selection
        ? rawSelection.slice(0, LIMITS.selection)
        : rawSelection;
    const bodyText = doc.body !== null ? doc.body.innerText : ''; // 布局感知，天然跳过 display:none
    const visibleText = bodyText.trim().replace(/\s+/g, ' ');
    const truncated: string[] = [];
    if (rawSelection.length > LIMITS.selection) truncated.push('selection');
    if (visibleText.length > LIMITS.visibleText) truncated.push('visibleText');

    // ---------- headings ----------
    const headings: Array<{ level: number; text: string }> = [];
    const headingEls = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const el of headingEls) {
      if (headings.length >= LIMITS.headings) {
        truncated.push('headings');
        break;
      }
      if (isSkippable(el)) continue;
      const level = Number(el.tagName.slice(1));
      const text = cap(textOf(el), LIMITS.text);
      if (text !== '') headings.push({ level, text });
    }

    // ---------- links ----------
    const links: Array<{ id: string; text: string; href: string }> = [];
    const linkEls = doc.querySelectorAll('a[href]');
    for (const el of linkEls) {
      if (links.length >= LIMITS.links) {
        truncated.push('links');
        break;
      }
      if (isSkippable(el)) continue;
      const href = cap((el as HTMLAnchorElement).href, LIMITS.href); // 取解析后的绝对 URL
      if (href === '') continue;
      links.push({ id: elementIdOf(el), text: cap(textOf(el), LIMITS.text), href });
    }

    // ---------- buttons（§8.2：button / input[type=button|submit|reset] / [role=button]） ----------
    const buttons: Array<{ id: string; text: string }> = [];
    const buttonEls = doc.querySelectorAll(
      'button, input[type=button], input[type=submit], input[type=reset], [role=button]',
    );
    for (const el of buttonEls) {
      if (buttons.length >= LIMITS.buttons) {
        truncated.push('buttons');
        break;
      }
      if (isSkippable(el)) continue;
      // input 类按钮的可见文案是 value 属性而非 textContent
      const text =
        el.tagName === 'INPUT'
          ? cap((el as HTMLInputElement).value.trim().replace(/\s+/g, ' '), LIMITS.text)
          : cap(textOf(el), LIMITS.text);
      buttons.push({ id: elementIdOf(el), text });
    }

    // ---------- inputs（§8.2：input:not([type=hidden]) / textarea / select） ----------
    const inputs: Array<{ id: string; type: string; placeholder?: string; value?: string }> = [];
    const inputEls = doc.querySelectorAll('input:not([type=hidden]), textarea, select');
    for (const el of inputEls) {
      if (inputs.length >= LIMITS.inputs) {
        truncated.push('inputs');
        break;
      }
      if (isSkippable(el)) continue;
      const tag = el.tagName;
      const type =
        tag === 'INPUT'
          ? (el as HTMLInputElement).type
          : tag === 'TEXTAREA'
            ? 'textarea'
            : 'select';
      const entry: { id: string; type: string; placeholder?: string; value?: string } = {
        id: elementIdOf(el),
        type,
      };
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder !== '') {
        entry.placeholder = cap(placeholder.trim().replace(/\s+/g, ' '), LIMITS.text);
      }
      // type=password 不采集 value（敏感信息不得进入快照）
      if (type !== 'password') {
        let value: string | null = null;
        if (tag === 'SELECT') {
          const selected = (el as HTMLSelectElement).selectedOptions;
          if (selected.length > 0) value = selected[0]?.textContent ?? null; // 取选中项文本
        } else {
          value = (el as HTMLInputElement | HTMLTextAreaElement).value;
        }
        if (value !== null && value !== '') {
          entry.value = cap(value.trim().replace(/\s+/g, ' '), LIMITS.text);
        }
      }
      inputs.push(entry);
    }

    // ---------- tables（§8.2：table 与 [role=table]） ----------
    const tables: Array<{ headers: string[]; rows: string[][] }> = [];
    const tableEls = doc.querySelectorAll('table, [role=table]');
    for (const table of tableEls) {
      if (tables.length >= LIMITS.tables) {
        truncated.push('tables');
        break;
      }
      if (isSkippable(table)) continue;
      // :scope 限定直接行/单元格，避免嵌套表格的行混入
      const trs = table.querySelectorAll(
        ':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr',
      );
      const rows: string[][] = [];
      let rowCount = 0;
      for (const tr of trs) {
        if (rowCount >= LIMITS.tableRows) {
          truncated.push('tableRows');
          break;
        }
        const cells = tr.querySelectorAll(
          ':scope > th, :scope > td, :scope > [role=gridcell], :scope > [role=columnheader]',
        );
        const rowTexts: string[] = [];
        for (const cell of cells) rowTexts.push(cap(textOf(cell), LIMITS.text));
        rows.push(rowTexts);
        rowCount++;
      }
      if (rows.length === 0) continue;
      // 表头取首行 th/[role=columnheader]（该行不再作为数据行重复出现）；缺失时 headers 留空，
      // 列数对齐由主进程 normalize 补齐/截断（§8.2）
      const firstRow = trs[0];
      const headers: string[] = [];
      if (
        firstRow !== undefined &&
        firstRow.querySelector(':scope > th, :scope > [role=columnheader]') !== null
      ) {
        const headerCells = firstRow.querySelectorAll(
          ':scope > th, :scope > td, :scope > [role=gridcell], :scope > [role=columnheader]',
        );
        for (const cell of headerCells) headers.push(cap(textOf(cell), LIMITS.text));
        rows.shift();
      }
      tables.push({ headers, rows });
    }

    // ---------- iframe 统计（§8.2：v1 仅主文档，全部跳过；跨域计数尽力而为） ----------
    let iframeTotal = 0;
    let iframeCrossOrigin = 0;
    const iframeEls = doc.querySelectorAll('iframe');
    for (const frame of iframeEls) {
      iframeTotal++;
      try {
        // 跨域（或未加载）时 contentDocument 不可读：null 或直接抛 SecurityError
        if (frame.contentDocument === null) iframeCrossOrigin++;
      } catch {
        iframeCrossOrigin++;
      }
    }

    // ---------- 持久化本快照的 elementId 上下文（§8.4：每次快照重建，有界无泄漏） ----------
    try {
      (win as { __aibrowsePage?: unknown }).__aibrowsePage = { nextId, elementMap };
    } catch {
      // 页面封死属性写入（敌手行为）：Map 不持久——本次快照 id 仍有效，
      // 后续快照经 data-aibrowse-el 属性仍可找回同一元素
    }

    return {
      ok: true,
      url: location.href,
      title: doc.title,
      readyState: doc.readyState,
      viewport,
      selection,
      visibleText:
        visibleText.length > LIMITS.visibleText
          ? visibleText.slice(0, LIMITS.visibleText)
          : visibleText,
      headings,
      links,
      buttons,
      inputs,
      tables,
      iframes: { total: iframeTotal, crossOrigin: iframeCrossOrigin },
      truncated,
    };
  } catch (err) {
    // 页面异常（篡改原型/抛异常的 getter/节点被并发删除）→ 由主进程走 L2 降级（§8.5）
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

// 自安装 IIFE：注入后在页面主世界立即执行并返回纯 JSON（结构化克隆安全，无函数/节点引用）
export const SNAPSHOT_SCRIPT_SOURCE: string = `(${collectSnapshot.toString()})();`;
