/**
 * SocialKoneqti shared API contract — SINGLE SOURCE OF TRUTH.
 *
 * Canonical copy: socialkoneqti/docs/contract/contract.ts
 * Copies:         socialkoneqtigateway/src/shared/contract.ts
 *                 socialkoneqti/dashboard/lib/contract.ts
 *                 socialkoneqtilauncher/src/shared/contract.ts
 * Change the canonical copy first, then copy it verbatim to the others.
 *
 * Types only — no runtime code, no prompts, no selectors (the launcher copy is public).
 *
 * Transport rules
 *  - Brain base URL: http://[WINDOWS_VPS_IP]:3001/api  (dashboard, server-side only)
 *                    https://social.koneqti.com/api/gateway (launcher, via Nginx)
 *  - Dashboard → brain: `Authorization: Bearer <INTERNAL_SECRET>` plus
 *        `X-User-Id: <users.id>`             when acting for an agency user
 *        `X-Portal-Client-Id: <agency_clients.id>` when acting for a portal client
 *  - Launcher → brain:  `Authorization: Bearer sk_live_...`
 *  - Every error response: { error: string, code?: ErrorCode, upgrade?: boolean }
 *  - All timestamps are ISO-8601 strings in UTC.
 */

// ───────────────────────────────── enums ─────────────────────────────────

export type Platform =
  | 'instagram' | 'tiktok' | 'youtube' | 'linkedin' | 'x'
  | 'facebook' | 'reddit' | 'quora' | 'pinterest';

export const PLATFORMS: Platform[] = [
  'instagram', 'tiktok', 'youtube', 'linkedin', 'x',
  'facebook', 'reddit', 'quora', 'pinterest',
];

export type Plan = 'starter' | 'growth' | 'pro' | 'agency';
export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'trial';

export type BrandStatus = 'active' | 'paused' | 'offboarding' | 'warmup' | 'crisis';
export type ApprovalMode = 'weekly_batch' | 'auto_24h' | 'manual_each' | 'auto';
export type AccountType = 'client' | 'own';

export type ProfileStatus = 'active' | 'paused' | 'blocked' | 'warmup' | 'session_expired' | 'banned';
export type ProxyType = 'static_residential' | 'wireguard' | 'mobile' | 'none';

export type PostStatus =
  | 'draft' | 'pending_approval' | 'approved' | 'needs_revision' | 'rejected'
  | 'scheduled' | 'posting' | 'posted' | 'failed' | 'flagged' | 'expired_draft' | 'paused';

export type PostFormat =
  | 'reel' | 'carousel' | 'story' | 'image' | 'text' | 'thread' | 'short'
  | 'video' | 'document' | 'pin' | 'idea_pin' | 'answer' | 'comment' | 'post';

export type Pillar = 'educational' | 'entertainment' | 'social_proof' | 'behind_the_scenes' | 'cta';

/** Five user-facing states. Never expose technical detail to users. */
export type FriendlyStatus = 'active' | 'starting' | 'reconnecting' | 'action_needed' | 'paused';

export type AgentStatus = 'online' | 'offline' | 'paused';
export type AdsPowerStatus = 'running' | 'not_found' | 'error';

export type JobStatus = 'queued' | 'dispatched' | 'running' | 'success' | 'failed' | 'cancelled' | 'expired';

export type IncidentType =
  | 'action_block' | 'shadowban' | 'session_expired' | 'ban' | 'captcha'
  | 'crisis' | 'agent_offline' | 'organic_post' | 'job_failed' | 'profile_corrupt';

export type ErrorCode =
  // HTTP-level
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'PLAN_LIMIT' | 'CONFLICT' | 'INTERNAL'
  // executor-level (launcher → brain in JobResult.error.code)
  | 'SESSION_EXPIRED' | 'ACTION_BLOCKED' | 'CAPTCHA' | 'BANNED'
  | 'SELECTOR_NOT_FOUND' | 'ADSPOWER_ERROR' | 'PROFILE_BUSY' | 'TIMEOUT'
  | 'NAVIGATION_FAILED' | 'UPLOAD_FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface ApiError { error: string; code?: ErrorCode; upgrade?: boolean }

// ───────────────────────────────── health ─────────────────────────────────

/** GET /health  (no auth) */
export interface HealthResponse { ok: true; status: 'ok'; version: string; time: string }

