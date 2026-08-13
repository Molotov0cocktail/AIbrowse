// SecureCredentialStore: API key storage with ciphertext-only persistence (Electron
// safeStorage / Windows DPAPI) under <userData>/credentials.json.
// Contract source: doc/stage2/detailed-design.md §3.4/§10 (zero-exposure line: file holds
// ciphertext only; renderer is write-only via IPC in S4; fail-closed on unavailability).
// The cipher backend is injected (design Q2: replaceable storage backend) — the real
// safeStorage glue lives in ./safe-storage-cipher.ts, so this module is fully unit-testable
// without Electron.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logWarn } from '../logger';

// —— Pure file format (zero deps, unit-tested) ——

export interface CredentialsFileData {
  version: 1;
  providers: Record<string, string>; // providerId → base64 ciphertext
}

export function serializeCredentialsFile(data: CredentialsFileData): string {
  return JSON.stringify(data, null, 2);
}

// Best-effort shape check for stored values. The real backstop is decryption failure
// (→ treated as missing, fail-closed); this check additionally drops plaintext-shaped
// entries such as keys starting with "sk-" that must never sit in the file.
export function isCiphertextShape(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (/^sk-/i.test(value)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(value);
}

// Corrupted file → null (treated as empty, fail-closed). Invalid entries are dropped and
// counted (caller warns); a missing/non-object providers field yields an empty map.
export function parseCredentialsFile(
  text: string,
): { data: CredentialsFileData; dropped: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  const providers: Record<string, string> = {};
  let dropped = 0;
  const providersRaw = record.providers;
  if (typeof providersRaw === 'object' && providersRaw !== null && !Array.isArray(providersRaw)) {
    for (const [providerId, value] of Object.entries(providersRaw)) {
      if (providerId !== '' && isCiphertextShape(value)) providers[providerId] = value;
      else dropped += 1;
    }
  }
  return { data: { version: 1, providers }, dropped };
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
}

export class SecureCredentialStoreImpl implements SecureCredentialStore {
  private readonly filePath: string;
  // Memory-only fallback when encryption is unavailable (process-lifetime, discarded on
  // exit) — per §3.4 the UI must then say 「当前环境无法安全保存 API Key，仅本次运行有效」.
  private readonly memoryFallback = new Map<string, string>();

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
    if (providerId === '' || apiKey === '') {
      logWarn('credential', 'set 参数无效（providerId/apiKey 不得为空）');
      return false;
    }
    if (!this.isAvailable()) {
      this.memoryFallback.set(providerId, apiKey);
      logWarn('credential', `安全存储不可用：API Key 仅本次运行有效（${providerId}）`);
      return false; // Contract: unavailable → set returns false and does not persist
    }
    try {
      const ciphertext = this.cipher.encrypt(apiKey);
      const data = this.readFileData();
      data.providers[providerId] = ciphertext;
      this.writeFileData(data);
      return true;
    } catch (error) {
      logWarn('credential', `API Key 保存失败（${providerId}）`, error);
      return false;
    }
  }

  async get(providerId: string): Promise<string | null> {
    const memory = this.memoryFallback.get(providerId);
    if (memory !== undefined) return memory;
    if (!this.isAvailable()) return null;
    const data = this.readFileData();
    const ciphertext = data.providers[providerId];
    if (ciphertext === undefined) return null;
    try {
      return this.cipher.decrypt(ciphertext);
    } catch (error) {
      logWarn('credential', `API Key 解密失败，按缺失处理（${providerId}）`, error);
      return null;
    }
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.get(providerId)) !== null;
  }

  async delete(providerId: string): Promise<boolean> {
    this.memoryFallback.delete(providerId);
    const data = this.readFileData();
    if (data.providers[providerId] === undefined) return true; // Idempotent
    delete data.providers[providerId];
    try {
      this.writeFileData(data);
      return true;
    } catch (error) {
      logWarn('credential', `API Key 删除失败（${providerId}）`, error);
      return false;
    }
  }

  private readFileData(): CredentialsFileData {
    const empty = (): CredentialsFileData => ({ version: 1, providers: {} });
    try {
      const text = readFileSync(this.filePath, 'utf8');
      const parsed = parseCredentialsFile(text);
      if (parsed === null) {
        logWarn('credential', 'credentials.json 损坏，按空处理（fail-closed）');
        return empty();
      }
      if (parsed.dropped > 0) {
        logWarn('credential', `credentials.json 中 ${parsed.dropped} 条损坏条目已忽略`);
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('credential', 'credentials.json 读取失败', error);
      }
      return empty();
    }
  }

  private writeFileData(data: CredentialsFileData): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, serializeCredentialsFile(data), 'utf8');
    renameSync(tmpPath, this.filePath); // Atomic replace (tmp + rename)
  }
}
