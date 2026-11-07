import test from 'node:test';
import assert from 'node:assert/strict';
import { pairs, summarizeContent } from './content-result.mjs';
const valid = () => ({
  completed: true,
  localRequests: 4,
  deniedRequests: 66,
  willQuit: true,
  error: null,
  requests: pairs.map((p) => ({ text_list: [p[0]], source_lang: 'en', target_lang: 'zh-CN' })),
  sentinel: { rejected: true, hits: 1 },
  translated: {
    nodes: pairs.map((p) => p[1]),
    paragraphs: pairs.map((p) => ({ original: p[0], text: p.join(''), translations: [p[1]] })),
  },
  restored: {
    nodes: [],
    paragraphs: pairs.map((p) => ({ original: p[0], text: p[0], translations: [] })),
  },
});
test('完整双语及还原DOM通过', () =>
  assert.equal(summarizeContent(valid(), 0, false).completed, true));
test('ACK与缺失观测不算通过', () => {
  for (const r of [null, {}, { completed: true, willQuit: true, messages: [{ ok: true }] }])
    assert.equal(summarizeContent(r, 0, false).completed, false);
});
test('漏译错译重复及原文丢失拒绝', () => {
  for (const edit of [
    (r) => r.translated.nodes.pop(),
    (r) => (r.translated.paragraphs[0].translations = ['错译']),
    (r) => r.translated.paragraphs[1].translations.push(pairs[1][1]),
    (r) => (r.translated.paragraphs[0].original = ''),
  ]) {
    const r = valid();
    edit(r);
    assert.equal(summarizeContent(r, 0, false).completed, false);
  }
});
test('还原残留或原文改变拒绝', () => {
  for (const edit of [
    (r) => r.restored.nodes.push(pairs[0][1]),
    (r) => (r.restored.paragraphs[0].text += 'changed'),
    (r) => delete r.restored,
  ]) {
    const r = valid();
    edit(r);
    assert.equal(summarizeContent(r, 0, false).completed, false);
  }
});
test('异常退出强杀哨兵缺失拒绝', () => {
  assert.equal(summarizeContent(valid(), 1, false).completed, false);
  assert.equal(summarizeContent(valid(), 0, true).completed, false);
  const r = valid();
  r.sentinel.hits = 0;
  assert.equal(summarizeContent(r, 0, false).completed, false);
});
test('审核反例：非布尔标志与缺失生命周期拒绝', () => {
  for (const edit of [
    (r) => (r.completed = 'false'),
    (r) => (r.willQuit = 'false'),
    (r) => delete r.error,
    (r) => (r.error = ''),
    (r) => (r.sentinel.rejected = 'true'),
  ]) {
    const r = valid();
    edit(r);
    assert.equal(summarizeContent(r, 0, false).completed, false);
  }
  for (const forced of [undefined, null, 0, 'false'])
    assert.equal(summarizeContent(valid(), 0, forced).completed, false);
});
test('审核反例：计数缺失、负数、越界、非整数拒绝', () => {
  for (const field of ['localRequests', 'deniedRequests'])
    for (const value of [undefined, null, -1, 0, 1.5, '4', Infinity, NaN, 101]) {
      const r = valid();
      r[field] = value;
      assert.equal(summarizeContent(r, 0, false).completed, false);
    }
  for (const value of [3, 61]) {
    const r = valid();
    r.localRequests = value;
    assert.equal(summarizeContent(r, 0, false).completed, false);
  }
});
test('审核反例：DOM伪数组、空成员、错配全文拒绝且不抛错', () => {
  for (const edit of [
    (r) => (r.translated.nodes = 'abc'),
    (r) => (r.translated.nodes = ['错译', '错译', '错译']),
    (r) => (r.translated.paragraphs[0] = null),
    (r) => (r.translated.paragraphs[0].text = ''),
    (r) => (r.translated.paragraphs[0].translations = { length: 1, 0: pairs[0][1] }),
    (r) => (r.restored.nodes = ''),
    (r) => (r.restored.paragraphs[1] = null),
    (r) => (r.requests[0] = null),
    (r) => (r.requests[1].text_list[0] = '错配'),
    (r) => (r.sentinel = []),
  ]) {
    const r = valid();
    edit(r);
    assert.equal(summarizeContent(r, 0, false).completed, false);
  }
});
