import type { BaseWindow, Rectangle } from 'electron';
import { registerFullscreenPolicy } from '../security/session-security';
import type { TabEntry } from './tab-manager';

interface Registration {
  entry: TabEntry;
  gestureUntil: number;
  grantedUntil: number;
}

/** Owns HTML fullscreen separately from application/window fullscreen. */
export class HtmlFullscreen {
  private readonly registrations = new Map<string, Registration>();
  private active: Registration | null = null;
  private readonly contentView: BaseWindow['contentView'];
  private restoreWindowFullscreen = false;
  private disposed = false;
  private readonly clearPending = (): void => {
    for (const registration of this.registrations.values()) {
      registration.gestureUntil = 0;
      registration.grantedUntil = 0;
    }
  };
  private readonly onHide = (): void => {
    this.clearPending();
    if (this.active === null) return;
    this.exit();
    // Windows restores visibility when leaving fullscreen; preserve the user's hide.
    if (!this.owner.isDestroyed() && this.owner.isVisible()) this.owner.hide();
  };
  private readonly onMinimize = (): void => {
    this.clearPending();
    if (this.active === null) return;
    this.exit();
    if (!this.owner.isDestroyed() && !this.owner.isMinimized()) this.owner.minimize();
  };
  private readonly onResize = (): void => {
    this.applyBounds();
  };
  private readonly onWindowLeave = (): void => {
    this.exit();
  };

  constructor(
    private readonly owner: BaseWindow,
    private readonly isInteractive: (entry: TabEntry) => boolean,
    private readonly restoreLayout: () => void,
  ) {
    this.contentView = owner.contentView;
    // Native fullscreen/resize events can precede Windows client-area layout.
    this.contentView.on('bounds-changed', this.onResize);
    owner.on('resize', this.onResize);
    owner.on('blur', this.clearPending);
    owner.on('hide', this.onHide);
    owner.on('minimize', this.onMinimize);
    owner.on('leave-full-screen', this.onWindowLeave);
  }

