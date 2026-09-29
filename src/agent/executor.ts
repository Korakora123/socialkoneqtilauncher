/**
 * Generic playbook step interpreter. Knows nothing about any platform:
 * every selector, URL, text and ordering comes from the brain's playbook + job payload,
 * every delay/typing timing comes from job.hbe.
 */
import type { ErrorCode, Job, Playbook, PlaybookStep } from '../shared/contract';
import type { DownloadFn } from './download';
import { isNavigationError, isTimeoutError, type PageDriver } from './driver';
import { resolveString, resolveTemplate, type TemplateContext } from './template';
import { humanType } from './typing';
import { AgentError, errorMessage, type SleepFn } from './util';

/** Technical ceiling for a single element lookup when the playbook gives none. Not a behaviour delay. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
export const DEFAULT_NAV_TIMEOUT_MS = 60_000;

export interface ExecutorDeps {
  driver: PageDriver;
  sleep: SleepFn;
  rng?: () => number;
  download: DownloadFn;
  signal?: AbortSignal;
  /** Called before each top-level step (1-based index). */
  onProgress?: (stepIndex: number, stepTotal: number, label: string) => void;
}

export interface ExecutionOutput {
  outputs: Record<string, unknown>;
  screenshot_b64?: string;
}

type Guard = NonNullable<Playbook['guards']>[number];

const NESTED_KEYS = new Set(['then', 'else', 'steps']);
/** Keys whose whole-string templates keep their raw value (lists / numbers). */
const RAW_KEYS = new Set(['files', 'items', 'ms']);
const NUMBER_KEYS = new Set(['pixels', 'times', 'limit', 'timeout_ms']);
const BOOL_KEYS = new Set(['optional', 'clear']);
const URL_ATTRS = new Set(['href', 'src']);

export function stepLabel(step: PlaybookStep): string {
  return step.label ?? step.action.replace(/_/g, ' ');
}

export class Executor {
  private readonly ctx: TemplateContext;
  private readonly outputs: Record<string, unknown> = {};
  private screenshot: string | undefined;
  /** Non-null while inside a foreach: output keys already turned into accumulating arrays. */
  private collector: Set<string> | null = null;
  private readonly rng: () => number;

  constructor(private readonly job: Job, private readonly playbook: Playbook, private readonly deps: ExecutorDeps) {
    this.ctx = { payload: job.payload ?? {}, outputs: this.outputs, hbe: job.hbe };
    this.rng = deps.rng ?? Math.random;
  }

  async run(): Promise<ExecutionOutput> {
    const steps = this.playbook.steps ?? [];
    if (this.playbook.start_url) {
      const url = resolveString(this.playbook.start_url, this.ctx);
      await this.guarded('start', () => this.navigate(url, 'start'));
      await this.checkGuards('start');
    }
    for (let i = 0; i < steps.length; i++) {
      this.throwIfAborted();
      const step = steps[i];
      this.deps.onProgress?.(i + 1, steps.length, stepLabel(step));
      await this.runStep(step);
      await this.pause(this.job.hbe.step_delays_ms?.[i] ?? this.job.hbe.hbe_delay_ms);
    }
    return { outputs: this.outputs, screenshot_b64: this.screenshot };
  }

  private throwIfAborted(): void {
    if (this.deps.signal?.aborted) {
      const r: unknown = this.deps.signal.reason;
      throw r instanceof AgentError ? r : new AgentError('CANCELLED', 'Job cancelled');
    }
  }

  private pause(ms: number): Promise<void> {
    return this.deps.sleep(Math.max(0, Number(ms) || 0), this.deps.signal);
  }

  private str(v: string): string { return resolveString(v, this.ctx); }

