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
    expect(resolveWatchGate({ smoke: '1', liveWatch: '1', liveProvider: '1' })).toEqual({
      ok: true,
      mode: 'live',
    });
    expect(resolveWatchD10Mode({ smoke: '1', watchSmoke: 'set' })).toEqual({
      ok: true,
      mode: 'set',
    });
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
