// A3 交互语义来源测试（红→绿先写）：快照 → ElementSemantics 确定性构建 + 按 Tab 存储 +
// 与可信文档世代（meta.documentId，主进程盖章）绑定——模型/网页不可提供或修改世代。
// 契约源：doc/stage3/detailed-design.md §5.2/§5.4 + threat-model §3.2/§3.3。
import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../../../shared/types/browser';
import { buildSnapshotSemantics, InteractionSemanticsStore } from './interaction-semantics';

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://page.example/',
    title: '示例',
    headings: [],
    links: [{ id: 'el-0', text: '导航', href: 'https://page.example/next' }],
    buttons: [
      { id: 'el-1', text: '提交', isSubmit: true },
      { id: 'el-2', text: '展开', ariaExpanded: false },
      { id: 'el-3', text: '普通' },
    ],
    inputs: [
      { id: 'el-4', type: 'text', placeholder: '请输入' },
      { id: 'el-5', type: 'password' },
      { id: 'el-6', type: 'checkbox' },
    ],
    meta: {
      capturedAt: 1,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
      documentId: 11,
    },
    ...overrides,
  };
}

describe('buildSnapshotSemantics（快照 → ElementSemantics 确定性映射）', () => {
  it('links → href/text；buttons → text/isSubmit/ariaExpanded；inputs → inputType（无 text）', () => {
    const map = buildSnapshotSemantics(makeSnapshot());
    expect(map.get('el-0')).toEqual({ href: 'https://page.example/next', text: '导航' });
    expect(map.get('el-1')).toEqual({ text: '提交', isSubmit: true });
    expect(map.get('el-2')).toEqual({ text: '展开', ariaExpanded: false });
    expect(map.get('el-3')).toEqual({ text: '普通' }); // 普通按钮：仅可见文本 → 权限层 L3 fail-closed
    expect(map.get('el-4')).toEqual({ inputType: 'text' });
    expect(map.get('el-5')).toEqual({ inputType: 'password' });
    expect(map.get('el-6')).toEqual({ inputType: 'checkbox' });
  });

  it('inputs 不产生 text 字段（placeholder/value 非可见文本证据，宁缺勿错——A6 确认摘要源）', () => {
    const map = buildSnapshotSemantics(
      makeSnapshot({
        inputs: [{ id: 'el-8', type: 'submit', placeholder: '占位', value: '值', isSubmit: true }],
      }),
    );
    expect(map.get('el-8')).toEqual({ inputType: 'submit', isSubmit: true });
    expect('text' in (map.get('el-8') ?? {})).toBe(false);
  });

  it('跨集合元素合并语义（input[type=submit] 同时进入 buttons 与 inputs：text/isSubmit/inputType 并存）', () => {
    const snap = makeSnapshot({
      buttons: [{ id: 'el-7', text: '确定', isSubmit: true }],
      inputs: [{ id: 'el-7', type: 'submit', isSubmit: true }],
    });
    const map = buildSnapshotSemantics(snap);
    expect(map.get('el-7')).toEqual({ text: '确定', isSubmit: true, inputType: 'submit' });
  });

  it('确定性：同一快照两次构建结果一致', () => {
    expect(buildSnapshotSemantics(makeSnapshot())).toEqual(buildSnapshotSemantics(makeSnapshot()));
  });
});

describe('InteractionSemanticsStore（按 Tab 存储 + 世代绑定）', () => {
  it('updateFromSnapshot → lookup 返回 {semantics, documentId}（世代来自主进程盖章的 meta）', () => {
    const store = new InteractionSemanticsStore();
    store.updateFromSnapshot('t1', makeSnapshot());
    expect(store.lookup('t1', 'el-0')).toEqual({
      semantics: { href: 'https://page.example/next', text: '导航' },
      documentId: 11,
    });
  });

  it('按 Tab 隔离：同 elementId 在不同 Tab 的语义互不串扰', () => {
    const store = new InteractionSemanticsStore();
    store.updateFromSnapshot('t1', makeSnapshot());
    store.updateFromSnapshot(
      't2',
      makeSnapshot({ links: [{ id: 'el-0', text: '另一页链接', href: 'https://other.example/' }] }),
    );
    expect(store.lookup('t1', 'el-0')?.semantics.href).toBe('https://page.example/next');
    expect(store.lookup('t2', 'el-0')?.semantics.href).toBe('https://other.example/');
  });

  it('同 Tab 新快照覆盖旧语义并更新世代（旧世代绑定随之失效——生命周期核心）', () => {
    const store = new InteractionSemanticsStore();
    store.updateFromSnapshot('t1', makeSnapshot());
    store.updateFromSnapshot(
      't1',
      makeSnapshot({
        meta: {
          capturedAt: 2,
          readyState: 'complete',
          degraded: 'none',
          warnings: [],
          documentId: 12,
        },
      }),
    );
    const binding = store.lookup('t1', 'el-0');
    expect(binding?.documentId).toBe(12);
  });

  it('未知 tabId / 未知 elementId → null（权限层 fail-closed 的输入）', () => {
    const store = new InteractionSemanticsStore();
    store.updateFromSnapshot('t1', makeSnapshot());
    expect(store.lookup('t9', 'el-0')).toBeNull();
    expect(store.lookup('t1', 'el-99')).toBeNull();
  });

  it('clearTab 后查找为 null；clearAll 全清', () => {
    const store = new InteractionSemanticsStore();
    store.updateFromSnapshot('t1', makeSnapshot());
    store.updateFromSnapshot('t2', makeSnapshot());
    store.clearTab('t1');
    expect(store.lookup('t1', 'el-0')).toBeNull();
    expect(store.lookup('t2', 'el-0')).not.toBeNull();
    store.clearAll();
    expect(store.lookup('t2', 'el-0')).toBeNull();
  });
});
