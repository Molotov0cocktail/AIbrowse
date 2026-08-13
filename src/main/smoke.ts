// 冒烟自检（T2 起扩展）：AIBROWSE_SMOKE=1 时在主进程内驱动浏览器核心场景并断言。
// 场景（§10 + T3 扩展）：多 view 创建/切换/关闭、最后 Tab 自动新建、可选真实 URL 加载、
// dispose 幂等与无泄漏；T3 新增 UI 窗口导航保护拦截验证（R-01）与渲染层 bounds 上报生效验证（§6）。
// 任何断言失败 → logError + 抛出，入口 catch 后以退出码 1 结束（与基线冒烟语义一致）。

import { app, session, webContents, WebContentsView } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserController } from './browser/browser-controller';
import { PERSIST_PARTITION } from './browser/session-manager';
import { SEARCH_ENGINE_URL } from '../shared/url';
import { getCurrentLogFilePath, logError, logInfo } from './logger';
import { ConversationServiceImpl } from './ai/conversation-service';
import { ConversationStore } from './ai/conversation-store';
import { ConfigStore } from './ai/config-store';
import { FakeProvider, type FakeProviderScript } from './ai/provider/fake-provider';
import { registerProviderFactory } from './ai/provider/llm-provider';
import type { SecureCredentialStore } from './ai/credential-store';
import type { StreamChunkEvent, TurnDoneEvent } from '../shared/types/conversation';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(failure);
    await delay(50);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`冒烟断言失败：${message}`);
}

export interface SmokeOptions {
  loadUrl?: string;
  uiWindow?: BrowserWindow | null; // T3：UI 窗口导航保护拦截与 bounds 上报生效验证用
}

// ---------- T4：受控采集页面（真实 Electron 集成冒烟，不依赖外网） ----------
// 双本地 HTTP 服务器：第二服务器端口不同即不同 origin，供 iframe 页验证跨域跳过与 L1 降级。
// 页面内容固定，采集断言（heading/link/button/table/elementId）直接对照此 HTML 编写。
const SIMPLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>冒烟采集页</title></head>
<body>
  <h1>主标题</h1>
  <h2>小节标题</h2>
  <p>这是一段用于验证可见文本采集的测试文本。</p>
  <a href="https://example.com/">示例链接</a>
  <a href="/relative-page">相对链接</a>
  <button type="button">点击我</button>
  <input type="button" value="确定">
  <input type="text" placeholder="输入框占位">
  <table>
    <thead><tr><th>列一</th><th>列二</th></tr></thead>
    <tbody>
      <tr><td>a1</td><td>b1</td></tr>
      <tr><td>a2</td><td>b2</td></tr>
    </tbody>
  </table>
</body>
</html>`;

function iframeHtml(innerUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>带框架采集页</title></head>
<body>
  <h1>带框架页</h1>
  <p>框架页可见文本。</p>
  <iframe src="${innerUrl}/inner"></iframe>
</body>
</html>`;
}

const INNER_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>内部文档</title></head>
<body><h1>内部文档标题</h1></body>
</html>`;

// T5 敌对页面（elementId 审查）：预置重复/畸形/超大/负数/冲突的 data-aibrowse-el 烙印，
// 验证一次快照内 id 唯一、格式合法、且每个 id 无歧义对应本次快照中的真实元素（§8.4/§8.6）。
// 另含跨集合元素（a[role=button]、input[type=button] 同时进入两个集合）验证同元素同 id。
const HOSTILE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>敌对采集页</title></head>
<body>
  <h1>敌对采集页</h1>
  <a href="https://example.com/a" data-aibrowse-el="7">链接甲（合法烙印）</a>
  <a href="https://example.com/b" data-aibrowse-el="7">链接乙（与甲重复）</a>
  <a href="https://example.com/c" data-aibrowse-el="el-x">链接丙（畸形）</a>
  <a href="https://example.com/d" data-aibrowse-el="12345678901">链接丁（超大）</a>
  <a href="https://example.com/e" data-aibrowse-el="-3">链接戊（负数）</a>
  <a href="https://example.com/f" role="button" data-aibrowse-el="2">跨集合链接</a>
  <button type="button" data-aibrowse-el="2">跨集合按钮（与跨集合链接冲突）</button>
  <input type="button" value="输入按钮" data-aibrowse-el="9999999999">
  <input type="text" placeholder="普通输入">
</body>
</html>`;

// Session 冒烟（T5）：受控 Set-Cookie 页面（HttpOnly 证明不依赖 document.cookie 读取，
// 跨进程持久化只能来自 persist: 分区落盘）。
const COOKIE_NAME = 'aibrowse_session_probe';
const COOKIE_VALUE = 'persist-ok';

interface ControlledPages {
  simpleUrl: string;
  iframeUrl: string;
  hostileUrl: string;
  redirectOkUrl: string;
  redirectEvilUrl: string;
  setCookieUrl: string;
  base: string;
  close: () => Promise<void>;
}

async function startControlledPages(): Promise<ControlledPages> {
  const innerServer: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INNER_HTML);
  });
  await new Promise<void>((resolve, reject) => {
    innerServer.once('error', reject);
    innerServer.listen(0, '127.0.0.1', resolve);
  });
  const innerAddr = innerServer.address();
  if (innerAddr === null || typeof innerAddr === 'string') {
    throw new Error('跨域 iframe 服务器未能取得监听地址');
  }
  const innerUrl = `http://127.0.0.1:${innerAddr.port}`;

  const mainServer: Server = createServer((req, res) => {
    if (req.url === '/simple') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SIMPLE_HTML);
      return;
    }
    if (req.url === '/iframe') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(iframeHtml(innerUrl));
      return;
    }
    if (req.url === '/hostile') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HOSTILE_HTML);
      return;
    }
    if (req.url === '/redirect-ok') {
      // 允许目标：http → http（白名单内，302 应被放行跟随）
      const addr = mainServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/simple` });
      res.end();
      return;
    }
    if (req.url === '/redirect-evil') {
      // 禁止目标：未注册自定义协议（白名单外）。探针实测（Electron 43.4.0，2026-08-13）：
      // file:/data:/about:blank 等目标被 Chromium 网络层先拦（ERR_UNSAFE_REDIRECT），
      // 不会到达 will-redirect；自定义协议与 mailto: 会真实触发 will-redirect——
      // 这正是 R-02 威胁模型（未来注册 aibrowse:// 等协议时）的验证目标。
      res.writeHead(302, { Location: 'aibrowse-smoke://redirect-blocked/' });
      res.end();
      return;
    }
    if (req.url === '/set-cookie') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400`,
      });
      res.end('<!doctype html><title>会话冒烟页</title><p>ok</p>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    mainServer.once('error', reject);
    mainServer.listen(0, '127.0.0.1', resolve);
  });
  const mainAddr = mainServer.address();
  if (mainAddr === null || typeof mainAddr === 'string') {
    throw new Error('采集页面服务器未能取得监听地址');
  }
  const base = `http://127.0.0.1:${mainAddr.port}`;
  const close = async (): Promise<void> => {
    await Promise.all([
      new Promise<void>((resolve) => mainServer.close(() => resolve())),
      new Promise<void>((resolve) => innerServer.close(() => resolve())),
    ]);
  };
  return {
    simpleUrl: `${base}/simple`,
    iframeUrl: `${base}/iframe`,
    hostileUrl: `${base}/hostile`,
    redirectOkUrl: `${base}/redirect-ok`,
    redirectEvilUrl: `${base}/redirect-evil`,
    setCookieUrl: `${base}/set-cookie`,
    base,
    close,
  };
}

// 活动 Tab 对应的可见 WebContentsView（bounds 上报验证：§6 全量覆盖式应用）
function visibleTabView(win: BrowserWindow | null | undefined): WebContentsView | null {
  if (win === null || win === undefined) return null;
  for (const child of win.contentView.children) {
    if (child instanceof WebContentsView && child.getVisible()) return child;
  }
  return null;
}