// ───────────────────────────────── auth ─────────────────────────────────

export interface PlanLimits {
  brands: number;          // Infinity serialised as -1
  platforms: number;
  clientPortals: number;
  engagement: boolean;
  adManager: boolean;
  whiteLabel: boolean;
  videoPipeline: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  plan: Plan;
  status: UserStatus;
  own_accounts_addon: boolean;
  plan_expires_at: string | null;
  trial_ends_at: string | null;
  created_at: string;
}

/** POST /auth/register (internal) */
export interface RegisterRequest { email: string; password: string; name?: string; plan?: Plan }
export interface RegisterResponse { user: PublicUser }

/** POST /auth/login (internal) — 401 on bad credentials */
export interface LoginRequest { email: string; password: string }
export interface LoginResponse { user: PublicUser }

/** GET /auth/me (internal + X-User-Id) */
export interface MeResponse { user: PublicUser; api_key: string; limits: PlanLimits; usage: PlanUsage }

/** POST /auth/rotate-key (internal + X-User-Id) */
export interface RotateKeyResponse { api_key: string }

/** POST /auth/validate-key (api key) */
export interface ValidateKeyResponse { valid: true; user: Pick<PublicUser, 'id' | 'name' | 'plan' | 'status'> }

export interface PlanUsage { brands: number; platforms: number; clientPortals: number }
/** GET /auth/subscription */
export interface SubscriptionResponse { plan: Plan; limits: PlanLimits; usage: PlanUsage; status: UserStatus }

// ───────────────────────────────── brands ─────────────────────────────────

export interface TargetAudience {
  demographics: string;
  painPoints: string[];
  desires: string[];
  countries?: string[];            // ISO-3166 alpha-2; the brain also accepts English names and normalises them
  ageMin?: number;
  ageMax?: number;
}

export interface BrandPlatformConfig {
  enabled: boolean;
  handle?: string;
  postsPerDay?: number;
  subreddits?: string[];           // reddit
  boards?: string[];               // pinterest
  thoughtLeaders?: string[];       // linkedin / x first-comment + reply-guy targets
  groups?: string[];               // facebook
}

/** The brand profile (blueprint §8), stored as JSON in brands.profile_json */
export interface BrandProfile {
  niche: string;
  subNiche?: string;
  targetAudience: TargetAudience;
  toneOfVoice: string;
  contentPillars: string[];
  competitors: string[];
  blacklistedTopics: string[];
  blacklistedTerms?: string[];
  ctaStyle?: string;
  timezone: string;                // IANA, e.g. "America/New_York"
  website?: string;
  privacyPolicyUrl?: string;
  platforms: Partial<Record<Platform, BrandPlatformConfig>>;
  contentWeights?: {               // written by the weekly learning loop
    formats?: Partial<Record<PostFormat, number>>;
    pillars?: Partial<Record<Pillar, number>>;
    hookTypes?: Record<string, number>;
  };
  monetization?: {                 // own accounts only
    affiliateLinks?: Record<string, string>;
    revenueGoal?: number;
  };
}

export interface Brand {
  id: string;
  user_id: string;
  name: string;
  status: BrandStatus;
  account_type: AccountType;
  approval_mode: ApprovalMode;
  profile: BrandProfile;
  account_age_days: number;
  onboarded_at: string | null;
  created_at: string;
  friendly_status?: FriendlyStatus;
}

export interface CreateBrandRequest {
  name: string;
  account_type?: AccountType;
  approval_mode?: ApprovalMode;
  profile: BrandProfile;
  new_accounts?: boolean;          // true → every platform profile starts warmup
}
export type UpdateBrandRequest = Partial<CreateBrandRequest> & { status?: BrandStatus };

/** GET /brands → { brands }, GET /brands/:id → { brand, profiles } */
export interface BrandListResponse { brands: BrandSummary[] }
export interface BrandSummary extends Brand {
  platforms_enabled: Platform[];
  posts_today: number;
  pending_approvals: number;
  open_incidents: number;
}
export interface BrandDetailResponse { brand: Brand; profiles: PlatformProfile[] }

