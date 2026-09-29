import os from 'node:os';
import type { AdsPowerStatus, HeartbeatRequest, HeartbeatResponse } from '../shared/contract';
import type { Logger } from './util';

export function ramUsage(): { percent: number; used_gb: number; total_gb: number } {
  const total = os.totalmem();
  const used = total - os.freemem();
  const gb = (n: number): number => Math.round((n / 1024 ** 3) * 10) / 10;
  return { percent: total > 0 ? Math.round((used / total) * 100) : 0, used_gb: gb(used), total_gb: gb(total) };
}

export interface HeartbeatDeps {
  send(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  adspowerStatus(): Promise<AdsPowerStatus>;
  agentId(): string;
  activeJobs(): number;
  isPaused(): boolean;
  version: string;
  intervalMs(): number;
  logger: Logger;
  onResponse?(res: HeartbeatResponse, adspower: AdsPowerStatus): void;
  onError?(err: unknown, adspower: AdsPowerStatus): void;
}

/** Sends POST /agent/heartbeat every heartbeat_interval_ms (60 s by default). */
export class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.loop();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    if (!this.active) return;
    await this.beat();
    if (!this.active) return;
    this.timer = setTimeout(() => void this.loop(), Math.max(5000, this.deps.intervalMs()));
  }

  async beat(): Promise<void> {
    const adspower = await this.deps.adspowerStatus().catch((): AdsPowerStatus => 'error');
    try {
      const res = await this.deps.send({
        agent_id: this.deps.agentId(),
        adspower_status: adspower,
        ram_percent: ramUsage().percent,
        active_jobs: this.deps.activeJobs(),
        paused: this.deps.isPaused(),
        version: this.deps.version,
      });
      this.deps.onResponse?.(res, adspower);
    } catch (e) {
      this.deps.logger.warn('heartbeat failed', { reason: e instanceof Error ? e.name : 'unknown' });
      this.deps.onError?.(e, adspower);
    }
  }
}
