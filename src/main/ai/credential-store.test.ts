// SecureCredentialStore tests (pure/file parts; real safeStorage behavior is smoke-verified
// later per design §13.2 scenario 10). The cipher backend is injected so the write path is
// exercised for real: ciphertext-only file, corruption tolerance, fail-closed behavior.
// Contract source: doc/stage2/detailed-design.md §3.4/§10.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger } from '../logger';
import {
  SecureCredentialStoreImpl,
  isCiphertextShape,
  parseCredentialsFile,
  serializeCredentialsFile,
  type CipherBackend,
} from './credential-store';

// Deterministic invertible test cipher (base64). Stands in for Electron safeStorage so the
// whole store write/read path runs under vitest without Electron.
class Base64Cipher implements CipherBackend {
  isAvailable(): boolean {
    return true;
  }
  encrypt(plaintext: string): string {
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }
  decrypt(ciphertext: string): string {
    return Buffer.from(ciphertext, 'base64').toString('utf8');
  }
}

class UnavailableCipher implements CipherBackend {
  isAvailable(): boolean {
    return false;
  }
  encrypt(): string {
    throw new Error('unavailable');
  }
  decrypt(): string {
    throw new Error('unavailable');
  }
}

class DecryptFailureCipher extends Base64Cipher {
  override decrypt(): string {
    throw new Error('decrypt failed');
  }
}

let baseDir: string;
beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aibrowse-cred-'));
  // Route logger output to the temp dir so tests never write log files into the repo.
  initLogger(join(baseDir, 'app'));
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const PLAIN_KEY = 'sk-proj-plaintext-secret-1234567890';

describe('SecureCredentialStoreImpl — 密文落盘（API Key 零暴露红线）', () => {
  it('set/get 往返返回明文', async () => {
    const store = new SecureCredentialStoreImpl(baseDir, new Base64Cipher());
    expect(await store.set('openai', PLAIN_KEY)).toBe(true);
    expect(await store.get('openai')).toBe(PLAIN_KEY);
  });

  it('落盘文件仅为密文：不含明文 Key、不含 sk- 形态子串，且为合法文件结构', async () => {
    const dir = join(baseDir, 'case-cipher-only');
    const store = new SecureCredentialStoreImpl(dir, new Base64Cipher());
    await store.set('openai', PLAIN_KEY);
    const fileText = readFileSync(join(dir, 'credentials.json'), 'utf8');
    expect(fileText).not.toContain(PLAIN_KEY);
    expect(fileText).not.toMatch(/sk-/i);
    const parsed = parseCredentialsFile(fileText);
    expect(parsed).not.toBeNull();
    expect(parsed?.data.providers['openai']).toBe(
      Buffer.from(PLAIN_KEY, 'utf8').toString('base64'),
    );
  });

  it('原子写：set 后无 .tmp 残留', async () => {
    const dir = join(baseDir, 'case-atomic');
    const store = new SecureCredentialStoreImpl(dir, new Base64Cipher());
    await store.set('openai', PLAIN_KEY);
    expect(existsSync(join(dir, 'credentials.json.tmp'))).toBe(false);
  });

  it('isAvailable 透传 cipher 后端', () => {
    expect(new SecureCredentialStoreImpl(baseDir, new Base64Cipher()).isAvailable()).toBe(true);
    expect(new SecureCredentialStoreImpl(baseDir, new UnavailableCipher()).isAvailable()).toBe(
      false,
    );
  });
});

describe('SecureCredentialStoreImpl — has/delete 语义', () => {
  it('has 反映存在性（不含密钥）；delete 后消失且幂等', async () => {
    const store = new SecureCredentialStoreImpl(
      join(baseDir, 'case-has-delete'),
      new Base64Cipher(),
    );
    expect(await store.has('openai')).toBe(false);
    await store.set('openai', PLAIN_KEY);
    expect(await store.has('openai')).toBe(true);
    expect(await store.delete('openai')).toBe(true);
    expect(await store.has('openai')).toBe(false);
    expect(await store.delete('openai')).toBe(true); // 幂等
  });
});