// ---------- T5：UI 端到端驱动（React DOM 点击/键盘事件，不引入 Playwright） ----------
// React 事件系统监听根容器：原生 click / input / keydown 事件冒泡即触发对应 handler。
// 受控输入（地址栏）用原型 value setter 写入——绕过 React 实例 tracker 后 dispatch
// input 事件，ChangeEventPlugin 检测到值变化即触发 onChange（标准 React 驱动手法）。
async function uiJs(uiWc: WebContents, script: string): Promise<unknown> {
  return uiWc.executeJavaScript(script);
}

async function typeIntoAddressBar(uiWc: WebContents, text: string): Promise<void> {
  await uiJs(
    uiWc,
    `(() => {
      const el = document.querySelector('.address-bar');
      if (!el) throw new Error('地址栏元素不存在');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await delay(100); // React setState 落定后再发 Enter（防御批处理时序）
  await uiJs(
    uiWc,
    `(() => {
      const el = document.querySelector('.address-bar');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`,
  );
}

async function clickUi(uiWc: WebContents, selector: string): Promise<void> {
  await uiJs(
    uiWc,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('UI 元素不存在：' + ${JSON.stringify(selector)});
      el.click();
    })()`,
  );
}

async function clickUiTab(uiWc: WebContents, index: number): Promise<void> {
  const i = String(index);
  await uiJs(
    uiWc,
    `(() => {
      const tabs = document.querySelectorAll('[role="tab"]');
      if (tabs.length <= ${i}) throw new Error('标签页不存在：' + ${i});
      tabs[${i}].click();
    })()`,
  );
}

async function clickUiTabClose(uiWc: WebContents, index: number): Promise<void> {
  const i = String(index);
  await uiJs(
    uiWc,
    `(() => {
      const tabs = document.querySelectorAll('[role="tab"]');
      const close = tabs[${i}]?.querySelector('.tab-close');
      if (!close) throw new Error('标签页关闭按钮不存在：' + ${i});
      close.click();
    })()`,
  );
}

async function uiTabCount(uiWc: WebContents): Promise<number> {
  return (await uiJs(uiWc, `document.querySelectorAll('[role="tab"]').length`)) as number;
}

async function uiTabTitle(uiWc: WebContents, index: number): Promise<string> {
  return (await uiJs(
    uiWc,
    `document.querySelectorAll('[role="tab"]')[${index}].querySelector('.tab-title').textContent`,
  )) as string;
}

// ---------- S3：AI 共读场景（冒烟矩阵 1–8 主进程驱动，FakeProvider 离线确定性） ----------
// 冒烟矩阵见 doc/stage2/detailed-design.md §13.2（矩阵 1–8）；矩阵 4（L3）需在
// controller.dispose() 之后执行（无任何标签页 = 真实 L3），由返回句柄的 runL3 承接。
// 会话持久化落在进程专属临时目录（app.getPath('temp')），全程不触碰用户真实 userData，
// 验证的是真实文件读写（原子写/不落盘/删除/重启恢复），结束后整体清理。
const FAKE_MODEL = 'fake-model';

// 冒烟用凭据替身：注入 resolver 时 ConfigStore/credentials 仅用于配置加载路径
// （hasKey 判定），不触发任何加密动作（safeStorage 运行时验证留待 S4 场景 10）。
const smokeCredentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => true,
  delete: async () => false,
};

export interface AiSmokeHandle {
  runL3: () => Promise<void>; // 矩阵 4：dispose 后提问 → mode='none'
  cleanup: () => Promise<void>;
}

function buildSmokeConversationService(
  dir: string,
  controller: BrowserController,
  resolveProviderFn: (() => Promise<FakeProvider>) | undefined,
  chunks: StreamChunkEvent[],
  turns: TurnDoneEvent[],
): ConversationServiceImpl {
  const configStore = new ConfigStore(dir, smokeCredentials);
  configStore.set({
    providerId: 'fake',
    baseUrl: 'https://fake.example/v1',
    model: FAKE_MODEL,
  });
  return new ConversationServiceImpl({
    browser: controller, // 真实 BrowserController：实时快照防串页以真实采集验证
    store: new ConversationStore(dir),
    configStore,
    credentials: smokeCredentials,
    resolveProviderFn:
      resolveProviderFn === undefined ? undefined : async () => resolveProviderFn(),
    onStreamChunk: (e) => chunks.push(e),
    onTurnDone: (e) => turns.push(e),
  });
}

async function waitTurn(turns: TurnDoneEvent[], requestId: string): Promise<TurnDoneEvent> {
  let found: TurnDoneEvent | undefined;
  await waitFor(
    async () => {
      found = turns.find((t) => t.requestId === requestId);
      return found !== undefined;
    },
    10000,
    `turn-done 未在 10 秒内到达（requestId=${requestId}）`,
  );
  return found as TurnDoneEvent;
}

export async function runAiConversationScenarios(
  controller: BrowserController,
  uiWindow: BrowserWindow | null | undefined,
): Promise<AiSmokeHandle> {
  // v1 单 Provider 选择契约（决议 #20）：选择依赖已注册 kind 集合——冒烟进程内注册
  // 'fake' kind，与生产 openai-compatible 同路径；注入的 resolver 仅替换流式实现，
  // 工厂不会被调用（仅满足类型）。
  registerProviderFactory({
    kind: 'fake',
    create: () => new FakeProvider({}),
  });
  const convDir = join(app.getPath('temp'), `aibrowse-smoke-conversations-${process.pid}`);
  const cleanup = async (): Promise<void> => {
    try {
      rmSync(convDir, { recursive: true, force: true });
    } catch (error) {
      logError('smoke', 'AI 冒烟临时目录清理失败', error);
    }
  };

  // holder 对象规避 TS 对闭包赋值后的 null 收窄（getLastRequest 只属最近一轮）
  const fakeHolder: { current: FakeProvider | null } = { current: null };
  let script: FakeProviderScript = {};
  const setScript = (s: FakeProviderScript): void => {
    script = s;
  };
  const resolveProviderFn = (): Promise<FakeProvider> => {
    fakeHolder.current = new FakeProvider(script); // 每个 ask 新实例
    return Promise.resolve(fakeHolder.current);
  };

  const chunks: StreamChunkEvent[] = [];
  const turns: TurnDoneEvent[] = [];
  const storeDir = join(convDir, 'conversations');

  const runL3 = async (): Promise<void> => {
    // 矩阵 4：L3 降级——dispose 后无任何标签页，getActiveTab → null → 快照 null →
    // mode='none' + 提示，无异常（真实 L3：tab 不可用）
    const service = buildSmokeConversationService(
      convDir,
      controller,
      resolveProviderFn,
      chunks,
      turns,
    );
    try {
      setScript({});
      const session = await service.createSession();
      assert(session !== null, 'L3 场景应能创建会话');
      const result = await service.ask({
        sessionId: session?.id ?? '',
        question: '页面已销毁的问题',
      });
      assert(result.ok, 'L3 场景 ask 应返回 ok');
      const turn = await waitTurn(turns, result.ok ? result.requestId : '');
      assert(turn.status === 'complete', 'L3 场景应正常完成（无异常）');
      assert(
        turn.contextSource.mode === 'none',
        `L3 场景 mode 应为 none（实际 ${turn.contextSource.mode}）`,
      );
      assert(turn.contextSource.url === null, 'L3 场景 contextSource.url 应为 null');
      const lastUser = fakeHolder.current?.getLastRequest()?.messages.at(-1)?.content ?? '';
      assert(lastUser.includes('页面已销毁的问题'), 'L3 场景请求应含问题原文');
      assert(!lastUser.includes('UNTRUSTED_WEB_CONTENT'), 'L3 场景请求不得含 web 块');
      logInfo('smoke', 'AI 共读矩阵 4 通过（L3 → mode=none，无异常）');
    } finally {
      service.dispose();
    }
  };

  try {
    const service = buildSmokeConversationService(
      convDir,
      controller,
      resolveProviderFn,
      chunks,
      turns,
    );
    const pages = await startControlledPages();
    try {
      // —— 矩阵 1：端到端流式回答 + contextSource.url === 提问时页 URL ——
      setScript({});
      const pageTab = await controller.createTab(pages.simpleUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === pageTab.id);
          return t !== undefined && t.state === 'ready';
        },
        10000,
        'AI 冒烟页面未在 10 秒内就绪',
      );
      const s1 = await service.createSession();
      assert(s1 !== null, '矩阵 1 应能创建会话');
      const r1 = await service.ask({ sessionId: s1?.id ?? '', question: '总结这个页面' });
      assert(r1.ok, '矩阵 1 ask 应返回 ok');
      const t1 = await waitTurn(turns, r1.ok ? r1.requestId : '');
      assert(t1.status === 'complete', '矩阵 1 turn-done 应为 complete');
      assert(t1.error === null, '矩阵 1 不应有错误');
      const r1Chunks = chunks
        .filter((c) => c.requestId === (r1.ok ? r1.requestId : ''))
        .map((c) => c.delta)
        .join('');
      assert(
        r1Chunks === '你好，这是来自 FakeProvider 的确定性回答。',
        `矩阵 1 流式分块应按序完整到达（实际 ${r1Chunks}）`,
      );
      assert(t1.message.content === r1Chunks, '矩阵 1 终态消息应为累计全文');
      assert(
        t1.contextSource.url === pages.simpleUrl,
        `矩阵 1 contextSource.url 应为提问时页 URL（实际 ${t1.contextSource.url}）`,
      );
      assert(t1.contextSource.mode === 'snapshot', '矩阵 1 mode 应为 snapshot');
      // Provider 实际收到的请求：真实页面正文经真实快照管线进入末条 user 消息的 web 块
      const req1 = fakeHolder.current?.getLastRequest();
      assert(req1 != null && req1.model === FAKE_MODEL, '矩阵 1 请求 model 应来自配置');
      const lastUser1 = req1?.messages.at(-1);
      assert(lastUser1?.role === 'user', '矩阵 1 末条消息应为 user');
      assert(
        lastUser1?.content.includes('UNTRUSTED_WEB_CONTENT') === true,
        '矩阵 1 请求应含 web 块',
      );
      assert(
        lastUser1?.content.includes('主标题') === true,
        '矩阵 1 请求应含真实页面正文（主标题）',
      );
      const h1 = await service.getHistory(s1?.id ?? '');
      assert(
        h1?.map((m) => m.role).join(',') === 'user,assistant',
        '矩阵 1 历史应为 user+assistant',
      );
      logInfo('smoke', 'AI 共读矩阵 1 通过（端到端流式 + contextSource.url + 真实页面正文入块）');

      // —— 矩阵 2：selection 独占——页面选中文本后提问，请求含 selection 不含页面正文 ——
      const pageWc = visibleTabView(uiWindow)?.webContents;
      assert(pageWc !== undefined, '矩阵 2 应有可见活动 Tab 视图');
      await pageWc.executeJavaScript(
        `(() => {
          const p = document.querySelector('p');
          const range = document.createRange();
          range.selectNodeContents(p);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        })()`,
      );
      const s2 = await service.createSession();
      assert(s2 !== null, '矩阵 2 应能创建会话');
      const r2 = await service.ask({ sessionId: s2?.id ?? '', question: '解释我选中的这段' });
      assert(r2.ok, '矩阵 2 ask 应返回 ok');
      const t2 = await waitTurn(turns, r2.ok ? r2.requestId : '');
      assert(
        t2.contextSource.mode === 'selection',
        `矩阵 2 mode 应为 selection（实际 ${t2.contextSource.mode}）`,
      );
      assert(
        t2.contextSource.selectionExcerpt?.includes('这是一段用于验证可见文本采集的测试文本') ===
          true,
        '矩阵 2 selectionExcerpt 应为选中文本摘录',
      );
      const lastUser2 = fakeHolder.current?.getLastRequest()?.messages.at(-1)?.content ?? '';
      assert(lastUser2.includes('<selection>'), '矩阵 2 请求应含 <selection> 块');
      assert(
        lastUser2.includes('这是一段用于验证可见文本采集的测试文本'),
        '矩阵 2 请求应含选中文本',
      );
      assert(!lastUser2.includes('主标题'), '矩阵 2 请求不得含页面正文（selection 独占）');
      await pageWc.executeJavaScript(`window.getSelection().removeAllRanges()`); // 清理 selection
      logInfo('smoke', 'AI 共读矩阵 2 通过（selection 独占：含选中文本、不含页面正文）');

      // —— 矩阵 3：防串页（§6.2 三断言：url 更新 / capturedAt 递增 / 旧内容不出现） ——
      const capturedAtA = t1.contextSource.capturedAt;
      assert(capturedAtA !== null, '矩阵 3 前置：第一轮应有 capturedAt');
      assert(await controller.navigate(pageTab.id, pages.iframeUrl), '矩阵 3 导航到页面 B 应成功');
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === pageTab.id);
          return t !== undefined && t.state === 'ready' && t.url === pages.iframeUrl;
        },
        10000,
        '矩阵 3 页面 B 未在 10 秒内就绪',
      );
      const r3 = await service.ask({ sessionId: s1?.id ?? '', question: '这个页面讲了什么' });
      assert(r3.ok, '矩阵 3 ask 应返回 ok');
      const t3 = await waitTurn(turns, r3.ok ? r3.requestId : '');
      assert(
        t3.contextSource.url === pages.iframeUrl,
        `矩阵 3 断言①：第二轮 contextSource.url 应为页面 B（实际 ${t3.contextSource.url}）`,
      );
      assert(
        (t3.contextSource.capturedAt ?? 0) > (capturedAtA ?? 0),
        '矩阵 3 断言①：capturedAt 应更新（严格大于第一轮）',
      );
      const lastUser3 = fakeHolder.current?.getLastRequest()?.messages.at(-1)?.content ?? '';
      assert(lastUser3.includes('带框架页'), '矩阵 3 断言②：请求应含页面 B 内容');
      assert(
        !lastUser3.includes('这是一段用于验证可见文本采集的测试文本'),
        '矩阵 3 断言②：页面 A 内容不得出现在页面 B 轮',
      );
      // 刷新后提问：capturedAt 严格递增（实时采集而非缓存快照）
      assert(await controller.reload(pageTab.id), '矩阵 3 刷新应成功');
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === pageTab.id);
          return t !== undefined && t.state === 'ready';
        },
        10000,
        '矩阵 3 刷新后未在 10 秒内就绪',
      );
      const r3b = await service.ask({ sessionId: s1?.id ?? '', question: '刷新后再问' });
      assert(r3b.ok, '矩阵 3 刷新后 ask 应返回 ok');
      const t3b = await waitTurn(turns, r3b.ok ? r3b.requestId : '');
      assert(
        (t3b.contextSource.capturedAt ?? 0) > (t3.contextSource.capturedAt ?? 0),
        '矩阵 3 断言①：刷新后 capturedAt 应严格递增',
      );
      // 提问时活动 Tab 已关闭（最后 Tab 策略自动新建空白页）→ 快照为空白页而非旧页内容
      const tabsBeforeClose = await controller.getTabs();
      for (const tab of tabsBeforeClose) {
        if (tab.id !== pageTab.id) await controller.closeTab(tab.id); // 使 pageTab 成为唯一 Tab
      }
      assert(await controller.closeTab(pageTab.id), '矩阵 3 关闭最后页面 Tab 应成功');
      await waitFor(
        async () => {
          const t = await controller.getActiveTab();
          return t !== null && t.state === 'ready';
        },
        5000,
        '矩阵 3 最后 Tab 策略未自动新建空白页',
      );
      const r3c = await service.ask({ sessionId: s1?.id ?? '', question: '空白页上的问题' });
      assert(r3c.ok, '矩阵 3 空白页 ask 应返回 ok');
      const t3c = await waitTurn(turns, r3c.ok ? r3c.requestId : '');
      const lastUser3c = fakeHolder.current?.getLastRequest()?.messages.at(-1)?.content ?? '';
      assert(
        t3c.contextSource.url === 'about:blank',
        `矩阵 3 断言③：关闭活动 Tab 后快照应为空白页（实际 ${t3c.contextSource.url}）`,
      );
      assert(!lastUser3c.includes('带框架页'), '矩阵 3 断言③：旧页内容不得出现在空白页轮');
      // —— 矩阵 5：薄快照——空白页正文稀薄 → thin 标记 + 提示（不改变模式） ——
      assert(t3c.contextSource.thin === true, '矩阵 5 空白页应判定为薄快照');
      assert(t3c.contextSource.mode === 'snapshot', '矩阵 5 thin 不改变模式');
      assert(
        t3c.contextSource.warnings.some((w) => w.includes('稀薄')),
        `矩阵 5 warnings 应含薄快照提示（实际 ${t3c.contextSource.warnings.join('；')}）`,
      );
      logInfo('smoke', 'AI 共读矩阵 3/5 通过（防串页三断言 + 薄快照 thin 标记）');

      // —— 矩阵 6：中止——慢速 FakeProvider 中途 abort → 流停 + aborted + 部分内容保留 ——
      setScript({
        chunks: [
          '第一段，',
          { text: '第二段，', delayMs: 400 },
          { text: '第三段。', delayMs: 400 },
        ],
      });
      const s6 = await service.createSession();
      assert(s6 !== null, '矩阵 6 应能创建会话');
      const r6 = await service.ask({ sessionId: s6?.id ?? '', question: '中止我' });
      assert(r6.ok, '矩阵 6 ask 应返回 ok');
      // 在途时同会话再 ask → busy（每会话单在途，决议 Q8）
      const busy = await service.ask({ sessionId: s6?.id ?? '', question: '再来一个' });
      assert(!busy.ok && busy.error.code === 'busy', '矩阵 6 在途时再 ask 应返回 busy');
      const r6Id = r6.ok ? r6.requestId : '';
      await waitFor(
        async () => chunks.some((c) => c.requestId === r6Id),
        5000,
        '矩阵 6 首个流式分块未在 5 秒内到达',
      );
      assert(service.abort(r6Id), '矩阵 6 abort 应命中在途生成');
      const t6 = await waitTurn(turns, r6Id);
      assert(t6.status === 'aborted', `矩阵 6 终态应为 aborted（实际 ${t6.status}）`);
      assert(t6.message.content.includes('第一段，'), '矩阵 6 应保留已生成部分');
      assert(!t6.message.content.includes('第三段。'), '矩阵 6 中止后不应继续生成');
      assert(service.abort(r6Id) === false, '矩阵 6 终态后 abort 应幂等返回 false');
      const h6 = await service.getHistory(s6?.id ?? '');
      assert(h6?.at(-1)?.status === 'aborted', '矩阵 6 历史中应保留已中止消息');
      logInfo('smoke', 'AI 共读矩阵 6 通过（中止保留部分 + busy + 幂等）');

      // —— 矩阵 7：错误归一化——注入 401 → invalid-key；注入超时 → timeout ——
      setScript({ error: { httpStatus: 401 } });
      const s7 = await service.createSession();
      assert(s7 !== null, '矩阵 7 应能创建会话');
      const r7 = await service.ask({ sessionId: s7?.id ?? '', question: '触发 401 的问题' });
      assert(r7.ok, '矩阵 7 ask 应返回 ok');
      const t7 = await waitTurn(turns, r7.ok ? r7.requestId : '');
      assert(t7.status === 'error', '矩阵 7 终态应为 error');
      assert(
        t7.error?.code === 'invalid-key',
        `矩阵 7 401 应归一化 invalid-key（实际 ${t7.error?.code}）`,
      );
      assert(t7.error?.httpStatus === 401, '矩阵 7 应携带 httpStatus 401');
      assert(t7.error?.message === 'API Key 无效或无权限，请检查设置', '矩阵 7 应为归一化中文文案');
      const h7 = await service.getHistory(s7?.id ?? '');
      assert(
        h7?.map((m) => m.role).join(',') === 'user,assistant',
        '矩阵 7 失败轮仍应先持久化 user 消息（引用链先于生成落地）',
      );
      assert(
        h7?.at(-1)?.status === 'error' && h7?.at(-1)?.errorCode === 'invalid-key',
        '矩阵 7 assistant 消息应带 errorCode',
      );
      setScript({ error: { code: 'timeout' } });
      const r7b = await service.ask({ sessionId: s7?.id ?? '', question: '触发超时的问题' });
      assert(r7b.ok, '矩阵 7 超时轮 ask 应返回 ok');
      const t7b = await waitTurn(turns, r7b.ok ? r7b.requestId : '');
      assert(
        t7b.error?.code === 'timeout',
        `矩阵 7 超时应归一化 timeout（实际 ${t7b.error?.code}）`,
      );
      assert(t7b.error?.retryable === true, '矩阵 7 timeout 应可重试');
      logInfo('smoke', 'AI 共读矩阵 7 通过（401 → invalid-key / 超时 → timeout 归一化）');

      // —— 矩阵 8：会话持久化 / 删除 / 不保存 / 重启恢复 ——
      setScript({});
      const s8 = await service.createSession();
      assert(s8 !== null, '矩阵 8 应能创建会话');
      const r8 = await service.ask({ sessionId: s8?.id ?? '', question: '会持久化的问题' });
      assert(r8.ok, '矩阵 8 ask 应返回 ok');
      await waitTurn(turns, r8.ok ? r8.requestId : '');
      const s8File = join(storeDir, `${s8?.id}.json`);
      assert(existsSync(s8File), '矩阵 8 普通会话提问后消息文件应落盘');
      const seph = await service.createSession({ ephemeral: true });
      assert(seph !== null, '矩阵 8 应能创建 ephemeral 会话');
      const reph = await service.ask({ sessionId: seph?.id ?? '', question: '不保存的提问' });
      assert(reph.ok, '矩阵 8 ephemeral ask 应返回 ok');
      await waitTurn(turns, reph.ok ? reph.requestId : '');
      assert(
        !existsSync(join(storeDir, `${seph?.id}.json`)),
        '矩阵 8 ephemeral 会话提问后不得落盘（不保存红线）',
      );
      const index8 = JSON.parse(readFileSync(join(storeDir, 'index.json'), 'utf8')) as {
        sessions: Array<{ id: string }>;
      };
      assert(
        index8.sessions.some((s) => s.id === s8?.id),
        '矩阵 8 索引应含普通会话',
      );
      assert(!index8.sessions.some((s) => s.id === seph?.id), '矩阵 8 索引不得含 ephemeral 会话');
      // setEphemeral(false) → 现有消息落盘
      assert(
        await service.setEphemeral(seph?.id ?? '', false),
        '矩阵 8 setEphemeral(false) 应成功',
      );
      assert(existsSync(join(storeDir, `${seph?.id}.json`)), '矩阵 8 setEphemeral(false) 后应落盘');
      // 重启模拟：全新 Service 实例从同一目录读盘（跨实例恢复 = 重启后历史恢复）
      const restarted = buildSmokeConversationService(
        convDir,
        controller,
        resolveProviderFn,
        chunks,
        turns,
      );
      try {
        const ids = (await restarted.listSessions()).map((s) => s.id);
        assert(ids.includes(s8?.id ?? ''), '矩阵 8 重启后应恢复普通会话');
        assert(ids.includes(seph?.id ?? ''), '矩阵 8 重启后应恢复已转普通模式的会话');
        assert(
          (await restarted.getHistory(s8?.id ?? ''))?.map((m) => m.role).join(',') ===
            'user,assistant',
          '矩阵 8 重启后历史应完整恢复',
        );
        // 删除即消失（含残留 tmp）：预置写入中断残留 → deleteSession 一并移除
        writeFileSync(`${s8File}.tmp`, 'half-written', 'utf8');
        assert(await restarted.deleteSession(s8?.id ?? ''), '矩阵 8 deleteSession 应返回 true');
        assert(!existsSync(s8File), '矩阵 8 删除后消息文件应消失');
        assert(!existsSync(`${s8File}.tmp`), '矩阵 8 删除应连残留 tmp 一并移除');
        assert((await restarted.getHistory(s8?.id ?? '')) === null, '矩阵 8 删除后历史应为 null');
        assert(await restarted.deleteSession(seph?.id ?? ''), '矩阵 8 清理转普通会话应成功');
        logInfo('smoke', 'AI 共读矩阵 8 通过（持久化/ephemeral 不落盘/重启恢复/删除含残留 tmp）');
      } finally {
        restarted.dispose();
      }
      service.dispose();
    } finally {
      await pages.close();
    }
    return { runL3, cleanup };
  } catch (err) {
    logError('smoke', 'AI 共读冒烟场景失败', err);
    await cleanup();
    throw err;
  }
}

