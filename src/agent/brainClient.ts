import axios, { AxiosError, type AxiosInstance } from 'axios';
import type {
  AgentErrorRequest, AgentProfilesResponse, AgentRegisterRequest, AgentRegisterResponse,
  AgentStatsResponse, AgentUpsertProfileRequest, ApiError, ErrorCode, HealthResponse,
  HeartbeatRequest, HeartbeatResponse, JobProgressRequest, JobProgressResponse, JobResultRequest, JobResultResponse,
  JobsResponse, Playbook, ProfileHealthRequest, ValidateKeyResponse,
} from '../shared/contract';

export interface BrainClientOptions {
  baseUrl: string;            // e.g. https://social.koneqti.com/api/gateway
  apiKey: string;             // sk_live_...
  version: string;
  timeoutMs?: number;
  http?: AxiosInstance;       // injectable for tests
}

/** Error from the brain (HTTP error or network failure). */
export class BrainError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: ErrorCode | null,
    public readonly upgrade: boolean = false,
    public readonly network: boolean = false,
  ) {
    super(message);
    this.name = 'BrainError';
  }
  get isAuth(): boolean { return this.status === 401 || this.code === 'UNAUTHORIZED'; }
}

function toBrainError(err: unknown): BrainError {
  if (err instanceof BrainError) return err;
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<ApiError>;
    if (ax.response) {
      const body = ax.response.data;
      const msg = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : `HTTP ${ax.response.status}`;
      return new BrainError(msg, ax.response.status, body?.code ?? null, Boolean(body?.upgrade));
    }
    return new BrainError(ax.code === 'ECONNABORTED' ? 'Brain request timed out' : `Cannot reach brain (${ax.code ?? 'network'})`, null, null, false, true);
  }
  return new BrainError(err instanceof Error ? err.message : String(err), null, null, false, true);
}

/** Typed client for every launcher-facing brain endpoint in the contract. */
export class BrainClient {
  private readonly http: AxiosInstance;

  constructor(opts: BrainClientOptions) {
    this.http = opts.http ?? axios.create({
      baseURL: opts.baseUrl.replace(/\/+$/, ''),
      timeout: opts.timeoutMs ?? 20_000,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'X-Agent-Version': opts.version,
      },
    });
  }

  private async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    try { return (await this.http.get<T>(url, { params })).data; } catch (e) { throw toBrainError(e); }
  }

  private async post<T>(url: string, body?: unknown, timeout?: number): Promise<T> {
    try { return (await this.http.post<T>(url, body ?? {}, timeout ? { timeout } : undefined)).data; } catch (e) { throw toBrainError(e); }
  }

  health(): Promise<HealthResponse> { return this.get('/health'); }
  validateKey(): Promise<ValidateKeyResponse> { return this.post('/auth/validate-key'); }

  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> { return this.post('/agent/register', req); }
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> { return this.post('/agent/heartbeat', req); }

  async jobs(agentId: string, slots: number): Promise<JobsResponse> {
    const res = await this.get<JobsResponse>('/agent/jobs', { agent_id: agentId, slots });
    return { jobs: Array.isArray(res?.jobs) ? res.jobs : [] };
  }

  /** The playbook is returned to the caller and must only be held in memory. */
  playbook(type: string): Promise<Playbook> { return this.get(`/agent/playbook/${encodeURIComponent(type)}`); }

  /** Also the cancel channel: `cancel: true` means the brain cancelled the job. */
  async progress(req: JobProgressRequest): Promise<JobProgressResponse> {
    const res = await this.post<Partial<JobProgressResponse> | undefined>('/agent/progress', req);
    return { ok: true, cancel: Boolean(res?.cancel) };
  }
  result(req: JobResultRequest): Promise<JobResultResponse> { return this.post('/agent/result', req, 60_000); }
  error(req: AgentErrorRequest): Promise<unknown> { return this.post('/agent/error', req); }

  profiles(): Promise<AgentProfilesResponse> { return this.get('/agent/profiles'); }
  upsertProfile(req: AgentUpsertProfileRequest): Promise<unknown> { return this.post('/agent/profiles', req); }
  profileHealth(req: ProfileHealthRequest): Promise<unknown> { return this.post('/agent/profiles/health', req); }
  /** Queues a `<platform>_health_check` job (202). Its result arrives through the normal job flow. */
  healthCheck(profileId: number): Promise<{ job_id: string }> { return this.post(`/agent/profiles/${profileId}/health-check`); }

  stats(): Promise<AgentStatsResponse> { return this.get('/agent/stats'); }
}
