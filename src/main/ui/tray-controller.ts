export interface TrayHandle {
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayControllerPorts {
  createTray(onShow: () => void, onQuit: () => void): TrayHandle;
  saveEnabled(enabled: boolean): void;
  showWindow(): void;
  hideWindow(): void;
  isWindowVisible(): boolean;
  canHide(): boolean;
  requestQuit(): void;
  reportError(message: string): void;
}

const CREATE_ERROR = '无法创建托盘，关闭窗口将退出应用。';
const SAVE_ERROR = '无法保存托盘设置，请稍后重试。';

export class TrayController {
  private tray: TrayHandle | null = null;
  private enabled = false;
  private quitting = false;
  private disposed = false;
  private initialized = false;

  constructor(private readonly ports: TrayControllerPorts) {}

  initialize(enabled: boolean): void {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    if (!enabled) return;
    try {
      this.tray = this.createTray();
      this.enabled = true;
    } catch {
      this.ports.reportError(CREATE_ERROR);
    }
  }

  isEnabled(): boolean {
    if (this.tray?.isDestroyed()) {
      this.tray = null;
      this.enabled = false;
      this.showWindow();
      this.ports.reportError('托盘已不可用，已恢复主窗口。');
    }
    return this.enabled && this.tray !== null && !this.disposed;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.quitting) throw new Error('托盘已关闭，无法更改设置。');
    const current = this.isEnabled();
    if (enabled === current) {
      // Persist an explicit disable even after native tray creation failed on startup.
      if (!enabled) this.save(false);
      return;
    }
    if (enabled) {
      const candidate = this.createTray();
      try {
        this.save(true);
      } catch (error) {
        this.destroyTray(candidate);
        throw error;
      }
      this.tray = candidate;
      this.enabled = true;
      return;
    }
    // Never remove the only reachable UI until window restoration succeeds.
    this.restoreWindow();
    this.save(false);
    const oldTray = this.tray;
    this.tray = null;
    this.enabled = false;
    if (oldTray) this.destroyTray(oldTray);
  }

  handleClose(event: { preventDefault(): void }): boolean {
    if (this.disposed || this.quitting || !this.isEnabled() || !this.ports.canHide()) {
      return false;
    }
    event.preventDefault();
    try {
      this.ports.hideWindow();
    } catch {
      this.showWindow();
      this.ports.reportError('无法隐藏主窗口，请通过托盘菜单退出应用。');
    }
    return true;
  }

  showWindow(): void {
    if (this.disposed) return;
    try {
      this.ports.showWindow();
    } catch {
      this.ports.reportError('无法恢复主窗口，请通过托盘菜单退出应用。');
    }
  }

  beginQuit(): void {
    if (this.disposed) return;
    this.quitting = true;
    if (!this.ports.isWindowVisible()) this.showWindow();
  }

  cancelQuit(): void {
    if (!this.disposed) this.quitting = false;
  }

  requestQuit(): void {
    if (this.disposed || this.quitting) return;
    this.beginQuit();
    this.ports.requestQuit();
  }

  dispose(): void {
    if (this.disposed) return;
    if (!this.ports.isWindowVisible()) this.showWindow();
    this.disposed = true;
    this.enabled = false;
    const oldTray = this.tray;
    this.tray = null;
    if (oldTray) this.destroyTray(oldTray);
  }

  private restoreWindow(): void {
    if (this.ports.isWindowVisible()) return;
    try {
      this.ports.showWindow();
      if (!this.ports.isWindowVisible()) throw new Error();
    } catch {
      throw new Error('无法恢复主窗口，托盘设置未改变。');
    }
  }

  private createTray(): TrayHandle {
    try {
      const tray = this.ports.createTray(
        () => this.showWindow(),
        () => this.requestQuit(),
      );
      if (tray.isDestroyed()) throw new Error();
      return tray;
    } catch {
      throw new Error(CREATE_ERROR);
    }
  }

  private save(enabled: boolean): void {
    try {
      this.ports.saveEnabled(enabled);
    } catch {
      throw new Error(SAVE_ERROR);
    }
  }

  private destroyTray(tray: TrayHandle): void {
    try {
      if (!tray.isDestroyed()) tray.destroy();
    } catch {
      this.ports.reportError('托盘清理失败，主窗口仍可正常退出。');
    }
  }
}