  /** Map raw browser errors to contract error codes, attributed to a step. */
  private async guarded<T>(stepId: string, fn: () => Promise<T>, selectorStep = false): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.mapError(e, stepId, selectorStep);
    }
  }

  private mapError(e: unknown, stepId: string, selectorStep: boolean): AgentError {
    if (e instanceof AgentError) return e.stepId ? e : new AgentError(e.code, e.message, stepId);
    if (isTimeoutError(e)) {
      return new AgentError(selectorStep ? 'SELECTOR_NOT_FOUND' : 'TIMEOUT', errorMessage(e).split('\n')[0], stepId);
    }
    if (isNavigationError(e)) return new AgentError('NAVIGATION_FAILED', errorMessage(e).split('\n')[0], stepId);
    return new AgentError('UNKNOWN', errorMessage(e).split('\n')[0], stepId);
  }

  private async navigate(url: string, stepId: string): Promise<void> {
    try {
      await this.deps.driver.goto(url, DEFAULT_NAV_TIMEOUT_MS);
    } catch (e) {
      if (isTimeoutError(e)) throw new AgentError('TIMEOUT', 'Navigation timed out', stepId);
      throw new AgentError('NAVIGATION_FAILED', errorMessage(e).split('\n')[0], stepId);
    }
  }

  /** Evaluate playbook guards; the first match aborts the job with the guard's code. */
  async checkGuards(stepId: string): Promise<void> {
    const guards = this.playbook.guards ?? [];
    for (const g of guards) {
      if (await this.guardMatches(g)) {
        throw new AgentError(g.code, `Guard matched (${g.code})`, stepId);
      }
    }
  }

  private async guardMatches(g: Guard): Promise<boolean> {
    const d = this.deps.driver;
    try {
      if (g.url_contains && d.url().includes(this.str(g.url_contains))) return true;
      if (g.selector && (await d.exists(this.str(g.selector)))) return true;
      if (g.text && (await d.containsText(this.str(g.text)))) return true;
    } catch {
      return false;
    }
    return false;
  }

  private async runSteps(steps: PlaybookStep[]): Promise<void> {
    for (const s of steps) {
      this.throwIfAborted();
      await this.runStep(s);
      await this.pause(this.job.hbe.hbe_delay_ms);
    }
  }

  /**
   * Resolve templates in every field of a step right before it runs (so {{item.x}} and
   * {{outputs.x}} reflect the current state). Nested step lists are resolved when they run.
   * Whole-string templates keep their raw type (numbers, booleans, arrays).
   */
  prepare(step: PlaybookStep): PlaybookStep {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) {
      if (NESTED_KEYS.has(k)) { out[k] = v; continue; }
      if (k === 'fields' && v && typeof v === 'object') {
        const fields: Record<string, { selector?: string; attr?: string }> = {};
        for (const [name, f] of Object.entries(v as Record<string, { selector?: string; attr?: string }>)) {
          fields[name] = {
            ...(f?.selector !== undefined ? { selector: this.str(f.selector) } : {}),
            ...(f?.attr !== undefined ? { attr: this.str(f.attr) } : {}),
          };
        }
        out[k] = fields;
        continue;
      }
      if (typeof v !== 'string' || k === 'id' || k === 'action') { out[k] = v; continue; }
      if (RAW_KEYS.has(k)) out[k] = resolveTemplate(v, this.ctx);
      else if (NUMBER_KEYS.has(k)) out[k] = Number(resolveTemplate(v, this.ctx));
      else if (BOOL_KEYS.has(k)) { const r = resolveTemplate(v, this.ctx); out[k] = r === true || r === 'true'; }
      else out[k] = this.str(v);
    }
    return out as unknown as PlaybookStep;
  }

  /** Inside a foreach, extracted values accumulate across iterations instead of overwriting. */
  private collect(key: string, value: unknown, list: boolean): void {
    if (!this.collector) { this.outputs[key] = value; return; }
    if (!this.collector.has(key) || !Array.isArray(this.outputs[key])) {
      this.collector.add(key);
      this.outputs[key] = [];
    }
    const arr = this.outputs[key] as unknown[];
    if (list && Array.isArray(value)) arr.push(...value);
    else arr.push(value);
  }

  /** href/src values are returned absolute, resolved against the current page URL. */
  private absolutize(attr: string | undefined, value: string | null): string | null {
    if (value === null || !attr || !URL_ATTRS.has(attr.toLowerCase())) return value;
    try { return new URL(value, this.deps.driver.url()).href; } catch { return value; }
  }

  async runStep(raw: PlaybookStep): Promise<void> {
    const d = this.deps.driver;
    const step = this.prepare(raw);
    const id = step.id;
    switch (step.action) {
      case 'goto': {
        await this.navigate(step.url, id);
        await this.checkGuards(id);
        return;
      }
      case 'wait_for': {
        const timeout = Number.isFinite(step.timeout_ms) && (step.timeout_ms ?? 0) > 0 ? (step.timeout_ms as number) : DEFAULT_STEP_TIMEOUT_MS;
        try {
          await this.guarded(id, () => d.waitFor(step.selector, timeout), true);
        } catch (e) {
          if (step.optional && e instanceof AgentError && (e.code === 'SELECTOR_NOT_FOUND' || e.code === 'TIMEOUT')) return;
          throw e;
        }
        return;
      }
      case 'click': {
        if (step.optional && !(await d.exists(step.selector))) return;
        await this.guarded(id, () => d.click(step.selector, DEFAULT_STEP_TIMEOUT_MS), true);
        await this.checkGuards(id);
        return;
      }
      case 'click_text': {
        try {
          await this.guarded(id, () => d.clickText(step.text, step.role || undefined, DEFAULT_STEP_TIMEOUT_MS), true);
        } catch (e) {
          if (step.optional && e instanceof AgentError && e.code === 'SELECTOR_NOT_FOUND') return;
          throw e;
        }
        await this.checkGuards(id);
        return;
      }
      case 'type': {
        await this.guarded(id, () => d.focus(step.selector, Boolean(step.clear), DEFAULT_STEP_TIMEOUT_MS), true);
        await this.guarded(id, () => humanType(d, step.text, this.job.hbe.typing, this.deps.sleep, this.rng, this.deps.signal));
        return;
      }
      case 'press': {
        await this.guarded(id, () => d.press(step.key));
        return;
      }
      case 'upload': {
        const rawFiles: unknown = step.files;
        const urls = (Array.isArray(rawFiles) ? rawFiles : rawFiles === undefined || rawFiles === null || rawFiles === '' ? [] : [rawFiles])
          .map((u) => String(u)).filter((u) => u.length > 0);
        if (urls.length === 0) throw new AgentError('UPLOAD_FAILED', 'No files to upload', id);
        let files;
        try {
          files = await this.deps.download(urls, this.deps.signal);
        } catch (e) {
          throw e instanceof AgentError ? new AgentError(e.code, e.message, id) : new AgentError('UPLOAD_FAILED', errorMessage(e), id);
        }
        try {
          await this.guarded(id, () => d.setInputFiles(step.selector, files.paths, DEFAULT_STEP_TIMEOUT_MS), true);
        } finally {
          await files.cleanup();
        }
        return;
      }
      case 'scroll': {
        const times = Math.max(1, Number.isFinite(step.times) ? (step.times as number) : 1);
        const px = Number.isFinite(step.pixels) ? step.pixels : 0;
        for (let n = 0; n < times; n++) {
          await this.guarded(id, () => d.scroll(px));
          if (n < times - 1) await this.pause(this.job.hbe.hbe_delay_ms);
        }
        return;
      }
      case 'delay': {
        const v = Number(step.ms);
        if (!Number.isFinite(v)) throw new AgentError('UNKNOWN', 'Delay value is not a number', id);
        await this.pause(v);
        return;
      }
      case 'think': {
        await this.pause(this.job.hbe.think_ms);
        return;
      }
      case 'assert': {
        let ok = true;
        if (step.selector) { const sel = step.selector; ok = ok && (await this.guarded(id, () => d.exists(sel))); }
        if (step.text) { const txt = step.text; ok = ok && (await this.guarded(id, () => d.containsText(txt))); }
        if (!ok) throw new AgentError(step.code, `Assertion failed (${step.code})`, id);
        return;
      }
      case 'extract': {
        const attr = step.attr || undefined;
        let value: string | null;
        try {
          const v = await this.guarded(id, () => d.read(step.selector, attr, DEFAULT_STEP_TIMEOUT_MS), true);
          value = attr ? this.absolutize(attr, v) : (v ?? '').trim();
        } catch (e) {
          if (!step.optional) throw e;
          value = null;
        }
        this.collect(step.as, value, false);
        return;
      }
      case 'extract_url': {
        this.outputs[step.as] = d.url();
        return;
      }
      case 'extract_list': {
        const fields = step.fields ?? {};
        const limit = Number.isFinite(step.limit) ? step.limit : undefined;
        const rows = await this.guarded(id, () => d.readList(step.selector, fields, limit), true);
        const mapped: Array<Record<string, unknown>> = rows.map((row) => {
          const r: Record<string, unknown> = {};
          for (const [name, v] of Object.entries(row)) r[name] = this.absolutize(fields[name]?.attr, v);
          if (this.collector) r._item = this.ctx.item;
          return r;
        });
        this.collect(step.as, mapped, true);
        return;
      }
      case 'if_exists': {
        const present = await this.guarded(id, () => d.exists(step.selector));
        await this.runSteps(present ? step.then ?? [] : step.else ?? []);
        return;
      }
      case 'foreach': {
        const items: unknown = step.items;
        if (items === undefined || items === null) return;
        if (!Array.isArray(items)) throw new AgentError('UNKNOWN', 'foreach items is not a list', id);
        const prevItem = this.ctx.item;
        const outermost = this.collector === null;
        if (outermost) this.collector = new Set<string>();
        try {
          for (const item of items) {
            this.ctx.item = item;
            await this.runSteps(step.steps ?? []);
          }
        } finally {
          this.ctx.item = prevItem;
          if (outermost) this.collector = null;
        }
        return;
      }
      case 'screenshot': {
        const png = await this.guarded(id, () => d.screenshot());
        const b64 = png.toString('base64');
        if (step.as) this.outputs[step.as] = b64;
        else this.screenshot = b64;
        return;
      }
      default: {
        const unknown = step as { id?: string; action?: string };
        throw new AgentError('UNKNOWN', `Unsupported step action: ${String(unknown.action)}`, unknown.id);
      }
    }
  }
}

/** Runs the playbook, bounded by job.timeout_ms. */
export async function runPlaybook(job: Job, playbook: Playbook, deps: ExecutorDeps): Promise<ExecutionOutput> {
  const ctrl = new AbortController();
  const onParentAbort = (): void => ctrl.abort(deps.signal?.reason ?? new AgentError('CANCELLED', 'Job cancelled'));
  if (deps.signal?.aborted) onParentAbort();
  deps.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timeoutMs = job.timeout_ms > 0 ? job.timeout_ms : 10 * 60_000;
  const timer = setTimeout(() => ctrl.abort(new AgentError('TIMEOUT', `Job exceeded ${timeoutMs} ms`)), timeoutMs);
  const exec = new Executor(job, playbook, { ...deps, signal: ctrl.signal });
  const aborted = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => {
      const r: unknown = ctrl.signal.reason;
      reject(r instanceof AgentError ? r : new AgentError('CANCELLED', 'Job cancelled'));
    }, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([exec.run(), aborted]);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onParentAbort);
  }
}

export function toErrorCode(e: unknown): ErrorCode {
  return e instanceof AgentError ? e.code : 'UNKNOWN';
}