export interface PlatformProfile {
  id: number;
  user_id: string;
  brand_id: string;
  platform: Platform;
  handle: string | null;
  adspower_profile_id: string;
  proxy_type: ProxyType;
  proxy_host: string | null;
  proxy_port: string | null;
  proxy_user: string | null;       // password is never returned
  status: ProfileStatus;
  warmup_day: number;              // 0 = not in warmup
  warmup_started_at: string | null;
  session_healthy: boolean;
  last_action_at: string | null;
  last_health_check_at: string | null;
  karma_score?: number | null;     // reddit
  friendly_status?: FriendlyStatus;
}

export interface UpsertProfileRequest {
  platform: Platform;
  handle?: string;
  adspower_profile_id: string;
  proxy_type?: ProxyType;
  proxy_host?: string;
  proxy_port?: string;
  proxy_user?: string;
  proxy_pass?: string;             // stored in the credential vault, never echoed
  start_warmup?: boolean;
}

// ───────────────────────────────── content ─────────────────────────────────

export interface Post {
  id: number;
  user_id: string;
  brand_id: string;
  platform: Platform;
  format: PostFormat;
  pillar: Pillar | null;
  hook_type: string | null;
  topic: string | null;
  caption: string;
  caption_snippet: string;
  hashtags: string[];
  media_urls: string[];
  media_brief: string | null;      // what imageCreator/videoCreator should make
  extra: Record<string, unknown>;  // platform-specific: thread tweets, title, tags, board, subreddit, question url…
  trend_based: boolean;
  status: PostStatus;
  scheduled_for: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  screening: ScreeningResult | null;
  revision_feedback: string | null;
  approval_requested_at: string | null;
  approved_at: string | null;
  posted_at: string | null;
  metrics: PostMetrics;
  boosted: boolean;
  created_at: string;
}

export interface PostMetrics {
  impressions: number;
  engagements: number;
  engagement_rate: number;
  saves: number;
  shares: number;
  comments_count: number;
  profile_visits: number;
  followers_gained: number;
}

export interface ScreeningResult {
  pass: boolean;
  issues: string[];
  severity: 'none' | 'low' | 'high' | 'critical';
}

/** POST /content/generate */
export interface GenerateContentRequest {
  brand_id: string;
  platforms?: Platform[];          // default: all enabled platforms of the brand
  days?: number;                   // default 7
  start_date?: string;             // YYYY-MM-DD, default tomorrow in brand timezone
  topic?: string;                  // force a topic (single post)
}
export interface GenerateContentResponse { job_id: string; queued: number }

/** GET /content/generation/:jobId */
export interface GenerationStatusResponse {
  job_id: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  created: number;
  flagged: number;
  error?: string;
}

/** GET /content/calendar/:brandId?from=YYYY-MM-DD&to=YYYY-MM-DD */
export interface CalendarResponse { brand_id: string; from: string; to: string; posts: Post[] }

/** GET /content/pending/:brandId */
export interface PendingResponse { posts: Post[] }

/** POST /content/approve/:postId  → { post } */
/** POST /content/reject/:postId */
export interface RejectRequest { feedback?: string; revise?: boolean }
/** POST /content/approve-all/:brandId → { approved: number } */
/** POST /content/send-preview/:brandId → { sent: boolean } */
/** POST /content/manual */
export interface ManualPostRequest {
  brand_id: string;
  platform: Platform;
  format: PostFormat;
  caption: string;
  media_urls?: string[];
  scheduled_for: string;
  skip_approval?: boolean;
}
/** PUT /content/:postId  (edit caption/schedule while draft/pending) */
export interface UpdatePostRequest { caption?: string; scheduled_for?: string; media_urls?: string[] }
export interface PostResponse { post: Post }

// ───────────────────────────────── analytics ─────────────────────────────────

export interface SeriesPoint { date: string; value: number }

/** GET /analytics/:brandId/summary?days=30 */
export interface AnalyticsSummaryResponse {
  brand_id: string;
  days: number;
  totals: { reach: number; engagements: number; engagement_rate: number; followers_gained: number; posts: number };
  followers: Partial<Record<Platform, { current: number; change: number; series: SeriesPoint[] }>>;
  engagement_series: SeriesPoint[];
  top_posts: Post[];
  platform_breakdown: Array<{ platform: Platform; reach: number; engagement_rate: number; posts: number }>;
}

/** GET /analytics/overview  (all brands of the user) */
export interface OverviewResponse {
  agent: { status: FriendlyStatus; last_seen: string | null; machine_name: string | null };
  brands: { active: number; warmup: number; paused: number; issue: number };
  today: { scheduled: number; published: number; errors: number };
  week: { reach: number; engagement_rate: number; followers_gained: number; top_platform: Platform | null };
  action_needed: ActionItem[];
  brand_rows: BrandSummary[];
}

