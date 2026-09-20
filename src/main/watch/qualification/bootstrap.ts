import { initializeQualificationContext } from './context';

export async function bootstrapQualification(): Promise<void> {
  const runtime = await initializeQualificationContext();
  process.on('uncaughtExceptionMonitor', () =>
    runtime.registry.increment('uncaughtExceptionTotal'),
  );
  process.on('unhandledRejection', () => runtime.registry.increment('unhandledRejectionTotal'));
}
