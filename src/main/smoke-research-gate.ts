// C9（决议 #169 + 恢复校准，2026-08-18）：LIVE_RESEARCH 门控纯逻辑（零 Electron
// 依赖）。纪律（七、门控修正）：
// - 请求标志独立读取——「设置了 AIBROWSE_LIVE_RESEARCH 但未设置 SMOKE」不得
//   被静默忽略，必须明确失败；
// - 从属校验：必须从属于 AIBROWSE_SMOKE=1 + AIBROWSE_LIVE_PROVIDER=1；
// - 与全部既有 LIVE/SESSION/SOURCES/SOURCES_UI/RESEARCH 门控确定性互斥
//   （冲突明确失败，不静默选路）；
// - 非法环境值明确失败；
// - 失败路径的临时目录/DB/进程零残留由 index.ts 装配侧保证（本模块纯判定）。

export interface ResearchGateEnv {
  smoke?: string; // AIBROWSE_SMOKE
  liveProvider?: string; // AIBROWSE_LIVE_PROVIDER
  liveResearch?: string; // AIBROWSE_LIVE_RESEARCH
  liveSites?: string; // AIBROWSE_LIVE_SITES
  liveAgent?: string; // AIBROWSE_LIVE_AGENT
  liveAgentPre?: string; // AIBROWSE_LIVE_AGENT_PRE
  liveAgentSupplement?: string; // AIBROWSE_LIVE_AGENT_SUPPLEMENT
  liveAgentSources?: string; // AIBROWSE_LIVE_AGENT_SOURCES
  sessionSmoke?: string; // AIBROWSE_SESSION_SMOKE
  sourcesSmoke?: string; // AIBROWSE_SOURCES_SMOKE
  sourcesUiSmoke?: string; // AIBROWSE_SOURCES_UI_SMOKE
  researchSmoke?: string; // AIBROWSE_RESEARCH_SMOKE
}

export type ResearchGateVerdict =
  | { ok: true; mode: 'live-research' } // 合法单一组合 → 仅走 LIVE_RESEARCH
  | { ok: true; mode: 'none' } // 未请求 LIVE_RESEARCH → 不进入
  | { ok: false; reason: string }; // 明确失败（缺从属/冲突/非法值）

const SET_CHECK_GATE = (value: string | undefined): boolean => value === 'set' || value === 'check';

/** LIVE_RESEARCH 门控判定（纯函数）：请求标志独立读取 + 从属 + 确定性互斥 */
export function resolveResearchGate(env: ResearchGateEnv): ResearchGateVerdict {
  const liveResearch = env.liveResearch;
  if (liveResearch === undefined || liveResearch === '') return { ok: true, mode: 'none' };
  if (liveResearch !== '1') {
    return {
      ok: false,
      reason: `AIBROWSE_LIVE_RESEARCH 值非法：${liveResearch}（仅支持 1）`,
    };
  }
  if (env.smoke !== '1') {
    return {
      ok: false,
      reason: 'AIBROWSE_LIVE_RESEARCH 必须从属于 AIBROWSE_SMOKE=1（缺 SMOKE 明确失败，不静默忽略）',
    };
  }
  if (env.liveProvider !== '1') {
    return {
      ok: false,
      reason:
        'AIBROWSE_LIVE_RESEARCH 必须从属于 AIBROWSE_LIVE_PROVIDER=1（缺 LIVE_PROVIDER 明确失败）',
    };
  }
  const conflicts: string[] = [];
  if (env.liveSites === '1') conflicts.push('AIBROWSE_LIVE_SITES');
  if (env.liveAgent === '1') conflicts.push('AIBROWSE_LIVE_AGENT');
  if (env.liveAgentPre === '1') conflicts.push('AIBROWSE_LIVE_AGENT_PRE');
  if (env.liveAgentSupplement === '1') conflicts.push('AIBROWSE_LIVE_AGENT_SUPPLEMENT');
  if (env.liveAgentSources === '1') conflicts.push('AIBROWSE_LIVE_AGENT_SOURCES');
  if (SET_CHECK_GATE(env.sessionSmoke)) conflicts.push('AIBROWSE_SESSION_SMOKE');
  if (SET_CHECK_GATE(env.sourcesSmoke)) conflicts.push('AIBROWSE_SOURCES_SMOKE');
  if (SET_CHECK_GATE(env.sourcesUiSmoke)) conflicts.push('AIBROWSE_SOURCES_UI_SMOKE');
  if (SET_CHECK_GATE(env.researchSmoke)) conflicts.push('AIBROWSE_RESEARCH_SMOKE');
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `AIBROWSE_LIVE_RESEARCH 与 ${conflicts.join('、')} 互斥，请只选其一`,
    };
  }
  return { ok: true, mode: 'live-research' };
}
