import type { ErrorCode } from '../shared/contract';

/** Minimal logger interface. Implementations must never receive API keys, payload text or playbooks. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

/** An executor/transport error carrying a contract ErrorCode. */
export class AgentError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly stepId?: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Abortable sleep. Rejects with AgentError('CANCELLED') when the signal aborts. */
export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function abortReason(signal?: AbortSignal): AgentError {
  const r: unknown = signal?.reason;
  if (r instanceof AgentError) return r;
  return new AgentError('CANCELLED', 'Job cancelled');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Uniform random integer in [min, max]. */
export function randomBetween(min: number, max: number, rng: () => number = Math.random): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(lo + rng() * (hi - lo));
}