export interface ActionItem {
  kind: 'session_expired' | 'pending_approval' | 'agent_offline' | 'crisis' | 'action_block' | 'flagged_content' | 'ban';
  brand_id?: string;
  platform?: Platform;
  message: string;
  href?: string;
}

export interface Incident {
  id: number;
  user_id: string;
  brand_id: string | null;
  platform: Platform | null;
  incident_type: IncidentType;
  detected_at: string;
  resolved_at: string | null;
  resume_after: string | null;
  notes: string | null;
}

// ───────────────────────────────── agent (launcher) ─────────────────────────────────

/** POST /agent/register */
export interface AgentRegisterRequest {
  machine_name: string;
  version: string;
  adspower_status: AdsPowerStatus;
  agent_id?: string;               // reuse the id stored locally, if any
}
export interface AgentRegisterResponse {
  agent_id: string;
  user: { name: string | null; plan: Plan; agency_name: string };
  config: { poll_interval_ms: number; heartbeat_interval_ms: number; max_concurrent_jobs: number };
}

/** POST /agent/heartbeat */
export interface HeartbeatRequest {
  agent_id: string;
  adspower_status: AdsPowerStatus;
  ram_percent: number;
  active_jobs: number;
  paused: boolean;
  version: string;
}
export interface HeartbeatResponse { ok: true; paused_by_brain: boolean; latest_version: string | null }

/** GET /agent/jobs?agent_id=...&slots=N  → leases up to N jobs */
export interface JobsResponse { jobs: Job[] }

/**
 * A job leased to the launcher. The launcher never decides anything:
 * it waits until scheduled_for, opens the AdsPower profile, fetches the playbook,
 * runs the steps with the delays given here, and reports the result.
 */
export interface Job {
  id: string;
  type: string;                    // == playbook type, e.g. "instagram_post"
  platform: Platform | 'tool';     // 'tool' = agency's own Canva/CapCut profile
  brand_id: string | null;
  brand_name: string | null;
  post_id: number | null;
  adspower_profile_id: string;
  scheduled_for: string;
  expires_at: string;              // do not start after this — report status 'expired'
  playbook_version: number;
  hbe: HbePlan;
  payload: Record<string, unknown>;   // referenced by playbook templates as {{payload.x}}
  timeout_ms: number;
  label: string;                   // human text for Live Activity, e.g. "Posting Reel — Morning workout tips…"
}

/** Human Behaviour Engine plan — computed by the brain, obeyed by the launcher. */
export interface HbePlan {
  hbe_delay_ms: number;            // default pause between steps
  step_delays_ms: number[];        // per-step override (index = step index), may be shorter than steps
  typing: { min_char_ms: number; max_char_ms: number; typo_rate: number; word_pause_rate: number; word_pause_ms: [number, number] };
  think_ms: number;                // pause before the final "publish" click
}

/** POST /agent/progress — also the cancel channel: `cancel: true` means the brain cancelled the job
 *  (brand paused, post rejected, crisis…). The launcher stops at once and reports status 'cancelled'. */
export interface JobProgressRequest { job_id: string; step_index: number; step_total: number; label: string }
export interface JobProgressResponse { ok: true; cancel: boolean }

/** POST /agent/result */
export interface JobResultRequest {
  job_id: string;
  agent_id: string;
  status: 'success' | 'failed' | 'expired' | 'cancelled';
  started_at: string;
  finished_at: string;
  outputs?: Record<string, unknown>;  // values captured by `extract` / `extract_list` steps
  error?: { code: ErrorCode; message: string; step_id?: string };
  screenshot_b64?: string;            // PNG, optional, confirmation or failure evidence
}
export interface JobResultResponse { ok: true }

/** POST /agent/error */
export interface AgentErrorRequest { agent_id: string; message: string; stack?: string; context?: Record<string, unknown> }

/** GET /agent/profiles — what the launcher's Profile Manager shows */
export interface AgentProfilesResponse {
  brands: Array<{
    brand_id: string;
    brand_name: string;
    profiles: Array<Pick<PlatformProfile,
      'id' | 'platform' | 'handle' | 'adspower_profile_id' | 'proxy_type' | 'proxy_host' | 'proxy_port' | 'status' | 'warmup_day' | 'session_healthy' | 'last_action_at'>>;
  }>;
}

