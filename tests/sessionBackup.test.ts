import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findUnknownAction, KNOWN_ACTIONS, runPlaybook, type ExecutorDeps } from '../src/agent/executor';
import { AgentRuntime, type AgentConfig } from '../src/agent/runtime';
import {
  BACKUPS_KEPT, decryptBackup, encryptBackup, SessionVault, type SessionBackup,
} from '../src/agent/sessionVault';
import type { BrainClient } from '../src/agent/brainClient';
import type { AdsPowerClient } from '../src/agent/profileManager';
import { AgentError, nullLogger } from '../src/agent/util';
import type { Job, Playbook, PlaybookStep } from '../src/shared/contract';
import { cookie, FakeDriver, job, MemorySessions, playbook, recordingSleep } from './helpers';

const KEY = Buffer.alloc(32, 7);
const fixedKey = async (): Promise<Buffer> => KEY;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sk-sessions-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const backup = (over: Partial<SessionBackup> = {}): SessionBackup => ({
  v: 1, saved_at: '2026-09-30T10:00:00.000Z', origin: 'https://site.test', cookies: [cookie('sid', 'secret-value')], local_storage: { token: 'abc' }, ...over,
});

async function run(j: Job, pb: Playbook, d: FakeDriver, over: Partial<ExecutorDeps> = {}) {
  const { sleep } = recordingSleep();
  try {
    return { out: await runPlaybook(j, pb, { driver: d, sleep, rng: () => 0, download: async () => ({ paths: [], cleanup: async () => undefined }), ...over }), err: null as AgentError | null };
  } catch (e) {
    return { out: null, err: e as AgentError };
  }
}

describe('session backup encryption', () => {
  it('round-trips with AES-256-GCM and never stores plaintext', () => {
    const enc = encryptBackup(backup(), KEY);
    expect(enc.includes(Buffer.from('secret-value'))).toBe(false);
    expect(decryptBackup(enc, KEY)).toEqual(backup());
  });

  it('rejects a wrong key and tampered data', () => {
    const enc = encryptBackup(backup(), KEY);
    expect(() => decryptBackup(enc, Buffer.alloc(32, 1))).toThrow();
    const bad = Buffer.from(enc); bad[bad.length - 1] ^= 0xff;
    expect(() => decryptBackup(bad, KEY)).toThrow();
    expect(() => decryptBackup(Buffer.from('nope'), KEY)).toThrow();
  });
});

describe('SessionVault (files on this PC)', () => {
  it('writes <profile>/<platform>-<timestamp>.bin and keeps the newest 4 per profile + platform', async () => {
    let t = Date.parse('2026-09-30T10:00:00.000Z');
    const vault = new SessionVault(root, fixedKey, () => new Date(t));
    for (let i = 0; i < 6; i++) {
      await vault.save('ads-1', 'instagram', backup({ cookies: [cookie('n', String(i))] }));
      t += 60_000;
    }
    await vault.save('ads-1', 'x', backup());
    const files = readdirSync(join(root, 'ads-1')).sort();
    const insta = files.filter((f) => f.startsWith('instagram-'));
    expect(insta).toHaveLength(BACKUPS_KEPT);
    expect(insta[0]).toBe('instagram-2026-09-30T10-02-00-000Z.bin');
    expect(files.filter((f) => f.startsWith('x-'))).toHaveLength(1);
    expect((await vault.loadLatest('ads-1', 'instagram'))?.cookies[0].value).toBe('5');
    expect(await vault.lastBackups('ads-1')).toEqual({ instagram: '2026-09-30T10:05:00.000Z', x: '2026-09-30T10:06:00.000Z' });
    expect(await vault.lastBackups('ads-none')).toEqual({});
  });

  it('never overwrites a backup taken in the same millisecond', async () => {
    const vault = new SessionVault(root, fixedKey, () => new Date('2026-09-30T10:00:00.000Z'));
    await vault.save('ads-1', 'instagram', backup());
    await vault.save('ads-1', 'instagram', backup());
    expect(readdirSync(join(root, 'ads-1'))).toHaveLength(2);
  });

  it('falls back to an older backup when the newest is damaged, null when none', async () => {
    let t = Date.parse('2026-09-30T10:00:00.000Z');
    const vault = new SessionVault(root, fixedKey, () => new Date(t));
    await vault.save('ads-1', 'tiktok', backup({ cookies: [cookie('a', 'old')] }));
    t += 1000;
    await vault.save('ads-1', 'tiktok', backup({ cookies: [cookie('a', 'new')] }));
    const newest = readdirSync(join(root, 'ads-1')).sort().at(-1) as string;
    writeFileSync(join(root, 'ads-1', newest), 'garbage');
    expect((await vault.loadLatest('ads-1', 'tiktok'))?.cookies[0].value).toBe('old');
    expect(await vault.loadLatest('ads-1', 'reddit')).toBeNull();
    expect(await vault.loadLatest('missing', 'tiktok')).toBeNull();
  });

  it('keeps path segments safe', async () => {
    const vault = new SessionVault(root, fixedKey);
    await vault.save('../evil', 'instagram', backup());
    expect(readdirSync(root)).toEqual(['___evil']);
  });
});

