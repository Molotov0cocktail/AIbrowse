import { afterEach, expect, it, vi } from 'vitest';
import { createStartupDataPreparation } from '../../src/main/storage/startup-data-preparation';
import { superviseStartupProbe } from '../../src/main/storage/startup-probe-supervisor';
import { assertStartupProbeInputs } from '../../src/main/storage/startup-probe';
import { TransferBudget } from '../../src/main/storage/transfer-budget';

vi.mock('../../src/main/storage/startup-probe-supervisor', () => ({
  superviseStartupProbe: vi.fn(),
}));
vi.mock('../../src/main/storage/startup-probe', () => ({ assertStartupProbeInputs: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each([false, true])(
  'normal最终main证明同步关闭准入=%s，关闭后不得返回normal',
  async (cancel) => {
    let afterInputs = false,
      cancelled = false;
    vi.mocked(assertStartupProbeInputs).mockImplementation(async () => {
      afterInputs = true;
    });
    vi.mocked(superviseStartupProbe).mockReturnValue({
      done: Promise.resolve({
        state: 'succeeded',
        exitCode: 0,
        result: { state: 'normal', root: { dev: '1', ino: '2' }, members: [] },
      }),
      cancel() {},
      ownsChild: () => false,
    });
    const subject = createStartupDataPreparation({
      userDataRoot: process.cwd(),
      productVersion: '0.1.0',
      guardian: { authorizeUtility: async () => {}, confirmUtilityExit: async () => {} },
      assertNoStores() {
        if (cancel && afterInputs && !cancelled) {
          cancelled = true;
          subject.beginShutdown();
        }
      },
      requireSpace: async () => {},
      requestRelaunch: async () => false,
      createProbeAdapter: () => ({ spawn: vi.fn(), ownsProcess: () => false }),
    });
    const result = await subject.prepare({
      budget: new TransferBudget(),
      absoluteDeadline: performance.now() + 1000,
    });
    expect(cancelled).toBe(cancel);
    expect(result.state).toBe(cancel ? 'recovery-required' : 'normal');
    await subject.drainBeforeClose();
  },
);
