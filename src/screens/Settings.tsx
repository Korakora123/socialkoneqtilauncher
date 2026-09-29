import { useEffect, useState } from 'react';
import { sk } from '../renderer/bridge';
import type { AgentSnapshot, SettingsView } from '../shared/ipc';
import { Card, Details, Notice } from '../components/ui';

type Msg = { kind: 'ok' | 'error' | 'info'; text: string; details?: string } | null;

export function Settings({ snap }: { snap: AgentSnapshot }): JSX.Element {
  const [s, setS] = useState<SettingsView | null>(null);
  const [brainUrl, setBrainUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [adsUrl, setAdsUrl] = useState('');
  const [adsKey, setAdsKey] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sk.getSettings().then((v) => { setS(v); setBrainUrl(v.brain_url); setAdsUrl(v.adspower_url); });
  }, []);

  if (!s) return <div className="text-ink-2">Loading…</div>;

  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await sk.saveSettings({
      ...(brainUrl !== s.brain_url ? { brain_url: brainUrl } : {}),
      ...(adsUrl !== s.adspower_url ? { adspower_url: adsUrl } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(adsKey ? { adspower_api_key: adsKey } : {}),
    });
    setBusy(false);
    if (r.ok) { setS(r.data); setApiKey(''); setAdsKey(''); setMsg({ kind: 'ok', text: 'Saved — reconnecting…' }); }
    else setMsg({ kind: 'error', text: r.error.message });
  };

  const validate = async (): Promise<void> => {
    setBusy(true);
    const r = await sk.validateKey();
    setBusy(false);
    setMsg(r.ok
      ? { kind: 'ok', text: `API key is valid — ${r.data.user.name ?? 'your account'} (${r.data.user.plan} plan)` }
      : { kind: 'error', text: 'This API key was not accepted. Copy it again from Settings in the dashboard.', details: r.error.message });
  };

  const testConn = async (): Promise<void> => {
    setBusy(true);
    const r = await sk.testConnection();
    setBusy(false);
    if (!r.ok) return setMsg({ kind: 'error', text: 'Test failed', details: r.error.message });
    const parts = [r.data.brain ? 'SocialKoneqti reachable' : 'SocialKoneqti not reachable', r.data.adspower === 'running' ? 'AdsPower running' : 'AdsPower not detected'];
    setMsg({ kind: r.data.brain && r.data.adspower === 'running' ? 'ok' : 'error', text: parts.join(' · ') });
  };

  const toggleAuto = async (v: boolean): Promise<void> => {
    const r = await sk.saveSettings({ auto_start: v });
    if (r.ok) setS(r.data);
  };

  const updates = async (): Promise<void> => {
    const r = await sk.checkForUpdates();
    setMsg(r.ok ? { kind: r.data.available ? 'ok' : 'info', text: r.data.message } : { kind: 'error', text: r.error.message });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="font-display text-2xl font-bold">Settings</h1>

      <Card title="Connection">
        <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-3 text-sm">
          <label className="text-ink-2" htmlFor="brain">Brain URL</label>
          <input id="brain" className="input" value={brainUrl} onChange={(e) => setBrainUrl(e.target.value)} />
          <label className="text-ink-2" htmlFor="key">API key</label>
          <input id="key" className="input font-mono" type="password" autoComplete="off"
            placeholder={s.has_api_key ? s.api_key_masked : 'sk_live_… (from dashboard → Settings)'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>Save</button>
          <button type="button" className="btn-ghost" disabled={busy || !s.has_api_key} onClick={() => void validate()}>Validate key</button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void testConn()}>Test connection</button>
        </div>
      </Card>

      <Card title="AdsPower">
        <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-3 text-sm">
          <label className="text-ink-2" htmlFor="ads">Local API URL</label>
          <input id="ads" className="input" value={adsUrl} onChange={(e) => setAdsUrl(e.target.value)} />
          <label className="text-ink-2" htmlFor="adskey">API key (optional)</label>
          <input id="adskey" className="input font-mono" type="password" autoComplete="off"
            placeholder={s.has_adspower_api_key ? 'Saved' : 'Only if AdsPower API security is on'} value={adsKey} onChange={(e) => setAdsKey(e.target.value)} />
        </div>
        <div className="mt-4"><button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>Save</button></div>
      </Card>

      <Card title="Preferences">
        <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm">
          <span>Start automatically when Windows starts</span>
          <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={s.auto_start} onChange={(e) => void toggleAuto(e.target.checked)} />
        </label>
        <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm">
          <span>Pause all agents</span>
          <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={snap.paused_local} onChange={(e) => void (e.target.checked ? sk.pause() : sk.resume())} />
        </label>
      </Card>

      <Card title="About">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-2">Version {s.version}{snap.latest_version && snap.latest_version !== s.version ? ` · ${snap.latest_version} available` : ''}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => void updates()}>Check for updates</button>
        </div>
      </Card>

      {msg && <Notice kind={msg.kind}>{msg.text}{msg.details && <Details text={msg.details} />}</Notice>}
    </div>
  );
}
