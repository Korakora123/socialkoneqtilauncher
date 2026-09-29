import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { BrainClient, BrainError } from '../src/agent/brainClient';
import { AdsPowerClient } from '../src/agent/profileManager';
import { AgentError } from '../src/agent/util';

type Handler = (cfg: InternalAxiosRequestConfig) => { status?: number; data: unknown } | Error;

function http(handler: Handler, baseURL = 'http://x.test') {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (cfg) => {
    seen.push(cfg);
    const r = handler(cfg);
    if (r instanceof Error) throw r;
    const response = { data: r.data, status: r.status ?? 200, statusText: '', headers: {}, config: cfg };
    if (response.status >= 400) throw new AxiosError('fail', 'ERR_BAD_RESPONSE', cfg, null, response);
    return response;
  };
  return { instance: axios.create({ baseURL, adapter, headers: { Authorization: 'Bearer sk_live_test' } }), seen };
}

describe('AdsPowerClient', () => {
  it('returns the puppeteer ws endpoint on start', async () => {
    const { instance, seen } = http(() => ({ data: { code: 0, data: { ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/x' }, debug_port: '9222' } } }));
    const c = new AdsPowerClient({ baseUrl: 'http://x.test', minGapMs: 0, http: instance });
    await expect(c.start('abc')).resolves.toEqual({ wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x', debugPort: '9222' });
    expect(seen[0].url).toBe('/api/v1/browser/start');
    expect(seen[0].params).toEqual({ user_id: 'abc' });
  });

  it('maps code !== 0 to ADSPOWER_ERROR', async () => {
    const { instance } = http(() => ({ data: { code: -1, msg: 'Profile does not exist' } }));
    const c = new AdsPowerClient({ baseUrl: 'http://x.test', minGapMs: 0, http: instance });
    const err = await c.start('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('ADSPOWER_ERROR');
  });

  it('pages through the profile list', async () => {
    const { instance } = http((cfg) => {
      const page = (cfg.params as { page: number }).page;
      const list = page === 1 ? [{ user_id: 'a', name: 'A' }, { user_id: 'b', name: 'B' }] : [{ user_id: 'c', name: 'C', group_name: 'G' }];
      return { data: { code: 0, data: { list } } };
    });
    const c = new AdsPowerClient({ baseUrl: 'http://x.test', minGapMs: 0, http: instance });
    const res = await c.listProfiles(2);
    expect(res.map((p) => p.user_id)).toEqual(['a', 'b', 'c']);
    expect(res[2].group_name).toBe('G');
  });

  it('status: running / not_found', async () => {
    const ok = new AdsPowerClient({ baseUrl: 'http://x.test', minGapMs: 0, http: http(() => ({ data: { code: 0 } })).instance });
    expect(await ok.status()).toBe('running');
    const down = new AdsPowerClient({ baseUrl: 'http://x.test', minGapMs: 0, http: http(() => new AxiosError('refused', 'ECONNREFUSED')).instance });
    expect(await down.status()).toBe('not_found');
  });
});

describe('BrainClient', () => {
  it('calls the contract endpoints with typed params', async () => {
    const { instance, seen } = http((cfg) => {
      if (cfg.url === '/agent/jobs') return { data: { jobs: [{ id: 'j1' }] } };
      return { data: { ok: true } };
    });
    const b = new BrainClient({ baseUrl: 'http://x.test', apiKey: 'k', version: '0.1.0', http: instance });
    const res = await b.jobs('agent-1', 2);
    expect(res.jobs).toHaveLength(1);
    expect(seen[0].params).toEqual({ agent_id: 'agent-1', slots: 2 });
    await b.playbook('instagram_post');
    expect(seen[1].url).toBe('/agent/playbook/instagram_post');
    await b.profileHealth({ profile_id: 3, healthy: true });
    expect(seen[2].url).toBe('/agent/profiles/health');
    expect(seen[2].method).toBe('post');
  });

  it('turns error responses into BrainError with code', async () => {
    const { instance } = http(() => ({ status: 401, data: { error: 'Invalid key', code: 'UNAUTHORIZED' } }));
    const b = new BrainClient({ baseUrl: 'http://x.test', apiKey: 'k', version: '0.1.0', http: instance });
    const err = await b.validateKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect((err as BrainError).isAuth).toBe(true);
    expect((err as BrainError).message).toBe('Invalid key');
  });

  it('marks network failures', async () => {
    const { instance } = http(() => new AxiosError('down', 'ECONNREFUSED'));
    const b = new BrainClient({ baseUrl: 'http://x.test', apiKey: 'k', version: '0.1.0', http: instance });
    const err = (await b.health().catch((e: unknown) => e)) as BrainError;
    expect(err.network).toBe(true);
    expect(err.status).toBeNull();
  });
});
