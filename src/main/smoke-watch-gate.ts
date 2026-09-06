// Sixth Stage D10: Watch 门控解析与 Stage 映射聚合（纯逻辑、零 Electron）。
// AIBROWSE_WATCH_SMOKE 仍是唯一跨进程 Watch set/check 入口；D10 不另造重叠门控。

import {
  validateWatchSixthMapping,
  validateWatchWrtManifest,
  WATCH_SIXTH_SECTION_MAPPING,
  WATCH_WRT_MANIFEST,
} from './smoke-watch-manifest';

export interface WatchGateEnv {
  smoke?: string;
  watchSmoke?: string;
  sessionSmoke?: string;
  sourcesSmoke?: string;
  sourcesUiSmoke?: string;
  researchSmoke?: string;
  liveProvider?: string;
  liveWatch?: string;
  liveSites?: string;
  liveAgent?: string;
  liveAgentPre?: string;
  liveAgentSupplement?: string;
  liveAgentSources?: string;
  liveResearch?: string;
  h3a?: string;
}

export type WatchGateVerdict =
  { ok: true; mode: 'none' | 'set' | 'check' | 'live' | 'h3a' } | { ok: false; reason: string };

function isSetCheck(value: string | undefined): boolean {
  return value === 'set' || value === 'check';
}

export function resolveWatchGate(env: WatchGateEnv): WatchGateVerdict {
  const requested = env.watchSmoke;
  if (env.h3a !== undefined && env.h3a !== '1') {
    return { ok: false, reason: `AIBROWSE_WATCH_H3A 值非法：${env.h3a}（仅支持 1）` };
  }
  if (env.h3a === '1') {
    if (env.smoke !== '1') {
      return { ok: false, reason: 'AIBROWSE_WATCH_H3A 必须从属于 AIBROWSE_SMOKE=1' };
    }
    const conflicts: string[] = [];
    if (env.liveWatch !== undefined) conflicts.push('AIBROWSE_LIVE_WATCH');
    if (env.liveProvider !== undefined) conflicts.push('AIBROWSE_LIVE_PROVIDER');
    if (env.liveSites !== undefined) conflicts.push('AIBROWSE_LIVE_SITES');
    if (env.liveAgent !== undefined) conflicts.push('AIBROWSE_LIVE_AGENT');
    if (env.liveAgentPre !== undefined) conflicts.push('AIBROWSE_LIVE_AGENT_PRE');
    if (env.liveAgentSupplement !== undefined) conflicts.push('AIBROWSE_LIVE_AGENT_SUPPLEMENT');
    if (env.liveAgentSources !== undefined) conflicts.push('AIBROWSE_LIVE_AGENT_SOURCES');
    if (env.liveResearch !== undefined) conflicts.push('AIBROWSE_LIVE_RESEARCH');
    if (requested !== undefined && requested !== '') conflicts.push('AIBROWSE_WATCH_SMOKE');
    if (env.sessionSmoke !== undefined && env.sessionSmoke !== '')
      conflicts.push('AIBROWSE_SESSION_SMOKE');
    if (env.sourcesSmoke !== undefined && env.sourcesSmoke !== '')
      conflicts.push('AIBROWSE_SOURCES_SMOKE');
    if (env.sourcesUiSmoke !== undefined && env.sourcesUiSmoke !== '')
      conflicts.push('AIBROWSE_SOURCES_UI_SMOKE');
    if (env.researchSmoke !== undefined && env.researchSmoke !== '')
      conflicts.push('AIBROWSE_RESEARCH_SMOKE');
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `AIBROWSE_WATCH_H3A 与 ${conflicts.join('、')} 互斥，请只选其一`,
      };
    }
    return { ok: true, mode: 'h3a' };
  }
  if (env.liveWatch !== undefined && env.liveWatch !== '1') {
    return { ok: false, reason: `AIBROWSE_LIVE_WATCH 值非法：${env.liveWatch}（仅支持 1）` };
  }
  if (env.liveWatch === '1') {
    if (env.smoke !== '1') {
      return { ok: false, reason: 'AIBROWSE_LIVE_WATCH 必须从属于 AIBROWSE_SMOKE=1' };
    }
    if (env.liveProvider === '1') {
      return {
        ok: false,
        reason: 'AIBROWSE_LIVE_WATCH 与 AIBROWSE_LIVE_PROVIDER 互斥，请只选其一',
      };
    }
    if (isSetCheck(requested)) {
      return {
        ok: false,
        reason: 'AIBROWSE_LIVE_WATCH 与 AIBROWSE_WATCH_SMOKE=set|check 互斥，请只选其一',
      };
    }
    const conflicts: string[] = [];
    if (isSetCheck(env.sessionSmoke)) conflicts.push('AIBROWSE_SESSION_SMOKE');
    if (isSetCheck(env.sourcesSmoke)) conflicts.push('AIBROWSE_SOURCES_SMOKE');
    if (isSetCheck(env.sourcesUiSmoke)) conflicts.push('AIBROWSE_SOURCES_UI_SMOKE');
    if (isSetCheck(env.researchSmoke)) conflicts.push('AIBROWSE_RESEARCH_SMOKE');
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `AIBROWSE_LIVE_WATCH 与 ${conflicts.join('、')} 互斥，请只选其一`,
      };
    }
    return { ok: true, mode: 'live' };
  }
  if (requested === undefined || requested === '') {
    return { ok: true, mode: 'none' };
  }
  if (!isSetCheck(requested)) {
    return { ok: false, reason: `AIBROWSE_WATCH_SMOKE 值非法：${requested}（仅支持 set|check）` };
  }
  if (env.smoke !== '1') {
    return { ok: false, reason: 'AIBROWSE_WATCH_SMOKE 必须从属于 AIBROWSE_SMOKE=1' };
  }
  const conflicts: string[] = [];
  if (isSetCheck(env.sessionSmoke)) conflicts.push('AIBROWSE_SESSION_SMOKE');
  if (isSetCheck(env.sourcesSmoke)) conflicts.push('AIBROWSE_SOURCES_SMOKE');
  if (isSetCheck(env.sourcesUiSmoke)) conflicts.push('AIBROWSE_SOURCES_UI_SMOKE');
  if (isSetCheck(env.researchSmoke)) conflicts.push('AIBROWSE_RESEARCH_SMOKE');
  if (env.liveProvider === '1') conflicts.push('AIBROWSE_LIVE_PROVIDER');
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `AIBROWSE_WATCH_SMOKE 与 ${conflicts.join('、')} 互斥，请只选其一`,
    };
  }
  return { ok: true, mode: requested as 'set' | 'check' };
}

export function validateWatchD10Contract(): string[] {
  return [
    ...validateWatchWrtManifest(WATCH_WRT_MANIFEST),
    ...validateWatchSixthMapping(WATCH_SIXTH_SECTION_MAPPING),
  ];
}

export function resolveWatchD10Mode(env: WatchGateEnv): WatchGateVerdict {
  const gate = resolveWatchGate(env);
  if (!gate.ok) return gate;
  if (gate.mode === 'none') return gate;
  const contractErrors = validateWatchD10Contract();
  return contractErrors.length === 0
    ? gate
    : { ok: false, reason: `D10 Contract 不完整：${contractErrors.join('；')}` };
}
