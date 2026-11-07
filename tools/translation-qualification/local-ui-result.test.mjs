import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLocalUI } from './local-ui-result.mjs';

const sample = () => ({
  completed: true,
  willQuit: true,
  error: null,
  versions: { electron: '43.8.4' },
  pages: Object.fromEntries(
    ['popup', 'options', 'side-panel'].map((name) => [
      name,
      {
        text: name === 'popup' ? '翻译服务 设置' : name === 'options' ? '基本设置' : '翻译文本',
        buttons: ['翻译'],
        inputs: [{ type: 'checkbox' }, { type: 'checkbox' }],
        require: 'undefined',
        appBridge: 'undefined',
      },
    ]),
  ),
});

test('设置页菜单壳与加载提示不能算设置控件就绪', () => {
  const r = sample();
  r.pages.options.text = '基本设置 加载中...';
  assert.equal(summarizeLocalUI(r, 0, false).rendered.options, false);
});
test('观察到三份原UI控制也不宣称功能集成通过', () => {
  assert.deepEqual(summarizeLocalUI(sample(), 0, false), {
    completed: true,
    rendered: { popup: true, options: true, 'side-panel': true },
    functionalIntegration: 'NOT RUN',
  });
});
test('非零退出、强杀、缺终态与采集异常均拒绝', () => {
  for (const [code, forced] of [
    [1, false],
    [null, false],
    [0, true],
  ]) {
    const s = summarizeLocalUI(sample(), code, forced);
    assert.equal(s.completed, false);
    assert.equal(s.rendered.popup, false);
  }
  for (const alter of [
    (r) => {
      r.willQuit = false;
    },
    (r) => {
      r.error = '失败';
    },
    (r) => {
      delete r.versions;
    },
  ]) {
    const r = sample();
    alter(r);
    assert.equal(summarizeLocalUI(r, 0, false).completed, false);
  }
});
test('采集完成但原UI空白、缺控制或具有应用桥不得声称渲染通过', () => {
  for (const alter of [
    (r) => {
      r.pages.popup.text = '';
    },
    (r) => {
      r.pages.popup.buttons = [];
    },
    (r) => {
      delete r.pages.popup;
    },
    (r) => {
      r.pages.popup.appBridge = 'object';
    },
  ]) {
    const r = sample();
    alter(r);
    const s = summarizeLocalUI(r, 0, false);
    assert.equal(s.completed, true);
    assert.equal(s.rendered.popup, false);
  }
});
