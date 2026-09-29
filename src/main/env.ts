import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keys the pre-filled per-user .env may contain (CLAUDE.md "electron/.env"). */
export interface SeedEnv {
  BRAIN_URL?: string;
  API_KEY?: string;
  USER_ID?: string;
  POLL_INTERVAL_MS?: string;
  HEARTBEAT_INTERVAL_MS?: string;
  ADSPOWER_URL?: string;
  ADSPOWER_API_KEY?: string;
}

/** Returns the first .env found in the given directories, parsed (never logged). */
export function readSeedEnv(dirs: string[]): { path: string; env: SeedEnv } | null {
  for (const dir of dirs) {
    const p = join(dir, '.env');
    if (existsSync(p)) {
      try {
        return { path: p, env: parse(readFileSync(p)) as SeedEnv };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function toPositiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