/** POST /agent/profiles — create/update a profile from the launcher's Add Profile screen */
export type AgentUpsertProfileRequest = UpsertProfileRequest & { brand_id: string };

/** POST /agent/profiles/health */
export interface ProfileHealthRequest { profile_id: number; healthy: boolean; reason?: ErrorCode; detected_ip?: string }

/** GET /agent/stats */
export interface AgentStatsResponse {
  today: { jobs_completed: number; posts_published: number; comments_replied: number; follows: number; errors: number };
  recent: Array<{ at: string; brand_name: string | null; platform: Platform | 'tool'; label: string; status: JobStatus }>;
  upcoming: Array<{ at: string; brand_name: string | null; platform: Platform | 'tool'; label: string }>;
}

// ───────────────────────────────── playbooks ─────────────────────────────────

/**
 * GET /agent/playbook/:type → Playbook
 * Fetched per job, held in memory only, never written to disk by the launcher.
 *
 * Templates: any string field (selectors and click_text included) may contain {{payload.x}},
 * {{item.x}}, {{outputs.x}}, {{hbe.think_ms}}. A string that is exactly one template resolves to
 * the raw value (array / number / boolean). `text` values are typed with HbePlan.typing timing.
 *
 * Inside `foreach`: `extract_list` APPENDS rows to outputs[as] and adds `_item` (the current item)
 * to every row; `extract` collects one value per iteration into an array outputs[as].
 * `attr: "href" | "src"` always yields an ABSOLUTE URL (resolved against the page URL).
 */
export interface Playbook {
  type: string;
  version: number;
  platform: Platform | 'tool';
  description: string;
  start_url?: string;
  steps: PlaybookStep[];
  /** Checked after every navigation; first match aborts the job with its code. */
  guards?: Array<{ selector?: string; url_contains?: string; text?: string; code: ErrorCode }>;
}

export type PlaybookStep =
  | { id: string; action: 'goto'; url: string; label?: string }
  | { id: string; action: 'wait_for'; selector: string; timeout_ms?: number; optional?: boolean; label?: string }
  | { id: string; action: 'click'; selector: string; optional?: boolean; label?: string }
  | { id: string; action: 'click_text'; text: string; role?: string; optional?: boolean; label?: string }
  | { id: string; action: 'type'; selector: string; text: string; clear?: boolean; label?: string }
  | { id: string; action: 'press'; key: string; label?: string }
  | { id: string; action: 'upload'; selector: string; files: string; label?: string }  // template resolving to string[] of URLs
  | { id: string; action: 'scroll'; pixels: number; times?: number; label?: string }
  | { id: string; action: 'delay'; ms: number | string; label?: string }
  | { id: string; action: 'think'; label?: string }                                    // waits hbe.think_ms
  | { id: string; action: 'assert'; selector?: string; text?: string; code: ErrorCode; label?: string }
  | { id: string; action: 'extract'; selector: string; attr?: string; as: string; optional?: boolean; label?: string }
  | { id: string; action: 'extract_url'; as: string; label?: string }
  | { id: string; action: 'extract_list'; selector: string; as: string; limit?: number;
      fields: Record<string, { selector?: string; attr?: string }>; label?: string }
  | { id: string; action: 'if_exists'; selector: string; then: PlaybookStep[]; else?: PlaybookStep[]; label?: string }
  | { id: string; action: 'foreach'; items: string; steps: PlaybookStep[]; label?: string }
  | { id: string; action: 'screenshot'; as?: string; label?: string }
  /** Protocol 5 (profile corruption): save/restore the profile's cookies + localStorage in an encrypted file
   *  ON THE USER'S PC ONLY (never sent to the brain). outputs[as] = number of cookies saved/restored. */
  | { id: string; action: 'backup_session'; as?: string; label?: string }
  | { id: string; action: 'restore_session'; as?: string; optional?: boolean; label?: string };

// ───────────────────────────────── client portal ─────────────────────────────────

