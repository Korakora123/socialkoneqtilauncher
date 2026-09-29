import { useEffect, useState } from 'react';
import { sk } from '../renderer/bridge';
import { PLATFORMS, type AgentProfilesResponse, type Platform, type ProxyType } from '../shared/contract';
import type { AdsPowerProfile, ProfileTestResult } from '../shared/ipc';
import { Card, Details, Notice, PLATFORM_NAME } from '../components/ui';

export interface ProfileDraft {
  brand_id?: string;
  platform?: Platform;
  handle?: string;
  adspower_profile_id?: string;
  proxy_type?: ProxyType;
  proxy_host?: string;
  proxy_port?: string;
}

const PROXY_OPTIONS: Array<{ value: ProxyType; label: string }> = [
  { value: 'wireguard', label: 'WireGuard (client home IP)' },
  { value: 'static_residential', label: 'Static residential (IPRoyal / Bright Data)' },
  { value: 'mobile', label: 'Mobile proxy' },
  { value: 'none', label: 'No proxy (set in AdsPower)' },
];

/** §48 Screen 3 — Add/Edit Profile. */
export function AddProfile({ draft, onDone }: { draft: ProfileDraft | null; onDone: () => void }): JSX.Element {
  const [brands, setBrands] = useState<AgentProfilesResponse['brands']>([]);
  const [ads, setAds] = useState<AdsPowerProfile[] | null>(null);
  const [brandId, setBrandId] = useState(draft?.brand_id ?? '');
  const [platform, setPlatform] = useState<Platform>(draft?.platform ?? 'instagram');
  const [handle, setHandle] = useState(draft?.handle ?? '');
  const [adsId, setAdsId] = useState(draft?.adspower_profile_id ?? '');
  const [proxyType, setProxyType] = useState<ProxyType>(draft?.proxy_type ?? 'static_residential');
  const [host, setHost] = useState(draft?.proxy_host ?? '');
  const [port, setPort] = useState(draft?.proxy_port ?? '');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [test, setTest] = useState<ProfileTestResult | 'running' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetect, setShowDetect] = useState(false);
  const editing = Boolean(draft?.platform && draft?.brand_id);

  useEffect(() => {
    void sk.getBrainProfiles().then((r) => {
      if (r.ok) {
        setBrands(r.data.brands);
        if (!brandId && r.data.brands[0]) setBrandId(r.data.brands[0].brand_id);
      }
    });
  }, [brandId]);

  const detect = async (): Promise<void> => {
    setShowDetect(true);
    const r = await sk.getAdsPowerProfiles();
    setAds(r.ok ? r.data : []);
    if (!r.ok) setError('AdsPower is not responding — please open AdsPower and try again.');
  };

  const runTest = async (): Promise<void> => {
    if (!adsId) return;
    setTest('running');
    const r = await sk.testProfile(adsId);
    setTest(r.ok ? r.data : { opened: false, ip: null, error: { code: r.error.code ?? 'UNKNOWN', message: r.error.message } });
  };

  const save = async (): Promise<void> => {
    setError(null);
    if (!brandId) return setError('Choose a brand.');
    if (!adsId.trim()) return setError('Enter the AdsPower profile ID.');
    setSaving(true);
    const r = await sk.saveProfile({
      brand_id: brandId,
      platform,
      adspower_profile_id: adsId.trim(),
      ...(handle.trim() ? { handle: handle.trim() } : {}),
      proxy_type: proxyType,
      ...(proxyType !== 'none' && host.trim() ? { proxy_host: host.trim() } : {}),
      ...(proxyType !== 'none' && port.trim() ? { proxy_port: port.trim() } : {}),
      ...(proxyType !== 'none' && user.trim() ? { proxy_user: user.trim() } : {}),
      ...(proxyType !== 'none' && pass ? { proxy_pass: pass } : {}),
    });
    setSaving(false);
    if (r.ok) onDone();
    else setError(r.error.message);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="font-display text-2xl font-bold">{editing ? 'Edit Profile' : 'Add Profile'}</h1>
      <Card>
        <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-3 text-sm">
          <label className="text-ink-2" htmlFor="brand">Brand</label>
          <select id="brand" className="input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            {brands.length === 0 && <option value="">No brands yet — create one in the dashboard</option>}
            {brands.map((b) => <option key={b.brand_id} value={b.brand_id}>{b.brand_name}</option>)}
          </select>

          <label className="text-ink-2" htmlFor="platform">Platform</label>
          <select id="platform" className="input" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_NAME[p]}</option>)}
          </select>

          <label className="text-ink-2" htmlFor="handle">Handle</label>
          <input id="handle" className="input" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />

          <label className="text-ink-2" htmlFor="ads">AdsPower ID</label>
          <div className="flex gap-2">
            <input id="ads" className="input font-mono" placeholder="e.g. jxxxxxx" value={adsId} onChange={(e) => setAdsId(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={() => void detect()}>Auto-detect</button>
          </div>
        </div>
        {showDetect && (
          <div className="mt-3 max-h-48 overflow-y-auto rounded-lg border bg-navy-4 p-2" style={{ borderColor: 'var(--border-2)' }}>
            {ads === null ? <div className="p-2 text-sm text-ink-2">Reading AdsPower…</div>
              : ads.length === 0 ? <div className="p-2 text-sm text-ink-2">No AdsPower profiles found.</div>
              : ads.map((p) => (
                <button key={p.user_id} type="button" onClick={() => { setAdsId(p.user_id); setShowDetect(false); }}
                  className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-navy-3">
                  <span className="font-mono">{p.user_id}</span>
                  <span className="text-ink-2">{p.name}{p.group_name ? ` · ${p.group_name}` : ''}</span>
                </button>
              ))}
          </div>
        )}
      </Card>

      <Card title="Proxy settings">
        <div className="mb-4 space-y-2">
          {PROXY_OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-3 text-sm">
              <input type="radio" name="proxy" className="accent-violet-600" checked={proxyType === o.value} onChange={() => setProxyType(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
        {proxyType !== 'none' && (
          <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-3 text-sm">
            <label className="text-ink-2" htmlFor="host">Host</label>
            <input id="host" className="input" value={host} onChange={(e) => setHost(e.target.value)} />
            <label className="text-ink-2" htmlFor="port">Port</label>
            <input id="port" className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            <label className="text-ink-2" htmlFor="user">Username</label>
            <input id="user" className="input" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            <label className="text-ink-2" htmlFor="pass">Password</label>
            <input id="pass" className="input" type="password" autoComplete="new-password" placeholder={editing ? 'Leave empty to keep the saved password' : ''} value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">The proxy password is sent to your encrypted vault and never stored on this computer.</p>

        <div className="mt-4 space-y-2">
          <button type="button" className="btn-ghost" disabled={!adsId || test === 'running'} onClick={() => void runTest()}>
            {test === 'running' ? 'Testing…' : 'Test Connection'}
          </button>
          {test && test !== 'running' && (test.opened
            ? <Notice kind="ok">✅ Connection successful{test.ip ? ` — IP: ${test.ip}` : ''}</Notice>
            : <Notice kind="error">The profile could not be opened. <Details text={test.error ? `${test.error.code}: ${test.error.message}` : null} /></Notice>)}
        </div>
      </Card>

      {error && <Notice kind="error">{error}</Notice>}

      <div className="flex justify-end gap-3">
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
        <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Profile'}</button>
      </div>
    </div>
  );
}
