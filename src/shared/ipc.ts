/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Launcher-local only (not part of the brain contract).
 */
import type {
  AdsPowerStatus, AgentProfilesResponse, AgentStatsResponse, AgentUpsertProfileRequest,
  ErrorCode, FriendlyStatus, Plan, Platform, ValidateKeyResponse,
} from './contract';

export interface RunningJobView {
  id: string;
  type: string;
  label: string;
  platform: Platform | 'tool';
  brand_name: string | null;
  step_index: number;
  step_total: number;
  step_label: string;
  started_at: string;
}

export interface WaitingJobView {
  id: string;
  label: string;
  platform: Platform | 'tool';
  brand_name: string | null;
  scheduled_for: string;
}

export interface LocalResultView {
  id: string;
  label: string;
  platform: Platform | 'tool';
  brand_name: string | null;
  status: 'success' | 'failed' | 'expired' | 'cancelled';
  at: string;
  error?: { code: ErrorCode; message: string; step_id?: string };
}

export interface AgentSnapshot {
  status: FriendlyStatus;
  /** Friendly one-liner for the user. */
  message: string;
  /** Technical detail, only shown inside an expandable "details" block. */
  details: string | null;
  brain_host: string;
  agent_id: string | null;
  agency_name: string | null;
  user_name: string | null;
  plan: Plan | null;
  last_sync_at: string | null;
  adspower: AdsPowerStatus;
  adspower_url: string;
  ram: { percent: number; used_gb: number; total_gb: number };
  paused_local: boolean;
  paused_by_brain: boolean;
  running: RunningJobView[];
  waiting: WaitingJobView[];
  recent: LocalResultView[];
  jobs_today_local: number;
  version: string;
  latest_version: string | null;
}

export interface SettingsView {
  brain_url: string;
  api_key_masked: string;
  has_api_key: boolean;
  adspower_url: string;
  has_adspower_api_key: boolean;
  auto_start: boolean;
  paused: boolean;
  version: string;
}

export interface SettingsUpdate {
  brain_url?: string;
  api_key?: string;
  adspower_url?: string;
  adspower_api_key?: string;
  auto_start?: boolean;
}

export interface AdsPowerProfile {
  user_id: string;
  name: string;
  serial_number: string | null;
  group_name: string | null;
  ip: string | null;
}

export interface ProfileTestResult {
  opened: boolean;
  ip: string | null;
  error: { code: ErrorCode; message: string } | null;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { message: string; code?: ErrorCode } };

export interface UpdateCheckResult { available: boolean; version: string | null; message: string }

/** The API exposed on `window.sk` by preload.ts. */
export interface SkBridge {
  getSnapshot(): Promise<AgentSnapshot>;
  onSnapshot(cb: (s: AgentSnapshot) => void): () => void;
  getSettings(): Promise<SettingsView>;
  saveSettings(update: SettingsUpdate): Promise<IpcResult<SettingsView>>;
  validateKey(): Promise<IpcResult<ValidateKeyResponse>>;
  testConnection(): Promise<IpcResult<{ brain: boolean; adspower: AdsPowerStatus }>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  refresh(): Promise<void>;
  getStats(): Promise<IpcResult<AgentStatsResponse>>;
  getBrainProfiles(): Promise<IpcResult<AgentProfilesResponse>>;
  getAdsPowerProfiles(): Promise<IpcResult<AdsPowerProfile[]>>;
  testProfile(adspowerProfileId: string, profileId?: number): Promise<IpcResult<ProfileTestResult>>;
  saveProfile(req: AgentUpsertProfileRequest): Promise<IpcResult<{ saved: true }>>;
  /** Opens the AdsPower profile window so the user can log in manually (Re-login). */
  openProfile(adspowerProfileId: string): Promise<IpcResult<{ opened: true }>>;
  checkForUpdates(): Promise<IpcResult<UpdateCheckResult>>;
  openDashboard(): Promise<void>;
}

export const IPC = {
  getSnapshot: 'sk:get-snapshot',
  snapshot: 'sk:snapshot',
  getSettings: 'sk:get-settings',
  saveSettings: 'sk:save-settings',
  validateKey: 'sk:validate-key',
  testConnection: 'sk:test-connection',
  pause: 'sk:pause',
  resume: 'sk:resume',
  refresh: 'sk:refresh',
  getStats: 'sk:get-stats',
  getBrainProfiles: 'sk:get-brain-profiles',
  getAdsPowerProfiles: 'sk:get-adspower-profiles',
  testProfile: 'sk:test-profile',
  saveProfile: 'sk:save-profile',
  openProfile: 'sk:open-profile',
  checkForUpdates: 'sk:check-updates',
  openDashboard: 'sk:open-dashboard',
} as const;
