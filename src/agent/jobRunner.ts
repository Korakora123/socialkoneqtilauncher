import type { ErrorCode, Job, JobResultRequest, Playbook } from '../shared/contract';
import type { BrowserSession } from './browser';
import type { DownloadFn } from './download';
import { runPlaybook } from './executor';
import type { AdsPowerClient } from './profileManager';
import type { SessionStore } from './sessionVault';
import { AgentError, errorMessage, type Logger, type SleepFn } from './util';

export interface JobRunnerDeps {
  agentId: () => string;
  fetchPlaybook: (type: string) => Promise<Playbook>;
  adspower: Pick<AdsPowerClient, 'start' | 'stop'>;
  connect: (wsEndpoint: string) => Promise<BrowserSession>;
  download: DownloadFn;
  sleep: SleepFn;
  sessions?: SessionStore;
  now?: () => Date;
  logger: Logger;
  onProgress?: (job: Job, stepIndex: number, stepTotal: number, label: string) => void;
  /**
   * POST /agent/progress — the brain's cancel channel. Resolves true when the brain cancelled
   * the job. Network errors must resolve false (never block a job on a progress call).
   */
  reportProgress?: (job: Job, stepIndex: number, stepTotal: number, label: string) => Promise<boolean>;
}

const cancelledByBrain = (): AgentError => new AgentError('CANCELLED', 'Cancelled by the brain');

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

  // Pre-start progress call (step 0): a job cancelled while it waited locally never starts.
  if (deps.reportProgress && (await deps.reportProgress(job, 0, 0, 'Starting').catch(() => false))) {
    const err = cancelledByBrain();
    deps.logger.info('job cancelled before start', { job_id: job.id, type: job.type });
    return { ...base, status: 'cancelled', finished_at: now().toISOString(), error: { code: err.code, message: err.message } };
  }

  // Local controller: aborts on the parent signal (shutdown) or on a brain cancel.
  const ctrl = new AbortController();
  const onParentAbort = (): void => ctrl.abort(signal?.reason);
  if (signal?.aborted) onParentAbort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let session: BrowserSession | null = null;
  let profileStarted = false;
  try {
    let playbook: Playbook;
    try {
      playbook = await deps.fetchPlaybook(job.type);
    } catch (e) {
      throw new AgentError('INTERNAL', `Playbook unavailable: ${errorMessage(e)}`);
    }
    if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof AgentError ? ctrl.signal.reason : cancelledByBrain();
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
      ...(deps.sessions ? { sessions: deps.sessions } : {}),
      signal: ctrl.signal,
      onProgress: (i, total, label) => {
        deps.onProgress?.(job, i, total, label);
        if (!deps.reportProgress) return;
        void deps.reportProgress(job, i, total, label)
          .then((cancel) => { if (cancel && !ctrl.signal.aborted) ctrl.abort(cancelledByBrain()); })
          .catch(() => undefined);
      },
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
    if (session && err.code !== 'CANCELLED') {
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
    signal?.removeEventListener('abort', onParentAbort);
    if (session) await session.close().catch(() => undefined);
    if (profileStarted) {
      await deps.adspower.stop(job.adspower_profile_id).catch((e: unknown) => {
        deps.logger.warn('adspower stop failed', { job_id: job.id, reason: e instanceof AgentError ? e.code : 'unknown' });
      });
    }
  }
}
