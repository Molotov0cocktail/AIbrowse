import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveWatchD10Mode,
  resolveWatchGate,
  validateWatchD10Contract,
} from './smoke-watch-gate';

describe('D10 Watch gate', () => {
  it('默认不启用且 set/check 必须挂在唯一 smoke 门控下', () => {
    expect(resolveWatchGate({})).toEqual({ ok: true, mode: 'none' });
    expect(resolveWatchGate({ watchSmoke: 'set' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', watchSmoke: 'set' })).toEqual({ ok: true, mode: 'set' });
    expect(resolveWatchGate({ smoke: '1', watchSmoke: 'check' })).toEqual({
      ok: true,
      mode: 'check',
    });
    expect(validateWatchD10Contract()).toEqual([]);
  });

  it('拒绝非法值、并行门控，并让 live runner 进入独立门控', () => {
    expect(resolveWatchGate({ smoke: '1', watchSmoke: 'other' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', watchSmoke: 'set', researchSmoke: 'set' }).ok).toBe(
      false,
    );
    expect(resolveWatchGate({ liveWatch: '1' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', liveWatch: '1' })).toEqual({ ok: true, mode: 'live' });
    expect(resolveWatchGate({ smoke: '1', liveWatch: '1', liveProvider: '1' }).ok).toBe(false);
    expect(resolveWatchD10Mode({ smoke: '1', watchSmoke: 'set' })).toEqual({
      ok: true,
      mode: 'set',
    });
  });

  it('H3a 必须在 Provider、IPC 与 BrowserWindow 装配前独占运行并退出', () => {
    expect(resolveWatchGate({ smoke: '1', h3a: '1' })).toEqual({ ok: true, mode: 'h3a' });
    for (const conflict of [
      { liveProvider: '1' },
      { liveWatch: '1' },
      { liveSites: '1' },
      { liveAgent: '1' },
      { liveAgentPre: '1' },
      { liveAgentSupplement: '1' },
      { liveAgentSources: '1' },
      { liveResearch: '1' },
      { sessionSmoke: 'set' },
      { sourcesSmoke: 'check' },
      { sourcesUiSmoke: 'set' },
      { researchSmoke: 'check' },
      { watchSmoke: 'set' },
    ]) {
      expect(resolveWatchGate({ smoke: '1', h3a: '1', ...conflict }).ok).toBe(false);
    }
    const source = readFileSync('src/main/index.ts', 'utf8');
    const h3aBranch = source.indexOf('if (H3A_MODE)');
    const ipcRegistration = source.indexOf('registerIpcHandlers();', h3aBranch);
    const browserCreation = source.indexOf('await createBrowserWindow();', h3aBranch);
    const providerSetup = source.indexOf('const liveKey = LIVE_PROVIDER_SETUP_MODE');
    expect(h3aBranch).toBeGreaterThanOrEqual(0);
    expect(ipcRegistration).toBeGreaterThan(h3aBranch);
    expect(browserCreation).toBeGreaterThan(ipcRegistration);
    expect(providerSetup).toBeGreaterThan(browserCreation);
    const branch = source.slice(h3aBranch, ipcRegistration);
    expect(branch).toContain('runH3aCampaign');
    expect(branch).toContain('app.exit(0)');
    expect(branch).toContain('app.exit(1)');
    expect(branch).toContain('return;');
    expect(branch).not.toContain('createBrowserWindow');
    expect(branch).not.toContain('AIBROWSE_TEST_API_KEY');
  });

  it('NASA 单次诊断只接受精确 literal，并继承 H3a 独占门控', () => {
    expect(
      resolveWatchGate({
        smoke: '1',
        h3a: '1',
        h3aDiagnostic: 'nasa-feed-budget-first-v1',
      }),
    ).toEqual({
      ok: true,
      mode: 'h3a',
      h3aDiagnostic: 'nasa-feed-budget-first-v1',
    });
    for (const value of ['', '0', 'nasa', 'rss-fallback']) {
      const result = resolveWatchGate({ smoke: '1', h3a: '1', h3aDiagnostic: value });
      expect(result).toEqual({ ok: false, reason: 'AIBROWSE_WATCH_H3A_DIAGNOSTIC 值非法' });
    }
    expect(resolveWatchGate({ h3aDiagnostic: 'nasa-feed-budget-first-v1' })).toEqual({
      ok: false,
      reason: 'AIBROWSE_WATCH_H3A_DIAGNOSTIC 必须从属于 AIBROWSE_SMOKE=1 与 AIBROWSE_WATCH_H3A=1',
    });
    expect(
      resolveWatchGate({
        smoke: '1',
        h3a: '1',
        h3aDiagnostic: 'nasa-feed-budget-first-v1',
        liveProvider: '1',
      }).ok,
    ).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1' })).toEqual({ ok: true, mode: 'h3a' });

    const source = readFileSync('src/main/index.ts', 'utf8');
    const gate = source.indexOf("h3aDiagnostic: process.env['AIBROWSE_WATCH_H3A_DIAGNOSTIC']");
    const branch = source.indexOf("if (diagnostic === 'nasa-feed-budget-first-v1')");
    const fullCampaign = source.indexOf('const result = await runH3aCampaign', branch);
    const providerSetup = source.indexOf('const liveKey = LIVE_PROVIDER_SETUP_MODE');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThan(gate);
    expect(source.slice(branch, fullCampaign)).toContain('runH3aFeedBudgetDiagnostic');
    expect(source.slice(branch, fullCampaign)).toContain('NASA 单次诊断已记录，未判定 H3a 资格');
    expect(source.slice(branch, fullCampaign)).not.toContain('H3a 三项真实产品门通过');
    expect(source.slice(gate, fullCampaign)).toContain('requireExistingWorkflow: true');
    expect(fullCampaign).toBeLessThan(providerSetup);
  });

  it('Research set 直接退出前必须完成 Watch 与 Sources 排水和 Watch 目录清理', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const branchStart = source.indexOf("if (RESEARCH_GATE_MODE && researchMode === 'set')");
    const branchEnd = source.indexOf('app.exit(0);', branchStart);
    expect(branchStart).toBeGreaterThanOrEqual(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('await watchShutdown()');
    expect(branch).toContain('await sourceIpcAdmission.drain()');
    expect(branch).toContain('smokeWatchDir');
  });
});
