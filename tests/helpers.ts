import type { HbePlan, Job, Playbook } from '../src/shared/contract';
import type { ListField, PageDriver } from '../src/agent/driver';

export const hbe = (over: Partial<HbePlan> = {}): HbePlan => ({
  hbe_delay_ms: 1000,
  step_delays_ms: [],
  typing: { min_char_ms: 50, max_char_ms: 150, typo_rate: 0, word_pause_rate: 0, word_pause_ms: [300, 900] },
  think_ms: 2500,
  ...over,
});

export const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1',
  type: 'test_playbook',
  platform: 'instagram',
  brand_id: 'b1',
  brand_name: 'Brand',
  post_id: 1,
  adspower_profile_id: 'ads-1',
  scheduled_for: new Date(0).toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  playbook_version: 1,
  hbe: hbe(),
  payload: {},
  timeout_ms: 60_000,
  label: 'Test job',
  ...over,
});

export const playbook = (steps: Playbook['steps'], over: Partial<Playbook> = {}): Playbook => ({
  type: 'test_playbook', version: 1, platform: 'instagram', description: 'test', steps, ...over,
});

export class TimeoutError extends Error { override name = 'TimeoutError'; }

/** In-memory fake page. Selectors are opaque strings; nothing platform specific. */
export class FakeDriver implements PageDriver {
  calls: string[] = [];
  typed = '';
  currentUrl = 'about:blank';
  present = new Set<string>();
  texts = new Set<string>();
  values: Record<string, string> = {};
  lists: Record<string, Array<Record<string, string | null>>> = {};
  failOn: Record<string, Error> = {};
  /** url → side effect when navigated */
  onGoto: Record<string, () => void> = {};
  onClick: Record<string, () => void> = {};

  private maybeFail(key: string): void {
    const e = this.failOn[key];
    if (e) throw e;
  }
  async goto(url: string): Promise<void> {
    this.calls.push(`goto ${url}`); this.maybeFail(`goto ${url}`);
    this.currentUrl = url; this.onGoto[url]?.();
  }
  url(): string { return this.currentUrl; }
  async waitFor(selector: string): Promise<void> {
    this.calls.push(`wait ${selector}`);
    if (!this.present.has(selector)) throw new TimeoutError(`locator.waitFor: Timeout 30000ms exceeded`);
  }
  async exists(selector: string): Promise<boolean> { return this.present.has(selector); }
  async containsText(text: string): Promise<boolean> { return this.texts.has(text); }
  async click(selector: string): Promise<void> {
    this.calls.push(`click ${selector}`); this.maybeFail(`click ${selector}`);
    if (!this.present.has(selector)) throw new TimeoutError('locator.click: Timeout 30000ms exceeded');
    this.onClick[selector]?.();
  }
  async clickText(text: string, role: string | undefined): Promise<void> {
    this.calls.push(`clickText ${text}${role ? ` [${role}]` : ''}`);
    if (!this.texts.has(text)) throw new TimeoutError('Timeout 30000ms exceeded');
  }
  async focus(selector: string, clear: boolean): Promise<void> {
    this.calls.push(`focus ${selector}${clear ? ' clear' : ''}`);
    if (!this.present.has(selector)) throw new TimeoutError('Timeout 30000ms exceeded');
    if (clear) this.typed = '';
  }
  async typeChar(ch: string): Promise<void> { this.typed += ch; }
  async press(key: string): Promise<void> {
    if (key === 'Backspace') this.typed = this.typed.slice(0, -1);
    else this.calls.push(`press ${key}`);
  }
  async setInputFiles(selector: string, files: string[]): Promise<void> {
    this.calls.push(`upload ${selector} ${files.join(',')}`);
    if (!this.present.has(selector)) throw new TimeoutError('Timeout 30000ms exceeded');
  }
  async scroll(px: number): Promise<void> { this.calls.push(`scroll ${px}`); }
  async read(selector: string, attr: string | undefined): Promise<string | null> {
    if (!this.present.has(selector)) throw new TimeoutError('Timeout 30000ms exceeded');
    return this.values[attr ? `${selector}@${attr}` : selector] ?? null;
  }
  async readList(selector: string, _fields: Record<string, ListField>, limit: number | undefined): Promise<Array<Record<string, string | null>>> {
    const rows = this.lists[selector] ?? [];
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }
  async screenshot(): Promise<Buffer> { this.calls.push('screenshot'); return Buffer.from('png'); }
}

export function recordingSleep(): { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
    },
  };
}
