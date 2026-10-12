// Read only the authorized credential/configuration surface. No business data is opened.
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ConfigStore } from '../../src/main/ai/config-store';
import { SecureCredentialStoreImpl } from '../../src/main/ai/credential-store';
import { SafeStorageCipher } from '../../src/main/ai/safe-storage-cipher';
import { OpenAICompatibleProvider } from '../../src/main/ai/provider/openai-compatible';
import {
  buildRoundAssistantMessage,
  replayToProviderMessages,
} from '../../src/main/ai/agent/agent-history';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderToolCall,
} from '../../src/shared/types/conversation';
import type { DigestService } from '../../src/main/watch/digest-service';
import { digestFixture, researchFixture } from './models-fixtures';
import { classifyDigestOutput, diagnosticDigestSchema } from './models-classify';

console.log = console.warn = console.error = console.debug = () => undefined;
const source = process.env.AIBROWSE_DIAGNOSTIC_SOURCE_PROFILE;
const resultRoot = process.env.AIBROWSE_DIAGNOSTIC_RESULT_ROOT;
const mode =
  process.env.AIBROWSE_DIAGNOSTIC_MODE === 'digest-pair'
    ? 'digest-pair'
    : process.env.AIBROWSE_DIAGNOSTIC_MODE === 'digest-schema'
      ? 'digest-schema'
      : process.env.AIBROWSE_DIAGNOSTIC_MODE === 'digest-only'
        ? 'digest-only'
        : 'full';
delete process.env.AIBROWSE_DIAGNOSTIC_SOURCE_PROFILE;
delete process.env.AIBROWSE_DIAGNOSTIC_RESULT_ROOT;
delete process.env.AIBROWSE_DIAGNOSTIC_MODE;
if (!source || !resultRoot) throw new Error('诊断路径缺失');
const sourceRoot = resolve(source);
const root = resolve(resultRoot);
if (sourceRoot === root || root.startsWith(`${sourceRoot}\\`)) throw new Error('诊断目录必须独立');
mkdirSync(root, { recursive: true });
const profile = join(root, 'isolated-profile');
mkdirSync(profile, { recursive: true });
const surfaces = ['provider-config.json', 'credentials.json', 'Local State'];
const hash = (name: string) =>
  createHash('sha256')
    .update(readFileSync(join(sourceRoot, name)))
    .digest('hex');
const before = surfaces.map(hash);
const localState = JSON.parse(readFileSync(join(sourceRoot, 'Local State'), 'utf8')) as {
  os_crypt?: unknown;
};
writeFileSync(join(profile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }));
app.setPath('userData', profile);
// Chromium loads OSCrypt Local State from sessionData; keep the copied key at that exact root.
app.setPath('sessionData', profile);

interface CallRecord {
  purpose: string;
  httpStatus: number | null;
  reasoningRequired: boolean;
  reasoningChunks: number;
  reasoningChars: number;
  deltaChars: number;
  tools: number;
  replayReasoningChars: number;
  errors: string[];
  done: boolean;
}
const report: {
  baseline: string;
  budget: number;
  networkRequests: number;
  calls: CallRecord[];
  credential: string;
  mode: string;
  digestOutputClassification?: unknown;
  requestContract?: unknown;
  phase?: string;
  schemaControl?: unknown;
  credentialCounts?: { configured: number; available: number; cipherAvailable: boolean };
  originalSurfacesUnchanged: boolean;
  digest?: unknown;
  oldDigest?: unknown;
  research?: unknown;
  replayOnlyReasoningDifference?: boolean;
  finished?: boolean;
} = {
  baseline: 'dedbfdcbdcea2723eb09c4f73c0f1b5810cbe9e8',
  budget: mode === 'full' ? 6 : mode === 'digest-pair' ? 2 : 1,
  networkRequests: 0,
  mode,
  calls: [],
  credential: '尚未读取',
  originalSurfacesUnchanged: false,
};
const save = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
const guard = setTimeout(() => {
  report.finished = false;
  save();
  app.exit(2);
}, 330_000);
let active: CallRecord | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (active === null || report.networkRequests >= report.budget)
    throw new Error('请求预算或用途缺失');
  report.networkRequests++;
  save();
  const response = await realFetch(input, init);
  active.httpStatus = response.status;
  if (response.status === 400 || response.status === 422) {
    const reader = response.clone().body?.getReader();
    if (reader) {
      let text = '';
      while (text.length < 8192) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      void reader.cancel();
      active.reasoningRequired =
        /reasoning_content/i.test(text) && /missing|required|must/i.test(text);
    }
  }
  return response;
};

