import type { Job } from '../shared/contract';
import { ProfileLocks } from './locks';
import { AgentError, errorMessage, type Logger } from './util';

export interface PollerDeps {
  /** Lease up to `slots` jobs from the brain (GET /agent/jobs). */
  fetchJobs(slots: number): Promise<Job[]>;
  /** Execute + report one job. Must not throw. */
  runJob(job: Job, signal: AbortSignal): Promise<void>;
  /** Report a job whose expires_at passed before it could start. */
  reportExpired(job: Job): Promise<void>;
  isPaused(): boolean;
  maxConcurrent(): number;
  intervalMs(): number;
  locks: ProfileLocks;
  logger: Logger;
  now?: () => number;
  onChange?: () => void;
  onPollError?: (err: unknown) => void;
  onPollOk?: () => void;
  /** How often a due job that is blocked (paused / profile busy / no free slot) is re-checked. */
  recheckMs?: number;
}

interface Waiting { job: Job; timer: ReturnType<typeof setTimeout> }
interface Running { job: Job; ctrl: AbortController }

const MAX_TIMER_MS = 2_147_000_000;
const SEEN_LIMIT = 1000;

/**
 * Polls the brain for leased jobs and runs each one at its scheduled_for time.
 * - requests only as many jobs as there are free slots (max_concurrent_jobs − running − waiting)
 * - never runs two jobs on the same AdsPower profile at once
 * - dedupes job ids, reports 'expired' when a job can no longer start in time
 * - while paused (locally or by the brain) no jobs are leased and none are started
 */
export class Poller {
  private readonly waiting = new Map<string, Waiting>();
  private readonly running = new Map<string, Running>();
  private readonly seen = new Set<string>();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private active = false;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get runningJobs(): Job[] { return [...this.running.values()].map((r) => r.job); }
  get waitingJobs(): Job[] { return [...this.waiting.values()].map((w) => w.job); }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.loop();
  }

  /** Stops polling and clears scheduled timers. Running jobs continue unless cancelAll() is called. */
  stop(): void {
    this.active = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.ctrl.abort(new AgentError('CANCELLED', 'Agent shutting down'));
  }

  private async loop(): Promise<void> {
    if (!this.active) return;
    await this.tick();
    if (!this.active) return;
    this.loopTimer = setTimeout(() => void this.loop(), Math.max(1000, this.deps.intervalMs()));
  }

  /** One polling round. Public for tests and "Refresh". */
  async tick(): Promise<void> {
    if (this.polling || this.deps.isPaused()) return;
    const slots = this.deps.maxConcurrent() - this.running.size - this.waiting.size;
    if (slots <= 0) return;
    this.polling = true;
    try {
      const jobs = await this.deps.fetchJobs(slots);
      this.deps.onPollOk?.();
      for (const job of jobs) this.accept(job);
    } catch (e) {
      this.deps.logger.warn('poll failed', { reason: e instanceof Error ? e.name : 'unknown' });
      this.deps.onPollError?.(e);
    } finally {
      this.polling = false;
    }
  }

  private accept(job: Job): void {
    if (!job || typeof job.id !== 'string') return;
    if (this.seen.has(job.id) || this.waiting.has(job.id) || this.running.has(job.id)) return;
    this.seen.add(job.id);
    if (this.seen.size > SEEN_LIMIT) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    this.deps.logger.info('job leased', { job_id: job.id, type: job.type });
    const due = Date.parse(job.scheduled_for);
    const delay = Number.isFinite(due) ? Math.min(MAX_TIMER_MS, Math.max(0, due - this.now())) : 0;
    this.arm(job, delay);
    this.deps.onChange?.();
  }

  private arm(job: Job, delay: number): void {
    const timer = setTimeout(() => this.fire(job.id), delay);
    this.waiting.set(job.id, { job, timer });
  }

  private fire(id: string): void {
    const w = this.waiting.get(id);
    if (!w) return;
    const { job } = w;
    const expires = Date.parse(job.expires_at);
    if (Number.isFinite(expires) && this.now() > expires) {
      this.waiting.delete(id);
      this.deps.logger.info('job expired before start', { job_id: job.id, type: job.type });
      void this.deps.reportExpired(job).catch((e: unknown) => this.deps.logger.warn('report expired failed', { job_id: id, reason: errorMessage(e).slice(0, 80) }));
      this.deps.onChange?.();
      return;
    }
    const blocked = this.deps.isPaused()
      || this.running.size >= this.deps.maxConcurrent()
      || !this.deps.locks.tryAcquire(job.adspower_profile_id, job.id);
    if (blocked) {
      this.arm(job, this.deps.recheckMs ?? 5000);
      return;
    }
    this.waiting.delete(id);
    const ctrl = new AbortController();
    this.running.set(id, { job, ctrl });
    this.deps.onChange?.();
    void this.deps.runJob(job, ctrl.signal)
      .catch((e: unknown) => this.deps.logger.error('job runner crashed', { job_id: id, reason: errorMessage(e).slice(0, 80) }))
      .finally(() => {
        this.deps.locks.release(job.adspower_profile_id, job.id);
        this.running.delete(id);
        this.deps.onChange?.();
      });
  }
}
