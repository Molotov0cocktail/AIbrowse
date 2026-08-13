// Thin Electron glue: safeStorage (Windows DPAPI) → CipherBackend.
// Contract source: doc/stage2/detailed-design.md §3.4/§10 (Q2: replaceable backend seam).
// Real runtime encryption behavior is exercised by the smoke matrix from S3/S4 (§13.2
// scenario 10); the store logic itself is unit-tested with an injected cipher.
import { safeStorage } from 'electron';
import type { CipherBackend } from './credential-store';

export class SafeStorageCipher implements CipherBackend {
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  encrypt(plaintext: string): string {
    return safeStorage.encryptString(plaintext).toString('base64');
  }

  decrypt(ciphertext: string): string {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }
}
