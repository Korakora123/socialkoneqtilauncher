import { describe, expect, it, vi } from 'vitest';
import { executeJob, type JobRunnerDeps } from '../src/agent/jobRunner';
import { nullLogger } from '../src/agent/util';
import type { Playbook } from '../src/shared/contract';
import { FakeDriver, job, playbook } from './helpers';

/** Sleep that yields a macrotask so pending progress responses resolve in between steps. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const yieldingSleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
  await tick();
  if (signal?.aborted) throw signal.reason;
};

function setup(pb: Playbook, cancelAt: number | null) {
  const d = new FakeDriver();
  d.present = new Set(['#a', '#b', '#c', '#d']);
  const progress: number[] = [];
  const adspower = { start: vi.fn(async () => ({ wsEndpoint: 'ws://x', debugPort: null })), stop: vi.fn(async () => undefined) };
  const deps: JobRunnerDeps = {
    agentId: () => 'agent-1',
    fetchPlaybook: vi.fn(async () => pb),
    adspower,
    connect: async () => ({ driver: d, humanized: true, close: async () => undefined }),
    download: async () => ({ paths: [], cleanup: async () => undefined }),
    sleep: yieldingSleep,
    logger: nullLogger,
    reportProgress: async (_j, i) => { progress.push(i); return cancelAt !== null && i === cancelAt; },
  };
  return { d, deps, adspower, progress };
}

const fourClicks = playbook([
  { id: 's1', action: 'click', selector: '#a' },
  { id: 's2', action: 'click', selector: '#b' },
  { id: 's3', action: 'click', selector: '#c' },
  { id: 's4', action: 'click', selector: '#d' },
]);

describe('brain cancel channel (POST /agent/progress → cancel)', () => {
  it('sends a step-0 progress call before starting and never opens the profile when cancelled', async () => {
    const { deps, adspower, progress } = setup(fourClicks, 0);
    const res = await executeJob(job(), deps);
    expect(progress).toEqual([0]);
    expect(res.status).toBe('cancelled');
    expect(res.error?.code).toBe('CANCELLED');
    expect(adspower.start).not.toHaveBeenCalled();
    expect(deps.fetchPlaybook).not.toHaveBeenCalled();
  });

  it('aborts a running job when a progress response says cancel, and still stops the profile', async () => {
    const { d, deps, adspower, progress } = setup(fourClicks, 2);
    const res = await executeJob(job(), deps);
    expect(progress[0]).toBe(0);
    expect(res.status).toBe('cancelled');
    expect(res.error?.code).toBe('CANCELLED');
    expect(d.calls).toEqual(['click #a', 'click #b']);
    expect(adspower.stop).toHaveBeenCalledWith('ads-1');
  });

  it('runs to completion when the brain never cancels, and progress errors never block', async () => {
    const { d, deps } = setup(fourClicks, null);
    deps.reportProgress = async (_j, i) => { if (i === 1) throw new Error('offline'); return false; };
    const res = await executeJob(job(), deps);
    expect(res.status).toBe('success');
    expect(d.calls).toHaveLength(4);
  });
});
