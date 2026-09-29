import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import { dirname } from 'node:path';
import type { AgentConfig, ConfigStore } from '../agent/runtime';
import { readSeedEnv, toPositiveInt } from './env';

export const DEFAULT_BRAIN_URL = 'https://social.koneqti.com/api/gateway';
export const DEFAULT_ADSPOWER_URL = 'http://localhost:50325';
export const DASHBOARD_URL = 'https://social.koneqti.com/dashboard';

interface StoreShape {
  brain_url: string;
  api_key_enc: string;        // safeStorage-encrypted (base64) when available
  api_key_plain: string;      // fallback when OS encryption is unavailable
  adspower_api_key_enc: string;
  adspower_api_key_plain: string;
  agent_id: string | null;
  user_id: string | null;
  adspower_url: string;
  paused: boolean;
  auto_start: boolean;
  poll_interval_ms: number;
  heartbeat_interval_ms: number;
  env_seeded: boolean;
}

const store = new Store<StoreShape>({
  name: 'settings',
  defaults: {
    brain_url: DEFAULT_BRAIN_URL,
    api_key_enc: '',
    api_key_plain: '',
    adspower_api_key_enc: '',
    adspower_api_key_plain: '',
    agent_id: null,
    user_id: null,
    adspower_url: DEFAULT_ADSPOWER_URL,
    paused: false,
    auto_start: true,
    poll_interval_ms: 10_000,
    heartbeat_interval_ms: 60_000,
    env_seeded: false,
  },
});

function writeSecret(kind: 'api_key' | 'adspower_api_key', value: string): void {
  if (value && safeStorage.isEncryptionAvailable()) {
    store.set(`${kind}_enc`, safeStorage.encryptString(value).toString('base64'));
    store.set(`${kind}_plain`, '');
  } else {
    store.set(`${kind}_enc`, '');
    store.set(`${kind}_plain`, value);
  }
}

function readSecret(kind: 'api_key' | 'adspower_api_key'): string {
  const enc = store.get(`${kind}_enc`);
  if (enc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
  }
  return store.get(`${kind}_plain`);
}

/** Seeds settings from a pre-filled .env next to the .exe or in userData (first run only). */
export function seedFromEnv(): string | null {
  const dirs = [dirname(app.getPath('exe')), app.getPath('userData')];
  if (!app.isPackaged) dirs.unshift(process.cwd());
  const found = readSeedEnv(dirs);
  if (!found) return null;
  const e = found.env;
  const firstRun = !store.get('env_seeded');
  if (firstRun) {
    if (e.BRAIN_URL) store.set('brain_url', e.BRAIN_URL.trim());
    if (e.ADSPOWER_URL) store.set('adspower_url', e.ADSPOWER_URL.trim());
    if (e.USER_ID) store.set('user_id', e.USER_ID.trim());
    store.set('poll_interval_ms', toPositiveInt(e.POLL_INTERVAL_MS, 10_000));
    store.set('heartbeat_interval_ms', toPositiveInt(e.HEARTBEAT_INTERVAL_MS, 60_000));
    if (e.ADSPOWER_API_KEY) writeSecret('adspower_api_key', e.ADSPOWER_API_KEY.trim());
    store.set('env_seeded', true);
  }
  if (e.API_KEY && (firstRun || !readSecret('api_key'))) writeSecret('api_key', e.API_KEY.trim());
  return found.path;
}

export const configStore: ConfigStore & {
  autoStart(): boolean;
  setAutoStart(v: boolean): void;
  setSecrets(p: { api_key?: string; adspower_api_key?: string }): void;
} = {
  get(): AgentConfig {
    return {
      brain_url: store.get('brain_url') || DEFAULT_BRAIN_URL,
      api_key: readSecret('api_key'),
      agent_id: store.get('agent_id'),
      adspower_url: store.get('adspower_url') || DEFAULT_ADSPOWER_URL,
      adspower_api_key: readSecret('adspower_api_key'),
      paused: store.get('paused'),
      poll_interval_ms: store.get('poll_interval_ms'),
      heartbeat_interval_ms: store.get('heartbeat_interval_ms'),
    };
  },
  set(patch: Partial<AgentConfig>): void {
    if (patch.brain_url !== undefined) store.set('brain_url', patch.brain_url);
    if (patch.agent_id !== undefined) store.set('agent_id', patch.agent_id);
    if (patch.adspower_url !== undefined) store.set('adspower_url', patch.adspower_url);
    if (patch.paused !== undefined) store.set('paused', patch.paused);
    if (patch.poll_interval_ms !== undefined) store.set('poll_interval_ms', patch.poll_interval_ms);
    if (patch.heartbeat_interval_ms !== undefined) store.set('heartbeat_interval_ms', patch.heartbeat_interval_ms);
    if (patch.api_key !== undefined) writeSecret('api_key', patch.api_key);
    if (patch.adspower_api_key !== undefined) writeSecret('adspower_api_key', patch.adspower_api_key);
  },
  autoStart: () => store.get('auto_start'),
  setAutoStart: (v: boolean) => store.set('auto_start', v),
  setSecrets(p) {
    if (p.api_key !== undefined) writeSecret('api_key', p.api_key);
    if (p.adspower_api_key !== undefined) writeSecret('adspower_api_key', p.adspower_api_key);
  },
};

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return '••••••••';
  return `${key.slice(0, 8)}••••••••${key.slice(-4)}`;
}
