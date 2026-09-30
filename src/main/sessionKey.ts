/**
 * AES-256 key for local session backups, protected by the OS (Electron safeStorage → DPAPI on
 * Windows). The key file holds only the safeStorage-encrypted key; it never leaves this PC.
 */
import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KeyProvider } from '../agent/sessionVault';

export function safeStorageKey(keyFile: string): KeyProvider {
  let cached: Promise<Buffer> | null = null;
  const load = async (): Promise<Buffer> => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available for session backups');
    try {
      const key = Buffer.from(safeStorage.decryptString(await readFile(keyFile)), 'base64');
      if (key.length === 32) return key;
    } catch { /* missing or unreadable — create a new key (older backups become unreadable) */ }
    const key = randomBytes(32);
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
    return key;
  };
  return () => {
    cached ??= load().catch((e: unknown) => { cached = null; throw e; });
    return cached;
  };
}