export async function runSmokeScenario(
  controller: BrowserController,
  options: SmokeOptions = {},
): Promise<void> {
  try {
    // 0. 初始标签页（main 启动时创建）应存在并就绪
    const initial = await controller.getActiveTab();
    assert(initial !== null, '启动后应存在初始活动标签页');
    await waitFor(
      async () => (await controller.getActiveTab())?.state === 'ready',
      5000,
      '初始标签页未在 5 秒内就绪',
    );

    // 1. UI 窗口导航保护（§9，R-01 关闭条件）：页面发起的非法导航应被 will-navigate 拦截，
    //    UI 停留在自身页面——否则远程/本地其他文档将获得 window.aibrowse bridge（安全红线）。
    //    探针覆盖：远程 URL（核心威胁）+ 同目录其他 file: 入口 + '..' 路径穿越（生产模式
    //    精确匹配必须拒绝；前缀语义下穿越会被放行，故该探针能甄别策略回归）。
    if (options.uiWindow !== null && options.uiWindow !== undefined) {
      const uiWc = options.uiWindow.webContents;
      const uiUrl = uiWc.getURL();
      const uiEntry = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
      const blockedTargets = [
        'https://example.com/',
        pathToFileURL(join(__dirname, '../renderer/other.html')).href,
        `${uiEntry}/../other.html`,
      ];
      for (const target of blockedTargets) {
        await uiWc.executeJavaScript(`window.location.href = ${JSON.stringify(target)}`);
        await delay(800); // 给导航提交留出时间；保护生效则 URL 不变（未生效则已跳走/加载中）
        assert(
          uiWc.getURL() === uiUrl,
          `UI 窗口导航保护未拦截导航：UI 现为 ${uiWc.getURL()}（目标 ${target}）`,
        );
      }
      logInfo('smoke', 'UI 窗口导航保护拦截验证通过（远程/同目录/路径穿越三探针）');
    }

    // 2. 新建第二个标签页 → 新 Tab 成为活动 Tab
    const tab2 = await controller.createTab();
    assert((await controller.getTabs()).length === 2, 'createTab 后应有 2 个标签页');
    assert((await controller.getActiveTab())?.id === tab2.id, '新建标签页应成为活动标签页');
    await waitFor(
      async () => (await controller.getTabs()).find((t) => t.id === tab2.id)?.state === 'ready',
      5000,
      '第二个标签页未在 5 秒内就绪',
    );

    // 3. 渲染层 bounds 上报生效（§6）：chrome 高度已上报，活动 view 的 y 应 > 0
    //    （窗口首次显示前的兜底值为 y=0；上报后全量覆盖式应用到活动 view）
    await waitFor(
      async () => {
        const view = visibleTabView(options.uiWindow);
        return view !== null && view.getBounds().y > 0;
      },
      5000,
      '渲染层 bounds 上报未生效（活动 WebContentsView 的 y 仍为 0）',
    );
    logInfo('smoke', '渲染层 bounds 上报生效验证通过');

    // 4. 切回第一个标签页
    assert(await controller.activateTab(initial.id), 'activateTab 应返回 true');
    assert((await controller.getActiveTab())?.id === initial.id, '激活应切换回第一个标签页');

    // 5. 关闭活动标签页 → 右邻接管（§5 selectNextActive）
    assert(await controller.closeTab(initial.id), 'closeTab 应返回 true');
    const tabsAfterClose = await controller.getTabs();
    assert(
      tabsAfterClose.length === 1 && tabsAfterClose[0]?.id === tab2.id,
      '关闭活动标签页后应只剩右邻',
    );
    assert(
      (await controller.getActiveTab())?.id === tab2.id,
      '关闭活动标签页后右邻应成为活动标签页',
    );

    // 6. 关闭最后一个标签页 → 自动新建空白标签页（最后 Tab 策略，窗口常驻）
    assert(await controller.closeTab(tab2.id), 'closeTab 应返回 true');
    await waitFor(
      async () => (await controller.getTabs()).length === 1,
      5000,
      '最后 Tab 策略未自动新建标签页',
    );
    const autoCreated = await controller.getActiveTab();
    assert(autoCreated !== null && autoCreated.id !== tab2.id, '自动新建的应是全新空白标签页');
    await waitFor(
      async () => (await controller.getActiveTab())?.state === 'ready',
      5000,
      '自动新建的标签页未在 5 秒内就绪',
    );

    // 7. PageSnapshot 真实采集（§8，T4 集成冒烟）：本地受控页面实际注入只读脚本，
    //    验证 heading/link/button/table/elementId 由真实 Electron 采集而非 mock 得出。
    const pages = await startControlledPages();
    try {
      // 7.1 L0：无 iframe 的完整页面 → degraded=none、各集合内容与页面 HTML 一一对照
      const simpleTab = await controller.createTab(pages.simpleUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === simpleTab.id);
          return t !== undefined && t.state === 'ready';
        },
        10000,
        '采集页面未在 10 秒内就绪',
      );
      const snap = await controller.getPageSnapshot(simpleTab.id);
      assert(snap !== null, 'L0 页面快照不应为 null');
      assert(snap.url === pages.simpleUrl, `快照 URL 应为页面地址（实际 ${snap.url}）`);
      assert(snap.title === '冒烟采集页', `快照标题应为页面标题（实际 ${snap.title}）`);
      assert(
        snap.meta.degraded === 'none',
        `无 iframe 完整页面应为 L0（实际 ${snap.meta.degraded}）`,
      );
      assert(
        snap.meta.warnings.length === 0,
        `L0 快照不应有警告（实际 ${snap.meta.warnings.join('；')}）`,
      );
      assert(
        snap.headings.some((h) => h.level === 1 && h.text === '主标题'),
        'heading 应包含 h1「主标题」',
      );
      assert(
        snap.headings.some((h) => h.level === 2 && h.text === '小节标题'),
        'heading 应包含 h2「小节标题」',
      );
      assert(
        snap.links.some((l) => l.href === 'https://example.com/' && l.text === '示例链接'),
        'link 应包含「示例链接」指向 https://example.com/',
      );
      assert(
        snap.links.some((l) => l.href === `${pages.base}/relative-page`),
        '相对链接应解析为绝对 URL（el.href 语义）',
      );
      assert(
        snap.buttons.some((b) => b.text === '点击我') &&
          snap.buttons.some((b) => b.text === '确定'),
        'button 应包含 button 元素与 input[type=button]（value 为可见文案）',
      );
      assert(
        (snap.inputs ?? []).some((i) => i.type === 'text' && i.placeholder === '输入框占位'),
        'inputs 应包含 text 输入框及其 placeholder',
      );
      const table = snap.tables?.[0];
      assert(
        table !== undefined &&
          JSON.stringify(table.headers) === JSON.stringify(['列一', '列二']) &&
          table.rows.length === 2 &&
          table.rows[0]?.[0] === 'a1' &&
          table.rows[1]?.[1] === 'b2',
        'table 应采集表头与全部数据行',
      );
      assert(
        snap.visibleText?.includes('这是一段用于验证可见文本采集的测试文本') === true,
        'visibleText 应包含页面主要文本',
      );
      const allIds = [
        ...snap.links.map((x) => x.id),
        ...snap.buttons.map((x) => x.id),
        ...(snap.inputs ?? []).map((x) => x.id),
      ];
      assert(
        allIds.every((id) => /^el-\d+$/.test(id)),
        '全部交互元素 elementId 应为 el-<n> 格式',
      );
      // 一一对应语义（§8.4）：同一元素跨集合共用同一 id（input[type=button] 同时进入
      // buttons 与 inputs），不同元素 id 唯一——受控页不同交互元素数 = 2 links + 2 buttons + 1 text = 5
      assert(
        snap.buttons.find((b) => b.text === '确定')?.id ===
          (snap.inputs ?? []).find((i) => i.type === 'button')?.id,
        '同一元素跨集合应共用同一 elementId（input[type=button] 同时进入 buttons/inputs）',
      );
      assert(
        new Set(allIds).size === 5,
        `不同元素的 elementId 应唯一（受控页应为 5 个不同元素，实际去重后 ${new Set(allIds).size} 个）`,
      );

      // 7.2 同一导航生命周期内重复采集 → 属性烙印复用，elementId 稳定（§8.4）
      const snapAgain = await controller.getPageSnapshot(simpleTab.id);
      assert(snapAgain !== null, '重复采集不应返回 null');
      assert(
        snapAgain.links.find((l) => l.href === 'https://example.com/')?.id ===
          snap.links.find((l) => l.href === 'https://example.com/')?.id,
        '重复采集应复用 data-aibrowse-el 烙印，elementId 稳定',
      );
      assert(
        snapAgain.buttons.find((b) => b.text === '确定')?.id ===
          snap.buttons.find((b) => b.text === '确定')?.id,
        '重复采集应复用烙印（跨集合元素 input[type=button] 的 id 同样稳定）',
      );

      // 7.3 L1：含跨域 iframe 的页面 → degraded=partial + 中文跳过警告（v1 仅主文档，§8.2）
      const iframeTab = await controller.createTab(pages.iframeUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === iframeTab.id);
          return t !== undefined && t.state === 'ready';
        },
        10000,
        'iframe 页面未在 10 秒内就绪',
      );
      const iframeSnap = await controller.getPageSnapshot(iframeTab.id);
      assert(iframeSnap !== null, 'iframe 页面快照不应为 null');
      assert(
        iframeSnap.meta.degraded === 'partial',
        `跨域 iframe 页面应为 L1 partial（实际 ${iframeSnap.meta.degraded}）`,
      );
      assert(
        iframeSnap.meta.warnings.some((w) => w.includes('跳过 1 个 iframe')),
        `L1 快照应包含 iframe 跳过警告（实际 ${iframeSnap.meta.warnings.join('；')}）`,
      );
      assert(
        iframeSnap.headings.some((h) => h.text === '带框架页'),
        'iframe 页面主文档 heading 应正常采集',
      );

      // 7.4 L3：未知 tabId → null（不抛异常）
      assert((await controller.getPageSnapshot('no-such-tab')) === null, '未知 tabId 应为 L3 null');

      // 7.5 敌对页面 elementId（T5 审查）：预置重复/畸形/超大/负数/冲突烙印时，
      //     一次快照内 id 必须唯一、格式合法、每个 id 无歧义对应本次快照中的真实元素
      const hostileTab = await controller.createTab(pages.hostileUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === hostileTab.id);
          return t !== undefined && t.state === 'ready';
        },
        10000,
        '敌对页面未在 10 秒内就绪',
      );
      const hostileSnap = await controller.getPageSnapshot(hostileTab.id);
      assert(hostileSnap !== null, '敌对页面快照不应为 null');
      const hostileIds = [
        ...hostileSnap.links.map((x) => x.id),
        ...hostileSnap.buttons.map((x) => x.id),
        ...(hostileSnap.inputs ?? []).map((x) => x.id),
      ];
      assert(
        hostileIds.every((id) => /^el-\d{1,10}$/.test(id)),
        '敌对页面全部 elementId 应为合法 el-<1–10 位数字> 格式（畸形/超大烙印不得外泄）',
      );
      // 敌对页不同交互元素数：6 links + 2 buttons（跨集合链接重复计入 links）+ 1 text input = 9
      assert(
        new Set(hostileIds).size === 9,
        `敌对页面不同元素应各有唯一 id（应为 9 个，实际去重后 ${new Set(hostileIds).size} 个）`,
      );
      assert(
        hostileSnap.links.find((l) => l.text === '链接甲（合法烙印）')?.id === 'el-7',
        '合法预置烙印应被复用（链接甲 → el-7）',
      );
      assert(
        hostileSnap.buttons.find((b) => b.text === '输入按钮')?.id === 'el-9999999999',
        '顶格合法烙印（10 位 9）应被复用且后续分配不发生溢出',
      );
      assert(
        hostileSnap.links.find((l) => l.text === '跨集合链接')?.id ===
          hostileSnap.buttons.find((b) => b.text === '跨集合链接')?.id,
        '跨集合元素（a[role=button]）应在 links/buttons 共用同一 id',
      );
      assert(
        hostileSnap.buttons.find((b) => b.text === '输入按钮')?.id ===
          (hostileSnap.inputs ?? []).find((i) => i.type === 'button')?.id,
        '跨集合元素（input[type=button]）应在 buttons/inputs 共用同一 id',
      );
      // 无歧义对应真实元素：快照中的每个 id 都必须能在页面活 DOM 的合法烙印中找到
      const hostileTabWc = visibleTabView(options.uiWindow)?.webContents;
      assert(hostileTabWc !== undefined, '敌对页面应为活动 Tab（可见 view 存在）');
      const brandedIds = (await hostileTabWc.executeJavaScript(
        `[...new Set([...document.querySelectorAll('[data-aibrowse-el]')]
          .map((el) => el.getAttribute('data-aibrowse-el'))
          .filter((v) => /^\\d{1,10}$/.test(v)))]`,
      )) as string[];
      for (const id of hostileIds) {
        assert(
          brandedIds.includes(id.slice(3)),
          `快照 id ${id} 应无歧义对应活 DOM 中的真实元素（未找到对应烙印）`,
        );
      }
      // 跨快照稳定：静态敌对页重复采集 id 完全一致
      const hostileSnapAgain = await controller.getPageSnapshot(hostileTab.id);
      assert(hostileSnapAgain !== null, '敌对页面重复采集不应返回 null');
      assert(
        JSON.stringify(hostileSnapAgain.links.map((x) => x.id)) ===
          JSON.stringify(hostileSnap.links.map((x) => x.id)) &&
          JSON.stringify(hostileSnapAgain.buttons.map((x) => x.id)) ===
            JSON.stringify(hostileSnap.buttons.map((x) => x.id)) &&
          JSON.stringify((hostileSnapAgain.inputs ?? []).map((x) => x.id)) ===
            JSON.stringify((hostileSnap.inputs ?? []).map((x) => x.id)),
        '敌对页面跨快照 elementId 应稳定（重复采集 id 一致）',
      );
      logInfo(
        'smoke',
        '敌对页面 elementId 验证通过（重复/畸形/超大/冲突烙印 → 唯一且对应真实元素）',
      );

      // 7.6 Tab 服务器重定向白名单（R-02 关闭验证）：will-redirect 拦截非白名单 302 目标。
      //     程序化 loadURL 遇 302 时唯一拦截点——redirect-ok（http→http）放行跟随，
      //     redirect-evil（http→file:）拦截且当前文档不被替换。
      const redirectTab = await controller.createTab(pages.redirectOkUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === redirectTab.id);
          return t !== undefined && t.state === 'ready' && t.url === pages.simpleUrl;
        },
        10000,
        `白名单内 302 应被跟随（期望到达 ${pages.simpleUrl}）`,
      );
      assert(
        (await controller.getActiveTab())?.title === '冒烟采集页',
        '跟随 302 后应加载目标页内容（标题=冒烟采集页）',
      );
      // 程序化导航遇禁止目标 302：will-redirect preventDefault 使本次导航被取消，
      // loadURL reject → navigate 按失败语义返回 false，当前文档不被替换。
      // 日志偏移切片：仅断言本次运行产生的拦截 warn（同日更早运行不参与）。
      const logFile = getCurrentLogFilePath();
      const logOffsetBefore = statSync(logFile).size;
      const navResult = await controller.navigate(redirectTab.id, pages.redirectEvilUrl);
      assert(
        navResult === false,
        `非白名单 302 目标应导致导航失败（navigate 返回 false，实际 ${String(navResult)}）`,
      );
      assert(
        (await controller.getTabs()).find((x) => x.id === redirectTab.id)?.url === pages.simpleUrl,
        '非白名单 302 目标（自定义协议）应在 will-redirect 被拦截，当前文档不被替换',
      );
      // 页面发起导航遇禁止目标 302（will-navigate 放行初始 http 地址，will-redirect 拦截目标）
      const redirectTabWc = visibleTabView(options.uiWindow)?.webContents;
      assert(redirectTabWc !== undefined, '重定向测试标签页应为活动 Tab');
      await redirectTabWc.executeJavaScript(
        `window.location.href = ${JSON.stringify(pages.redirectEvilUrl)}`,
      );
      await delay(800); // 给 302 与拦截留出时间；拦截生效则当前文档不被替换
      assert(
        (await controller.getTabs()).find((x) => x.id === redirectTab.id)?.url === pages.simpleUrl,
        '页面发起的非白名单 302 目标同样应在 will-redirect 被拦截',
      );
      // 注意：statSync 的大小是字节，而字符串 slice 按字符——中文日志每字 3 字节，
      // 必须按 Buffer 字节级切片再解码（否则偏移会落空）
      const logTail = readFileSync(logFile).subarray(logOffsetBefore).toString('utf8');
      assert(
        logTail.includes('已拦截非白名单重定向'),
        `Tab will-redirect 拦截应记录 warn 日志（本次运行区间内，offsetBefore=${logOffsetBefore}）`,
      );
      assert(await controller.closeTab(redirectTab.id), '关闭重定向测试标签页应返回 true');
      assert(await controller.closeTab(hostileTab.id), '关闭敌对页面标签页应返回 true');

      assert(await controller.closeTab(simpleTab.id), '关闭采集页面标签页应返回 true');
      assert(await controller.closeTab(iframeTab.id), '关闭 iframe 页面标签页应返回 true');
      logInfo(
        'smoke',
        'PageSnapshot 真实采集验证通过（L0 内容/L1 iframe 跳过/L3 null/elementId 稳定/敌对烙印唯一/302 重定向拦截）',
      );
    } finally {
      await pages.close();
    }

    // 7.7 UI 端到端（T5）：React DOM 点击/键盘事件驱动完整链路——地址栏输入 URL/搜索、
    //     新建/切换/关闭 Tab、后退/前进/刷新、标题随网页变化、调试面板「读取当前网页」、
    //     远程页面隔离探针（window.aibrowse / Node / Electron 均不可达）。
    //     全链路：DOM 事件 → React handler → preload bridge → IPC（sender 校验）→
    //     BrowserController → TabManager/webContents → tabs:updated 推送 → DOM 更新。
    if (options.uiWindow !== null && options.uiWindow !== undefined) {
      const uiWc = options.uiWindow.webContents;
      const uiPages = await startControlledPages();
      try {
        const active = await controller.getActiveTab();
        assert(active !== null, 'UI 端到端前应有活动标签页');
        const firstTabId = active.id;

        // 7.7.1 地址栏输入 URL → Enter → 活动 Tab 真实导航
        await typeIntoAddressBar(uiWc, uiPages.simpleUrl);
        await waitFor(
          async () => {
            const t = await controller.getActiveTab();
            return t !== null && t.url === uiPages.simpleUrl && t.state === 'ready';
          },
          10000,
          '地址栏输入 URL 后活动 Tab 未在 10 秒内到达目标页',
        );

        // 7.7.2 标题随网页变化：主进程 TabInfo.title 与标签栏 DOM 文案同步
        assert(
          (await controller.getActiveTab())?.title === '冒烟采集页',
          'Tab 标题应随网页变化（主进程 TabInfo.title）',
        );
        await waitFor(
          async () => (await uiTabTitle(uiWc, 0)) === '冒烟采集页',
          5000,
          '标签栏标题未随网页更新（UI DOM 文案）',
        );

        // 7.7.3 后退/前进：地址栏导航到第二页 → 后退回到第一页 → 前进回到第二页
        await typeIntoAddressBar(uiWc, uiPages.iframeUrl);
        await waitFor(
          async () => (await controller.getActiveTab())?.url === uiPages.iframeUrl,
          10000,
          '地址栏导航到第二页失败',
        );
        await clickUi(uiWc, 'button[aria-label="后退"]');
        await waitFor(
          async () => (await controller.getActiveTab())?.url === uiPages.simpleUrl,
          10000,
          '后退未回到第一页',
        );
        await clickUi(uiWc, 'button[aria-label="前进"]');
        await waitFor(
          async () => (await controller.getActiveTab())?.url === uiPages.iframeUrl,
          10000,
          '前进未回到第二页',
        );

        // 7.7.4 刷新：点击刷新 → did-start-loading 计数增加 → 状态回到 ready、URL 不变
        const reloadWc = visibleTabView(options.uiWindow)?.webContents;
        assert(reloadWc !== undefined, '刷新验证前应有活动 Tab 视图');
        let reloadLoadingCount = 0;
        const onReloadLoading = (): void => {
          reloadLoadingCount++;
        };
        reloadWc.on('did-start-loading', onReloadLoading);
        try {
          await clickUi(uiWc, 'button[aria-label="刷新"]');
          await waitFor(
            async () => {
              const t = await controller.getActiveTab();
              return (
                reloadLoadingCount > 0 &&
                t !== null &&
                t.state === 'ready' &&
                t.url === uiPages.iframeUrl
              );
            },
            10000,
            '刷新未生效（无加载事件或未回到 ready）',
          );
        } finally {
          reloadWc.removeListener('did-start-loading', onReloadLoading);
        }

        // 7.7.5 搜索：地址栏输入搜索词 → Enter → main 规范化到 Bing 搜索 URL 并真实发起导航
        //      （离线环境目标页加载会失败，断言导航目标 URL；URL 判断另有 15 用例单测）
        const searchWc = visibleTabView(options.uiWindow)?.webContents;
        assert(searchWc !== undefined, '搜索验证前应有活动 Tab 视图');
        const startedUrls: string[] = [];
        const onStartNavigation = (
          details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ): void => {
          if (details.isMainFrame) startedUrls.push(details.url);
        };
        searchWc.on('did-start-navigation', onStartNavigation);
        try {
          await typeIntoAddressBar(uiWc, 'hello world');
          await waitFor(
            async () => startedUrls.some((u) => u.startsWith(`${SEARCH_ENGINE_URL}?q=hello+world`)),
            5000,
            `搜索未发起 Bing 搜索导航（实际 ${startedUrls.join(' / ') || '无'}）`,
          );
        } finally {
          searchWc.removeListener('did-start-navigation', onStartNavigation);
        }
        // 恢复：导航回受控页面（离线搜索页加载失败后 Tab 可能处于 error 状态）
        await typeIntoAddressBar(uiWc, uiPages.simpleUrl);
        await waitFor(
          async () => (await controller.getActiveTab())?.url === uiPages.simpleUrl,
          10000,
          '搜索验证后未恢复到受控页面',
        );

        // 7.7.6 新建 Tab（DOM 点击 ＋）→ 新 Tab 成为活动 Tab，标签栏 DOM 同步出现两个 tab
        await clickUi(uiWc, 'button[aria-label="新建标签页"]');
        await waitFor(
          async () => (await controller.getTabs()).length === 2,
          5000,
          '新建标签页后应有 2 个标签页',
        );
        await waitFor(
          async () => (await uiTabCount(uiWc)) === 2,
          5000,
          '标签栏 DOM 应显示 2 个 tab',
        );
        const newTabId = (await controller.getActiveTab())?.id;
        assert(
          newTabId !== null && newTabId !== undefined && newTabId !== firstTabId,
          '新建标签页应成为活动标签页',
        );
        await waitFor(
          async () => (await controller.getActiveTab())?.state === 'ready',
          5000,
          '新建标签页未在 5 秒内就绪',
        );

        // 7.7.7 切换 Tab（DOM 点击第一个 tab）→ 活动 Tab 切回第一个，aria-selected 同步
        await clickUiTab(uiWc, 0);
        await waitFor(
          async () => (await controller.getActiveTab())?.id === firstTabId,
          5000,
          '点击标签页后未切换回第一个 Tab',
        );
        const ariaSelected = (await uiJs(
          uiWc,
          `document.querySelectorAll('[role="tab"]')[0].getAttribute('aria-selected')`,
        )) as string;
        assert(ariaSelected === 'true', '活动 Tab 的 aria-selected 应为 true');

        // 7.7.8 关闭 Tab（DOM 点击第二个 tab 的关闭按钮）→ 剩余第一个 Tab 且保持活动
        await clickUiTabClose(uiWc, 1);
        await waitFor(
          async () => {
            const tabs = await controller.getTabs();
            return tabs.length === 1 && tabs[0]?.id === firstTabId;
          },
          5000,
          '关闭标签页后应只剩第一个 Tab',
        );
        await waitFor(
          async () => (await uiTabCount(uiWc)) === 1,
          5000,
          '标签栏 DOM 应回到 1 个 tab',
        );

        // 7.7.9 调试面板「读取当前网页」：点击按钮 → bridge → IPC → BrowserController →
        //       PageReader → 界面展示合法 JSON + degraded 徽标（L0）+ L1 warnings 列表
        await clickUi(uiWc, '.debug-capture');
        await waitFor(
          async () =>
            (
              (await uiJs(
                uiWc,
                `document.querySelector('.debug-json')?.textContent ?? ''`,
              )) as string
            ).includes('"title": "冒烟采集页"'),
          10000,
          '调试面板未显示 PageSnapshot JSON（含页面标题）',
        );
        const l0Badge = (await uiJs(
          uiWc,
          `document.querySelector('.debug-badge')?.textContent ?? ''`,
        )) as string;
        assert(l0Badge.includes('L0'), `L0 快照徽标应显示 L0（实际 ${l0Badge}）`);
        await typeIntoAddressBar(uiWc, uiPages.iframeUrl);
        await waitFor(
          async () => (await controller.getActiveTab())?.url === uiPages.iframeUrl,
          10000,
          '调试面板 L1 验证前未导航到 iframe 页面',
        );
        await clickUi(uiWc, '.debug-capture');
        await waitFor(
          async () =>
            (
              (await uiJs(
                uiWc,
                `document.querySelector('.debug-badge')?.textContent ?? ''`,
              )) as string
            ).includes('L1'),
          10000,
          'L1 快照徽标未显示',
        );
        await waitFor(
          async () =>
            (
              (await uiJs(
                uiWc,
                `[...document.querySelectorAll('.debug-warnings li')].map((li) => li.textContent).join('|')`,
              )) as string
            ).includes('跳过 1 个 iframe'),
          10000,
          '调试面板 warnings 列表未显示 iframe 跳过警告',
        );

        // 7.7.10 远程页面隔离探针（First_stage §八）：活动 Tab 页面主世界无法访问
        //        window.aibrowse bridge / Node.js / Electron API
        const probeWc = visibleTabView(options.uiWindow)?.webContents;
        assert(probeWc !== undefined, '隔离探针前应有活动 Tab 视图');
        const probe = (await probeWc.executeJavaScript(
          `({
            aibrowse: typeof window.aibrowse,
            process: typeof window.process,
            require: typeof window.require,
            electron: typeof window.electron,
          })`,
        )) as { aibrowse: string; process: string; require: string; electron: string };
        assert(probe.aibrowse === 'undefined', '远程页面不得访问 window.aibrowse bridge');
        assert(probe.process === 'undefined', '远程页面不得访问 Node.js process');
        assert(probe.require === 'undefined', '远程页面不得访问 Node.js require');
        assert(probe.electron === 'undefined', '远程页面不得访问 Electron API');
        logInfo(
          'smoke',
          'UI 端到端验证通过（地址栏/搜索/多 Tab/后退前进刷新/标题/调试面板/远程隔离）',
        );
      } finally {
        await uiPages.close();
      }
    }

    // 7.8 AI 共读场景（S3，主进程驱动，FakeProvider 离线）：矩阵 1–3/5–8（矩阵 4 在
    //     dispose 后执行——L3 需要无任何标签页）；会话持久化用进程专属临时目录，
    //     验证真实文件读写，不触碰用户真实 userData
    const aiSmoke = await runAiConversationScenarios(controller, options.uiWindow);

    // 8. 可选真实 URL 加载（AIBROWSE_SMOKE_URL）：验证多 Tab 可开网页 + 标题随页面变化
    if (options.loadUrl !== undefined) {
      const pageTab = await controller.createTab(options.loadUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === pageTab.id);
          return t !== undefined && t.state === 'ready' && t.title !== '';
        },
        15000,
        `真实网页（${options.loadUrl}）15 秒内未加载完成（state=ready 且标题非空）`,
      );
      assert(await controller.closeTab(pageTab.id), '关闭网页标签页应返回 true');
      await waitFor(
        async () => (await controller.getTabs()).length === 1,
        5000,
        '关闭网页标签页后应回到单个标签页',
      );
    }

    // 9. dispose 幂等 + 无残留 webContents（退出路径无泄漏）
    controller.dispose();
    controller.dispose(); // 第二次应为无操作（幂等）
    assert((await controller.getTabs()).length === 0, 'dispose 后应无标签页');
    await waitFor(
      async () => webContents.getAllWebContents().length === 1, // 仅剩 React UI 窗口
      5000,
      'dispose 后仍残留标签页 webContents',
    );

    // 9.1 矩阵 4（L3 → mode='none'）：dispose 后无任何标签页，提问走真实 L3 路径
    try {
      await aiSmoke.runL3();
    } finally {
      await aiSmoke.cleanup(); // 会话冒烟临时目录整体清理（含 provider-config 测试残留）
    }

    logInfo(
      'smoke',
      '冒烟场景全部通过（T2 浏览器核心 + T3 UI 闭环 + T4 PageSnapshot 采集 + T5 安全/端到端扩展 + S3 AI 共读矩阵 1–8）',
    );
  } catch (err) {
    logError('smoke', '冒烟场景失败', err);
    throw err;
  }
}

