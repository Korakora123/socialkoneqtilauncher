import { useState, type ReactNode } from 'react';
import type { FriendlyStatus, Platform } from '../shared/contract';

export const FRIENDLY: Record<FriendlyStatus, { dot: string; label: string; color: string }> = {
  active: { dot: '🟢', label: 'Active', color: '#10B981' },
  starting: { dot: '🟡', label: 'Starting', color: '#F59E0B' },
  reconnecting: { dot: '🟡', label: 'Reconnecting', color: '#F59E0B' },
  action_needed: { dot: '🔴', label: 'Action needed', color: '#EF4444' },
  paused: { dot: '⚪', label: 'Paused', color: '#94A3B8' },
};

export const PLATFORM_ICON: Record<Platform | 'tool', string> = {
  instagram: '📸', tiktok: '🎵', youtube: '▶️', linkedin: '💼', x: '𝕏',
  facebook: '📘', reddit: '👽', quora: '❓', pinterest: '📌', tool: '🛠',
};

export const PLATFORM_NAME: Record<Platform | 'tool', string> = {
  instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', x: 'X',
  facebook: 'Facebook', reddit: 'Reddit', quora: 'Quora', pinterest: 'Pinterest', tool: 'Tool',
};

export function StatusPill({ status }: { status: FriendlyStatus }): JSX.Element {
  const f = FRIENDLY[status];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
      style={{ borderColor: `${f.color}55`, color: f.color, background: `${f.color}14` }}>
      <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
      {f.label}
    </span>
  );
}

export function Dot({ color }: { color: string }): JSX.Element {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }): JSX.Element {
  return (
    <section className="card">
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h2 className="label">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="font-medium text-ink-1">{value}</span>
    </div>
  );
}

/** Technical detail is only ever shown behind this toggle. */
export function Details({ text, label = 'Details' }: { text: string | null | undefined; label?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mt-2">
      <button type="button" className="text-xs text-violet-light underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
        {open ? `Hide ${label.toLowerCase()}` : `View ${label.toLowerCase()}`}
      </button>
      {open && <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-navy-4 p-3 text-xs text-ink-2">{text}</pre>}
    </div>
  );
}

export function Notice({ kind, children }: { kind: 'ok' | 'error' | 'info'; children: ReactNode }): JSX.Element {
  const c = kind === 'ok' ? '#10B981' : kind === 'error' ? '#EF4444' : '#A78BFA';
  return (
    <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: `${c}55`, background: `${c}14`, color: c }}>
      {children}
    </div>
  );
}

export function ProgressDots({ index, total }: { index: number; total: number }): JSX.Element {
  const n = Math.max(total, 1);
  return (
    <div className="flex gap-1" aria-label={`Step ${index} of ${total}`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="h-2 flex-1 rounded-full" style={{ background: i < index ? '#7C3AED' : '#1A2740', minWidth: 6 }} />
      ))}
    </div>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