describe('SecureCredentialStoreImpl — 损坏容错（fail-closed）', () => {
  it('文件非 JSON → 视为空 + 可恢复写入', async () => {
    const dir = join(baseDir, 'case-corrupt');
    mkdirSync(dir, { recursive: true });
    const store = new SecureCredentialStoreImpl(dir, new Base64Cipher());
    writeFileSync(join(dir, 'credentials.json'), 'not json{{', 'utf8');
    expect(await store.get('openai')).toBeNull();
    expect(await store.has('openai')).toBe(false);
    expect(await store.set('openai', PLAIN_KEY)).toBe(true);
    expect(await store.get('openai')).toBe(PLAIN_KEY);
  });

  it('sk- 明文形态条目与非法值在加载时被丢弃（fail-closed）', async () => {
    const dir = join(baseDir, 'case-plain-entry');
    mkdirSync(dir, { recursive: true });
    const store = new SecureCredentialStoreImpl(dir, new Base64Cipher());
    const good = Buffer.from('ok-value', 'utf8').toString('base64');
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({
        version: 1,
        providers: {
          plain: 'sk-proj-plaintext-1234567890',
          junk: 'not base64 !!',
          good: good,
        },
      }),
      'utf8',
    );
    expect(await store.has('plain')).toBe(false);
    expect(await store.has('junk')).toBe(false);
    expect(await store.get('good')).toBe('ok-value');
  });

  it('解密失败 → get 返回 null（不抛异常）', async () => {
    const store = new SecureCredentialStoreImpl(
      join(baseDir, 'case-decrypt-fail'),
      new DecryptFailureCipher(),
    );
    await store.set('openai', PLAIN_KEY);
    expect(await store.get('openai')).toBeNull();
  });

  it('文件缺失 → get null（常规状态，无异常）', async () => {
    const store = new SecureCredentialStoreImpl(join(baseDir, 'case-missing'), new Base64Cipher());
    expect(await store.get('openai')).toBeNull();
  });
});

describe('SecureCredentialStoreImpl — 参数与不可用降级（§3.4/§10）', () => {
  it('空 providerId/apiKey → set 返回 false 不落盘', async () => {
    const dir = join(baseDir, 'case-bad-args');
    const store = new SecureCredentialStoreImpl(dir, new Base64Cipher());
    expect(await store.set('', PLAIN_KEY)).toBe(false);
    expect(await store.set('openai', '')).toBe(false);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('isAvailable=false → set 返回 false 不落盘，但仅内存 Key 本次运行可用（退出即弃）', async () => {
    const dir = join(baseDir, 'case-unavailable');
    const store = new SecureCredentialStoreImpl(dir, new UnavailableCipher());
    expect(await store.set('openai', PLAIN_KEY)).toBe(false);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
    expect(await store.get('openai')).toBe(PLAIN_KEY); // 仅内存降级
    expect(await store.has('openai')).toBe(true);
    await store.delete('openai');
    expect(await store.get('openai')).toBeNull();
  });

  it('cipher.encrypt 抛异常 → set 返回 false（fail-closed）', async () => {
    class ThrowCipher implements CipherBackend {
      isAvailable(): boolean {
        return true;
      }
      encrypt(): string {
        throw new Error('encrypt failed');
      }
      decrypt(): string {
        throw new Error('decrypt failed');
      }
    }
    const store = new SecureCredentialStoreImpl(
      join(baseDir, 'case-encrypt-throw'),
      new ThrowCipher(),
    );
    expect(await store.set('openai', PLAIN_KEY)).toBe(false);
  });
});

describe('纯文件格式函数（parse/serialize/isCiphertextShape）', () => {
  it('serialize/parse 往返', () => {
    const data = { version: 1 as const, providers: { a: 'QUJD', b: 'QUJD' } };
    const parsed = parseCredentialsFile(serializeCredentialsFile(data));
    expect(parsed).toEqual({ data, dropped: 0 });
  });

  it('整体不可解析（非 JSON/数组/version 不符）→ null', () => {
    expect(parseCredentialsFile('')).toBeNull();
    expect(parseCredentialsFile('[1,2]')).toBeNull();
    expect(parseCredentialsFile('{"version":2,"providers":{}}')).toBeNull();
    expect(parseCredentialsFile('{"version":1,"providers":[]}')).not.toBeNull(); // providers 非对象 → 视为空
    expect(parseCredentialsFile('{"version":1,"providers":[]}')?.data.providers).toEqual({});
  });

  it('非法条目丢弃计数（dropped）', () => {
    const parsed = parseCredentialsFile(
      '{"version":1,"providers":{"good":"QUJD","bad":"sk-proj-x","junk":"!!!","empty":""}}',
    );
    expect(parsed?.dropped).toBe(3);
    expect(parsed?.data.providers).toEqual({ good: 'QUJD' });
  });

  it('isCiphertextShape：base64 通过；sk- 明文形态 / 非法字符 / 空串拒绝', () => {
    expect(isCiphertextShape('QUJDREVG')).toBe(true);
    expect(isCiphertextShape('sk-proj-plaintext-1234567890')).toBe(false);
    expect(isCiphertextShape('not base64 !!')).toBe(false);
    expect(isCiphertextShape('')).toBe(false);
    expect(isCiphertextShape(42)).toBe(false);
  });
});