function instrument(
  provider: LLMProvider,
  purpose: string,
  observe?: (event: ProviderEvent) => void,
): LLMProvider {
  return {
    metadata: provider.metadata,
    async *stream(request, signal) {
      if (report.calls.length >= report.budget) throw new Error('真实请求预算耗尽');
      const record: CallRecord = {
        purpose,
        httpStatus: null,
        reasoningRequired: false,
        reasoningChunks: 0,
        reasoningChars: 0,
        deltaChars: 0,
        tools: 0,
        replayReasoningChars: request.messages.reduce(
          (n, message) => n + (message.reasoning?.length ?? 0),
          0,
        ),
        errors: [],
        done: false,
      };
      report.calls.push(record);
      active = record;
      save();
      try {
        for await (const event of provider.stream(request, signal)) {
          if (event.type === 'reasoning') {
            record.reasoningChunks++;
            record.reasoningChars += event.text.length;
          }
          if (event.type === 'delta') record.deltaChars += event.text.length;
          if (event.type === 'toolCalls') record.tools += event.toolCalls.length;
          if (event.type === 'error') record.errors.push(event.error.code);
          if (event.type === 'done') record.done = true;
          observe?.(event);
          yield event;
        }
      } finally {
        active = null;
        save();
      }
    },
  };
}

