import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileLocks } from '../src/agent/locks';
import { Poller, type PollerDeps } from '../src/agent/poller';
import { nullLogger } from '../src/agent/util';
import type { Job } from '../src/shared/contract';
import { job } from './helpers';

const T0 = Date.parse('2026-09-29T10:00:00.000Z');

interface Harness {
  poller: Poller;
  started: string[];
  expired: string[];
  finish: (id: string) => void;
  queue: Job[][];
  slotsAsked: number[];
  paused: { v: boolean };
  locks: ProfileLocks;
}

function harness(max = 2, over: Partial<PollerDeps> = {}): Harness {
  const started: string[] = [];
  const expired: string[] = [];
  const resolvers = new Map<string, () => void>();
  const queue: Job[][] = [];
  const slotsAsked: number[] = [];
  const paused = { v: false };
  const locks = new ProfileLocks();
  const poller = new Poller({
    fetchJobs: async (slots) => { slotsAsked.push(slots); return queue.shift() ?? []; },
    runJob: (j) => new Promise<void>((res) => { started.push(j.id); resolvers.set(j.id, res); }),
    reportExpired: async (j) => { expired.push(j.id); },
    isPaused: () => paused.v,
    maxConcurrent: () => max,
    intervalMs: () => 10_000,
    locks,
    logger: nullLogger,
    recheckMs: 1000,
    ...over,
  });
  return { poller, started, expired, queue, slotsAsked, paused, locks, finish: (id) => resolvers.get(id)?.() };
}

const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

describe('Poller', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits until scheduled_for before starting a job', async () => {
    const h = harness();
    h.queue.push([job({ id: 'a', scheduled_for: at(60_000), expires_at: at(600_000) })]);
    await h.poller.tick();
    expect(h.poller.waitingJobs.map((j) => j.id)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.started).toEqual(['a']);
  });

  it('asks only for free slots (max − running − waiting)', async () => {
    const h = harness(3);
    h.queue.push([job({ id: 'a', adspower_profile_id: 'p1' })]);
    await h.poller.tick();
    expect(h.slotsAsked).toEqual([3]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(['a']);
    h.queue.push([job({ id: 'b', adspower_profile_id: 'p2', scheduled_for: at(120_000) })]);
    await h.poller.tick();
    expect(h.slotsAsked).toEqual([3, 2]);
    await h.poller.tick();
    expect(h.slotsAsked).toEqual([3, 2, 1]);
  });

  it('does not poll when all slots are taken', async () => {
    const h = harness(1);
    h.queue.push([job({ id: 'a' })]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    await h.poller.tick();
    expect(h.slotsAsked).toEqual([1]);
  });

  it('never runs two jobs for the same AdsPower profile at once', async () => {
    const h = harness(3);
    h.queue.push([job({ id: 'a', adspower_profile_id: 'same' }), job({ id: 'b', adspower_profile_id: 'same' }), job({ id: 'c', adspower_profile_id: 'other' })]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started.sort()).toEqual(['a', 'c']);
    expect(h.locks.isLocked('same')).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.started).not.toContain('b');
    h.finish('a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.started).toContain('b');
  });

  it('respects a profile lock held by something else (e.g. a profile test)', async () => {
    const h = harness(2);
    h.locks.tryAcquire('p1', 'test');
    h.queue.push([job({ id: 'a', adspower_profile_id: 'p1' })]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.started).toEqual([]);
    h.locks.release('p1', 'test');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.started).toEqual(['a']);
  });

  it('reports expired when a job cannot start before expires_at', async () => {
    const h = harness(1);
    h.queue.push([
      job({ id: 'a', adspower_profile_id: 'p1' }),
      job({ id: 'b', adspower_profile_id: 'p1', expires_at: at(3_000) }),
    ]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.expired).toEqual(['b']);
    expect(h.poller.waitingJobs).toHaveLength(0);
  });

  it('reports expired immediately for jobs already past expires_at', async () => {
    const h = harness();
    h.queue.push([job({ id: 'old', scheduled_for: at(-600_000), expires_at: at(-1) })]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.expired).toEqual(['old']);
    expect(h.started).toEqual([]);
  });

  it('dedupes job ids across polls', async () => {
    const h = harness(3);
    const a = job({ id: 'a', adspower_profile_id: 'p1' });
    h.queue.push([a], [a]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    h.finish('a');
    await vi.advanceTimersByTimeAsync(0);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(['a']);
  });

  it('does not poll or start jobs while paused', async () => {
    const h = harness();
    h.queue.push([job({ id: 'a', scheduled_for: at(1_000) })]);
    await h.poller.tick();
    h.paused.v = true;
    await h.poller.tick();
    expect(h.slotsAsked).toEqual([2]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.started).toEqual([]);
    h.paused.v = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.started).toEqual(['a']);
  });

  it('polls on the brain-provided interval when started', async () => {
    const h = harness(2);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.slotsAsked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.slotsAsked).toHaveLength(2);
    h.poller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.slotsAsked).toHaveLength(2);
  });

  it('survives poll errors and reports them', async () => {
    const errors: unknown[] = [];
    const h = harness(2, { fetchJobs: async () => { throw new Error('offline'); }, onPollError: (e) => errors.push(e) });
    await h.poller.tick();
    expect(errors).toHaveLength(1);
  });

  it('cancelAll aborts running jobs', async () => {
    const signals: AbortSignal[] = [];
    const h = harness(2, { runJob: (_j, s) => { signals.push(s); return new Promise<void>(() => undefined); } });
    h.queue.push([job({ id: 'a' })]);
    await h.poller.tick();
    await vi.advanceTimersByTimeAsync(0);
    h.poller.cancelAll();
    expect(signals[0].aborted).toBe(true);
  });
});
