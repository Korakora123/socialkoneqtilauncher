import { useEffect, useState } from 'react';
import { sk } from '../renderer/bridge';
import type { AgentStatsResponse, JobStatus } from '../shared/contract';
import type { AgentSnapshot } from '../shared/ipc';
import { Card, Details, PLATFORM_ICON, PLATFORM_NAME, ProgressDots, clock } from '../components/ui';

const TWO_HOURS = 2 * 60 * 60 * 1000;

function statusIcon(s: JobStatus | 'success' | 'failed' | 'expired' | 'cancelled'): string {
  if (s === 'success') return '✅';
  if (s === 'failed') return '⚠️';
  if (s === 'expired' || s === 'cancelled') return '⏭';
  return '•';
}

const ERROR_TEXT: Record<string, string> = {
  SESSION_EXPIRED: 'Session expired — log in again',
  ACTION_BLOCKED: 'Platform paused this action',
  CAPTCHA: 'Verification needed',
  BANNED: 'Account needs attention',
  ADSPOWER_ERROR: 'AdsPower could not open the profile',
  PROFILE_BUSY: 'Profile was busy',
  TIMEOUT: 'Took too long',
};

/** §48 Screen 4 — Live Job Monitor. */
export function LiveActivity({ snap }: { snap: AgentSnapshot }): JSX.Element {
  const [stats, setStats] = useState<AgentStatsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => { void sk.getStats().then((r) => { if (alive && r.ok) setStats(r.data); }); };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [snap.recent.length]);

  const cutoff = Date.now() - TWO_HOURS;
  const localRecent = snap.recent.filter((r) => Date.parse(r.at) >= cutoff);
  const localIds = new Set(localRecent.map((r) => `${r.at}|${r.label}`));
  const brainRecent = (stats?.recent ?? []).filter((r) => Date.parse(r.at) >= cutoff && !localIds.has(`${r.at}|${r.label}`));
  const upcoming = [
    ...snap.waiting.map((w) => ({ at: w.scheduled_for, brand_name: w.brand_name, platform: w.platform, label: w.label })),
    ...(stats?.upcoming ?? []),
  ].filter((u, i, arr) => arr.findIndex((x) => x.at === u.at && x.label === u.label) === i)
    .filter((u) => Date.parse(u.at) <= Date.now() + TWO_HOURS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="font-display text-2xl font-bold">Live Activity</h1>

      <Card title="Running now">
        {snap.running.length === 0 ? <p className="text-sm text-ink-2">Nothing running right now.</p> : (
          <div className="space-y-4">
            {snap.running.map((r) => (
              <div key={r.id}>
                <div className="flex items-center gap-2 font-medium">
                  <span className="text-mint">●</span> {PLATFORM_ICON[r.platform]} {PLATFORM_NAME[r.platform]}{r.brand_name ? ` / ${r.brand_name}` : ''}
                </div>
                <div className="pl-5 text-sm text-ink-2">{r.label}</div>
                <div className="mt-1 flex items-center gap-3 pl-5 text-sm">
                  <span className="shrink-0 text-ink-2">
                    {r.step_total > 0 ? `Step ${r.step_index}/${r.step_total}: ${r.step_label}` : r.step_label}
                  </span>
                  <div className="w-40"><ProgressDots index={r.step_index} total={r.step_total} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent (last 2 hours)">
        {localRecent.length + brainRecent.length === 0 ? <p className="text-sm text-ink-2">No activity in the last 2 hours.</p> : (
          <div className="space-y-2 text-sm">
            {localRecent.map((r) => (
              <div key={`l-${r.id}`}>
                <div className="flex items-center gap-3">
                  <span>{statusIcon(r.status)}</span>
                  <span className="w-12 font-mono text-ink-2">{clock(r.at)}</span>
                  <span className="text-ink-2">{r.brand_name ?? ''} {PLATFORM_NAME[r.platform]}</span>
                  <span className="text-ink-1">{r.status === 'success' ? r.label : r.error ? (ERROR_TEXT[r.error.code] ?? 'Could not finish') : r.status === 'expired' ? 'Skipped — too late to start' : r.label}</span>
                </div>
                {r.error && <div className="pl-7"><Details label="Error details" text={`${r.error.code}${r.error.step_id ? ` at step ${r.error.step_id}` : ''}\n${r.error.message}`} /></div>}
              </div>
            ))}
            {brainRecent.map((r, i) => (
              <div key={`b-${i}`} className="flex items-center gap-3">
                <span>{statusIcon(r.status)}</span>
                <span className="w-12 font-mono text-ink-2">{clock(r.at)}</span>
                <span className="text-ink-2">{r.brand_name ?? ''} {PLATFORM_NAME[r.platform]}</span>
                <span className="text-ink-1">{r.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Upcoming next 2 hours">
        {upcoming.length === 0 ? <p className="text-sm text-ink-2">Nothing scheduled in the next 2 hours.</p> : (
          <div className="space-y-2 text-sm">
            {upcoming.map((u, i) => (
              <div key={i} className="flex items-center gap-3">
                <span>⏱</span>
                <span className="w-12 font-mono text-ink-2">{clock(u.at)}</span>
                <span className="text-ink-2">{u.brand_name ?? ''}</span>
                <span className="text-ink-1">{PLATFORM_NAME[u.platform]} · {u.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
