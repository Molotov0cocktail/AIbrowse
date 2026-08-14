// SearchProvider（A4）：统一搜索抽象 + v1 Bing 搜索页实现。契约源：
// doc/stage3/detailed-design.md §6（接口）+ proposal Q3/Q11（浏览器搜索页 + 临时 Tab
// 可见执行后关闭）。零 Electron import——浏览器能力只经构造注入的 BrowserController
// 使用（Agent 架构纪律）；接口隔离保未来替换（决议 #22：API 供应商实现同接口即可）。
//
// 临时搜索 Tab 所有权与恢复语义（本任务实施固定，任何路径必须遵守）：
//  1. 调用开始时记录 Tab 集合与原活动 Tab，但绝不把用户已有 Tab 标记为临时资源；
//  2. 只允许关闭本次调用成功创建的精确 tabId（createTab 返回值），绝不按位置/标题/
//     URL/活动 Tab 推断所有权；
//  3. 创建、等待 ready、快照、解析、取消、超时、异常任何路径经 try/finally 最佳努力清理；
//  4. 临时 Tab 已被用户/其他流程关闭 → finally 安全无操作，绝不关闭替代 Tab；
//  5. 清理时用户仍停留在临时搜索 Tab → 恢复到调用前仍存在的活动 Tab；用户已主动
//     切换到其他 Tab → 不抢回焦点；调用前活动 Tab 已被关闭 → 不重建不激活，
//     沿用 BrowserController.closeTab 的正常活动 Tab 策略；
//  6. 并发调用各持有各自局部 tabId（本模块零共享状态，无「当前搜索 Tab」变量）。
//
// 错误映射（「工具错误不得被模型误认为成功」上位要求的最小契约校准）：
//  ready 超时/导航失败/Tab 被提前关闭/快照 null（L3）/快照 L2 降级/空内容快照
//  （结构无法识别）/BrowserController 异常 → ok:false + search-failed；
//  页面有内容但无有机结果 → ok:true 空数组 + 明确提示；AbortSignal → errorCode
//  'aborted'（由工具层/A5 归一）。
//
// 解析容忍设计：启发式不追求完美——结构变化降级为 warnings，不抛异常、不阻塞 Agent。
// v1 限制（如实登记）：快照为扁平结构，无法为每条结果提供可靠的摘要关联证据 →
// snippet 恒空串 + warning；Bing ck/a 包装链接以确定性 base64url 规则还原
// （u=a1<base64url>，实测 2026-08-14 公网 Bing 主要返回直接目标 URL，两形态均覆盖测试）。
import { SEARCH_ENGINE_URL } from '../../../shared/url';
import type { PageSnapshot } from '../../../shared/types/browser';
import type { BrowserController } from '../../browser/browser-controller';
import { logWarn } from '../../logger';

// §6.1：query 上限（与 ToolRegistry 字符串校验上限同值——注册表为第一道校验，
// 提供者级校验为纵深防御，任何超出 fail-closed 拒绝而非截断）
export const SEARCH_QUERY_MAX_LENGTH = 500;
// 结果条目上限与字段长度（§6.1：title ≤200、最多 10 条；snippet 契约上限 300——
// v1 扁平快照无可靠关联证据恒空串，故无需截断常量，未来供应商实现须遵守该上限）
const RESULT_MAX = 10;
const TITLE_MAX = 200;
// 默认 ready 等待超时（§6.2：15 秒；可注入以便确定性测试）
export const SEARCH_READY_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 50;

export interface SearchResult {
  title: string; // ≤ 200 字符（确定性截断）
  url: string; // http/https（解析层过滤，非 http/https 丢弃）
  snippet: string; // 摘要 ≤ 300 字符；无可靠关联证据 → 空串
  source: string; // 引擎标识（v1 恒 'bing'）
}

export interface SearchProviderResult {
  ok: boolean;
  results: SearchResult[]; // ok=false 或降级时为空
  errorCode?: 'search-failed' | 'aborted'; // aborted 由外层（工具层/A5）归一
  warnings?: string[]; // 中文（解析降级/部分结果丢弃/空结果原因）
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, signal: AbortSignal): Promise<SearchProviderResult>;
}

// Bing 自身域（含所有子域）——搜索引擎自身导航/设置/登录等非结果链接一律丢弃；
// 形似域名（bing.com.evil.com）不匹配（锚定结尾）。
const BING_HOST_PATTERN = /(^|\.)bing\.com$/i;