/** POST /portal/login (internal) */
export interface PortalLoginRequest { email: string; password: string; host?: string }
export interface PortalClient {
  id: number;
  agency_user_id: string;
  brand_id: string;
  client_name: string;
  client_email: string;
  approval_mode: ApprovalMode;
}
export interface PortalLoginResponse { client: PortalClient }
/** GET /portal/brand → { brand, profiles } (read only, proxy fields stripped) */
/** GET /portal/content/pending → PendingResponse ;  GET /portal/content/calendar?from&to → CalendarResponse */
/** POST /portal/content/:id/approve ; POST /portal/content/:id/reject (RejectRequest) */
/** GET /portal/analytics?days= → AnalyticsSummaryResponse ;  GET /portal/reports → ReportsResponse */
/** POST /portal/feedback */
export interface FeedbackRequest { message: string }

// ───────────────────────────────── reports ─────────────────────────────────

export interface Report { id: number; brand_id: string; month: string; file_name: string; created_at: string; emailed_at: string | null }
export interface ReportsResponse { reports: Report[] }
/** POST /reports/generate/:brandId {month?: 'YYYY-MM'} → { report } ;  GET /reports/file/:id → application/pdf */

// ───────────────────────────────── agency / white-label ─────────────────────────────────

export interface Branding {
  agency_name: string;
  logo_url: string;
  favicon_url?: string | null;
  primary_color: string;
  secondary_color?: string;
  hide_powered_by: boolean;
}

export interface AgencyConfig extends Branding {
  user_id: string;
  custom_domain: string | null;
  subdomain_slug: string | null;
  domain_verified: boolean;
  ssl_provisioned: boolean;
  sender_name: string | null;
  sender_email: string | null;
  reply_to: string | null;
  smtp_host: string | null;
  smtp_user: string | null;
  report_footer_text: string | null;
  report_footer_website: string | null;
}
/** GET /agency/by-domain?domain= and /agency/by-slug?slug=  (internal) → { branding } | 404 */
export interface BrandingResponse { branding: Branding }
/** GET/PUT /agency/config → { config } (PUT accepts Partial<AgencyConfig> & { smtp_pass?: string }) */

export interface AgencyClient {
  id: number;
  agency_user_id: string;
  brand_id: string;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  approval_mode: ApprovalMode;
  status: BrandStatus;
  warmup_start_date: string | null;
  onboarded_at: string | null;
  last_login: string | null;
  notes: string | null;
  portal_enabled: boolean;
}

/** POST /agency/clients — the 6-step wizard in one request */
export interface CreateClientRequest {
  client: { name: string; email: string; phone?: string; niche: string; audience: string; tone: string; pillars: string[]; competitors?: string[]; blacklist?: string[]; timezone?: string };
  platforms: Platform[];
  profiles: Array<{ platform: Platform; adspower_profile_id: string; handle?: string }>;
  proxy: { type: ProxyType; host?: string; port?: string; user?: string; pass?: string };
  portal: { enabled: boolean; email?: string; send_welcome?: boolean; approval_mode: ApprovalMode };
  warmup: { new_accounts: boolean };
}
export interface CreateClientResponse { client: AgencyClient; brand: Brand; portal_password?: string; welcome_sent: boolean }

/** GET /agency/clients → { clients: Array<AgencyClient & { brand: BrandSummary }> } */
/** POST /agency/clients/bulk { ids: number[], action: 'pause'|'resume'|'send_preview'|'generate' } */

// ───────────────────────────────── ad manager (M18) ─────────────────────────────────

export interface AdCampaign {
  id: number;
  brand_id: string;
  platform: 'meta' | 'tiktok';
  post_id: number | null;
  campaign_id: string | null;
  ad_type: 'boost' | 'lead_gen' | 'reach';
  objective: string;
  budget: number;
  daily_budget: number;
  duration_days: number;
  max_cpa: number | null;
  status: 'pending' | 'active' | 'paused' | 'completed' | 'failed';
  started_at: string | null;
  ended_at: string | null;
  pause_reason: string | null;
  metrics: { spend: number; impressions: number; clicks: number; leads: number; cpc: number; cpa: number; roas: number } | null;
}
/** GET /ads/candidates/:brandId → { candidates: Array<Post & { boost_score: number }> } */
/** POST /ads/boost { post_id, budget, duration_days, objective?, max_cpa? } → { campaign } */
/** GET /ads/campaigns?brand_id= → { campaigns } ; POST /ads/campaigns/:id/pause */

// ───────────────────────────────── admin ─────────────────────────────────

