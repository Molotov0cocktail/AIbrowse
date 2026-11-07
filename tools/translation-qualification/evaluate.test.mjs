import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './evaluate.mjs';

function sample() {
  const pages = (controlled) =>
    Object.fromEntries(
      ['user', 'research', 'watch'].map((role, i) => [
        role,
        {
          id: i + 1,
          url: 'http://127.0.0.1:43210/same',
          sameSession: true,
          observed: {
            marker: controlled ? (role === 'user' ? 'controlled' : null) : 'native',
            bridge: 'undefined',
            require: 'undefined',
            cookie: 'translation_fixture=shared',
            frames: [
              { url: 'http://127.0.0.1:43210/frame', marker: null, bridge: 'undefined' },
              { url: 'about:blank', marker: null, bridge: 'undefined' },
            ],
          },
        },
      ]),
    );
  return {
    completed: true,
    willQuit: true,
    timedOut: false,
    error: null,
    versions: { electron: '43.8.4' },
    requests: 12,
    native: { pages: pages(false) },
    controlled: {
      pages: pages(true),
      nativeExtensions: 0,
      revokedOnNavigation: true,
      revokedOnClose: true,
      admittedBeforeClose: true,
      networkSentinel: { fetchRejected: true, deniedOriginHits: 0, deniedByGate: 1 },
      audit: [{ id: 1, allowed: true }],
    },
  };
}
test('任务页原生注入否决原包路线，受控装载仅获得合成结论', () => {
  assert.deepEqual(evaluate(sample()), {
    experiment: 'COMPLETE',
    nativeRoute: 'REJECTED_TASK_INJECTION',
    controlledLoading: 'PASS_SYNTHETIC_LOADING_ONLY',
    integration: 'NOT RUN',
  });
});
test('缺少终态、超时、预算溢出、错误版本与缺页不能成功', () => {
  for (const alter of [
    (r) => {
      r.willQuit = false;
    },
    (r) => {
      r.completed = false;
    },
    (r) => {
      r.timedOut = true;
    },
    (r) => {
      r.requests = 61;
    },
    (r) => {
      r.versions.electron = '43.7.7';
    },
    (r) => {
      delete r.native.pages.watch;
    },
    (r) => {
      r.controlled.pages.watch.id = 1;
    },
    (r) => {
      r.controlled.pages.watch.url += 'other';
    },
  ]) {
    const r = sample();
    alter(r);
    assert.equal(evaluate(r).experiment, 'INCOMPLETE');
  }
});
test('受控任务页、子帧、主世界桥泄漏与未撤销均不得通过', () => {
  for (const alter of [
    (r) => {
      r.controlled.pages.watch.observed.marker = 'controlled';
    },
    (r) => {
      r.controlled.pages.user.observed.frames[0].marker = 'controlled';
    },
    (r) => {
      r.controlled.pages.user.observed.bridge = 'object';
    },
    (r) => {
      r.controlled.nativeExtensions = 1;
    },
    (r) => {
      r.controlled.revokedOnNavigation = false;
    },
    (r) => {
      r.controlled.revokedOnClose = false;
    },
    (r) => {
      r.controlled.pages.research.observed.cookie = '';
    },
    (r) => {
      r.controlled.pages.user.observed.marker = null;
    },
  ]) {
    const r = sample();
    alter(r);
    assert.equal(evaluate(r).controlledLoading, 'NOT PROVEN');
  }
});
test('看不到原生注入不是隔离通过', () => {
  const r = sample();
  r.native.pages.research.observed.marker = null;
  r.native.pages.watch.observed.marker = null;
  assert.equal(evaluate(r).nativeRoute, 'NOT PROVEN');
});

test('缺失和伪造证据均不得产生受控装载PASS', () => {
  for (const alter of [
    (r) => {
      delete r.controlled.pages.user.observed.cookie;
    },
    (r) => {
      r.controlled.pages.user.observed.frames = { length: 2 };
    },
    (r) => {
      for (const p of Object.values(r.controlled.pages)) delete p.url;
    },
    (r) => {
      for (const p of Object.values(r.controlled.pages))
        p.observed.cookie = 'not_translation_fixture=shared-other';
    },
    (r) => {
      r.controlled.audit = [];
    },
    (r) => {
      r.controlled.networkSentinel.deniedOriginHits = 1;
    },
    (r) => {
      r.controlled.admittedBeforeClose = false;
    },
    (r) => {
      for (const p of Object.values(r.controlled.pages))
        p.observed.frames = [
          { url: 'about:blank', marker: null, bridge: 'undefined' },
          { url: 'about:blank', marker: null, bridge: 'undefined' },
        ];
    },
  ]) {
    const r = sample();
    alter(r);
    assert.notEqual(evaluate(r).controlledLoading, 'PASS_SYNTHETIC_LOADING_ONLY');
  }
});
