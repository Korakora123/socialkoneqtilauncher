/**
 * Runs every real brain playbook through the executor against a permissive fake page.
 * The playbooks live in the PRIVATE brain repo and are read from its absolute path at test time;
 * they are never copied into this public repo. When the directory is absent (e.g. CI for this
 * repo) the suite is skipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ListField, PageDriver } from '../src/agent/driver';
import { runPlaybook } from '../src/agent/executor';
import type { Playbook, PlaybookStep } from '../src/shared/contract';
import { hbe, job } from './helpers';

const DIR = '/home/user/socialkoneqtigateway/src/playbooks';
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ROOTS = new Set(['payload', 'item', 'outputs', 'hbe']);
const ARRAY_KEYS = new Set(['items', 'files']);
const NUMBER_KEYS = new Set(['ms', 'pixels', 'times', 'limit', 'timeout_ms']);
const BOOL_KEYS = new Set(['optional', 'clear']);

type Kind = 'array' | 'number' | 'bool' | 'string';
interface Ref { path: string; kind: Kind }

/** Every template reference in the playbook, with the kind of value its field needs. */
function collectRefs(node: unknown, key = '', out: Ref[] = []): Ref[] {
  if (typeof node === 'string') {
    for (const m of node.matchAll(TEMPLATE)) {
      const kind: Kind = ARRAY_KEYS.has(key) ? 'array' : NUMBER_KEYS.has(key) ? 'number' : BOOL_KEYS.has(key) ? 'bool' : 'string';
      out.push({ path: m[1], kind });
    }
  } else if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, key, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectRefs(v, k, out);
  }
  return out;
}

function setPath(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!(last in cur) || typeof cur[last] === 'string') cur[last] = value;
}

/** Builds a payload + foreach item shape where every referenced path resolves to a usable value. */
function synthesise(refs: Ref[]): { payload: Record<string, unknown>; item: Record<string, unknown> } {
  const item: Record<string, unknown> = {};
  const payload: Record<string, unknown> = {};
  const value = (k: Kind): unknown => (k === 'array' ? [item] : k === 'number' ? 1000 : k === 'bool' ? true : 'https://x.test/x');
  for (const r of refs) {
    const [root, ...rest] = r.path.split('.');
    if (rest.length === 0) continue;
    if (root === 'payload') setPath(payload, rest, value(r.kind));
    if (root === 'item') setPath(item, rest, value(r.kind));
  }
  // file lists are URL strings, not objects
  const fix = (o: Record<string, unknown>): void => {
    for (const r of refs.filter((x) => x.kind === 'array')) {
      const [root, ...rest] = r.path.split('.');
      if (root !== 'payload' || rest.length === 0) continue;
      let cur: unknown = o;
      for (const p of rest.slice(0, -1)) cur = (cur as Record<string, unknown>)?.[p];
      if (cur && typeof cur === 'object') {
        const last = rest[rest.length - 1];
        (cur as Record<string, unknown>)[last] = [item];
      }
    }
  };
  fix(payload);
  return { payload, item };
}

class PermissiveDriver implements PageDriver {
  strings: string[] = [];
  private current = 'about:blank';
  constructor(private readonly guardSelectors: Set<string>, private readonly guardTexts: Set<string>, private readonly item: Record<string, unknown>) {}
  private rec(...s: string[]): void { this.strings.push(...s); }
  async goto(url: string): Promise<void> { this.rec(url); this.current = url; }
  url(): string { return this.current; }
  async waitFor(selector: string): Promise<void> { this.rec(selector); }
  async exists(selector: string): Promise<boolean> { this.rec(selector); return !this.guardSelectors.has(selector); }
  async containsText(text: string): Promise<boolean> { this.rec(text); return !this.guardTexts.has(text); }
  async click(selector: string): Promise<void> { this.rec(selector); }
  async clickText(text: string, role: string | undefined): Promise<void> { this.rec(text, role ?? ''); }
  async focus(selector: string): Promise<void> { this.rec(selector); }
  async typeChar(): Promise<void> {}
  async press(key: string): Promise<void> { this.rec(key); }
  async setInputFiles(selector: string, paths: string[]): Promise<void> { this.rec(selector); expect(paths.length).toBeGreaterThan(0); }
  async scroll(): Promise<void> {}
  async read(selector: string, attr: string | undefined): Promise<string | null> { this.rec(selector, attr ?? ''); return 'x'; }
  async readList(selector: string, fields: Record<string, ListField>): Promise<Array<Record<string, string | null>>> {
    this.rec(selector, ...Object.values(fields).flatMap((f) => [f.selector ?? '', f.attr ?? '']));
    const row: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(this.item)) if (typeof v === 'string') row[k] = v;
    for (const name of Object.keys(fields)) row[name] = 'x';
    return [row];
  }
  async screenshot(): Promise<Buffer> { return Buffer.from('png'); }
}

function stepActions(steps: PlaybookStep[], out: Set<string> = new Set()): Set<string> {
  for (const s of steps) {
    out.add(s.action);
    if (s.action === 'foreach') stepActions(s.steps, out);
    if (s.action === 'if_exists') { stepActions(s.then, out); stepActions(s.else ?? [], out); }
  }
  return out;
}

describe.skipIf(files.length === 0)('real brain playbooks run through the executor', () => {
  const SUPPORTED = new Set(['goto', 'wait_for', 'click', 'click_text', 'type', 'press', 'upload', 'scroll', 'delay', 'think',
    'assert', 'extract', 'extract_url', 'extract_list', 'if_exists', 'foreach', 'screenshot']);

  it.each(files)('%s', async (file) => {
    const pb = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Playbook;
    expect(pb.type).toBe(file.replace(/\.json$/, ''));
    for (const a of stepActions(pb.steps)) expect(SUPPORTED, `unknown action "${a}"`).toContain(a);

    const refs = collectRefs(pb);
    for (const r of refs) expect(ROOTS, `unsupported template root in {{${r.path}}}`).toContain(r.path.split('.')[0]);

    const { payload, item } = synthesise(refs);
    const guardSelectors = new Set((pb.guards ?? []).flatMap((g) => (g.selector ? [g.selector] : [])));
    const guardTexts = new Set((pb.guards ?? []).flatMap((g) => (g.text ? [g.text] : [])));
    const driver = new PermissiveDriver(guardSelectors, guardTexts, item);
    const out = await runPlaybook(
      job({ type: pb.type, payload, hbe: hbe({ hbe_delay_ms: 0, think_ms: 0, typing: { min_char_ms: 0, max_char_ms: 0, typo_rate: 0, word_pause_rate: 0, word_pause_ms: [0, 0] } }) }),
      pb,
      { driver, sleep: async () => undefined, rng: () => 0.5, download: async (urls) => ({ paths: urls.map((_, i) => `/tmp/f${i}`), cleanup: async () => undefined }) },
    );
    expect(out.outputs).toBeTypeOf('object');
    for (const s of driver.strings) expect(s, 'unresolved template reached the page').not.toMatch(/\{\{|\}\}/);
  });
});
