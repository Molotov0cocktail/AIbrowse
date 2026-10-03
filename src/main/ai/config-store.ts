// Provider configuration and target authorization commit together in one atomic file.
// Credential values remain exclusively in SecureCredentialStore.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logWarn } from '../logger';
import { readBoundedFile } from './bounded-file';
import { isCredentialGeneration, type SecureCredentialStore } from './credential-store';
import type { ProviderConfig, ProviderInfo } from '../../shared/types/conversation';

export type { ProviderConfig, ProviderInfo } from '../../shared/types/conversation';

const PROVIDER_LABELS: Record<string, string> = { 'openai-compatible': 'OpenAI 兼容' };
const CONFIG_FILE_MAX_BYTES = 256 * 1024;
const MAX_PROVIDERS = 64;

function containsControl(value: string, includeSpace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= (includeSpace ? 32 : 31) || (code >= 127 && code <= 159);
  });
}

// Canonical authority includes scheme, host, effective port and API base path.
// Reject ambiguous input before WHATWG URL normalization can erase it.
export function normalizeBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  const trimmed = raw.trim();
  if (
    trimmed === '' ||
    containsControl(trimmed, true) ||
    /[\\?#]/.test(trimmed) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c|2e|25)/i.test(trimmed)
  )
    return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return null;
  const authorityAndPath = trimmed.match(/^https?:\/\/([^/]*)(.*)$/i);
  if (authorityAndPath === null || authorityAndPath[1]!.includes('@')) return null;
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(authorityAndPath[2]!)) return null;
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
  if (/%(?![0-9a-f]{2})/i.test(path)) return null;
  return `${url.origin}${path}`;
}

export function validateProviderConfig(input: unknown): ProviderConfig | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['providerId', 'baseUrl', 'model'].includes(key)))
    return null;
  if (typeof record.providerId !== 'string' || typeof record.model !== 'string') return null;
  const providerId = record.providerId.trim();
  const model = record.model.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId) ||
    ['__proto__', 'constructor', 'prototype'].includes(providerId) ||
    model === '' ||
    model.length > 256 ||
    containsControl(model)
  )
    return null;
  const baseUrl = normalizeBaseUrl(record.baseUrl as string);
  return baseUrl === null ? null : { providerId, baseUrl, model };
}

interface TargetBinding {
  target: string;
  generation: string;
}
interface StoredProvider {
  config: ProviderConfig;
  revision: number;
  binding: TargetBinding | null;
}

export interface ProviderAuthorizationSnapshot {
  readonly target: string;
  readonly generation: string;
  readonly configurationVersion: number;
  isCurrent(): boolean;
}

interface IssuedSnapshot {
  config: ProviderConfig;
  authorization: ProviderAuthorizationSnapshot;
}
const issuedSnapshots = new WeakMap<ProviderConfig, IssuedSnapshot>();

// Authorization cannot be forged by adding fields to an IPC DTO or spreading a config.
export function getProviderAuthorization(
  config: ProviderConfig,
): ProviderAuthorizationSnapshot | null {
  const issued = issuedSnapshots.get(config);
  if (
    issued === undefined ||
    issued.config.providerId !== config.providerId ||
    issued.config.baseUrl !== config.baseUrl ||
    issued.config.model !== config.model
  )
    return null;
  return issued.authorization;
}

export function isProviderAuthorized(
  config: ProviderConfig,
  credentials: SecureCredentialStore,
): boolean {
  const authorization = getProviderAuthorization(config);
  return (
    authorization !== null &&
    authorization.isCurrent() &&
    credentials.getBound !== undefined &&
    credentials.getGeneration?.(config.providerId) === authorization.generation
  );
}

export class ConfigStore {
  private readonly filePath: string;
  private loaded: Map<string, StoredProvider> | null = null;
  private revision = 0;
  private loadFailed = false;
  private loadedText: string | null = null;

  constructor(
    userDataDir: string,
    private readonly credentials: SecureCredentialStore,
  ) {
    this.filePath = join(userDataDir, 'provider-config.json');
  }

  get(providerId: string): ProviderConfig | null {
    const stored = this.ensureLoaded().get(providerId);
    if (stored === undefined) return null;
    const config = { ...stored.config };
    if (stored.binding !== null) {
      const binding = { ...stored.binding };
      const version = stored.revision;
      issuedSnapshots.set(config, {
        config: { ...config },
        authorization: Object.freeze({
          target: binding.target,
          generation: binding.generation,
          configurationVersion: version,
          isCurrent: () => {
            const current = this.ensureLoaded().get(providerId);
            return (
              current?.revision === version &&
              current.binding?.target === binding.target &&
              current.binding.generation === binding.generation
            );
          },
        }),
      });
    }
    return config;
  }

  getVersion(): number {
    this.ensureLoaded();
    return this.revision;
  }

  isTargetAuthorized(providerId: string, target: string, generation: string): boolean {
    const stored = this.ensureLoaded().get(providerId);
    return (
      stored?.binding?.target === target &&
      stored.binding.generation === generation &&
      stored.config.baseUrl === target
    );
  }

