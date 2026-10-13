import { promises as dns } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  isAllowedPublicAddress,
  validatePublicUrl,
  type ApprovedTarget,
} from '../watch/network-policy';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_CONCURRENT = 4;
const MAX_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 8_192;
const MAX_ACCEPT_LENGTH = 1_024;
const FORBIDDEN_HOST = 'www.iflyrec.com';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FILTERED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
  'authentication-info',
  'proxy-authentication-info',
]);

export interface QualifiedScriptRequest {
  url: string;
  method: 'GET' | 'HEAD';
  headers?: { Accept?: string; Referer?: string };
}

export interface QualifiedScriptResponse {
  status: number;
  statusText: string;
  finalUrl: string;
  responseText: string;
  responseHeaders: string;
}

export type QualifiedScriptNetworkErrorCode =
  | 'invalid-request'
  | 'security-rejected'
  | 'forbidden-host'
  | 'busy'
  | 'timeout'
  | 'response-too-large'
  | 'invalid-response'
  | 'aborted'
  | 'closed'
  | 'unavailable';

const ERROR_MESSAGES: Readonly<Record<QualifiedScriptNetworkErrorCode, string>> = Object.freeze({
  'invalid-request': '脚本网络请求格式无效',
  'security-rejected': '脚本网络请求被安全策略拒绝',
  'forbidden-host': '该网站不允许通过脚本网络访问',
  busy: '脚本网络请求过多，请稍后再试',
  timeout: '脚本网络请求超时',
  'response-too-large': '脚本网络响应超过大小限制',
  'invalid-response': '脚本网络响应格式无效',
  aborted: '脚本网络请求已取消',
  closed: '脚本网络服务已关闭',
  unavailable: '脚本网络请求失败',
});

export class QualifiedScriptNetworkError extends Error {
  readonly code: QualifiedScriptNetworkErrorCode;

  constructor(code: QualifiedScriptNetworkErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'QualifiedScriptNetworkError';
    this.code = code;
  }
}

export interface QualifiedResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface TransportResponsePort {
  statusCode?: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  on(event: string, listener: (...args: never[]) => void): this;
  once(event: string, listener: (...args: never[]) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  destroy(): void;
}

interface TransportRequestPort {
  once(event: string, listener: (...args: never[]) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  setTimeout(timeout: number, listener: () => void): this;
  end(): void;
  destroy(): void;
}

export interface QualifiedScriptNetworkDependencies {
  lookup?: (hostname: string) => Promise<QualifiedResolvedAddress[]>;
  transport?: (
    options: RequestOptions,
    onResponse: (response: TransportResponsePort) => void,
  ) => TransportRequestPort;
  timeoutMs?: number;
}

interface ValidatedInput {
  target: ApprovedTarget;
  method: 'GET' | 'HEAD';
  headers: Readonly<Record<string, string>>;
}

interface Operation {
  controller: AbortController;
  abortCode: QualifiedScriptNetworkErrorCode | null;
}

interface HopResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
}

let globalActiveRequests = 0;

function failure(code: QualifiedScriptNetworkErrorCode): QualifiedScriptNetworkError {
  return new QualifiedScriptNetworkError(code);
}

function defaultLookup(hostname: string): Promise<QualifiedResolvedAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true }) as Promise<QualifiedResolvedAddress[]>;
}

function defaultTransport(
  options: RequestOptions,
  onResponse: (response: TransportResponsePort) => void,
): TransportRequestPort {
  const request = options.protocol === 'https:' ? httpsRequest : httpRequest;
  const outgoing = request(options, (response) => {
    // The bounded operation listener may be removed before destroy emits its
    // late error. This transport-local drain prevents an unhandled emitter error.
    response.on('error', () => {});
    onResponse(response as unknown as TransportResponsePort);
  });
  outgoing.on('error', () => {});
  return outgoing as unknown as TransportRequestPort;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isStrictString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function validateTarget(raw: unknown): ApprovedTarget {
  if (!isStrictString(raw, MAX_URL_LENGTH) || /\s/u.test(raw) || !/^https?:\/\//iu.test(raw)) {
    throw failure('security-rejected');
  }
  const result = validatePublicUrl(raw);
  if (!result.ok) throw failure('security-rejected');
  if (result.target.host === FORBIDDEN_HOST) throw failure('forbidden-host');
  return result.target;
}

function validateAccept(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACCEPT_LENGTH ||
    value !== value.trim() ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw failure('invalid-request');
  }
  return value;
}

