import axios, { type AxiosInstance } from 'axios';
import type { AdsPowerStatus } from '../shared/contract';
import type { AdsPowerProfile } from '../shared/ipc';
import { AgentError } from './util';

/**
 * AdsPower Local API wrapper (default http://localhost:50325).
 * AdsPower answers `{ code: 0, msg, data }`; any other code is an ADSPOWER_ERROR.
 * AdsPower rate-limits its local API (~1 request/second), so calls are serialised.
 */
export interface AdsPowerOptions {
  baseUrl: string;
  apiKey?: string;            // only when "Local API security" is enabled in AdsPower
  minGapMs?: number;          // spacing between requests (AdsPower rate limit)
  http?: AxiosInstance;
}

interface AdsResponse<T> { code: number; msg?: string; data?: T }

export interface StartedProfile { wsEndpoint: string; debugPort: string | null }

export class AdsPowerClient {
  private readonly http: AxiosInstance;
  private readonly minGapMs: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(opts: AdsPowerOptions) {
    this.minGapMs = opts.minGapMs ?? 1100;
    this.http = opts.http ?? axios.create({
      baseURL: opts.baseUrl.replace(/\/+$/, ''),
      timeout: 60_000,
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
    });
  }

  /** Serialise requests and respect the AdsPower rate limit. */
  private call<T>(path: string, params?: Record<string, unknown>): Promise<AdsResponse<T>> {
    const run = async (): Promise<AdsResponse<T>> => {
      const wait = this.lastAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const res = await this.http.get<AdsResponse<T>>(path, { params });
        return res.data;
      } finally {
        this.lastAt = Date.now();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async ok<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    let res: AdsResponse<T>;
    try {
      res = await this.call<T>(path, params);
    } catch (e) {
      throw new AgentError('ADSPOWER_ERROR', `AdsPower not reachable: ${axios.isAxiosError(e) ? (e.code ?? e.message) : String(e)}`);
    }
    if (!res || res.code !== 0) throw new AgentError('ADSPOWER_ERROR', `AdsPower: ${res?.msg ?? 'unknown error'}`);
    return res.data as T;
  }

  async status(): Promise<AdsPowerStatus> {
    try {
      const res = await this.call<unknown>('/status');
      return res && res.code === 0 ? 'running' : 'error';
    } catch (e) {
      if (axios.isAxiosError(e) && !e.response) return 'not_found';
      return 'error';
    }
  }

  async listProfiles(pageSize = 100, maxPages = 50): Promise<AdsPowerProfile[]> {
    const out: AdsPowerProfile[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.ok<{ list?: Array<Record<string, unknown>> }>('/api/v1/user/list', { page, page_size: pageSize });
      const list = Array.isArray(data?.list) ? data.list : [];
      for (const p of list) {
        const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
        out.push({
          user_id: String(p.user_id ?? ''),
          name: str(p.name) ?? '',
          serial_number: str(p.serial_number),
          group_name: str(p.group_name),
          ip: str(p.ip),
        });
      }
      if (list.length < pageSize) break;
    }
    return out.filter((p) => p.user_id.length > 0);
  }

  async start(profileId: string): Promise<StartedProfile> {
    const data = await this.ok<{ ws?: { puppeteer?: string }; debug_port?: string | number }>(
      '/api/v1/browser/start', { user_id: profileId },
    );
    const ws = data?.ws?.puppeteer;
    if (!ws) throw new AgentError('ADSPOWER_ERROR', 'AdsPower did not return a browser endpoint');
    return { wsEndpoint: ws, debugPort: data.debug_port !== undefined ? String(data.debug_port) : null };
  }

  async stop(profileId: string): Promise<void> {
    await this.ok<unknown>('/api/v1/browser/stop', { user_id: profileId });
  }

  async isActive(profileId: string): Promise<boolean> {
    const data = await this.ok<{ status?: string }>('/api/v1/browser/active', { user_id: profileId });
    return data?.status === 'Active';
  }
}
