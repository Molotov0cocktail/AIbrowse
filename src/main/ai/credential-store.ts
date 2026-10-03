// SecureCredentialStore: API key storage with ciphertext-only persistence (Electron
// safeStorage / Windows DPAPI) under <userData>/credentials.json.
// Contract source: doc/stage2/detailed-design.md §3.4/§10 (zero-exposure line: file holds
// ciphertext only; renderer is write-only via IPC in S4; fail-closed on unavailability).
// The cipher backend is injected (design Q2: replaceable storage backend) — the real
// safeStorage glue lives in ./safe-storage-cipher.ts, so this module is fully unit-testable
// without Electron.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { logWarn } from '../logger';
import { readBoundedFile } from './bounded-file';

const MAX_PROVIDERS = 64;
const MAX_CIPHERTEXT_CHARS = 128 * 1024;
const CREDENTIAL_FILE_MAX_BYTES = 9 * 1024 * 1024;

function validProviderId(providerId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId) &&
    !['__proto__', 'constructor', 'prototype'].includes(providerId)
  );
}

// —— Pure file format (zero deps, unit-tested) ——

export interface CredentialsFileData {
  version: 1 | 2;
  providers: Record<string, string>; // providerId → base64 ciphertext
  generations?: Record<string, string>;
}

export function serializeCredentialsFile(data: CredentialsFileData): string {
  return JSON.stringify(data, null, 2);
}

// Best-effort shape check for stored values. The real backstop is decryption failure
// (→ treated as missing, fail-closed); this check additionally drops plaintext-shaped
// entries such as keys starting with "sk-" that must never sit in the file.
export function isCiphertextShape(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_CIPHERTEXT_CHARS)
    return false;
  if (/^sk-/i.test(value)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(value);
}

// Structural corruption or quota violation returns null. Invalid entries are counted
// for diagnostics; the store rejects any dropped entry and preserves the source file.
export function parseCredentialsFile(
  text: string,
): { data: CredentialsFileData; dropped: number } | null {
  if (Buffer.byteLength(text) > CREDENTIAL_FILE_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return null;
  const generationRaw = record.generations;
  if (
    record.version === 2 &&
    (typeof generationRaw !== 'object' || generationRaw === null || Array.isArray(generationRaw))
  )
    return null;
  if (
    typeof record.providers !== 'object' ||
    record.providers === null ||
    Array.isArray(record.providers) ||
    Object.keys(record.providers).length > MAX_PROVIDERS
  )
    return null;
  if (
    record.version === 2 &&
    Object.keys(generationRaw as object).length !== Object.keys(record.providers).length
  )
    return null;
  const providers: Record<string, string> = {};
  const generations: Record<string, string> = {};
  let dropped = 0;
  const providersRaw = record.providers;
  if (typeof providersRaw === 'object' && providersRaw !== null && !Array.isArray(providersRaw)) {
    for (const [providerId, value] of Object.entries(providersRaw)) {
      const generation = (generationRaw as Record<string, unknown> | undefined)?.[providerId];
      if (
        validProviderId(providerId) &&
        isCiphertextShape(value) &&
        (record.version === 1 || isCredentialGeneration(generation))
      ) {
        providers[providerId] = value;
        if (typeof generation === 'string') generations[providerId] = generation;
      } else dropped += 1;
    }
  }
  return {
    data: record.version === 1 ? { version: 1, providers } : { version: 2, providers, generations },
    dropped,
  };
}

export function isCredentialGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|legacy:[a-f0-9]{64})$/.test(
      value,
    )
  );
}

function generationFor(data: CredentialsFileData, providerId: string): string | null {
  const ciphertext = Object.hasOwn(data.providers, providerId)
    ? data.providers[providerId]
    : undefined;
  if (ciphertext === undefined) return null;
  return data.version === 2
    ? (data.generations?.[providerId] ?? null)
    : `legacy:${createHash('sha256').update(ciphertext).digest('hex')}`;
}

// —— Cipher backend seam (replaceable: safeStorage today, Credential Manager etc. later) ——

export interface CipherBackend {
  isAvailable(): boolean;
  encrypt(plaintext: string): string; // Ciphertext (base64); throws on failure
  decrypt(ciphertext: string): string; // Throws on failure
}

export interface SecureCredentialStore {
  isAvailable(): boolean; // safeStorage.isEncryptionAvailable() (Windows = DPAPI)
  set(providerId: string, apiKey: string): Promise<boolean>; // Encrypt+persist; unavailable/failure → false + warn
  get(providerId: string): Promise<string | null>; // Main-process only (adapter); decrypt failure → null + warn
  has(providerId: string): Promise<boolean>; // IPC-safe query (never contains the key)
  delete(providerId: string): Promise<boolean>;
  // Optional only for existing non-network test doubles; real adapters fail closed without these.
  getGeneration?(providerId: string): string | null;
  getBound?(providerId: string, generation: string): Promise<string | null>;
  getMutationVersion?(providerId: string): number;
}

export class SecureCredentialStoreImpl implements SecureCredentialStore {
  private readonly filePath: string;
  // Memory-only fallback when encryption is unavailable (process-lifetime, discarded on
  // exit) — per §3.4 the UI must then say 「当前环境无法安全保存 API Key，仅本次运行有效」.
  private readonly memoryFallback = new Map<string, string>();
  private readonly memoryGenerations = new Map<string, string>();
  private mutationVersion = 0;

