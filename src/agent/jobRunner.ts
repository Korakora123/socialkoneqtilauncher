import type { ErrorCode, Job, JobResultRequest, Playbook } from '../shared/contract';
import type { BrowserSession } from './browser';
import type { DownloadFn } from './download';
import { runPlaybook } from './executor';
import type { AdsPowerClient } from './profileManager';
import { AgentError, errorMessage, type Logger, type SleepFn } from './util';

export interface JobRunnerDeps {
  agentId: () => string;
  fetchPlaybook: (type: string) => Promise<Playbook>;
  adspower: Pick<AdsPowerClient, 'start' | 'stop'>;
  connect: (wsEndpoint: string) => Promise<BrowserSession>;
  download: DownloadFn;
  sleep: SleepFn;
  now?: () => Date;
  logger: Logger;
  onProgress?: (job: Job, stepIndex: number, stepTotal: number, label: string) => void;
}

/**
 * Executes one leased job end to end and returns the JobResultRequest to report.
 * Never throws. The playbook lives only in this function's scope.
 */
export async function executeJob(job: Job, deps: JobRunnerDeps, signal?: AbortSignal): Promise<JobResultRequest> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const base = { job_id: job.id, agent_id: deps.agentId(), started_at: startedAt };

  if (Date.parse(job.expires_at) < now().getTime()) {
    return { ...base, status: 'expired', finished_at: now().toISOString() };
  }

  let session: BrowserSession | null = null;
  let profileStarted = false;
  try {
    let playbook: Playbook;
    try {
      playbook = await deps.fetchPlaybook(job.type);
    } catch (e) {
      throw new AgentError('INTERNAL', `Playbook unavailable: ${errorMessage(e)}`);
    }
    const started = await deps.adspower.start(job.adspower_profile_id);
    profileStarted = true;
    try {
      session = await deps.connect(started.wsEndpoint);
    } catch (e) {
      throw new AgentError('ADSPOWER_ERROR', `Could not attach to profile browser: ${errorMessage(e)}`);
    }
    const out = await runPlaybook(job, playbook, {
      driver: session.driver,
      sleep: deps.sleep,
      download: deps.download,
      signal,
      onProgress: (i, total, label) => deps.onProgress?.(job, i, total, label),
    });
    return {
      ...base,
      status: 'success',
      finished_at: now().toISOString(),
      outputs: out.outputs,
      ...(out.screenshot_b64 ? { screenshot_b64: out.screenshot_b64 } : {}),
    };
  } catch (e) {
    const err = e instanceof AgentError ? e : new AgentError('UNKNOWN', errorMessage(e));
    let screenshot: string | undefined;
    if (session) {
      try { screenshot = (await session.driver.screenshot()).toString('base64'); } catch { /* evidence is best effort */ }
    }
    const code: ErrorCode = err.code;
    deps.logger.warn('job failed', { job_id: job.id, type: job.type, code, step_id: err.stepId });
    return {
      ...base,
      status: code === 'CANCELLED' ? 'cancelled' : 'failed',
      finished_at: now().toISOString(),
      error: { code, message: err.message.slice(0, 500), ...(err.stepId ? { step_id: err.stepId } : {}) },
      ...(screenshot ? { screenshot_b64: screenshot } : {}),
    };
  } finally {
    if (session) await session.close().catch(() => undefined);
    if (profileStarted) {
      await deps.adspower.stop(job.adspower_profile_id).catch((e: unknown) => {
        deps.logger.warn('adspower stop failed', { job_id: job.id, reason: e instanceof AgentError ? e.code : 'unknown' });
      });
    }
  }
}