function validateInput(value: unknown): ValidatedInput {
  try {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, ['url', 'method', 'headers'])) {
      throw failure('invalid-request');
    }
    if (value.method !== 'GET' && value.method !== 'HEAD') throw failure('invalid-request');
    const target = validateTarget(value.url);
    const headers: Record<string, string> = {};
    if (value.headers !== undefined) {
      if (!isPlainRecord(value.headers) || !hasOnlyKeys(value.headers, ['Accept', 'Referer'])) {
        throw failure('invalid-request');
      }
      if (value.headers.Accept !== undefined) headers.Accept = validateAccept(value.headers.Accept);
      if (value.headers.Referer !== undefined) {
        headers.Referer = validateTarget(value.headers.Referer).url;
      }
    }
    return { target, method: value.method, headers };
  } catch (error) {
    if (error instanceof QualifiedScriptNetworkError) throw error;
    throw failure('invalid-request');
  }
}

function operationFailure(operation: Operation): QualifiedScriptNetworkError {
  return failure(operation.abortCode ?? 'aborted');
}

function serializeHeaders(rawHeaders: readonly string[]): string {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length > 512) {
    throw failure('invalid-response');
  }
  const lines: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1]!;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\p{Cc}\p{Cf}]/u.test(value)) {
      throw failure('invalid-response');
    }
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('tm-finalurl') || FILTERED_RESPONSE_HEADERS.has(lowerName)) continue;
    lines.push(`${name}: ${value}`);
  }
  const serialized = lines.join('\r\n');
  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) throw failure('invalid-response');
  return serialized;
}

function redirectLocation(headers: IncomingHttpHeaders): string | null {
  const value = headers.location;
  return typeof value === 'string' ? value : null;
}

export class QualifiedScriptNetwork {
  private readonly lookup: (hostname: string) => Promise<QualifiedResolvedAddress[]>;
  private readonly transport: QualifiedScriptNetworkDependencies['transport'];
  private readonly timeoutMs: number;
  private readonly operations = new Set<Operation>();
  private closed = false;

