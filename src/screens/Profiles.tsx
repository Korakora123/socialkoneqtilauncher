import { useCallback, useEffect, useMemo, useState } from 'react';
import { sk } from '../renderer/bridge';
import type { AgentProfilesResponse, ProfileStatus } from '../shared/contract';
import type { AdsPowerProfile, ProfileTestResult } from '../shared/ipc';
import { Card, Details, Dot, Notice, PLATFORM_ICON, PLATFORM_NAME, timeAgo } from '../components/ui';
import type { ProfileDraft } from './AddProfile';

type BrainProfile = AgentProfilesResponse['brands'][number]['profiles'][number];

function health(p: BrainProfile): { color: string; text: string } {
  const s: ProfileStatus = p.status;
  if (s === 'session_expired') return { color: '#EF4444', text: 'Login needed' };
  if (s === 'blocked' || s === 'banned') return { color: '#EF4444', text: 'Action needed' };
  if (s === 'paused') return { color: '#94A3B8', text: 'Paused' };
  if (s === 'warmup') return { color: '#F59E0B', text: `Warming up · day ${p.warmup_day}` };
  return p.session_healthy ? { color: '#10B981', text: 'Healthy' } : { color: '#F59E0B', text: 'Check needed' };
}

const PROXY_NAME: Record<string, string> = {
  static_residential: 'Residential', wireguard: 'WireGuard', mobile: 'Mobile', none: 'No proxy',
};

/** §48 Screen 2 — Profile Manager. */
export function Profiles({ onAdd }: { onAdd: (d: ProfileDraft | null) => void }): JSX.Element {
  const [brain, setBrain] = useState<AgentProfilesResponse | null>(null);
  const [ads, setAds] = useState<AdsPowerProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adsError, setAdsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tests, setTests] = useState<Record<string, ProfileTestResult | 'running'>>({});
  const [bulk, setBulk] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, a] = await Promise.all([sk.getBrainProfiles(), sk.getAdsPowerProfiles()]);
    if (b.ok) { setBrain(b.data); setError(null); } else setError(b.error.message);
    if (a.ok) { setAds(a.data); setAdsError(null); } else { setAds(null); setAdsError(a.error.message); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const adsIds = useMemo(() => new Set((ads ?? []).map((p) => p.user_id)), [ads]);
  const linked = useMemo(() => new Set((brain?.brands ?? []).flatMap((b) => b.profiles.map((p) => p.adspower_profile_id))), [brain]);
  const unassigned = (ads ?? []).filter((p) => !linked.has(p.user_id));

  const test = async (adsId: string, profileId?: number): Promise<void> => {
    setTests((t) => ({ ...t, [adsId]: 'running' }));
    const r = await sk.testProfile(adsId, profileId);
    setTests((t) => ({ ...t, [adsId]: r.ok ? r.data : { opened: false, ip: null, error: { code: r.error.code ?? 'UNKNOWN', message: r.error.message } } }));
  };

  const healthAll = async (): Promise<void> => {
    setBulk(true);
    for (const b of brain?.brands ?? []) {
      for (const p of b.profiles) await test(p.adspower_profile_id, p.id);
    }
    setBulk(false);
    void load();
  };

  const relogin = async (adsId: string): Promise<void> => {
    const r = await sk.openProfile(adsId);
    setTests((t) => ({ ...t, [adsId]: r.ok ? { opened: true, ip: null, error: null } : { opened: false, ip: null, error: { code: r.error.code ?? 'ADSPOWER_ERROR', message: r.error.message } } }));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">Profile Manager</h1>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={() => onAdd(null)}>+ Add Profile</button>
          <button type="button" className="btn-ghost" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh All'}</button>
          <button type="button" className="btn-ghost" disabled={bulk || !brain} onClick={() => void healthAll()}>{bulk ? 'Checking…' : 'Health Check All'}</button>
        </div>
      </div>

      {error && <Notice kind="error">We could not load your profiles right now. <Details text={error} /></Notice>}
      {adsError && <Notice kind="info">AdsPower is not responding — open AdsPower to see local profiles. <Details text={adsError} /></Notice>}

      {brain && brain.brands.length === 0 && (
        <Card><p className="text-sm text-ink-2">No brand profiles yet. Create a brand in the dashboard, then add its AdsPower profiles here.</p></Card>
      )}

      {brain?.brands.map((b) => (
        <Card key={b.brand_id} title={`Brand: ${b.brand_name}`}>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {b.profiles.map((p) => {
              const h = health(p);
              const t = tests[p.adspower_profile_id];
              const missing = ads !== null && !adsIds.has(p.adspower_profile_id);
              return (
                <div key={p.id} className="py-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="w-6 text-lg">{PLATFORM_ICON[p.platform]}</span>
                    <span className="w-24 font-medium">{PLATFORM_NAME[p.platform]}</span>
                    <span className="text-sm text-ink-2">profile: <span className="font-mono text-ink-1">{p.adspower_profile_id}</span></span>
                    <span className="ml-auto inline-flex items-center gap-2 text-sm"><Dot color={h.color} /> {h.text}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 pl-9 text-sm text-ink-2">
                    <span>Handle: <span className="text-ink-1">{p.handle ?? '—'}</span></span>
                    <span>Last: {timeAgo(p.last_action_at)}</span>
                    <span>IP: {t && t !== 'running' && t.ip ? t.ip : p.proxy_host ?? '—'} ({PROXY_NAME[p.proxy_type] ?? p.proxy_type})</span>
                    {missing && <span className="text-gold">Not found in AdsPower</span>}
                    <span className="ml-auto flex gap-2">
                      {p.status === 'session_expired' && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => void relogin(p.adspower_profile_id)}>Re-login</button>
                      )}
                      <button type="button" className="btn-ghost btn-sm" onClick={() => onAdd({
                        brand_id: b.brand_id, platform: p.platform, handle: p.handle ?? '', adspower_profile_id: p.adspower_profile_id,
                        proxy_type: p.proxy_type, proxy_host: p.proxy_host ?? '', proxy_port: p.proxy_port ?? '',
                      })}>Edit</button>
                      <button type="button" className="btn-ghost btn-sm" disabled={t === 'running'} onClick={() => void test(p.adspower_profile_id, p.id)}>
                        {t === 'running' ? 'Testing…' : 'Test'}
                      </button>
                    </span>
                  </div>
                  {t && t !== 'running' && (
                    <div className="mt-2 pl-9">
                      {t.opened
                        ? <Notice kind="ok">Profile opened successfully{t.ip ? ` — IP: ${t.ip}` : ''}</Notice>
                        : <Notice kind="error">This profile could not be opened. <Details text={t.error ? `${t.error.code}: ${t.error.message}` : null} /></Notice>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" className="btn-ghost btn-sm mt-3" onClick={() => onAdd({ brand_id: b.brand_id })}>+ Add Brand Profile</button>
        </Card>
      ))}

      {unassigned.length > 0 && (
        <Card title="AdsPower profiles not linked to a brand">
          <div className="space-y-2">
            {unassigned.map((p) => (
              <div key={p.user_id} className="flex items-center gap-3 text-sm">
                <span className="font-mono text-ink-1">{p.user_id}</span>
                <span className="text-ink-2">{p.name}{p.group_name ? ` · ${p.group_name}` : ''}</span>
                <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => onAdd({ adspower_profile_id: p.user_id })}>Assign</button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
