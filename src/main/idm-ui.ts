import { app, type BrowserWindow } from 'electron';
import { IdmDownloadService } from './downloads/idm-service';

/** A user-only handoff, separate from browser tools and automatic downloads. */
export function createIdmFeature(win: BrowserWindow): IdmDownloadService {
  const service = new IdmDownloadService();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    service.dispose();
    app.removeListener('will-quit', dispose);
    win.removeListener('closed', dispose);
  };
  app.once('will-quit', dispose);
  win.once('closed', dispose);
  return service;
}