async function run(): Promise<void> {
  await app.whenReady();
  const credentials = new SecureCredentialStoreImpl(sourceRoot, new SafeStorageCipher());
  const configs = new ConfigStore(sourceRoot, credentials);
  const listed = await configs.list();
  const available = listed.filter((item) => item.hasKey);
  report.credentialCounts = {
    configured: listed.length,
    available: available.length,
    cipherAvailable: credentials.isAvailable(),
  };
  if (available.length !== 1) {
    report.credential = '凭据不可用或目标不唯一';
    return;
  }
  const config = configs.get(available[0]!.providerId);
  if (config === null) {
    report.credential = '凭据不可用';
    return;
  }
  const provider = new OpenAICompatibleProvider(config, credentials, {
    connectMs: 15_000,
    idleMs: 30_000,
    totalMs: 45_000,
  });
  report.credential = '真实ConfigStore与SafeStorageCipher只读解密可用';
  if (mode === 'full') {
    const requests: ProviderRequest[] = [];
    let reasoning = '';
    let firstText = '';
    let toolCalls: ProviderToolCall[] = [];
    const bounded: LLMProvider = {
      metadata: provider.metadata,
      async *stream(request, signal) {
        if (requests.length >= 2) {
          fixture.controller.abort();
          return;
        }
        const index = requests.length;
        requests.push(structuredClone(request));
        const measured = instrument(
          provider,
          index === 0 ? 'Research真实工具轮生成' : 'Research原始工具续轮无reasoning',
          (event) => {
            if (index !== 0) return;
            if (event.type === 'reasoning') {
              reasoning += event.text;
              if (reasoning.length > 256_000) fixture.controller.abort();
            }
            if (event.type === 'delta') firstText += event.text;
            if (event.type === 'toolCalls') toolCalls = event.toolCalls;
          },
        );
        yield* measured.stream(request, signal);
      },
    };
    const fixture = researchFixture(root, bounded, config.model, false, true);
    try {
      await fixture.runtime.run();
      report.research = {
        toolRoundReached: toolCalls.length > 0,
        continuationObserved: requests.length === 2,
        continuationHadToolMessage: requests[1]?.messages.some(
          (message) => message.role === 'tool',
        ),
        observed: fixture.observed,
        diagnosticStopStatus: fixture.task()?.status,
      };
    } finally {
      fixture.close();
    }
    const continuation = requests[1];
    let controlText = '';
    if (continuation && toolCalls.length > 0 && reasoning.length > 0) {
      const replay: ProviderRequest = structuredClone(continuation);
      const assistant = replay.messages.find(
        (message) => message.role === 'assistant' && message.toolCalls,
      );
      if (!assistant) throw new Error('工具续轮缺少assistant');
      assistant.reasoning = reasoning;
      const compared = structuredClone(replay);
      delete compared.messages.find((message) => message.toolCalls)!.reasoning;
      report.replayOnlyReasoningDifference =
        JSON.stringify(compared) === JSON.stringify(continuation);
      const measured = instrument(provider, '相同Research续轮仅补同源内存reasoning', (event) => {
        if (event.type === 'delta') controlText += event.text;
      });
      for await (const event of measured.stream(replay, AbortSignal.timeout(50_000))) void event;
      const persistedAssistant = buildRoundAssistantMessage({
        id: 'assistant-1',
        text: firstText,
        toolCalls,
        now: 0,
      });
      const tools = continuation.messages
        .filter((message) => message.role === 'tool')
        .map((message, index) => ({
          id: `tool-${index}`,
          role: 'tool' as const,
          toolCallId: message.toolCallId,
          content: message.content,
          createdAt: 0,
          status: 'complete' as const,
        }));
      const history = replayToProviderMessages([
        persistedAssistant,
        ...tools,
        {
          id: 'final-1',
          role: 'assistant',
          content: controlText || '合成查询结束',
          createdAt: 0,
          status: 'complete',
        },
      ]);
      const question = {
        role: 'user' as const,
        content: '这是下一轮独立合成问题，请只回答字符串 OK。不要调用工具。',
      };
      const priorUser = requests[0]!.messages.filter((message) => message.role === 'user');
      const oldRequest: ProviderRequest = {
        ...continuation,
        requestId: 'old-run-history',
        messages: [...priorUser, ...history, question],
      };
      for await (const event of instrument(provider, '跨run完整旧工具历史无reasoning').stream(
        oldRequest,
        AbortSignal.timeout(50_000),
      ))
        void event;
      const freshRequest: ProviderRequest = {
        ...oldRequest,
        requestId: 'fresh-run-control',
        messages: [question],
      };
      for await (const event of instrument(provider, '无旧工具历史的新run对照').stream(
        freshRequest,
        AbortSignal.timeout(50_000),
      ))
        void event;
    }
    reasoning = '';
    firstText = '';
    controlText = '';
    requests.length = 0;
  }
  const replayEvents: ProviderEvent[] = [];
  const retained: { request: ProviderRequest | null } = { request: null };
  const digestProvider = instrument(provider, '真实DigestService合成事件AI解释', (event) => {
    if (event.type === 'reasoning')
      replayEvents.push({ type: 'reasoning', text: 'SYNTHETIC_REASONING_MARKER' });
    else if (event.type === 'delta' || event.type === 'done' || event.type === 'toolCalls')
      replayEvents.push(event);
    else
      replayEvents.push({
        type: 'error',
        error: { ...event.error, providerId: null, model: null },
      });
  });
  const observedDigest: LLMProvider = {
    metadata: digestProvider.metadata,
    async *stream(request, signal) {
      if (mode === 'digest-schema')
        request = { ...request, system: request.system + '\n' + diagnosticDigestSchema };
      retained.request = structuredClone(request);
      const prompt = request.system + request.messages.map((message) => message.content).join('\n');
      report.requestContract = {
        mentionsSections: prompt.includes('sections'),
        mentionsExplanation: prompt.includes('explanation'),
        mentionsEventIds: prompt.includes('eventIds'),
        requestsCanonical: prompt.includes('canonical JSON'),
      };
      yield* digestProvider.stream(request, signal);
    },
  };
  const digest = digestFixture(root, observedDigest, config.model);
  try {
    await digest.run();
    const row = digest.result();
    report.digest = {
      state: row?.provider_state,
      code: row?.provider_result_code,
      hasExplanation: typeof row?.explanation_json === 'string',
      factsHash: row?.facts_hash,
    };
  } finally {
    digest.close();
  }
  report.digestOutputClassification = classifyDigestOutput(
    replayEvents
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join(''),
    ['event-001'],
  );
  const require = createRequire(join(root, 'entry.cjs'));
  const oldFile = join(root, 'old-digest.cjs');
  if (existsSync(oldFile)) {
    const old = require(oldFile) as { DigestService: typeof DigestService };
    const offline: LLMProvider = {
      metadata: provider.metadata,
      async *stream() {
        yield* replayEvents;
      },
    };
    const previous = digestFixture(root, offline, 'offline-real-stream-shape', old.DigestService);
    try {
      await previous.run();
      const row = previous.result();
      report.oldDigest = {
        state: row?.provider_state,
        code: row?.provider_result_code,
        hasExplanation: typeof row?.explanation_json === 'string',
        reasoningReplacedBySyntheticMarker: true,
      };
    } finally {
      previous.close();
    }
  }
  replayEvents.length = 0;
  if (mode === 'digest-pair' && retained.request !== null) {
    report.phase = 'awaiting-schema-control';
    save();
    const decision = join(root, 'allow-schema-control.json');
    const expiresAt = Date.now() + 60_000;
    let allowed = false;
    while (Date.now() < expiresAt) {
      if (existsSync(decision)) {
        try {
          allowed =
            (JSON.parse(readFileSync(decision, 'utf8')) as { allow?: unknown }).allow === true;
        } catch {
          allowed = false;
        }
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (allowed) {
      const original = retained.request;
      const modified = structuredClone(original);
      modified.system += '\n' + diagnosticDigestSchema;
      const restored = structuredClone(modified);
      restored.system = original.system;
      const onlySystemChanged = JSON.stringify(restored) === JSON.stringify(original);
      if (!onlySystemChanged) throw new Error('对照改变了schema以外的请求');
      const controlEvents: ProviderEvent[] = [];
      const controlled = instrument(
        provider,
        '同一Digest请求仅补完整输出schema反事实对照',
        (event) => {
          if (event.type === 'delta' || event.type === 'done') controlEvents.push(event);
        },
      );
      const injected: LLMProvider = {
        metadata: controlled.metadata,
        async *stream(_request, signal) {
          yield* controlled.stream(modified, signal);
        },
      };
      const control = digestFixture(root, injected, config.model);
      try {
        await control.run();
        const row = control.result();
        const output = controlEvents
          .filter((event) => event.type === 'delta')
          .map((event) => event.text)
          .join('');
        report.schemaControl = {
          onlySystemChanged,
          state: row?.provider_state,
          code: row?.provider_result_code,
          hasExplanation: typeof row?.explanation_json === 'string',
          classification: classifyDigestOutput(output, ['event-001']),
        };
      } finally {
        control.close();
        controlEvents.length = 0;
      }
    } else report.schemaControl = { executed: false, reason: '未收到内部对照标记或等待到期' };
    retained.request = null;
    report.phase = 'finished';
  }
}

void run()
  .then(
    () => {
      report.finished = true;
    },
    () => {
      report.finished = false;
    },
  )
  .finally(() => {
    report.originalSurfacesUnchanged = surfaces.every(
      (name, index) => hash(name) === before[index],
    );
    save();
    clearTimeout(guard);
    globalThis.fetch = realFetch;
    app.quit();
  });
