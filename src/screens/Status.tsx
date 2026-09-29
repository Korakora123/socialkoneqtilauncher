import { useEffect, useState } from 'react';
import { sk } from '../renderer/bridge';
import type { AgentStatsResponse } from '../shared/contract';
import type { AgentSnapshot } from '../shared/ipc';
import { Card, Details, Dot, FRIENDLY, Row, timeAgo } from '../components/ui';

const PLAN_NAME: Record<string, string> = { starter: 'Starter', growth: 'Growth', pro: 'Pro', agency: 'Agency' };

/** §48 Screen 1 — Connection Status. */
export function Status({ snap, onSettings }: { snap: AgentSnapshot; onSettings: () => void }): JSX.Element {
  const [stats, setStats] = useState<AgentStatsResponse | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = (): void => { void sk.getStats().then((r) => { if (alive && r.ok) setStats(r.data); }); };
    load();
    const t = setInterval(load, 30_000);
    const clockT = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(clockT); };
  }, [snap.status]);

  const f = FRIENDLY[snap.status];
  const paused = snap.paused_local;
  const ads = snap.adspower === 'running'
    ? <span className="inline-flex items-center gap-2"><Dot color="#10B981" /> Running</span>
    : <span className="inline-flex items-center gap-2"><Dot color="#EF4444" /> Not detected — please open AdsPower</span>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Card>
        <div className="flex items-start gap-4">
          <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: f.color, boxShadow: `0 0 12px ${f.color}` }} />
          <div className="flex-1">
            <h1 className="font-display text-xl font-bold">{snap.message}</h1>
            <div className="mt-2 space-y-0.5 text-sm text-ink-2">
              {snap.agency_name && <div>Agency: <span className="text-ink-1">{snap.agency_name}</span></div>}
              {snap.plan && <div>Plan: <span className="text-ink-1">{PLAN_NAME[snap.plan] ?? snap.plan}</span></div>}
              <div>Last sync: <span className="text-ink-1">{timeAgo(snap.last_sync_at)}</span></div>
            </div>
            {snap.status !== 'active' && <Details text={snap.details} />}
          </div>
        </div>
      </Card>

      <Card title="Agent status — today">
        <Row label="Jobs completed today" value={stats?.today.jobs_completed ?? snap.jobs_today_local} />
        <Row label="Posts published today" value={stats?.today.posts_published ?? '—'} />
        <Row label="Comments replied" value={stats?.today.comments_replied ?? '—'} />
        <Row label="Follows performed" value={stats?.today.follows ?? '—'} />
        <Row label="Errors" value={stats?.today.errors ?? '—'} />
      </Card>

      <Card title="System">
        <Row label="AdsPower" value={ads} />
        <Row label="RAM usage" value={`${snap.ram.percent}% (${snap.ram.used_gb} GB / ${snap.ram.total_gb} GB)`} />
        <Row label="Active jobs" value={`${snap.running.length} running now`} />
        <Row label="Waiting to start" value={snap.waiting.length} />
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" className={paused ? 'btn-primary' : 'btn-ghost'} onClick={() => void (paused ? sk.resume() : sk.pause())}>
            {paused ? '▶ Resume All' : '⏸ Pause All'}
          </button>
          <button type="button" className="btn-ghost" onClick={onSettings}>Settings</button>
        </div>
      </Card>
    </div>
  );
}
