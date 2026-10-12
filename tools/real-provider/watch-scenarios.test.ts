import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '../../src/main/ai/provider/fake-provider';
import { runIndependentWatchScenarios, WATCH_REPAIR_EVENT_ID } from './watch-scenarios';
import { campaignPolicy, validCampaignPolicyBinding } from './campaign-policy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('独立监控真实Provider验收的离线oracle', () => {
  it.each([true, false])('只投递显式授权计划，并拒绝错误Event引用：%s', async (valid) => {
    const root = mkdtempSync(join(tmpdir(), 'watch-repair-provider-'));
    roots.push(root);
    const provider = new FakeProvider({
      chunks: [
        JSON.stringify({
          sections: [
            {
              eventIds: [valid ? WATCH_REPAIR_EVENT_ID : 'unrelated-event'],
              explanation: '合成产品价格由42元变为49元。',
            },
          ],
        }),
      ],
    });
    const result = await runIndependentWatchScenarios(root, provider, 'fake');
    expect(result.passed).toBe(valid);
    expect(result).toMatchObject({
      providerCalls: 1,
      sourceSharingReads: 0,
      selectedProjectionOnly: true,
      disabledPlansSkippedProvider: true,
      sourcesUnchanged: true,
      targetSharingUnchanged: true,
      eventsUnchanged: true,
      integrityValid: true,
    });
    expect(provider.getRequests()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('由42元');
  });
  it('新阶段预算2/3分钟，旧阶段预算不变且拒绝阶段绑定错配', () => {
    const watch = campaignPolicy('watch-repair');
    expect(watch).toEqual({ phase: 'watch-repair', requestBudget: 2, lifetimeMs: 180000 });
    const legacy = campaignPolicy('probe');
    expect(legacy).toEqual({ phase: 'legacy', requestBudget: 28, lifetimeMs: 900000 });
    expect(validCampaignPolicyBinding(watch, 'watch-repair')).toBe(true);
    expect(validCampaignPolicyBinding(legacy, 'probe')).toBe(true);
    expect(validCampaignPolicyBinding(watch, 'probe')).toBe(false);
    expect(validCampaignPolicyBinding(legacy, 'watch-repair')).toBe(false);
    expect(validCampaignPolicyBinding({ ...watch, lifetimeMs: 900000 }, 'watch-repair')).toBe(
      false,
    );
    expect(validCampaignPolicyBinding({ requestBudget: 28, lifetimeMs: 900000 }, 'probe')).toBe(
      true,
    );
    expect(() => campaignPolicy('unknown')).toThrow();
  });
});