describe('executor — backup_session / restore_session', () => {
  it('backs up cookies + localStorage of the current origin, outputs the cookie count, stores encrypted', async () => {
    const d = new FakeDriver();
    d.currentUrl = 'https://site.test/home';
    d.cookieJar = [cookie('sid', 'secret-value'), cookie('csrf')];
    d.storage['https://site.test'] = { token: 'abc' };
    const vault = new SessionVault(root, fixedKey);
    const { out, err } = await run(job({ adspower_profile_id: 'ads-9', platform: 'linkedin' }),
      playbook([{ id: 'b', action: 'backup_session', as: 'saved' }]), d, { sessions: vault });
    expect(err).toBeNull();
    expect(out?.outputs).toEqual({ saved: 2 });
    const [file] = readdirSync(join(root, 'ads-9'));
    expect(file).toMatch(/^linkedin-.*\.bin$/);
    expect(readFileSync(join(root, 'ads-9', file)).includes(Buffer.from('secret-value'))).toBe(false);
    const b = await vault.loadLatest('ads-9', 'linkedin');
    expect(b?.origin).toBe('https://site.test');
    expect(b?.local_storage).toEqual({ token: 'abc' });
  });

  it('skips localStorage on a page without a web origin', async () => {
    const d = new FakeDriver();
    d.cookieJar = [cookie('sid')];
    const s = new MemorySessions();
    const { err } = await run(job(), playbook([{ id: 'b', action: 'backup_session' }]), d, { sessions: s });
    expect(err).toBeNull();
    expect(d.calls).not.toContain('getLocalStorage');
    expect((await s.loadLatest('ads-1', 'instagram'))?.origin).toBeNull();
  });

  it('restores the newest backup: cookies, navigates to the origin, sets localStorage', async () => {
    const s = new MemorySessions();
    await s.save('ads-1', 'instagram', backup({ cookies: [cookie('old')] }));
    await s.save('ads-1', 'instagram', backup({ cookies: [cookie('sid'), cookie('csrf')] }));
    const d = new FakeDriver();
    const { out, err } = await run(job(), playbook([{ id: 'r', action: 'restore_session', as: 'restored' }]), d, { sessions: s });
    expect(err).toBeNull();
    expect(out?.outputs).toEqual({ restored: 2 });
    expect(d.calls).toEqual(['addCookies 2', 'goto https://site.test', 'setLocalStorage https://site.test']);
    expect(d.storage['https://site.test']).toEqual({ token: 'abc' });
  });

  it('does not navigate when already on the origin', async () => {
    const s = new MemorySessions();
    await s.save('ads-1', 'instagram', backup());
    const d = new FakeDriver();
    d.currentUrl = 'https://site.test/feed';
    const { err } = await run(job(), playbook([{ id: 'r', action: 'restore_session' }]), d, { sessions: s });
    expect(err).toBeNull();
    expect(d.calls).toEqual(['addCookies 1', 'setLocalStorage https://site.test']);
  });

  it('fails with SESSION_EXPIRED without a backup unless optional', async () => {
    const d = new FakeDriver();
    const s = new MemorySessions();
    await s.save('ads-1', 'tiktok', backup()); // other platform does not count
    const failed = await run(job(), playbook([{ id: 'r', action: 'restore_session' }]), d, { sessions: s });
    expect(failed.err?.code).toBe('SESSION_EXPIRED');
    expect(failed.err?.stepId).toBe('r');
    const opt = await run(job(), playbook([{ id: 'r', action: 'restore_session', optional: true, as: 'n' }]), d, { sessions: s });
    expect(opt.err).toBeNull();
    expect(opt.out?.outputs).toEqual({ n: 0 });
    const tmpl = await run(job({ payload: { opt: true } }), playbook([{ id: 'r', action: 'restore_session', optional: '{{payload.opt}}' as unknown as boolean }]), d, { sessions: s });
    expect(tmpl.err).toBeNull();
  });

  it('backup → restore round trip through the encrypted vault', async () => {
    const vault = new SessionVault(root, fixedKey);
    const src = new FakeDriver();
    src.currentUrl = 'https://site.test/';
    src.cookieJar = [cookie('sid', 's1')];
    src.storage['https://site.test'] = { a: '1' };
    await run(job(), playbook([{ id: 'b', action: 'backup_session' }]), src, { sessions: vault });
    const dst = new FakeDriver();
    const { out } = await run(job(), playbook([{ id: 'r', action: 'restore_session', as: 'n' }]), dst, { sessions: vault });
    expect(out?.outputs.n).toBe(1);
    expect(dst.cookieJar).toEqual(src.cookieJar);
    expect(dst.storage['https://site.test']).toEqual({ a: '1' });
  });

  it('fails cleanly when no session store is wired', async () => {
    const { err } = await run(job(), playbook([{ id: 'b', action: 'backup_session' }]), new FakeDriver());
    expect(err?.code).toBe('INTERNAL');
    expect(err?.stepId).toBe('b');
  });

  it('never puts cookie values into outputs or logs', async () => {
    const d = new FakeDriver();
    d.cookieJar = [cookie('sid', 'secret-value')];
    const s = new MemorySessions();
    const { out } = await run(job(), playbook([{ id: 'b', action: 'backup_session', as: 'n' }, { id: 'r', action: 'restore_session', as: 'm' }]), d, { sessions: s });
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });
});