// 明确的 Bing 非结果导航标签（中英双语，精确匹配 trimmed 文本）：设置/登录/隐私/
// 广告控制等页脚与头部导航常指向 go.microsoft.com 等非 bing 域，需按标签确定性过滤。
// 代价（如实登记）：与标签完全同名的合法结果标题会被一并过滤——宁简勿误配。
const BING_NON_RESULT_LABELS: ReadonlySet<string> = new Set([
  '登录',
  '登入',
  '设置',
  '反馈',
  '隐私声明',
  '隐私和 Cookie',
  '法律声明',
  '使用条款',
  '广告',
  '关于我们的广告',
  '广告反馈',
  'Sign in',
  'Settings',
  'Feedback',
  'Privacy Statement',
  'Privacy & Cookies',
  'Legal',
  'Terms of use',
  'Advertise',
  'About our ads',
  'Ad feedback',
]);

// Bing ck/a 包装链接：真实目标在 u 参数（'a1' 前缀 + base64url 编码）。仅做字符串
// 解码（零代码执行、零网络）；解码失败/非 http/https → null（调用方按自身链接丢弃）。
export function unwrapBingWrapper(href: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (!BING_HOST_PATTERN.test(parsed.hostname) || parsed.pathname !== '/ck/a') return null;
  const u = parsed.searchParams.get('u');
  if (u === null || !u.startsWith('a1')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(u.slice(2), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  try {
    const target = new URL(decoded);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target.href : null;
  } catch {
    return null;
  }
}

// 搜索 URL 只由既有 SEARCH_ENGINE_URL 基准 + 安全 URL 编码构造（无代码拼接路径；
// baseUrl 为测试/未来供应商替换 seam，生产缺省即 SEARCH_ENGINE_URL，常量语义不变）。
export function buildSearchUrl(query: string, baseUrl: string = SEARCH_ENGINE_URL): string {
  return `${baseUrl}?q=${encodeURIComponent(query)}`;
}

// 确定性截断（字段上限，无标记——用户可见截断标记由 ToolExecutor 预算层负责）
function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export interface BingParseResult {
  results: SearchResult[];
  warnings: string[];
  // 快照是否含可解析内容（links 非空或可见文本非空）。区分「合法空结果」
  // （有内容但无有机结果 → ok:true 空数组）与「结构无法识别」
  // （空内容快照 → search-failed，不得伪装成功空结果）。
  hasContent: boolean;
}

// 确定性解析纯函数（§6.2）：输入只能是已 normalize 的 PageSnapshot（或 null=L3），
// 不读取 DOM、不联网；结构不符/URL 畸形/字段缺失均安全降级不抛异常。
// 去重键 = 目标 URL 字符串（包装链接解码后），保持首次出现顺序；最多 10 条。
export function parseBingSearchResults(snapshot: PageSnapshot | null): BingParseResult {
  if (snapshot === null) {
    return { results: [], warnings: ['页面快照不可用'], hasContent: false };
  }
  const links = Array.isArray(snapshot.links) ? snapshot.links : [];
  const visibleText = typeof snapshot.visibleText === 'string' ? snapshot.visibleText : '';
  const hasContent = links.length > 0 || visibleText.trim() !== '';

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  let droppedSelfNav = 0; // 自身域/明确非结果标签/不可还原的包装链接
  let droppedNonHttp = 0;
  let droppedMalformed = 0;
  let droppedEmptyTitle = 0;

  for (const link of links) {
    if (results.length >= RESULT_MAX) break; // 已去重 → 等价于过滤去重后的前 10 条
    const text = typeof link.text === 'string' ? link.text.trim() : '';
    if (text === '') {
      droppedEmptyTitle += 1;
      continue;
    }
    if (BING_NON_RESULT_LABELS.has(text)) {
      droppedSelfNav += 1;
      continue;
    }
    const rawHref = typeof link.href === 'string' ? link.href : '';
    if (rawHref === '') {
      droppedMalformed += 1;
      continue;
    }
    let url = rawHref;
    try {
      const parsed = new URL(rawHref);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        droppedNonHttp += 1;
        continue;
      }
      if (BING_HOST_PATTERN.test(parsed.hostname)) {
        const unwrapped = unwrapBingWrapper(rawHref);
        if (unwrapped === null) {
          droppedSelfNav += 1;
          continue;
        }
        url = unwrapped;
      }
    } catch {
      droppedMalformed += 1;
      continue;
    }
    if (seen.has(url)) continue; // 确定性去重，保持首次出现顺序
    seen.add(url);
    results.push({
      title: cut(text, TITLE_MAX),
      url,
      // v1 扁平快照无法可靠判断某段摘要属于哪条链接 → 空串 + warning
      // （不得把相邻但无依据的文本错误配给结果——宁缺勿错，登记为计划内限制）
      snippet: '',
      source: 'bing',
    });
  }

  const warnings: string[] = [];
  if (droppedSelfNav > 0)
    warnings.push(`已丢弃 ${droppedSelfNav} 条非结果链接（搜索引擎自身导航/设置等）`);
  if (droppedNonHttp > 0) warnings.push(`已丢弃 ${droppedNonHttp} 条非 http/https 链接`);
  if (droppedMalformed > 0) warnings.push(`已丢弃 ${droppedMalformed} 条无效链接`);
  if (droppedEmptyTitle > 0) warnings.push(`已丢弃 ${droppedEmptyTitle} 条空标题链接`);
  if (results.length > 0) {
    warnings.push('扁平快照无法可靠关联每条结果的摘要文本，摘要留空');
  }
  if (results.length === 0 && hasContent) {
    warnings.push('页面中未识别到搜索结果条目');
  }
  return { results, warnings, hasContent };
}

export interface BingSearchProviderOptions {
  browser: BrowserController; // 唯一浏览器通道（构造注入，不 import Electron）
  timeoutMs?: number; // ready 等待超时（缺省 15 秒，§6.2；测试可注入）
  pollIntervalMs?: number; // 状态轮询间隔（缺省 50ms；测试可注入）
  now?: () => number; // 注入时钟（确定性测试）
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 注入睡眠（确定性测试）
  searchBaseUrl?: string; // 测试/未来供应商替换 seam；缺省 SEARCH_ENGINE_URL
}

// 缺省睡眠：abort 时提前解除并清理定时器（不泄漏定时器/监听器）
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve();
    };
    const onAbort = (): void => done();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type WaitOutcome = 'ready' | 'error' | 'missing' | 'aborted' | 'timeout';

