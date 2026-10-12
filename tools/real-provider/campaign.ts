// Test-only composition of production services. Secrets arrive over a one-use pipe.
import { app, BaseWindow, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { SecureCredentialStoreImpl } from '../../src/main/ai/credential-store';
import { SafeStorageCipher } from '../../src/main/ai/safe-storage-cipher';
import { ConfigStore } from '../../src/main/ai/config-store';
import { OpenAICompatibleProvider } from '../../src/main/ai/provider/openai-compatible';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { digestFixture } from '../legacy-diagnostics/models-fixtures';
import { runResearchScenarios } from './research-scenarios';
import { runConversationScenarios } from './conversation-scenarios';
import { runIndependentWatchScenarios } from './watch-scenarios';
import { campaignPolicy, validCampaignPolicyBinding } from './campaign-policy';

console.log = console.warn = console.error = console.debug = () => undefined;
const root = app.getAppPath();
const profile = join(root, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-http-cache');
app.on('window-all-closed', () => undefined);
const phase = process.env.AIBROWSE_CAMPAIGN_PHASE ?? 'all';
const origin = process.env.AIBROWSE_CAMPAIGN_ORIGIN ?? '';
const model =
  phase === 'watch-repair'
    ? 'deepseek-flash'
    : (process.env.AIBROWSE_CAMPAIGN_MODEL ?? 'deepseek-flash');
const policy = campaignPolicy(phase);
if (
  !validCampaignPolicyBinding(JSON.parse(readFileSync(join(root, 'binding.json'), 'utf8')), phase)
)
  throw new Error('验收阶段预算绑定不符');
const budget = policy.requestBudget;
const campaignAbort = new AbortController();
interface Call {
  purpose: string;
  status: number | null;
  textChars: number;
  reasoningChars: number;
  tools: number;
  errors: string[];
  done: boolean;
  elapsedMs: number;
}
const report = {
  phase,
  model,
  budget,
  networkRequests: 0,
  calls: [] as Call[],
  cases: [] as unknown[],
  finished: false,
  fatal: null as string | null,
  stage: 'startup',
  credentialsDeleted: false,
  browserDisposed: false,
  ...(phase === 'watch-repair' ? { passed: false } : {}),
};
const save = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
let purpose = '准备';
let active: Call | null = null;
let networkBlocked = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (
    url !== 'https://api.deepseek.com/chat/completions' ||
    init?.redirect !== 'error' ||
    !active ||
    report.networkRequests >= budget ||
    networkBlocked
  )
    throw new Error('验收网络范围或预算拒绝');
  report.networkRequests++;
  save();
  const response = await realFetch(input, init);
  active.status = response.status;
  if ([401, 402, 403, 429].includes(response.status)) networkBlocked = true;
  save();
  return response;
};
const inputKey = new Promise<string>((resolve, reject) => {
  const pipe = process.env.AIBROWSE_CAMPAIGN_PIPE;
  const token = process.env.AIBROWSE_CAMPAIGN_TOKEN;
  delete process.env.AIBROWSE_CAMPAIGN_PIPE;
  delete process.env.AIBROWSE_CAMPAIGN_TOKEN;
  if (
    !pipe ||
    !/^\\\\\.\\pipe\\aibrowse-real-[a-f0-9]{32}$/.test(pipe) ||
    !token ||
    !/^[a-f0-9]{32}$/.test(token)
  ) {
    reject(new Error('一次性凭据通道缺失'));
    return;
  }
  const input = connect(pipe, () => input.write(token + '\n'));
  let value = '';
  input.setEncoding('utf8');
  input.setTimeout(10000, () => input.destroy(new Error('凭据通道超时')));
  input.on('data', (chunk: string) => {
    value += chunk;
    if (value.length > 256) {
      value = '';
      reject(new Error('凭据输入超限'));
      input.destroy();
    }
  });
  input.once('end', () => {
    const key = value.trim();
    value = '';
    resolve(key);
  });
  input.once('error', () => reject(new Error('凭据输入失败')));
});
const guard = setTimeout(
  () => {
    report.fatal = '总期限耗尽（失败退出）';
    save();
    if (phase !== 'watch-repair') {
      app.exit(2);
      return;
    }
    networkBlocked = true;
    campaignAbort.abort();
    void Promise.race([cleanupCredential(), new Promise((done) => setTimeout(done, 3000))]).finally(
      () => {
        save();
        app.exit(2);
      },
    );
  },
  phase === 'watch-repair' ? policy.lifetimeMs - 5000 : policy.lifetimeMs,
);
let credentials: SecureCredentialStoreImpl | null = null;
let credentialCleanup: Promise<void> | null = null;
function cleanupCredential(): Promise<void> {
  credentialCleanup ??= (async () => {
    try {
      if (credentials) report.credentialsDeleted = await credentials.delete('openai-compatible');
      else if (phase === 'watch-repair')
        report.credentialsDeleted = !existsSync(join(profile, 'credentials.json'));
      if (report.credentialsDeleted && existsSync(join(profile, 'credentials.json')))
        report.credentialsDeleted = !readFileSync(
          join(profile, 'credentials.json'),
          'utf8',
        ).includes('openai-compatible');
    } catch {
      report.credentialsDeleted = false;
      report.fatal ??= '凭据清除失败';
    }
  })();
  return credentialCleanup;
}
let browser: BrowserControllerImpl | null = null;
let win: BaseWindow | null = null;
async function run() {
  await app.whenReady();
  report.stage = 'input';
  const key = await inputKey;
  if (!/^sk-[a-zA-Z0-9_-]{16,200}$/.test(key)) throw new Error('凭据输入格式无效');
  credentials = new SecureCredentialStoreImpl(profile, new SafeStorageCipher());
  report.stage = 'dpapi';
  if (!credentials.isAvailable() || !(await credentials.set('openai-compatible', key)))
    throw new Error('DPAPI准备失败');
  const configs = new ConfigStore(profile, credentials);
  report.stage = 'binding';
  const config = { providerId: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model };
  if (
    !configs.commitAuthorized(
      config,
      configs.getVersion(),
      credentials.getGeneration(config.providerId),
    )
  )
    throw new Error('目标绑定失败');
  const authorized = configs.get(config.providerId);
  report.stage = 'provider';
  if (!authorized) throw new Error('已授权配置缺失');
  const actual = new OpenAICompatibleProvider(authorized, credentials, {
    connectMs: 15000,
    idleMs: 30000,
    totalMs: 60000,
  });
  const provider: LLMProvider = {
    metadata: actual.metadata,
    async *stream(request, signal) {
      if (active || report.calls.length >= budget || networkBlocked)
        throw new Error('验收请求预算或认证门拒绝');
      const call: Call = {
        purpose,
        status: null,
        textChars: 0,
        reasoningChars: 0,
        tools: 0,
        errors: [],
        done: false,
        elapsedMs: 0,
      };
      active = call;
      report.calls.push(call);
      save();
      const started = performance.now();
      try {
        for await (const event of actual.stream(
          request,
          AbortSignal.any([signal, campaignAbort.signal]),
        )) {
          if (event.type === 'delta') call.textChars += event.text.length;
          if (event.type === 'reasoning') call.reasoningChars += event.text.length;
          if (event.type === 'toolCalls') call.tools += event.toolCalls.length;
          if (event.type === 'error') call.errors.push(event.error.code);
          if (event.type === 'done') call.done = true;
          yield event;
        }
      } finally {
        call.elapsedMs = performance.now() - started;
        active = null;
        save();
      }
    },
  };
  if (phase === 'probe' || phase === 'all' || phase === 'watch-repair') {
    purpose = '基本流式连通与准确回答';
    let text = '';
    for await (const event of provider.stream(
      {
        requestId: 'basic',
        model,
        system: '回答简短。',
        messages: [{ role: 'user', content: '只回答整数：19加23等于多少？' }],
      },
      AbortSignal.timeout(65000),
    )) {
      if (event.type === 'delta') text += event.text;
    }
    report.cases.push({
      name: purpose,
      passed:
        text.trim() === '42' &&
        report.calls.at(-1)?.done &&
        report.calls.at(-1)?.errors.length === 0,
    });
    save();
    if (networkBlocked) return;
    if (phase === 'watch-repair') {
      if (
        !report.cases.every(
          (item) =>
            typeof item === 'object' && item !== null && 'passed' in item && item.passed === true,
        )
      )
        return;
      purpose = '独立Watch目标显式授权AI解释';
      report.cases.push(await runIndependentWatchScenarios(root, provider, model));
      save();
      return;
    }
    purpose = 'Watch生产摘要schema与真实解释';
    const fixture = digestFixture(root, provider, model);
    try {
      await fixture.run();
      const row = fixture.result();
      report.cases.push({
        name: purpose,
        state: row?.provider_state,
        code: row?.provider_result_code,
        hasExplanation: typeof row?.explanation_json === 'string',
        passed: row?.provider_state === 'succeeded' && typeof row?.explanation_json === 'string',
      });
    } finally {
      fixture.close();
      save();
    }
  }
  if (networkBlocked || phase === 'probe') return;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('合成网页origin缺失');
  win = new BaseWindow({ show: false });
  const partition = session.fromPartition('campaign-synthetic');
  partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== 'about:blank' && !details.url.startsWith(origin + '/') }),
  );
  browser = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: { getSession: () => partition },
    getFallbackBounds: () => ({ x: 0, y: 0, width: 1000, height: 750 }),
  });
  await browser.createTab();
  if (phase === 'conversation' || phase === 'all') {
    purpose = '真实共读与Agent隔离场景';
    const directory = join(root, 'conversation');
    mkdirSync(directory);
    report.cases.push(
      await runConversationScenarios(
        browser,
        origin,
        directory,
        provider,
        model,
        configs,
        credentials,
      ),
    );
    save();
  }
  if (!networkBlocked && (phase === 'research' || phase === 'all')) {
    purpose = '两显式URL真实Research全链路';
    const directory = join(root, 'research');
    mkdirSync(directory);
    report.cases.push(await runResearchScenarios(browser, origin, directory, provider, model));
    save();
  }
}
void run()
  .then(
    () => {
      report.finished = true;
    },
    (error: unknown) => {
      // Errors may carry remote strings: persist only a bounded local category.
      report.fatal = error instanceof Error ? error.name : '未知错误';
    },
  )
  .finally(async () => {
    if (browser) {
      browser.dispose();
      report.browserDisposed = true;
    }
    win?.destroy();
    await cleanupCredential();
    clearTimeout(guard);
    globalThis.fetch = realFetch;
    if (phase === 'watch-repair')
      report.passed =
        report.finished &&
        report.fatal === null &&
        report.credentialsDeleted &&
        report.networkRequests === 2 &&
        report.calls.length === 2 &&
        report.calls.every(
          (call) => call.status === 200 && call.done && call.errors.length === 0,
        ) &&
        report.cases.length === 2 &&
        report.cases.every(
          (item) =>
            typeof item === 'object' && item !== null && 'passed' in item && item.passed === true,
        );
    save();
    app.quit();
  });
