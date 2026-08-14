// agent-safety 防循环纯函数（A5，零 Electron 依赖）。契约源：doc/stage3/detailed-design.md
// §8.2/§8.3 + threat-model §3.5 + 决议 #33（2026-08-14 实施校准）：
// - 签名 = 工具名 + 确定性规范化参数：JSON.parse 成功且为对象 → 递归键排序 + Unicode NFC
//   后确定性序列化；解析失败/非对象 → NFC 原始串（无法取得合法参数的调用同样有稳定签名，
//   不依赖 JSON 键序）；
// - 仅对「执行了或试图执行」的工具调用计签（校验失败/被拒/失败/执行/安全阻断均计）；
// - 判定在每次执行管线前（wouldTriggerLoop 先于 record）：该调用会使连续 ≥3 或累计 ≥5 →
//   在执行前阻断（触发次零副作用）；无白名单例外（决议 #24）；无进展连续 2 轮触发；
// - 全部阈值可注入（测试不依赖真实墙钟）。

// 阈值常量（契约值：连续 3 / 累计 5 / 无进展 2）
export const AGENT_LOOP_SAME_SIGNATURE_CONSECUTIVE = 3;
export const AGENT_LOOP_SAME_SIGNATURE_TOTAL = 5;
export const AGENT_LOOP_NO_PROGRESS_STEPS = 2;

export interface AgentSafetyLimits {
  consecutive: number;
  total: number;
  noProgressSteps: number;
}

export const AGENT_SAFETY_LIMITS: AgentSafetyLimits = {
  consecutive: AGENT_LOOP_SAME_SIGNATURE_CONSECUTIVE,
  total: AGENT_LOOP_SAME_SIGNATURE_TOTAL,
  noProgressSteps: AGENT_LOOP_NO_PROGRESS_STEPS,
};

// 递归键排序（对象）；数组保持顺序；字符串值 NFC 归一（确定性序列化）
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'string') return value.normalize('NFC');
  return value;
}

// 参数规范化（确定性）：合法 JSON 对象 → 键排序 + NFC；否则 → NFC 原始串（不抛异常）
export function normalizeSignatureArguments(raw: string): string {
  const nfc = raw.normalize('NFC');
  let parsed: unknown;
  try {
    parsed = JSON.parse(nfc);
  } catch {
    return nfc;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return nfc;
  }
  return JSON.stringify(sortKeys(parsed));
}

// 签名 = 工具名 + 规范化参数（键排序/NFC 确定性——改变 JSON 键顺序不能逃避检测）
export function buildToolSignature(toolName: string, rawArguments: string): string {
  return `${toolName}|${normalizeSignatureArguments(rawArguments)}`;
}

// 防循环状态机：wouldTriggerLoop 必须在执行管线前判定（触发次在执行前被阻断并仍计签）；
// recordNoProgressRound 由循环层在空轮（无文本无工具）时调用。
export class AgentSafety {
  private readonly limits: AgentSafetyLimits;
  private readonly counters = new Map<string, number>();
  private lastSignature: string | null = null;
  private consecutiveCount = 0;
  private noProgress = 0;

  constructor(limits?: Partial<AgentSafetyLimits>) {
    this.limits = { ...AGENT_SAFETY_LIMITS, ...limits };
  }

  // 该调用是否会在执行前触发循环阻断（连续第 N 次/累计第 N 次，含本次）
  wouldTriggerLoop(signature: string): boolean {
    const consecutive =
      this.lastSignature === signature && this.consecutiveCount + 1 >= this.limits.consecutive;
    const total = (this.counters.get(signature) ?? 0) + 1 >= this.limits.total;
    return consecutive || total;
  }

  // 计签（执行了或试图执行的调用——含被拒/失败/安全阻断；阻断的调用同样计）
  record(signature: string): void {
    this.counters.set(signature, (this.counters.get(signature) ?? 0) + 1);
    if (this.lastSignature === signature) {
      this.consecutiveCount += 1;
    } else {
      this.lastSignature = signature;
      this.consecutiveCount = 1;
    }
  }

  recordNoProgressRound(): void {
    this.noProgress += 1;
  }

  get noProgressRounds(): number {
    return this.noProgress;
  }

  isNoProgressTriggered(): boolean {
    return this.noProgress >= this.limits.noProgressSteps;
  }
}
