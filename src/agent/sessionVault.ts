/**
 * Session backups (blueprint §30 Protocol 5 — profile corruption recovery).
 *
 * A profile's cookies + localStorage are saved to an AES-256-GCM encrypted file ON THIS PC ONLY:
 *   <root>/<adspower_profile_id>/<platform>-<timestamp>.bin
 * Nothing here is ever sent to the brain or written to a log. Pure Node: the encryption key comes
 * from an injectable provider (Electron safeStorage in the app, a fixed key in tests).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PageDriver, SessionCookie } from './driver';
import { AgentError } from './util';

/** Newest backups kept per profile + platform. */
export const BACKUPS_KEPT = 4;

const MAGIC = Buffer.from('SKSB1');
const IV_LEN = 12;
const TAG_LEN = 16;

export interface SessionBackup {
  v: 1;
  saved_at: string;
  /** Origin the localStorage belongs to (null when the page had no web origin). */
  origin: string | null;
  cookies: SessionCookie[];
  local_storage: Record<string, string>;
}

/** Returns the 32-byte AES-256 key. */
export type KeyProvider = () => Promise<Buffer>;

export interface SessionStore {
  save(adsId: string, platform: string, backup: SessionBackup): Promise<void>;
  /** Newest backup that decrypts cleanly (older ones are tried if the newest is damaged), or null. */
  loadLatest(adsId: string, platform: string): Promise<SessionBackup | null>;
  /** platform → ISO time of the newest backup, for one profile. */
  lastBackups(adsId: string): Promise<Record<string, string>>;
}

export function encryptBackup(backup: SessionBackup, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(backup), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(data: Buffer, key: Buffer): SessionBackup {
  if (data.length < MAGIC.length + IV_LEN + TAG_LEN || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a session backup file');
  }
  let o = MAGIC.length;
  const iv = data.subarray(o, (o += IV_LEN));
  const tag = data.subarray(o, (o += TAG_LEN));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(data.subarray(o)), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(json) as SessionBackup;
  if (parsed?.v !== 1 || !Array.isArray(parsed.cookies)) throw new Error('Unsupported session backup');
  return parsed;
}

/** Keeps ids/platforms usable as path segments (no traversal). */
export function safeSegment(s: string): string {
  const clean = String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return clean || '_';
}

const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-');
const FILE_RE = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bin$/;
const unstamp = (s: string): string => s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4');

export class SessionVault implements SessionStore {
  constructor(private readonly root: string, private readonly key: KeyProvider, private readonly now: () => Date = () => new Date()) {}

  private dir(adsId: string): string { return join(this.root, safeSegment(adsId)); }

  /** Backup files of one platform, newest first. */
  private async files(adsId: string, platform: string): Promise<string[]> {
    const p = safeSegment(platform);
    let names: string[];
    try { names = await readdir(this.dir(adsId)); } catch { return []; }
    return names.filter((n) => FILE_RE.exec(n)?.[1] === p).sort().reverse();
  }

  async save(adsId: string, platform: string, backup: SessionBackup): Promise<void> {
    const key = await this.key();
    const dir = this.dir(adsId);
    await mkdir(dir, { recursive: true });
    let t = this.now();
    let file = join(dir, `${safeSegment(platform)}-${stamp(t)}.bin`);
    // never overwrite a backup taken in the same millisecond
    const existing = new Set(await this.files(adsId, platform));
    while (existing.has(file.slice(dir.length + 1))) { t = new Date(t.getTime() + 1); file = join(dir, `${safeSegment(platform)}-${stamp(t)}.bin`); }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, encryptBackup(backup, key), { mode: 0o600 });
    await rename(tmp, file);
    const all = await this.files(adsId, platform);
    for (const old of all.slice(BACKUPS_KEPT)) await unlink(join(dir, old)).catch(() => undefined);
  }

  async loadLatest(adsId: string, platform: string): Promise<SessionBackup | null> {
    const names = await this.files(adsId, platform);
    if (names.length === 0) return null;
    const key = await this.key();
    for (const n of names) {
      try { return decryptBackup(await readFile(join(this.dir(adsId), n)), key); } catch { /* damaged — try the next older one */ }
    }
    return null;
  }

  async lastBackups(adsId: string): Promise<Record<string, string>> {
    let names: string[];
    try { names = await readdir(this.dir(adsId)); } catch { return {}; }
    const out: Record<string, string> = {};
    for (const n of names.sort()) {
      const m = FILE_RE.exec(n);
      if (m) out[m[1]] = unstamp(m[2]);
    }
    return out;
  }
}

/** Current page origin, or null for about:blank / data: / file: pages. */
export function webOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Reads cookies + localStorage from the connected profile and stores them encrypted. Returns cookies saved. */
export async function backupSession(driver: PageDriver, store: SessionStore, adsId: string, platform: string, now: () => Date = () => new Date()): Promise<number> {
  const cookies = await driver.getCookies();
  const origin = webOrigin(driver.url());
  const local_storage = origin ? await driver.getLocalStorage() : {};
  await store.save(adsId, platform, { v: 1, saved_at: now().toISOString(), origin, cookies, local_storage });
  return cookies.length;
}

/**
 * Restores the newest backup into the connected profile. Returns cookies restored, or null when
 * this PC holds no usable backup. `navigate` is used to reach the backup's origin for localStorage.
 */
export async function restoreSession(
  driver: PageDriver, store: SessionStore, adsId: string, platform: string, navigate: (url: string) => Promise<void>,
): Promise<number | null> {
  const b = await store.loadLatest(adsId, platform);
  if (!b) return null;
  if (b.cookies.length > 0) await driver.addCookies(b.cookies);
  if (b.origin && Object.keys(b.local_storage ?? {}).length > 0) {
    if (webOrigin(driver.url()) !== b.origin) await navigate(b.origin);
    await driver.setLocalStorage(b.local_storage);
  }
  return b.cookies.length;
}

export function noBackupError(stepId?: string): AgentError {
  return new AgentError('SESSION_EXPIRED', 'No saved session for this profile on this computer', stepId);
}
