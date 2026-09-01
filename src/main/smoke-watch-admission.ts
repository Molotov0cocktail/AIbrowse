// D10 repair: a small, Electron-free admission gate shared by Watch IPC and
// subscription publishing. Shutdown closes the gate synchronously so a late
// renderer event cannot reach a repository that is being disposed.

export class WatchIpcAdmission {
  private open = true;
  private sender: object | null = null;

  beginShutdown(): void {
    this.open = false;
    this.sender = null;
  }

  isOpen(): boolean {
    return this.open;
  }

  subscribe(sender: object): boolean {
    if (!this.open) return false;
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