  // Internal non-authorizing writes preserve an existing same-target binding only.
  set(config: ProviderConfig): boolean {
    const valid = validateProviderConfig(config);
    if (valid === null) return false;
    const existing = this.ensureLoaded().get(valid.providerId);
    const binding = existing?.binding?.target === valid.baseUrl ? existing.binding : null;
    return this.commit(valid, binding, this.revision);
  }

  // Only the main-process native-confirmation guard calls this on the product path.
  commitAuthorized(
    config: ProviderConfig,
    expectedVersion: number,
    generation: string | null,
  ): boolean {
    const valid = validateProviderConfig(config);
    if (valid === null || (generation !== null && !isCredentialGeneration(generation)))
      return false;
    if (generation !== null && this.credentials.getGeneration?.(valid.providerId) !== generation)
      return false;
    return this.commit(
      valid,
      generation === null ? null : { target: valid.baseUrl, generation },
      expectedVersion,
    );
  }

  async list(): Promise<ProviderInfo[]> {
    const configs = [...this.ensureLoaded().values()].map((entry) => entry.config);
    return Promise.all(
      configs.map(async (config) => ({
        providerId: config.providerId,
        label: PROVIDER_LABELS[config.providerId] ?? config.providerId,
        baseUrl: config.baseUrl,
        model: config.model,
        hasKey: await this.credentials.has(config.providerId),
      })),
    );
  }

  private commit(
    config: ProviderConfig,
    binding: TargetBinding | null,
    expectedVersion: number,
  ): boolean {
    const old = this.ensureLoaded();
    if (this.loadFailed) return false;
    if (this.revision !== expectedVersion || this.revision >= Number.MAX_SAFE_INTEGER) return false;
    if (!old.has(config.providerId) && old.size >= MAX_PROVIDERS) return false;
    const revision = this.revision + 1;
    const next = new Map(old);
    next.set(config.providerId, { config: { ...config }, revision, binding });
    try {
      if (readBoundedFile(this.filePath, CONFIG_FILE_MAX_BYTES) !== this.loadedText) return false;
      this.loadedText = this.writeFile(next, revision);
      this.loaded = next;
      this.revision = revision;
      return true;
    } catch (error) {
      logWarn('config', 'Provider 配置写入失败，原配置和授权保持不变', error);
      return false;
    }
  }

  private ensureLoaded(): Map<string, StoredProvider> {
    if (this.loaded !== null) return this.loaded;
    const map = new Map<string, StoredProvider>();
    try {
      const text = readBoundedFile(this.filePath, CONFIG_FILE_MAX_BYTES);
      if (text === null) {
        this.loaded = map;
        return map;
      }
      this.loadedText = text;
      const raw: unknown = JSON.parse(text);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error('配置形状无效');
      const record = raw as Record<string, unknown>;
      if (
        (record.version !== 1 && record.version !== 2) ||
        !Array.isArray(record.providers) ||
        record.providers.length > MAX_PROVIDERS
      )
        throw new Error('配置版本或形状无效');
      if (record.version === 2) {
        if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)
          throw new Error('配置版本无效');
        this.revision = record.revision as number;
      }
      for (const entry of record.providers) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
          throw new Error('配置条目无效');
        const value = entry as Record<string, unknown>;
        const config = validateProviderConfig(record.version === 1 ? value : value.config);
        if (config === null || map.has(config.providerId)) throw new Error('配置条目无效或重复');
        let binding: TargetBinding | null = null;
        let revision = 0;
        if (record.version === 2) {
          if (
            !Number.isSafeInteger(value.revision) ||
            (value.revision as number) < 0 ||
            (value.revision as number) > this.revision
          )
            throw new Error('配置条目版本无效');
          revision = value.revision as number;
          if (
            typeof value.binding === 'object' &&
            value.binding !== null &&
            !Array.isArray(value.binding)
          ) {
            const candidate = value.binding as Record<string, unknown>;
            if (
              Object.keys(candidate).length === 2 &&
              candidate.target === config.baseUrl &&
              isCredentialGeneration(candidate.generation)
            ) {
              binding = { target: config.baseUrl, generation: candidate.generation };
            } else throw new Error('配置绑定无效');
          } else if (value.binding !== null) throw new Error('配置绑定无效');
        }
        map.set(config.providerId, { config, revision, binding });
      }
    } catch (error) {
      this.loadFailed = true;
      logWarn('config', 'Provider 配置读取失败，拒绝读取与覆盖并保留原文件', error);
      this.revision = 0;
      map.clear();
    }
    this.loaded = map;
    return map;
  }

  private writeFile(configs: Map<string, StoredProvider>, revision: number): string {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const text = JSON.stringify(
      { version: 2, revision, providers: [...configs.values()] },
      null,
      2,
    );
    if (Buffer.byteLength(text) > CONFIG_FILE_MAX_BYTES) throw new Error('配置超出大小上限');
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, text, { encoding: 'utf8', flush: true });
    renameSync(tmpPath, this.filePath);
    return text;
  }
}