// ---------- T5：Session 跨进程持久化冒烟（First_stage §十四 Session 验收） ----------
// 用法（两次独立应用进程，同一临时 userData，进程间持久化只能来自 persist: 分区落盘；
// 触发本场景还须 AIBROWSE_SMOKE=1——缺省不会运行冒烟、只启动普通应用）：
//   进程 A：AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set AIBROWSE_USER_DATA_DIR=<临时目录> →
//           受控页 Set-Cookie（HttpOnly，排除 document.cookie 读取路径）→ 验证 Cookie 写入 → 完整退出
//   进程 B：AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=check AIBROWSE_USER_DATA_DIR=<同一目录> →
//           新进程验证 Cookie 仍在 → 完整退出
// 单次进程内读取不能构成「重启后保持」证据（§十四）；测试后由调用方清理临时目录。
export async function runSessionSmokeScenario(
  controller: BrowserController,
  mode: 'set' | 'check',
): Promise<void> {
  try {
    const cookies = session.fromPartition(PERSIST_PARTITION).cookies;
    const probe = async (): Promise<boolean> =>
      (await cookies.get({ name: COOKIE_NAME })).some(
        (c) => c.name === COOKIE_NAME && c.value === COOKIE_VALUE,
      );

    if (mode === 'set') {
      const pages = await startControlledPages();
      try {
        const tab = await controller.createTab(pages.setCookieUrl);
        await waitFor(probe, 10000, 'Set-Cookie 后未在 10 秒内写入 persist 分区 Cookie 存储');
        assert(await controller.closeTab(tab.id), '关闭会话冒烟标签页应返回 true');
        await delay(500); // 给持久层落盘留出安全余量（干净退出时 Chromium 会 flush）
        logInfo('smoke', 'Session 冒烟（set）通过：Cookie 已写入持久分区');
      } finally {
        await pages.close();
      }
    } else {
      await waitFor(probe, 10000, '重启后未在 10 秒内从持久分区读到先前写入的 Cookie');
      logInfo(
        'smoke',
        'Session 冒烟（check）通过：新进程读取到先前写入的 Cookie（跨进程持久化生效）',
      );
    }
  } catch (err) {
    logError('smoke', 'Session 冒烟失败', err);
    throw err;
  }
}