  register(entry: TabEntry): () => void {
    const wc = entry.webContents;
    const registration: Registration = { entry, gestureUntil: 0, grantedUntil: 0 };
    this.registrations.set(entry.info.id, registration);
    const grantGesture = (): void => {
      if (this.eligible(entry)) registration.gestureUntil = performance.now() + 1000;
    };
    const revoke = (): void => this.revoke(entry.info.id);
    const onDestroyed = (): void => {
      registration.gestureUntil = 0;
      registration.grantedUntil = 0;
      if (this.active !== registration) return;
      this.active = null;
      const restoreFullscreen = this.restoreWindowFullscreen;
      // Never reenter native window/layout APIs from a WebContents destruction stack.
      queueMicrotask(() => {
        if (this.disposed || this.active !== null || this.owner.isDestroyed()) return;
        this.owner.setFullScreen(restoreFullscreen);
        this.restoreLayout();
      });
    };
    const onMouse = (_event: Electron.Event, input: Electron.MouseInputEvent): void => {
      if ((input.type === 'mouseDown' || input.type === 'mouseUp') && input.button === 'left')
        grantGesture();
    };
    const onKey = (_event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') {
        revoke();
        return;
      }
      if (
        !input.isAutoRepeat &&
        !input.isComposing &&
        !input.control &&
        !input.alt &&
        !input.meta &&
        ['Enter', ' ', 'f', 'F'].includes(input.key)
      )
        grantGesture();
    };
    const unregister = registerFullscreenPolicy(wc, (phase) => {
      if (!this.eligible(entry) || registration.gestureUntil <= performance.now()) return false;
      if (phase === 'request') {
        registration.gestureUntil = 0;
        registration.grantedUntil = performance.now() + 1000;
      }
      return true;
    });
    const onEnter = (): void => {
      const allowed = this.eligible(entry) && registration.grantedUntil > performance.now();
      registration.gestureUntil = 0;
      registration.grantedUntil = 0;
      if (!allowed) {
        this.exitDocument(entry);
        return;
      }
      if (this.active && this.active !== registration) this.exit();
      if (this.active === null) this.restoreWindowFullscreen = this.owner.isFullScreen();
      this.active = registration;
      this.owner.setFullScreen(true);
      this.applyBounds();
    };
    const onLeave = (): void => {
      if (this.active === registration) this.exit(false);
    };
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (details.isMainFrame && !details.isSameDocument) revoke();
    };
    wc.on('before-mouse-event', onMouse);
    wc.on('before-input-event', onKey);
    wc.on('enter-html-full-screen', onEnter);
    wc.on('leave-html-full-screen', onLeave);
    wc.on('did-start-navigation', onNavigation);
    wc.on('render-process-gone', revoke);
    wc.on('destroyed', onDestroyed);
    return () => {
      revoke();
      unregister();
      this.registrations.delete(entry.info.id);
      wc.removeListener('before-mouse-event', onMouse);
      wc.removeListener('before-input-event', onKey);
      wc.removeListener('enter-html-full-screen', onEnter);
      wc.removeListener('leave-html-full-screen', onLeave);
      wc.removeListener('did-start-navigation', onNavigation);
      wc.removeListener('render-process-gone', revoke);
      wc.removeListener('destroyed', onDestroyed);
    };
  }

  private eligible(entry: TabEntry): boolean {
    return (
      !this.owner.isDestroyed() &&
      this.owner.isVisible() &&
      this.owner.isFocused() &&
      !entry.webContents.isDestroyed() &&
      !entry.taskOwned &&
      entry.info.state !== 'error' &&
      entry.committedUrl !== null &&
      /^https?:\/\//i.test(entry.committedUrl) &&
      entry.committedNavigationSerial === entry.navigationSerial &&
      entry.popupSuppressionCount === 0 &&
      this.isInteractive(entry)
    );
  }

  revoke(tabId: string): void {
    const registration = this.registrations.get(tabId);
    if (!registration) return;
    registration.gestureUntil = 0;
    registration.grantedUntil = 0;
    if (this.active === registration) this.exit();
  }

  reconcile(): void {
    for (const registration of this.registrations.values()) {
      if (!this.isInteractive(registration.entry)) this.revoke(registration.entry.info.id);
    }
  }

  bounds(tabId: string): Rectangle | null {
    if (this.active?.entry.info.id !== tabId || this.owner.isDestroyed()) return null;
    const { width, height } = this.owner.getContentBounds();
    return { x: 0, y: 0, width, height };
  }

  private applyBounds(): void {
    if (!this.active) return;
    const bounds = this.bounds(this.active.entry.info.id);
    if (bounds) this.active.entry.view.setBounds(bounds);
  }

  private exitDocument(entry: TabEntry): void {
    if (entry.webContents.isDestroyed()) return;
    // Dedicated world: separate from page (0), preload (999), and PageReader (1001).
    // Fixed cleanup only; never accepts page/model script text.
    void entry.webContents
      .executeJavaScriptInIsolatedWorld(1002, [
        { code: 'if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }' },
      ])
      .catch(() => {});
  }

  private exit(exitDocument = true): void {
    const previous = this.active;
    if (!previous) return;
    this.active = null;
    if (exitDocument) this.exitDocument(previous.entry);
    if (!this.owner.isDestroyed()) this.owner.setFullScreen(this.restoreWindowFullscreen);
    this.restoreLayout();
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.exit();
    this.contentView.removeListener('bounds-changed', this.onResize);
    this.owner.removeListener('resize', this.onResize);
    this.owner.removeListener('blur', this.clearPending);
    this.owner.removeListener('hide', this.onHide);
    this.owner.removeListener('minimize', this.onMinimize);
    this.owner.removeListener('leave-full-screen', this.onWindowLeave);
  }
}