describe('known actions', () => {
  it('lists the session actions', () => {
    expect(KNOWN_ACTIONS.has('backup_session')).toBe(true);
    expect(KNOWN_ACTIONS.has('restore_session')).toBe(true);
  });

  it('refuses a playbook with an unknown (nested) action before touching the page', async () => {
    const steps = [{ id: 'g', action: 'goto', url: 'https://site.test' },
      { id: 'f', action: 'foreach', items: '{{payload.x}}', steps: [{ id: 'z', action: 'teleport' }] }] as unknown as PlaybookStep[];
    expect(findUnknownAction(steps)).toEqual({ id: 'z', action: 'teleport' });
    const d = new FakeDriver();
    const { err } = await run(job(), playbook(steps), d);
    expect(err?.code).toBe('UNKNOWN');
    expect(d.calls).toEqual([]);
  });
});

describe('runtime — Restore session (Profiles screen)', () => {
  const cfg: AgentConfig = {
    brain_url: 'https://brain.test', api_key: 'k', agent_id: 'a1', adspower_url: 'http://ads.test', adspower_api_key: '',
    paused: false, poll_interval_ms: 10_000, heartbeat_interval_ms: 60_000,
  };

  function make(sessions: MemorySessions) {
    const d = new FakeDriver();
    const adspower = { start: vi.fn(async () => ({ wsEndpoint: 'ws://x', debugPort: null })), stop: vi.fn(async () => undefined), status: vi.fn(async () => 'running') };
    const brain = { healthCheck: vi.fn(async () => ({ job_id: 'hc-1' })) };
    const rt = new AgentRuntime({
      config: { get: () => cfg, set: () => undefined }, version: '0', machineName: 'm', logger: nullLogger, sessions,
      factories: {
        brain: () => brain as unknown as BrainClient,
        adspower: () => adspower as unknown as AdsPowerClient,
        connect: async () => ({ driver: d, humanized: true, close: async () => undefined }),
        sleep: async () => undefined,
      },
    });
    return { rt, d, adspower, brain };
  }

  it('restores locally through AdsPower, stops the profile, then queues the login check', async () => {
    const s = new MemorySessions();
    await s.save('ads-1', 'instagram', backup());
    const { rt, d, adspower, brain } = make(s);
    const r = await rt.restoreProfileSession('ads-1', 'instagram', 42);
    expect(r).toEqual({ restored: 1, health_job_id: 'hc-1' });
    expect(d.calls[0]).toBe('addCookies 1');
    expect(adspower.stop).toHaveBeenCalledWith('ads-1');
    expect(brain.healthCheck).toHaveBeenCalledWith(42);
    expect(rt.snapshot().health_checks[0]).toMatchObject({ profile_id: 42, state: 'queued', job_id: 'hc-1' });
    expect(await rt.sessionBackups(['ads-1', 'ads-2'])).toEqual({ 'ads-1': { instagram: '2026-09-30T10:00:00.000Z' }, 'ads-2': {} });
  });

  it('reports SESSION_EXPIRED without a backup and queues no check', async () => {
    const { rt, adspower, brain } = make(new MemorySessions());
    const err = await rt.restoreProfileSession('ads-1', 'instagram', 42).catch((e: unknown) => e);
    expect((err as AgentError).code).toBe('SESSION_EXPIRED');
    expect(adspower.stop).toHaveBeenCalled();
    expect(brain.healthCheck).not.toHaveBeenCalled();
  });
});