/** GET /admin/users → { users: Array<PublicUser & { brands: number; agent_status: AgentStatus | null }> } */
/** GET /admin/system-health */
export interface SystemHealthResponse {
  queues: Record<string, { waiting: number; active: number; failed: number; delayed: number }>;
  agents: { online: number; offline: number };
  errors_24h: number;
  db_size_mb: number;
  uptime_s: number;
  vault_unlocked: boolean;
  ai: { claude: boolean; ollama: boolean };
}
/** POST /admin/user/:id/suspend | /admin/user/:id/unsuspend | PUT /admin/user/:id/plan {plan} */
/** GET /admin/metrics/revenue → { mrr: number, active_users: number, trial_users: number, churn_30d: number, by_plan: Record<Plan, number> } */

// ───────────────────────────────── additional endpoints (v1.1) ─────────────────────────────────

/** POST /brands → { brand: Brand } · POST|PUT /brands/:id/profiles[/:profileId] → { profile: PlatformProfile } */
/** POST /brands/:id/pause { reason?, resume_expected? } · POST /brands/:id/resume · POST /brands/:id/crisis/resolve → BrandDetailResponse */
/** POST /brands/:id/profiles/:profileId/health-check → 202 { job_id }  (dashboard "Test") */
/** POST /agent/profiles/:id/health-check → 202 { job_id }             (launcher "Test"; result arrives via the normal job flow) */
/** POST /content/:postId/media { files: [{ name, data_b64 }] } → PostResponse   (png/jpg/webp/mp4/mov/pdf) */

/** GET /approval/:token (internal) — one-click email links */
export interface ApprovalLinkResponse { brand_name: string; brand_id: string; timezone: string; branding: Branding; posts: Post[] }
/** POST /approval/:token/decide */
export interface ApprovalDecideRequest { post_id: number; decision: 'approve' | 'reject' | 'revise'; feedback?: string }

/** POST /billing/plan-update (internal, from the verified Stripe webhook) */
export interface PlanUpdateRequest {
  user_id: string;
  plan?: Plan;
  status?: UserStatus;               // subscription deleted → 'suspended', trialing → 'trial'
  stripe_status?: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  own_accounts_addon?: boolean;
  plan_expires_at?: string | null;
}

/** PUT /auth/profile { name?, email? } → { user } · POST /auth/change-password { current_password, new_password } */
/** GET|PUT /auth/notifications { telegram_chat_id } */

/** POST /agency/clients/:id/pause|resume → { client } · POST /agency/clients/:id/reset-password { send_email? } → { portal_password, welcome_sent } */
/** GET /agency/clients/:id → { client, brand: BrandSummary, profiles: PlatformProfile[], analytics: AnalyticsSummaryResponse } */
export interface DomainVerifyResponse { verified: boolean; found: string; expected: string; ssl_provisioned: boolean; message: string }

/** GET /agency/analytics/overview */
export interface AgencyAnalyticsResponse {
  month: string;
  clients_managed: number;
  active_clients: number;
  platforms_active: number;
  totals: { posts: number; reach: number; followers_gained: number; engagement_rate: number };
  top_clients: Array<{ client_id: number; name: string; followers_gained: number; reach: number; engagement_rate: number }>;
  needs_attention: Array<{ brand_id: string; name: string; reason: string; since: string | null }>;
  platform_breakdown: Array<{ platform: Platform; reach: number; share: number; engagement_rate: number }>;
  agent_errors_30d: number;
}
/** POST /agency/reports/bulk { month?, email? } → 202 { queued } */

/** POST /ads/credentials/:brandId  { platform:'meta', access_token, ad_account_id, page_id, instagram_user_id? } | { platform:'tiktok', access_token, advertiser_id, identity_id?, identity_type? } */

/** Own accounts (M17): GET /own/portfolio · POST /own/revenue · GET /own/revenue/:accountId · POST /own/links → { code, url } · GET|POST /own/ab-tests
 *  GET /own/click/:code (internal) → { target }   — the dashboard's public /r/:code logs the click and redirects. */

/** Vault (super admin): GET /vault/status → { exists, unlocked } · POST /vault/unlock { password } · POST /vault/lock */
/** Admin extras: PUT /admin/user/:id/role { role } · GET /admin/live → { running, next_hour } */
/** Incidents: GET /incidents?open=1 → { incidents: Incident[] } · POST /incidents/:id/resolve */
