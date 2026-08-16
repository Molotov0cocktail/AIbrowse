// Fifth Stage C7: production ResearchRuntimeFactory (adjudication #155) —
// narrow-responsibility module so index.ts keeps its minimal assembly. Real
// dependencies wired: SourceService (normal-state re-check), SearchProvider,
// BrowserController, Provider config/credential resolution (ConfigStore +
// SecureCredentialStore read dynamically on every start; the Key is used
// short-lived inside main only and never cached), the real C6 ports
// (RESEARCH_PROMPTS_PORT/RESEARCH_SYNTHESIS_PORT) and the real C7 port
// (RESEARCH_RESULT_VALIDATION_PORT). Every launch creates an independent
// ResearchWorkspace/CaptureService/ResearchRuntime. Adjudication #154(7)
// shape: resolveProvider returns a one-shot prepared launch bound to a single
// start call (launch/release exactly-once); the LLMProvider instance never
// leaks into shared types.
import type { DbHandle } from '../sources/db/sqlite-driver';
import type { ConfigStore } from '../ai/config-store';
import type { SecureCredentialStore } from '../ai/credential-store';
import { listProviderKinds, resolveProvider, type LLMProvider } from '../ai/provider/llm-provider';
import { selectRegisteredProviderInfo } from '../ai/conversation-service';
import { logWarn } from '../logger';
import { RESEARCH_PROMPTS_PORT } from './synthesis/research-prompts';
import { RESEARCH_SYNTHESIS_PORT } from './synthesis/claim-model';
import { RESEARCH_RESULT_VALIDATION_PORT } from './result-validator';
import { createRepositoryPersistence } from './research-runtime-persistence';
import { ResearchRuntime } from './research-runtime';
import { ResearchWorkspace, type ResearchWorkspaceBrowser } from './research-workspace';
import { CaptureService } from './capture-service';
import type { ResearchSourcePort } from './research-runtime';
import type { CaptureBrowserPort } from './capture-service';
import type { SearchProvider } from '../ai/search/search-provider';
import type {
  ResearchPreparedLaunch,
  ResearchPreparedLaunchResult,
  ResearchRuntimeFactory,
} from '../../shared/types/research';

export interface ProductionSourcePort extends ResearchSourcePort {
  getState(): { mode: 'normal' | 'readonly-recovery' | 'unavailable' };
}

// 浏览器最小结构端口 = Workspace 五方法 + Capture 快照端口
// （BrowserControllerImpl 结构兼容，typecheck 保证）
export type ProductionBrowserPort = ResearchWorkspaceBrowser & CaptureBrowserPort;

export interface ProductionResearchRuntimeFactoryOptions {
  db: DbHandle;
  browser: ProductionBrowserPort; // BrowserController 最小结构端口
  sourceService: ProductionSourcePort | null; // null/非 normal → sources-unavailable
  searchProvider: SearchProvider | null; // null = 装配缺陷 → unavailable
  configStore: ConfigStore;
  credentials: SecureCredentialStore;
  createId?: () => string;
}

// 决议 #155(3)：错误精确映射——config 缺失/Key 缺失/创建失败/不支持 tools →
// research-provider-unavailable；Sources 缺失或非 normal →
// research-sources-unavailable；装配缺陷 → research-unavailable。
export function createProductionResearchRuntimeFactory(
  options: ProductionResearchRuntimeFactoryOptions,
): ResearchRuntimeFactory {
  return {
    async resolveProvider(): Promise<ResearchPreparedLaunchResult> {
      const source = options.sourceService;
      if (source === null) {
        return { ok: false, errorCode: 'research-sources-unavailable' };
      }
      try {
        if (source.getState().mode !== 'normal') {
          return { ok: false, errorCode: 'research-sources-unavailable' };
        }
      } catch (err) {
        logWarn('research', 'Sources 状态查询异常（归一 research-sources-unavailable）', err);
        return { ok: false, errorCode: 'research-sources-unavailable' };
      }
      if (options.searchProvider === null) {
        logWarn('research', 'SearchProvider 未装配（归一 research-unavailable）');
        return { ok: false, errorCode: 'research-unavailable' };
      }
      let provider: LLMProvider | null = null;
      let model = '';
      try {
        // 决议 #155(2)：Provider 配置/模型/凭据每次 start 动态读取（零缓存）
        const infos = await options.configStore.list();
        const info = selectRegisteredProviderInfo(infos, listProviderKinds());
        if (info === null) return { ok: false, errorCode: 'research-provider-unavailable' };
        const config = options.configStore.get(info.providerId);
        provider = await resolveProvider(config, options.credentials);
        if (provider === null) {
          return { ok: false, errorCode: 'research-provider-unavailable' };
        }
        if (!provider.metadata.supportsToolCalling) {
          // 决议 #155(3)：真实 tool capability 由异步 resolve 权威判定
          provider = null;
          return { ok: false, errorCode: 'research-provider-unavailable' };
        }
        model = config === null ? '' : config.model;
        if (model === '') return { ok: false, errorCode: 'research-provider-unavailable' };
      } catch (err) {
        // 决议 #155(3)：config 读取/Provider 创建异常 → provider-unavailable
        // （Key 零缓存——失败路径不保留实例）
        provider = null;
        logWarn('research', 'Provider 解析异常（归一 research-provider-unavailable）', err);
        return { ok: false, errorCode: 'research-provider-unavailable' };
      }
      // 决议 #154(7)：prepared 与单次 start 绑定（launch/release 恰好一次）
      let consumed = false;
      const prepared: ResearchPreparedLaunch = {
        launch(input) {
          if (consumed) throw new Error('程序缺陷：prepared 已被消费');
          consumed = true;
          const stopController = new AbortController();
          const runtime = new ResearchRuntime({
            taskId: input.taskId,
            goal: input.goal,
            runToken: input.runToken,
            model,
            provider: provider as LLMProvider,
            sourceService: source,
            searchProvider: options.searchProvider as SearchProvider,
            captureService: new CaptureService({
              workspace: new ResearchWorkspace(input.taskId, options.browser),
              browser: options.browser,
            }),
            persistence: createRepositoryPersistence(options.db, input.taskId),
            prompts: RESEARCH_PROMPTS_PORT,
            synthesis: RESEARCH_SYNTHESIS_PORT,
            resultValidation: RESEARCH_RESULT_VALIDATION_PORT,
            createId: options.createId,
            onProgress: input.onProgress,
            onSettle: input.onSettle,
            stopSignal: stopController.signal,
          });
          const done = runtime.run();
          return {
            taskId: input.taskId,
            runToken: input.runToken,
            done,
            abort: () => stopController.abort(),
          };
        },
        release() {
          // 决议 #154(7)：幂等——不 launch 时丢弃 prepared（shutdown/取消/
          // 异常路径必须调用）；释放后 Provider 引用随闭包消亡（Key 零缓存）
          consumed = true;
        },
      };
      return { ok: true, prepared };
    },
  };
}
