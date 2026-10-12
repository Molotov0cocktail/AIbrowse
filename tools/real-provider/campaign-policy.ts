export function campaignPolicy(phase: string) {
  if (phase === 'watch-repair')
    return { phase: 'watch-repair', requestBudget: 2, lifetimeMs: 180_000 } as const;
  if (['legacy', 'all', 'probe', 'research', 'conversation'].includes(phase))
    return { phase: 'legacy', requestBudget: 28, lifetimeMs: 900_000 } as const;
  throw new Error('未知验收阶段');
}

export function validCampaignPolicyBinding(binding: unknown, phase: string): boolean {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const record = binding as Record<string, unknown>;
  const expected = campaignPolicy(phase);
  return (
    (record['phase'] === expected.phase ||
      (expected.phase === 'legacy' && record['phase'] === undefined)) &&
    record['requestBudget'] === expected.requestBudget &&
    record['lifetimeMs'] === expected.lifetimeMs
  );
}