export class BingSearchProvider implements SearchProvider {
  readonly id = 'bing';
  private readonly browser: BrowserController;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly searchBaseUrl: string;

  constructor(options: BingSearchProviderOptions) {
    this.browser = options.browser;
    this.timeoutMs = options.timeoutMs ?? SEARCH_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.searchBaseUrl = options.searchBaseUrl ?? SEARCH_ENGINE_URL;
  }

  async search(query: string, signal: AbortSignal): Promise<SearchProviderResult> {
    // 参数校验（fail-closed；注册表校验为第一道，此处为纵深防御——超限拒绝而非截断）
    if (typeof query !== 'string' || query.trim() === '') {
      return { ok: false, errorCode: 'search-failed', results: [], warnings: ['搜索查询为空'] };
    }
    if (query.length > SEARCH_QUERY_MAX_LENGTH) {
      return {
        ok: false,
        errorCode: 'search-failed',
        results: [],
        warnings: [`搜索查询超过 ${SEARCH_QUERY_MAX_LENGTH} 字符上限`],
      };
    }
    if (signal.aborted) {
      return { ok: false, errorCode: 'aborted', results: [], warnings: [] };
    }

    // 调用前状态基线（所有权规则 1：记录但绝不把用户已有 Tab 标记为临时资源）
    let tabsBefore: Set<string>;
    let activeBefore: string | null;
    try {
      tabsBefore = new Set((await this.browser.getTabs()).map((t) => t.id));
      activeBefore = (await this.browser.getActiveTab())?.id ?? null;
    } catch (err) {
      logWarn('search', '读取标签页状态失败，搜索未执行', err);
      return {
        ok: false,
        errorCode: 'search-failed',
        results: [],
        warnings: ['读取标签页状态失败'],
      };
    }

    // 本次调用的临时 Tab 精确所有权：局部变量（零共享状态，并发互不串扰）
    let tempTabId: string | null = null;
    try {
      if (signal.aborted) {
        return { ok: false, errorCode: 'aborted', results: [], warnings: [] };
      }
      const tab = await this.browser.createTab(buildSearchUrl(query, this.searchBaseUrl));
      if (tabsBefore.has(tab.id)) {
        // 敌手/异常实现返回了已存在 tabId → 该 Tab 不是本调用资源，绝不纳入清理
        logWarn('search', `createTab 返回了已存在的 tabId（${tab.id}），放弃本次搜索`);
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['搜索标签页创建异常'],
        };
      }
      tempTabId = tab.id; // 之后所有操作与清理都只针对该精确 id

      const outcome = await this.waitForReady(tempTabId, signal);
      if (outcome === 'aborted') {
        return { ok: false, errorCode: 'aborted', results: [], warnings: [] };
      }
      if (outcome === 'timeout') {
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['等待搜索结果页就绪超时'],
        };
      }
      if (outcome === 'missing') {
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['搜索标签页已被关闭'],
        };
      }
      if (outcome === 'error') {
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['搜索结果页加载失败'],
        };
      }

      if (signal.aborted) {
        return { ok: false, errorCode: 'aborted', results: [], warnings: [] };
      }
      const snapshot = await this.browser.getPageSnapshot(tempTabId); // 实时采集，不复用缓存
      if (snapshot === null) {
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['搜索结果页快照不可用'],
        };
      }
      if (snapshot.meta.degraded === 'main-process-only') {
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['搜索结果页快照采集降级，无法解析搜索结果'],
        };
      }

      const parsed = parseBingSearchResults(snapshot);
      if (parsed.results.length === 0 && !parsed.hasContent) {
        // 结构无法识别：空内容快照不是「搜索无结果」，不得伪装成功空结果
        return {
          ok: false,
          errorCode: 'search-failed',
          results: [],
          warnings: ['页面结构无法识别（无可用内容），搜索失败', ...parsed.warnings],
        };
      }
      if (parsed.results.length === 0) {
        // 合法空结果：页面有内容但没有有机结果（可能确实无匹配或页面结构变化）
        return {
          ok: true,
          results: [],
          warnings: [...parsed.warnings, '未找到搜索结果（可能无匹配结果或页面结构变化）'],
        };
      }
      return { ok: true, results: parsed.results, warnings: parsed.warnings };
    } catch (err) {
      // 未预期异常（如 createTab 因控制器已销毁而 reject）：归一化 search-failed；
      // 查询原文不进日志（外发数据最小化，查询全量审计由审计层负责）
      logWarn('search', '搜索执行异常（query 长度已省略记录）', err);
      return { ok: false, errorCode: 'search-failed', results: [], warnings: ['搜索执行失败'] };
    } finally {
      await this.cleanupTempTab(tempTabId, activeBefore);
    }
  }

  // 轮询 getTabs 等待精确 tabId 就绪（不注册任何事件监听器，无监听器泄漏面）。
  // 状态机：ready → 继续；error → 快速失败；Tab 消失（用户提前关闭）→ 快速失败；
  // abort/超时各自返回；sleep 为 abort 感知（注入时钟下完全确定性）。
  private async waitForReady(tabId: string, signal: AbortSignal): Promise<WaitOutcome> {
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      if (signal.aborted) return 'aborted';
      if (this.now() > deadline) return 'timeout';
      const tabs = await this.browser.getTabs();
      const tab = tabs.find((t) => t.id === tabId); // 精确 id 匹配，绝不按位置推断
      if (tab === undefined) return 'missing';
      if (tab.state === 'ready') return 'ready';
      if (tab.state === 'error') return 'error';
      await this.sleep(this.pollIntervalMs, signal);
    }
  }

  // 最佳努力清理（规则 2–5）：只关闭本调用创建的精确 tabId；任何清理异常不掩盖
  // 搜索结果（日志记录后吞掉）。临时 Tab 已被关闭 → 零关闭动作（不关替代 Tab）。
  private async cleanupTempTab(
    tempTabId: string | null,
    activeBefore: string | null,
  ): Promise<void> {
    if (tempTabId === null) return; // 从未成功创建 → 无可清理
    try {
      const tabs = await this.browser.getTabs();
      const tempExists = tabs.some((t) => t.id === tempTabId);
      if (!tempExists) return; // 已被用户/其他流程关闭：安全无操作
      const activeNow = (await this.browser.getActiveTab())?.id ?? null;
      if (
        activeNow === tempTabId && // 用户仍停留在临时搜索 Tab（未被其他流程抢焦点）
        activeBefore !== null &&
        activeBefore !== tempTabId &&
        tabs.some((t) => t.id === activeBefore) // 调用前活动 Tab 仍存在（否则不重建不激活）
      ) {
        await this.browser.activateTab(activeBefore);
      }
      // 用户已切换到其他 Tab → 不抢回焦点，仅静默关闭临时 Tab
      await this.browser.closeTab(tempTabId); // 未知/已关闭 id → false 安全无操作
    } catch (err) {
      logWarn('search', '搜索临时标签页清理失败（不掩盖搜索结果）', err);
    }
  }
}