  constructor(
    userDataDir: string,
    private readonly cipher: CipherBackend,
  ) {
    this.filePath = join(userDataDir, 'credentials.json');
  }

  isAvailable(): boolean {
    return this.cipher.isAvailable();
  }

  async set(providerId: string, apiKey: string): Promise<boolean> {
    if (!validProviderId(providerId) || apiKey === '' || apiKey.length > 16_384) {
      logWarn('credential', 'set 参数无效（providerId/apiKey 不得为空）');
      return false;
    }
    if (!this.bumpMutation()) return false;
    const data = this.readFileData();
    if (data === null) return false;
    const ids = new Set([...Object.keys(data.providers), ...this.memoryFallback.keys()]);
    if (!ids.has(providerId) && ids.size >= MAX_PROVIDERS) return false;
    if (!this.isAvailable()) {
      this.memoryFallback.set(providerId, apiKey);
      this.memoryGenerations.set(providerId, randomUUID());
      logWarn('credential', `安全存储不可用：API Key 仅本次运行有效（${providerId}）`);
      return false;
    }
    try {
      const ciphertext = this.cipher.encrypt(apiKey);
      if (!isCiphertextShape(ciphertext)) return false;
      const generations = this.allGenerations(data);
      data.providers[providerId] = ciphertext;
      generations[providerId] = randomUUID();
      this.writeFileData({ version: 2, providers: data.providers, generations });
      this.memoryFallback.delete(providerId);
      this.memoryGenerations.delete(providerId);
      return true;
    } catch (error) {
      logWarn('credential', `API Key 保存失败（${providerId}）`, error);
      return false;
    }
  }

  async get(providerId: string): Promise<string | null> {
    if (!validProviderId(providerId)) return null;
    const memory = this.memoryFallback.get(providerId);
    if (memory !== undefined) return memory;
    if (!this.isAvailable()) return null;
    const data = this.readFileData();
    const ciphertext = data?.providers[providerId];
    if (ciphertext === undefined) return null;
    try {
      const key = this.cipher.decrypt(ciphertext);
      return key.length > 0 && key.length <= 16_384 ? key : null;
    } catch (error) {
      logWarn('credential', `API Key 解密失败，按缺失处理（${providerId}）`, error);
      return null;
    }
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.get(providerId)) !== null;
  }

  async delete(providerId: string): Promise<boolean> {
    if (!validProviderId(providerId)) return false;
    if (!this.bumpMutation()) return false;
    const data = this.readFileData();
    if (data === null) return false;
    try {
      if (Object.hasOwn(data.providers, providerId)) {
        const generations = this.allGenerations(data);
        delete data.providers[providerId];
        delete generations[providerId];
        this.writeFileData({ version: 2, providers: data.providers, generations });
      }
      this.memoryFallback.delete(providerId);
      this.memoryGenerations.delete(providerId);
      return true;
    } catch (error) {
      logWarn('credential', `API Key 删除失败（${providerId}）`, error);
      return false;
    }
  }

  getMutationVersion(providerId: string): number {
    return validProviderId(providerId) ? this.mutationVersion : 0;
  }

  getGeneration(providerId: string): string | null {
    if (!validProviderId(providerId)) return null;
    const memory = this.memoryGenerations.get(providerId);
    if (memory !== undefined) return memory;
    if (!this.isAvailable()) return null;
    const data = this.readFileData();
    return data === null ? null : generationFor(data, providerId);
  }

  async getBound(providerId: string, generation: string): Promise<string | null> {
    if (!validProviderId(providerId) || !isCredentialGeneration(generation)) return null;
    if (this.memoryGenerations.get(providerId) === generation) {
      return this.memoryFallback.get(providerId) ?? null;
    }
    if (!this.isAvailable()) return null;
    const data = this.readFileData();
    if (data === null || generationFor(data, providerId) !== generation) return null;
    try {
      const key = this.cipher.decrypt(data.providers[providerId]!);
      return key.length > 0 && key.length <= 16_384 ? key : null;
    } catch {
      return null;
    }
  }

  private bumpMutation(): boolean {
    if (this.mutationVersion >= Number.MAX_SAFE_INTEGER) return false;
    this.mutationVersion += 1;
    return true;
  }

  private allGenerations(data: CredentialsFileData): Record<string, string> {
    return Object.fromEntries(
      Object.keys(data.providers).map((id) => [id, generationFor(data, id)!]),
    );
  }

  private readFileData(): CredentialsFileData | null {
    try {
      const text = readBoundedFile(this.filePath, CREDENTIAL_FILE_MAX_BYTES);
      if (text === null) return { version: 1, providers: {} };
      const parsed = parseCredentialsFile(text);
      if (parsed === null || parsed.dropped > 0) {
        logWarn('credential', 'credentials.json 损坏或超限，拒绝读取与覆盖');
        return null;
      }
      return parsed.data;
    } catch (error) {
      logWarn('credential', 'credentials.json 读取失败，保留原文件', error);
      return null;
    }
  }

  private writeFileData(data: CredentialsFileData): void {
    const text = serializeCredentialsFile(data);
    if (Buffer.byteLength(text) > CREDENTIAL_FILE_MAX_BYTES)
      throw new Error('凭据文件超出大小上限');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, text, { encoding: 'utf8', flush: true });
    renameSync(tmpPath, this.filePath); // Atomic replace (tmp + rename)
  }
}
