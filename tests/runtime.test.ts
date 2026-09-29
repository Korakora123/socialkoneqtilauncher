import { describe, expect, it, vi } from 'vitest';
import type { BrainClient } from '../src/agent/brainClient';
import type { AdsPowerClient } from '../src/agent/profileManager';
import { AgentRuntime, type AgentConfig } from '../src/agent/runtime';
import { nullLogger } from '../src/agent/util';
import type { Job } from '../src/shared/contract';
import { FakeDriver, job, playbook } from './helpers';

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function makeRuntime(opts: { jobs?: Job[][]; active?: boolean[] } = {}) {
  let cfg: AgentConfig = {
    brain_url: 'https://brain.test/api/gateway', api_key: 'sk_live_test', agent_id: null,
    adspower_url: 'http://localhost:50325', adspower_api_key: '', paused: false,
    poll_interval_ms: 10_000, heartbeat_interval_ms: 60_000,
  };
  const queue = opts.jobs ?? [];
  const active = opts.active ?? [];
  const brain = {
    register: vi.fn(async () => ({ agent_id: 'agent-1', user: { name: 'U', plan: 'pro', agency_name: 'A' }, config: { poll_interval_ms: 10_000, heartbeat_interval_ms: 60_000, max_concurrent_jobs: 2 } })),
    heartbeat: vi.fn(async () => ({ ok: true, paused_by_brain: false, latest_version: null })),
    jobs: vi.fn(async () => ({ jobs: queue.shift() ?? [] })),
    playbook: vi.fn(async () => playbook([{ id: 'u', action: 'extract_url', as: 'url' }])),
    progress: vi.fn(async () => ({ ok: true, cancel: false })),
    result: vi.fn(async () => ({ ok: true })),
    healthCheck: vi.fn(async () => ({ job_id: 'hc-1' })),
    profileHealth: vi.fn(async () => ({})),
  };
  const adspower = {
    status: vi.fn(async () => 'running' as const),
    start: vi.fn(async () => ({ wsEndpoint: 'ws://x', debugPort: null })),
    stop: vi.fn(async () => undefined),
    isActive: vi.fn(async () => active.shift() ?? false),
  };
  const driver = new FakeDriver();
  driver.values = { body: '{"ip":"1.2.3.4"}' };
  driver.present = new Set(['body']);
  const rt = new AgentRuntime({
    config: { get: () => cfg, set: (p) => { cfg = { ...cfg, ...p }; } },
    version: '0.1.0', machineName: 'pc', logger: nullLogger,
    factories: {
      brain: () => brain as unknown as BrainClient,
      adspower: () => adspower as unknown as AdsPowerClient,
      connect: async () => ({ driver, humanized: true, close: async () => undefined }),
      sleep: async () => undefined,
    },
  });
  return { rt, brain, adspower };
}

describe('runtime — profile login checks', () => {
  it('Test = open profile + IP check, then queue the brain health-check job and follow it to done', async () => {
    const hcJob = job({ id: 'hc-1', type: 'instagram_health_check', adspower_profile_id: 'ads-9' });
    const { rt, brain, adspower } = makeRuntime({ jobs: [[], [hcJob]] });
    await rt.start();
    const res = await rt.testProfile('ads-9', 42);
    expect(res).toMatchObject({ opened: true, ip: '1.2.3.4', health_job_id: 'hc-1' });
    expect(adspower.start).toHaveBeenCalledWith('ads-9');
    expect(adspower.stop).toHaveBeenCalledWith('ads-9');
    expect(brain.healthCheck).toHaveBeenCalledWith(42);
    expect(brain.profileHealth).not.toHaveBeenCalled();
    // queueHealthCheck triggers a poll that leases the health-check job
    await until(() => rt.snapshot().health_checks[0]?.state === 'done');
    expect(rt.snapshot().health_checks[0]).toMatchObject({ profile_id: 42, job_id: 'hc-1', result: 'success' });
    expect(brain.result).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'hc-1', status: 'success' }));
    rt.stop(true);
  });

  it('reports unhealthy directly when the profile cannot open', async () => {
    const { rt, brain, adspower } = makeRuntime();
    adspower.start.mockRejectedValueOnce(new Error('boom'));
    const res = await rt.testProfile('ads-1', 7);
    expect(res.opened).toBe(false);
    expect(brain.profileHealth).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 7, healthy: false }));
    expect(brain.healthCheck).not.toHaveBeenCalled();
  });

  it('Re-login watches the profile and queues a check once the user closes it', async () => {
    const { rt, brain } = makeRuntime({ active: [true, true, false] });
    await rt.openProfile('ads-2', 5, 5);
    expect(rt.snapshot().health_checks[0].state).toBe('waiting_login');
    await until(() => brain.healthCheck.mock.calls.length > 0);
    expect(brain.healthCheck).toHaveBeenCalledWith(5);
    await until(() => rt.snapshot().health_checks[0].state === 'queued');
    rt.stop(true);
  });
});
