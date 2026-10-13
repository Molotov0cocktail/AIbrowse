import type { WebContents, WebFrameMain } from 'electron';
import type { IdmDownloadSnapshot } from './idm-download-interceptor';
import { normalizeIdmMetadata } from './idm-native-service';

interface Input {
  readonly snapshot: IdmDownloadSnapshot;
  readonly webContents: WebContents;
  readonly frame: WebFrameMain;
  readonly referrer: string;
  readonly isCurrent: () => boolean;
}
interface Result {
  readonly cookie: string;
  readonly referer: string;
  readonly userAgent: string;
}

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !('value' in entry)))
    return null;
  return value as Record<string, unknown>;
}

function cookieHeader(value: unknown, url: URL): string | null {
  const result = object(value);
  if (!result || !Array.isArray(result.cookies) || result.cookies.length > 128) return null;
  const names = new Set<string>();
  const pairs: string[] = [];
  for (const raw of result.cookies) {
    const cookie = object(raw);
    if (!cookie) return null;
    const { name, value, domain, path, partitionKey, partitionKeyOpaque } = cookie;
    if (
      typeof name !== 'string' ||
      name.length > 4096 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      typeof value !== 'string' ||
      value.length > 4096 ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(value) ||
      typeof domain !== 'string' ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      partitionKeyOpaque !== undefined ||
      names.has(name)
    )
      return null;
    const host = domain.startsWith('.') ? domain.slice(1) : domain;
    if (host !== url.hostname && !(domain.startsWith('.') && url.hostname.endsWith(`.${host}`)))
      return null;
    if (
      url.pathname !== path &&
      !(url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/'))
    )
      return null;
    if (partitionKey !== undefined) {
      const key = object(partitionKey);
      if (!key || key.hasCrossSiteAncestor !== false || typeof key.topLevelSite !== 'string')
        return null;
      const site = new URL(key.topLevelSite);
      if (
        site.protocol !== url.protocol ||
        site.username ||
        site.password ||
        site.port ||
        (site.hostname !== url.hostname && !url.hostname.endsWith(`.${site.hostname}`))
      )
        return null;
    }
    names.add(name);
    pairs.push(`${name}=${value}`);
  }
  const header = pairs.join('; ');
  return Buffer.byteLength(header, 'utf8') <= 16384 ? header : null;
}

/** A fixed, read-only command scoped by Chromium to the current main frame. */
export class IdmDownloadCookieReader {
  private closed = false;
  private readonly pending = new Set<() => void>();

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
  }

  async read(input: Input): Promise<Result | null> {
    const { webContents: wc, frame, snapshot } = input;
    try {
      const initialUrl = frame.url;
      const initialOrigin = frame.origin;
      const url = new URL(snapshot.url);
      const initial = new URL(initialUrl);
      if (
        !snapshot.hasUserGesture ||
        !['http:', 'https:'].includes(url.protocol) ||
        !['http:', 'https:'].includes(initial.protocol) ||
        snapshot.initiatorOrigin !== initialOrigin ||
        initial.origin !== initialOrigin ||
        url.origin !== initialOrigin ||
        snapshot.urlChain.length < 1 ||
        snapshot.urlChain.length > 20 ||
        snapshot.urlChain.at(-1) !== snapshot.url ||
        snapshot.urlChain.some((entry) => new URL(entry).origin !== initialOrigin)
      )
        return null;
      const active = (): boolean => {
        try {
          return (
            !this.closed &&
            input.isCurrent() &&
            !wc.isDestroyed() &&
            wc.mainFrame === frame &&
            frame.parent === null &&
            !frame.detached &&
            frame.url === initialUrl &&
            frame.origin === initialOrigin
          );
        } catch {
          return false;
        }
      };
      const debug = wc.debugger;
      if (!active() || debug.isAttached()) return null;
      const userAgent = wc.getUserAgent();
      if (
        !normalizeIdmMetadata({
          url: snapshot.url,
          cookie: '',
          referer: input.referrer,
          userAgent,
          filename: '',
        }) ||
        snapshot.urlChain.some(
          (entry) =>
            !normalizeIdmMetadata({ url: entry, cookie: '', referer: '', userAgent, filename: '' }),
        )
      )
        return null;
      return await new Promise<Result | null>((resolve) => {
        let settled = false;
        let owned = false;
        const finish = (value: Result | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          this.pending.delete(cancel);
          wc.session.cookies.removeListener('changed', cancel);
          debug.removeListener('detach', detached);
          if (owned) {
            owned = false;
            try {
              debug.detach();
            } catch {
              /* Already destroyed or externally detached. */
            }
          }
          resolve(value);
        };
        const cancel = (): void => finish(null);
        const detached = (): void => {
          owned = false;
          cancel();
        };
        const timer = setTimeout(cancel, 2000);
        timer.unref();
        const poll = setInterval(() => {
          if (!active()) cancel();
        }, 50);
        poll.unref();
        this.pending.add(cancel);
        wc.session.cookies.on('changed', cancel);
        debug.on('detach', detached);
        try {
          debug.attach('1.3');
          owned = true;
          if (!active() || settled) return cancel();
          // No event stream, bodies, arbitrary method names, or renderer interface.
          void debug
            .sendCommand('Network.getCookies', { urls: [snapshot.url] })
            .then((value: unknown) => {
              if (settled || !active()) return cancel();
              try {
                const cookie = cookieHeader(value, url);
                if (cookie === null) return cancel();
                const metadata = normalizeIdmMetadata({
                  url: snapshot.url,
                  cookie,
                  referer: input.referrer,
                  userAgent,
                  filename: '',
                });
                finish(
                  metadata === null
                    ? null
                    : {
                        cookie: metadata.cookie,
                        referer: metadata.referer,
                        userAgent: metadata.userAgent,
                      },
                );
              } catch {
                cancel();
              }
            }, cancel);
        } catch {
          cancel();
        }
      });
    } catch {
      return null;
    }
  }
}
