import { useEffect, useState } from 'react';
import { sk } from './renderer/bridge';
import type { AgentSnapshot } from './shared/ipc';
import { StatusPill } from './components/ui';
import { Status } from './screens/Status';
import { Profiles } from './screens/Profiles';
import { AddProfile, type ProfileDraft } from './screens/AddProfile';
import { LiveActivity } from './screens/LiveActivity';
import { Settings } from './screens/Settings';

export type Screen = 'status' | 'profiles' | 'add-profile' | 'activity' | 'settings';

const NAV: Array<{ id: Screen; label: string; icon: string }> = [
  { id: 'status', label: 'Status', icon: '◉' },
  { id: 'profiles', label: 'Profiles', icon: '▤' },
  { id: 'activity', label: 'Live Activity', icon: '⚡' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

function useSnapshot(): AgentSnapshot | null {
  const [snap, setSnap] = useState<AgentSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    void sk.getSnapshot().then((s) => { if (alive) setSnap(s); });
    const off = sk.onSnapshot((s) => setSnap(s));
    return () => { alive = false; off(); };
  }, []);
  return snap;
}

export function App(): JSX.Element {
  const snap = useSnapshot();
  const [screen, setScreen] = useState<Screen>('status');
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  const openAdd = (d: ProfileDraft | null): void => { setDraft(d); setScreen('add-profile'); };

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-navy-2 p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-violet font-display text-sm font-extrabold text-white">SK</div>
          <div>
            <div className="font-display text-sm font-bold leading-tight">SocialKoneqti</div>
            <div className="text-xs text-ink-3">Agent</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => {
            const active = screen === n.id || (n.id === 'profiles' && screen === 'add-profile');
            return (
              <button key={n.id} type="button" onClick={() => setScreen(n.id)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${active ? 'bg-navy-4 text-ink-1' : 'text-ink-2 hover:bg-navy-3'}`}>
                <span className={active ? 'text-violet-light' : 'text-ink-3'}>{n.icon}</span>
                {n.label}
                {n.id === 'activity' && (snap?.running.length ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-violet px-2 text-xs text-white">{snap?.running.length}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto space-y-2 px-2">
          {snap && <StatusPill status={snap.status} />}
          <div className="text-xs text-ink-3">v{snap?.version ?? ''}</div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        {!snap ? (
          <div className="text-ink-2">Starting…</div>
        ) : screen === 'status' ? (
          <Status snap={snap} onSettings={() => setScreen('settings')} />
        ) : screen === 'profiles' ? (
          <Profiles snap={snap} onAdd={openAdd} />
        ) : screen === 'add-profile' ? (
          <AddProfile draft={draft} onDone={() => setScreen('profiles')} />
        ) : screen === 'activity' ? (
          <LiveActivity snap={snap} />
        ) : (
          <Settings snap={snap} />
        )}
      </main>
    </div>
  );
}
