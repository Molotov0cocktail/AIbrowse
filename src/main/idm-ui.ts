import { app, dialog, type BrowserWindow, type Session } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IdmDownloadService } from './downloads/idm-service';
import { IdmNativeDownloadService, type IdmHelperIdentity } from './downloads/idm-native-service';
import { IdmDownloadInterceptor } from './downloads/idm-download-interceptor';
import { IdmDownloadCookieReader } from './downloads/idm-cookie-reader';

type InterceptorOptions = ConstructorParameters<typeof IdmDownloadInterceptor>[0];

function helperIdentity(): IdmHelperIdentity {
  const helperPath = app.isPackaged
    ? join(process.resourcesPath, 'idm/idm-handoff.exe')
    : join(app.getAppPath(), 'out/idm/idm-handoff.exe');
  const invalid = { helperPath, expectedSha256: '', expectedBytes: 0 };
  try {
    const path = join(__dirname, 'idm-handoff-integrity.json');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024) return invalid;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'bytes,sha256,version' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('bytes' in value) ||
      typeof value.bytes !== 'number' ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > 512 * 1024 ||
      !('sha256' in value) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      return invalid;
    return { helperPath, expectedSha256: value.sha256, expectedBytes: value.bytes };
  } catch {
    return invalid;
  }
}

/** Browser input authorization stays in main; UI retains the explicit URL fallback. */
export function createIdmFeature(options: {
  win: BrowserWindow;
  session: Session;
  isOpen(): boolean;
  isUserDownloadFrame: InterceptorOptions['isUserDownloadFrame'];
  getCaptureContext: InterceptorOptions['getCaptureContext'];
  consumeDownloadLease: InterceptorOptions['consumeDownloadLease'];
}) {
  const { win } = options;
  const service = new IdmDownloadService();
  const native = new IdmNativeDownloadService(helperIdentity());
  const cookieReader = new IdmDownloadCookieReader();
  let disposed = false;
  let showingError = false;
  const interceptor = new IdmDownloadInterceptor({
    session: options.session,
    service: native,
    readFallback: (input) => cookieReader.read(input),
    isUserDownloadFrame: (id, frame) => !disposed && options.isUserDownloadFrame(id, frame),
    getCaptureContext: (id, frame) =>
      !disposed && options.isOpen() ? options.getCaptureContext(id, frame) : null,
    consumeDownloadLease: (wc, frame, snapshot) => {
      if (disposed || !options.isOpen()) return null;
      const lease = options.consumeDownloadLease(wc, frame, snapshot);
      return lease === null
        ? null
        : {
            token: lease.token,
            isCurrent: () => !disposed && options.isOpen() && lease.isCurrent(),
          };
    },
    onResult: (result) => {
      if (result.ok || result.code === 'closed' || disposed || win.isDestroyed() || showingError)
        return;
      showingError = true;
      void dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'IDM 下载',
          message: result.message,
          buttons: ['知道了'],
          noLink: true,
        })
        .catch(() => {})
        .finally(() => {
          showingError = false;
        });
    },
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    interceptor.dispose();
    cookieReader.dispose();
    native.dispose();
    service.dispose();
    app.removeListener('will-quit', dispose);
    win.removeListener('closed', dispose);
  };
  app.once('will-quit', dispose);
  win.once('closed', dispose);
  return {
    getStatus: () => native.getStatus(),
    send: (value: unknown, isCurrent?: () => boolean) => service.send(value, isCurrent),
    dispose,
  };
}

export type IdmFeature = ReturnType<typeof createIdmFeature>;