  constructor(dependencies: QualifiedScriptNetworkDependencies = {}) {
    this.lookup = dependencies.lookup ?? defaultLookup;
    this.transport = dependencies.transport ?? defaultTransport;
    this.timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, dependencies.timeoutMs ?? MAX_TIMEOUT_MS),
    );
  }

  async request(
    input: QualifiedScriptRequest,
    signal?: AbortSignal,
  ): Promise<QualifiedScriptResponse> {
    if (this.closed) throw failure('closed');
    if (signal?.aborted) throw failure('aborted');
    const validated = validateInput(input);
    if (globalActiveRequests >= MAX_CONCURRENT) throw failure('busy');

    const operation: Operation = { controller: new AbortController(), abortCode: null };
    const onExternalAbort = (): void => this.abortOperation(operation, 'aborted');
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    this.operations.add(operation);
    globalActiveRequests += 1;
    if (signal?.aborted) onExternalAbort();
    const timer = setTimeout(() => this.abortOperation(operation, 'timeout'), this.timeoutMs);
    try {
      return await this.follow(validated, operation);
    } catch (error) {
      if (error instanceof QualifiedScriptNetworkError) throw error;
      throw failure('unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
      this.operations.delete(operation);
      globalActiveRequests -= 1;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const operation of this.operations) this.abortOperation(operation, 'closed');
  }

  private abortOperation(operation: Operation, code: QualifiedScriptNetworkErrorCode): void {
    if (operation.controller.signal.aborted) return;
    operation.abortCode = code;
    operation.controller.abort();
  }

  private async follow(
    input: ValidatedInput,
    operation: Operation,
  ): Promise<QualifiedScriptResponse> {
    let target = input.target;
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (operation.controller.signal.aborted) throw operationFailure(operation);
      const address = await this.resolve(target, operation);
      if (operation.controller.signal.aborted) throw operationFailure(operation);
      const response = await this.requestHop(target, address, input, operation);
      if (operation.controller.signal.aborted) throw operationFailure(operation);

      const location = redirectLocation(response.headers);
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        if (redirectCount >= MAX_REDIRECTS) throw failure('security-rejected');
        if (!isStrictString(location, MAX_URL_LENGTH) || /\s/u.test(location)) {
          throw failure('security-rejected');
        }
        let redirected: ApprovedTarget;
        try {
          redirected = validateTarget(new URL(location, target.url).toString());
        } catch (error) {
          if (error instanceof QualifiedScriptNetworkError) throw error;
          throw failure('security-rejected');
        }
        if (target.scheme === 'https' && redirected.scheme === 'http') {
          throw failure('security-rejected');
        }
        target = redirected;
        continue;
      }

      let responseText = '';
      if (input.method !== 'HEAD') {
        try {
          responseText = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
        } catch {
          throw failure('invalid-response');
        }
      }
      return {
        status: response.status,
        statusText: response.statusText,
        finalUrl: target.url,
        responseText,
        responseHeaders: serializeHeaders(response.rawHeaders),
      };
    }
  }

  private async resolve(
    target: ApprovedTarget,
    operation: Operation,
  ): Promise<QualifiedResolvedAddress> {
    const addresses = await this.raceAbort(this.lookup(target.host), operation);
    if (addresses.length === 0) throw failure('unavailable');
    for (const item of addresses) {
      if (
        (item.family !== 4 && item.family !== 6) ||
        isIP(item.address) !== item.family ||
        !isAllowedPublicAddress(item.address)
      ) {
        throw failure('security-rejected');
      }
    }
    return addresses[0]!;
  }

  private raceAbort<T>(promise: Promise<T>, operation: Operation): Promise<T> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(operationFailure(operation));
      };
      const cleanup = (): void => operation.controller.signal.removeEventListener('abort', onAbort);
      operation.controller.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          if (operation.controller.signal.aborted) reject(operationFailure(operation));
          else resolve(value);
        },
        () => {
          cleanup();
          reject(failure('unavailable'));
        },
      );
    });
  }

  private requestHop(
    target: ApprovedTarget,
    address: QualifiedResolvedAddress,
    input: ValidatedInput,
    operation: Operation,
  ): Promise<HopResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let response: TransportResponsePort | null = null;
      let request: TransportRequestPort | null = null;
      const chunks: Buffer[] = [];
      let byteLength = 0;

      const finish = (result: HopResponse | QualifiedScriptNetworkError): void => {
        if (settled) return;
        settled = true;
        operation.controller.signal.removeEventListener('abort', onAbort);
        request?.removeListener('error', onRequestError as (...args: never[]) => void);
        if (response !== null) {
          response.removeListener('data', onData as (...args: never[]) => void);
          response.removeListener('end', onEnd as (...args: never[]) => void);
          response.removeListener('aborted', onResponseFailure as (...args: never[]) => void);
          response.removeListener('error', onResponseFailure as (...args: never[]) => void);
        }
        if (result instanceof QualifiedScriptNetworkError) reject(result);
        else resolve(result);
      };
      const onAbort = (): void => {
        request?.destroy();
        response?.destroy();
        finish(operationFailure(operation));
      };
      const onRequestError = (): void => finish(failure('unavailable'));
      const onResponseFailure = (): void => finish(failure('unavailable'));
      const onData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.length;
        if (byteLength > MAX_BODY_BYTES) {
          response?.destroy();
          finish(failure('response-too-large'));
          return;
        }
        if (input.method !== 'HEAD') chunks.push(bytes);
      };
      const onEnd = (): void => {
        if (response === null) return;
        const status = response.statusCode;
        const statusText = response.statusMessage ?? '';
        if (
          status === undefined ||
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599 ||
          statusText.length > 1_024 ||
          /[\p{Cc}\p{Cf}]/u.test(statusText)
        ) {
          finish(failure('invalid-response'));
          return;
        }
        finish({
          status,
          statusText,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          body: input.method === 'HEAD' ? Buffer.alloc(0) : Buffer.concat(chunks, byteLength),
        });
      };
      const pinnedLookup = ((
        hostname: string,
        options: { all?: boolean },
        callback: (
          error: NodeJS.ErrnoException | null,
          address: string | QualifiedResolvedAddress[],
          family?: number,
        ) => void,
      ): void => {
        if (hostname.toLowerCase().replace(/\.+$/u, '') !== target.host) {
          callback(Object.assign(new Error('lookup rejected'), { code: 'EACCES' }), '', 0);
          return;
        }
        if (options.all === true) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as LookupFunction;

      try {
        request = this.transport!(
          {
            protocol: `${target.scheme}:`,
            hostname: target.host,
            port: target.port,
            method: input.method,
            path: new URL(target.url).pathname + new URL(target.url).search,
            headers: input.headers,
            lookup: pinnedLookup,
            agent: false,
            maxHeaderSize: 32 * 1024,
          },
          (incoming) => {
            if (settled) {
              incoming.destroy();
              return;
            }
            response = incoming;
            const declared = incoming.headers['content-length'];
            if (
              typeof declared === 'string' &&
              (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)
            ) {
              incoming.destroy();
              finish(failure('response-too-large'));
              return;
            }
            incoming.on('data', onData as (...args: never[]) => void);
            incoming.once('end', onEnd as (...args: never[]) => void);
            incoming.once('aborted', onResponseFailure as (...args: never[]) => void);
            incoming.once('error', onResponseFailure as (...args: never[]) => void);
          },
        );
        if (settled) {
          request.destroy();
          return;
        }
        request.once('error', onRequestError as (...args: never[]) => void);
        request.setTimeout(this.timeoutMs, () => this.abortOperation(operation, 'timeout'));
        operation.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (operation.controller.signal.aborted) onAbort();
        else request.end();
      } catch {
        finish(failure('unavailable'));
      }
    });
  }
}
