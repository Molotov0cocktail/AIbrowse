// D10 repair: a small, Electron-free admission gate shared by Watch IPC and
// subscription publishing. Shutdown closes the gate synchronously so a late
// renderer event cannot reach a repository that is being disposed.
import { MaintenanceAdmission } from '../storage/maintenance-admission';

export interface ShutdownAdmission {
  beginShutdown(): void;
  drain(): Promise<void>;
}

export interface WatchSubscriptionDestroyedEmitter {
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
}

/** Attach one named lifecycle listener and return an idempotent detach handle. */
export function addWatchSubscriptionDestroyedListener(
  sender: WatchSubscriptionDestroyedEmitter,
  listener: () => void,
): () => void {
  sender.once('destroyed', listener);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    try {
      sender.removeListener('destroyed', listener);
    } catch {
      // Sender destruction is already terminal; cleanup remains fail-closed.
    }
  };
}

/**
 * Close every renderer-facing gate before awaiting any drain. Resource owners
 * must be released by dispose only after this promise settles.
 */
export async function closeAndDrainThenDispose(
  admissions: readonly ShutdownAdmission[],
  dispose: () => void | Promise<void>,
): Promise<void> {
  for (const admission of admissions) admission.beginShutdown();
  await Promise.all(admissions.map((admission) => admission.drain()));
  await dispose();
}

export class WatchIpcAdmission extends MaintenanceAdmission {
  private sender: object | null = null;

  override beginShutdown(): void {
    super.beginShutdown();
    this.sender = null;
  }

  override pauseForMaintenance(generation: number): boolean {
    const paused = super.pauseForMaintenance(generation);
    if (paused) this.sender = null;
    return paused;
  }

  subscribe(sender: object): boolean {
    if (!this.isOpen()) return false;
    if (this.sender !== null && this.sender !== sender) return false;
    this.sender = sender;
    return true;
  }

  unsubscribe(sender: object): void {
    if (this.sender === sender) this.sender = null;
  }

  currentSender(): object | null {
    return this.sender;
  }
}
