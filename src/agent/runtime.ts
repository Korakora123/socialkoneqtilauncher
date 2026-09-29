/**
 * Agent runtime: register → heartbeat → poller → executor → report.
 * Pure Node (no Electron imports) so it can be unit-tested; main.ts wires it to IPC.
 */
import type {
  AdsPowerStatus, AgentProfilesResponse, AgentRegisterResponse, AgentStatsResponse,
  AgentUpsertProfileRequest, ErrorCode, FriendlyStatus, Job, JobResultRequest, ValidateKeyResponse,
} from '../shared/contract';
import type {
  AdsPowerProfile, AgentSnapshot, LocalResultView, ProfileTestResult, RunningJobView,
} from '../shared/ipc';
import { connectProfile, type BrowserSession } from './browser';
import { BrainClient, BrainError } from './brainClient';
import { downloadToTemp, type DownloadFn } from './download';
import { Heartbeat, ramUsage } from './heartbeat';
import { executeJob } from './jobRunner';
import { ProfileLocks } from './locks';
import { Poller } from './poller';
import { AdsPowerClient } from './profileManager';
import { AgentError, errorMessage, sleep, type Logger, type SleepFn } from './util';

export interface AgentConfig {
  brain_url: string;
  api_key: string;
  agent_id: string | null;
  adspower_url: string;
  adspower_api_key: string;
  paused: boolean;
  poll_interval_ms: number;
  heartbeat_interval_ms: number;
}

export interface ConfigStore {
  get(): AgentConfig;
  set(patch: Partial<AgentConfig>): void;
}

export interface RuntimeOptions {
  config: ConfigStore;
  version: string;
  machineName: string;
  logger: Logger;
  emit?: (s: AgentSnapshot) => void;
  onLatestVersion?: (v: string) => void;
  /** Injectable for tests. */
  factories?: {
    brain?: (cfg: AgentConfig, version: string) => BrainClient;
    adspower?: (cfg: AgentConfig) => AdsPowerClient;
    connect?: (ws: string, logger: Logger) => Promise<BrowserSession>;
    download?: DownloadFn;
    sleep?: SleepFn;
  };
}

type Phase = 'idle' | 'no_key' | 'starting' | 'connected' | 'reconnecting' | 'auth_failed' | 'forbidden';

const IP_CHECK_URL = 'https://api.ipify.org?format=json'; // neutral utility endpoint, not a platform
const RECENT_LIMIT = 50;

export class AgentRuntime {
  private brain!: BrainClient;
  private adspower!: AdsPowerClient;
  private poller: Poller | null = null;
  private heartbeat: Heartbeat | null = null;
  private readonly locks = new ProfileLocks();
  private phase: Phase = 'idle';
  private lastError: string | null = null;
  private registration: AgentRegisterResponse | null = null;
  private adsStatus: AdsPowerStatus = 'not_found';
  private pausedByBrain = false;
  private latestVersion: string | null = null;
  private lastSyncAt: string | null = null;
  private readonly runningViews = new Map<string, RunningJobView>();
  private readonly recent: LocalResultView[] = [];
  private readonly pendingResults: JobResultRequest[] = [];
  private jobsToday = { day: '', count: 0 };
  private generation = 0;
  private readonly sleep: SleepFn;

  constructor(private readonly opts: RuntimeOptions) {
    this.sleep = opts.factories?.sleep ?? sleep;
    this.buildClients();
  }

  private get cfg(): AgentConfig { return this.opts.config.get(); }
  private get log(): Logger { return this.opts.logger; }

  private buildClients(): void {
    const cfg = this.cfg;
    this.brain = this.opts.factories?.brain?.(cfg, this.opts.version)
      ?? new BrainClient({ baseUrl: cfg.brain_url, apiKey: cfg.api_key, version: this.opts.version });
    this.adspower = this.opts.factories?.adspower?.(cfg)
      ?? new AdsPowerClient({ baseUrl: cfg.adspower_url, apiKey: cfg.adspower_api_key || undefined });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<void> {
    const gen = ++this.generation;
    if (!this.cfg.api_key) {
      this.setPhase('no_key', null);
      return;
    }
    this.setPhase('starting', null);
    this.adsStatus = await this.adspower.status();
    let backoff = 2000;
    while (gen === this.generation) {
      try {
        const reg = await this.brain.register({
          machine_name: this.opts.machineName,
          version: this.opts.version,
          adspower_status: this.adsStatus,
          ...(this.cfg.agent_id ? { agent_id: this.cfg.agent_id } : {}),
        });
        if (gen !== this.generation) return;
        this.registration = reg;
        if (reg.agent_id !== this.cfg.agent_id) this.opts.config.set({ agent_id: reg.agent_id });
        this.lastSyncAt = new Date().toISOString();
        this.setPhase('connected', null);
        this.log.info('registered', { agent_id: reg.agent_id });
        break;
      } catch (e) {
        if (gen !== this.generation) return;
        if (this.handleAuthError(e)) return;
        this.setPhase(this.registration ? 'reconnecting' : 'starting', errorMessage(e));
        await this.sleep(backoff).catch(() => undefined);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    if (gen !== this.generation) return;
    this.startLoops();
  }

  private startLoops(): void {
    const agentId = (): string => this.registration?.agent_id ?? this.cfg.agent_id ?? '';
    this.heartbeat = new Heartbeat({
      send: (req) => this.brain.heartbeat(req),
      adspowerStatus: () => this.adspower.status(),
      agentId,
      activeJobs: () => this.poller?.runningJobs.length ?? 0,
      isPaused: () => this.cfg.paused,
      version: this.opts.version,
      intervalMs: () => this.registration?.config.heartbeat_interval_ms ?? this.cfg.heartbeat_interval_ms,
      logger: this.log,
      onResponse: (res, ads) => {
        this.adsStatus = ads;
        this.pausedByBrain = Boolean(res.paused_by_brain);
        this.lastSyncAt = new Date().toISOString();
        if (res.latest_version && res.latest_version !== this.latestVersion) {
          this.latestVersion = res.latest_version;
          if (res.latest_version !== this.opts.version) this.opts.onLatestVersion?.(res.latest_version);
        }
        if (this.phase !== 'connected') this.setPhase('connected', null); else this.emit();
      },
      onError: (e, ads) => {
        this.adsStatus = ads;
        if (!this.handleAuthError(e)) this.setPhase('reconnecting', errorMessage(e));
      },
    });
    this.poller = new Poller({
      fetchJobs: async (slots) => (await this.brain.jobs(agentId(), slots)).jobs,
      runJob: (job, signal) => this.runJob(job, signal),
      reportExpired: async (job) => {
        const now = new Date().toISOString();
        await this.report({ job_id: job.id, agent_id: agentId(), status: 'expired', started_at: now, finished_at: now }, job);
      },
      isPaused: () => this.cfg.paused || this.pausedByBrain,
      maxConcurrent: () => Math.max(1, this.registration?.config.max_concurrent_jobs ?? 1),
      intervalMs: () => this.registration?.config.poll_interval_ms ?? this.cfg.poll_interval_ms,
      locks: this.locks,
      logger: this.log,
      onChange: () => this.emit(),
      onPollOk: () => {
        this.lastSyncAt = new Date().toISOString();
        if (this.phase !== 'connected') this.setPhase('connected', null);
        void this.flushPending();
      },
      onPollError: (e) => { if (!this.handleAuthError(e)) this.setPhase('reconnecting', errorMessage(e)); },
    });
    this.heartbeat.start();
    this.poller.start();
  }

  /** Stops polling/heartbeat. Running jobs are cancelled only when `cancelRunning` is true. */
  stop(cancelRunning = false): void {
    this.generation++;
    this.heartbeat?.stop();
    this.poller?.stop();
    if (cancelRunning) this.poller?.cancelAll();
    this.heartbeat = null;
    this.poller = null;
  }

  /** Re-read settings (brain URL, key, AdsPower URL) and reconnect. */
  async reconfigure(): Promise<void> {
    this.stop(false);
    this.registration = null;
    this.buildClients();
    await this.start();
  }

  private handleAuthError(e: unknown): boolean {
    if (e instanceof BrainError && e.isAuth) {
      this.stop(false);
      this.setPhase('auth_failed', e.message);
      return true;
    }
    if (e instanceof BrainError && (e.status === 403 || e.code === 'FORBIDDEN' || e.code === 'PLAN_LIMIT')) {
      this.setPhase('forbidden', e.message);
      return false;
    }
    return false;
  }

  // ───────────────────────────── jobs ─────────────────────────────

  private async runJob(job: Job, signal: AbortSignal): Promise<void> {
    this.runningViews.set(job.id, {
      id: job.id, type: job.type, label: job.label, platform: job.platform, brand_name: job.brand_name,
      step_index: 0, step_total: 0, step_label: 'Opening profile', started_at: new Date().toISOString(),
    });
    this.emit();
    this.log.info('job started', { job_id: job.id, type: job.type });
    const agentId = this.registration?.agent_id ?? this.cfg.agent_id ?? '';
    try {
      const result = await executeJob(job, {
        agentId: () => agentId,
        fetchPlaybook: (type) => this.brain.playbook(type),
        adspower: this.adspower,
        connect: (ws) => (this.opts.factories?.connect ?? connectProfile)(ws, this.log),
        download: this.opts.factories?.download ?? downloadToTemp,
        sleep: this.sleep,
        logger: this.log,
        onProgress: (j, i, total, label) => {
          const v = this.runningViews.get(j.id);
          if (v) { v.step_index = i; v.step_total = total; v.step_label = label; }
          this.emit();
          void this.brain.progress({ job_id: j.id, step_index: i, step_total: total, label }).catch(() => undefined);
        },
      }, signal);
      await this.report(result, job);
    } finally {
      this.runningViews.delete(job.id);
      this.emit();
    }
  }

  private async report(result: JobResultRequest, job: Job): Promise<void> {
    this.log.info('job finished', { job_id: job.id, type: job.type, status: result.status, code: result.error?.code });
    this.pushRecent({
      id: job.id, label: job.label, platform: job.platform, brand_name: job.brand_name,
      status: result.status, at: result.finished_at, ...(result.error ? { error: result.error } : {}),
    });
    const today = new Date().toISOString().slice(0, 10);
    if (this.jobsToday.day !== today) this.jobsToday = { day: today, count: 0 };
    if (result.status === 'success') this.jobsToday.count++;
    let delay = 2000;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.brain.result(result);
        return;
      } catch (e) {
        if (e instanceof BrainError && e.status !== null && e.status < 500 && e.status !== 429) {
          this.log.warn('result rejected by brain', { job_id: job.id, status: e.status });
          return;
        }
        if (attempt < 3) { await this.sleep(delay).catch(() => undefined); delay *= 2; }
      }
    }
    this.log.warn('result queued for retry', { job_id: job.id });
    this.pendingResults.push(result);
  }

  private async flushPending(): Promise<void> {
    while (this.pendingResults.length > 0) {
      const r = this.pendingResults[0];
      try {
        await this.brain.result(r);
        this.pendingResults.shift();
      } catch {
        return;
      }
    }
  }

  private pushRecent(r: LocalResultView): void {
    this.recent.unshift(r);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
    this.emit();
  }

  // ───────────────────────────── controls ─────────────────────────────

  pause(): void {
    this.opts.config.set({ paused: true });
    this.emit();
    void this.heartbeat?.beat();
  }

  resume(): void {
    this.opts.config.set({ paused: false });
    this.emit();
    void this.heartbeat?.beat();
    void this.poller?.tick();
  }

  async refresh(): Promise<void> {
    if (this.phase === 'auth_failed' || this.phase === 'no_key' || !this.poller) {
      await this.reconfigure();
      return;
    }
    this.adsStatus = await this.adspower.status();
    await Promise.all([this.heartbeat?.beat(), this.poller?.tick()]);
    this.emit();
  }

  async testConnection(): Promise<{ brain: boolean; adspower: AdsPowerStatus }> {
    const adspower = await this.adspower.status();
    this.adsStatus = adspower;
    let brain = false;
    try { await this.brain.health(); brain = true; } catch { brain = false; }
    this.emit();
    return { brain, adspower };
  }

  validateKey(): Promise<ValidateKeyResponse> { return this.brain.validateKey(); }
  stats(): Promise<AgentStatsResponse> { return this.brain.stats(); }
  brainProfiles(): Promise<AgentProfilesResponse> { return this.brain.profiles(); }
  adsProfiles(): Promise<AdsPowerProfile[]> { return this.adspower.listProfiles(); }
  async saveProfile(req: AgentUpsertProfileRequest): Promise<void> { await this.brain.upsertProfile(req); }

  async openProfile(adsId: string): Promise<void> {
    if (this.locks.isLocked(adsId)) throw new AgentError('PROFILE_BUSY', 'This profile is busy with a job right now');
    await this.adspower.start(adsId);
  }

  /** Starts the profile, checks the browser opens and which IP it exits from, stops it. */
  async testProfile(adsId: string, profileId?: number): Promise<ProfileTestResult> {
    const owner = `test:${adsId}:${Date.now()}`;
    if (!this.locks.tryAcquire(adsId, owner)) {
      return { opened: false, ip: null, error: { code: 'PROFILE_BUSY', message: 'This profile is busy with a job right now' } };
    }
    let session: BrowserSession | null = null;
    let started = false;
    let result: ProfileTestResult;
    try {
      const s = await this.adspower.start(adsId);
      started = true;
      session = await (this.opts.factories?.connect ?? connectProfile)(s.wsEndpoint, this.log);
      let ip: string | null = null;
      try {
        await session.driver.goto(IP_CHECK_URL, 30_000);
        const body = await session.driver.read('body', undefined, 10_000);
        const parsed = JSON.parse(body ?? '{}') as { ip?: unknown };
        ip = typeof parsed.ip === 'string' ? parsed.ip : null;
      } catch {
        ip = null;
      }
      result = { opened: true, ip, error: null };
    } catch (e) {
      const code: ErrorCode = e instanceof AgentError ? e.code : 'ADSPOWER_ERROR';
      result = { opened: false, ip: null, error: { code, message: errorMessage(e) } };
    } finally {
      if (session) await session.close().catch(() => undefined);
      if (started) await this.adspower.stop(adsId).catch(() => undefined);
      this.locks.release(adsId, owner);
    }
    if (profileId !== undefined) {
      await this.brain.profileHealth({
        profile_id: profileId,
        healthy: result.opened,
        ...(result.error ? { reason: result.error.code } : {}),
        ...(result.ip ? { detected_ip: result.ip } : {}),
      }).catch((e: unknown) => this.log.warn('profile health report failed', { reason: errorMessage(e).slice(0, 80) }));
    }
    return result;
  }

  // ───────────────────────────── state ─────────────────────────────

  private setPhase(p: Phase, err: string | null): void {
    this.phase = p;
    this.lastError = err;
    this.emit();
  }

  private emit(): void { this.opts.emit?.(this.snapshot()); }

  friendly(): { status: FriendlyStatus; message: string } {
    const host = safeHost(this.cfg.brain_url);
    switch (this.phase) {
      case 'no_key': return { status: 'action_needed', message: 'Add your API key in Settings to connect' };
      case 'auth_failed': return { status: 'action_needed', message: 'Your API key was not accepted — check Settings' };
      case 'forbidden': return { status: 'action_needed', message: 'Your plan needs attention — open the dashboard' };
      default: break;
    }
    if (this.cfg.paused || this.pausedByBrain) {
      return { status: 'paused', message: this.pausedByBrain ? 'Paused from the dashboard' : 'Paused — agents are not running jobs' };
    }
    if (this.phase === 'starting' || this.phase === 'idle') return { status: 'starting', message: `Connecting to ${host}…` };
    if (this.phase === 'reconnecting') return { status: 'reconnecting', message: 'Connection lost — reconnecting automatically' };
    if (this.adsStatus !== 'running') return { status: 'action_needed', message: 'Please open AdsPower on this computer' };
    return { status: 'active', message: `Connected to ${host}` };
  }

  snapshot(): AgentSnapshot {
    const f = this.friendly();
    const cfg = this.cfg;
    const today = new Date().toISOString().slice(0, 10);
    const details = [
      this.lastError ? `Last error: ${this.lastError}` : null,
      this.adsStatus !== 'running' ? `AdsPower status: ${this.adsStatus} (${cfg.adspower_url})` : null,
    ].filter(Boolean).join('\n');
    return {
      status: f.status,
      message: f.message,
      details: details || null,
      brain_host: safeHost(cfg.brain_url),
      agent_id: this.registration?.agent_id ?? cfg.agent_id,
      agency_name: this.registration?.user.agency_name ?? null,
      user_name: this.registration?.user.name ?? null,
      plan: this.registration?.user.plan ?? null,
      last_sync_at: this.lastSyncAt,
      adspower: this.adsStatus,
      adspower_url: cfg.adspower_url,
      ram: ramUsage(),
      paused_local: cfg.paused,
      paused_by_brain: this.pausedByBrain,
      running: [...this.runningViews.values()],
      waiting: (this.poller?.waitingJobs ?? []).map((j) => ({
        id: j.id, label: j.label, platform: j.platform, brand_name: j.brand_name, scheduled_for: j.scheduled_for,
      })),
      recent: [...this.recent],
      jobs_today_local: this.jobsToday.day === today ? this.jobsToday.count : 0,
      version: this.opts.version,
      latest_version: this.latestVersion,
    };
  }
}

export function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

