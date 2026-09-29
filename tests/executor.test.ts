import { describe, expect, it, vi } from 'vitest';
import { Executor, runPlaybook, type ExecutorDeps } from '../src/agent/executor';
import { executeJob } from '../src/agent/jobRunner';
import { AgentError, nullLogger } from '../src/agent/util';
import type { Job, Playbook } from '../src/shared/contract';
import { FakeDriver, hbe, job, playbook, recordingSleep } from './helpers';

function deps(d: FakeDriver, over: Partial<ExecutorDeps> = {}): ExecutorDeps & { waits: number[]; cleaned: number } {
  const { sleep, waits } = recordingSleep();
  const state = { cleaned: 0 };
  const base: ExecutorDeps = {
    driver: d,
    sleep,
    rng: () => 0,
    download: async (urls) => ({ paths: urls.map((_, i) => `/tmp/f${i}`), cleanup: async () => { state.cleaned++; } }),
    ...over,
  };
  return Object.defineProperties(base, {
    waits: { value: waits },
    cleaned: { get: () => state.cleaned },
  }) as ExecutorDeps & { waits: number[]; cleaned: number };
}

async function run(j: Job, pb: Playbook, d: FakeDriver, over: Partial<ExecutorDeps> = {}) {
  const dp = deps(d, over);
  try {
    const out = await runPlaybook(j, pb, dp);
    return { out, err: null as AgentError | null, dp };
  } catch (e) {
    return { out: null, err: e as AgentError, dp };
  }
}

describe('executor — step interpretation', () => {
  it('runs goto/wait/click/type/press/think/delay with brain-supplied delays', async () => {
    const d = new FakeDriver();
    d.present = new Set(['#a', '#box', '#go']);
    const j = job({
      payload: { url: 'https://site.test/new', caption: 'hi there', wait: 1234 },
      hbe: hbe({ hbe_delay_ms: 700, step_delays_ms: [11, 22], think_ms: 3333, typing: { min_char_ms: 1, max_char_ms: 1, typo_rate: 0, word_pause_rate: 0, word_pause_ms: [0, 0] } }),
    });
    const progress: string[] = [];
    const { err, dp } = await run(j, playbook([
      { id: 's1', action: 'goto', url: '{{payload.url}}' },
      { id: 's2', action: 'wait_for', selector: '#a' },
      { id: 's3', action: 'type', selector: '#box', text: '{{payload.caption}}', clear: true, label: 'Typing caption' },
      { id: 's4', action: 'delay', ms: '{{payload.wait}}' },
      { id: 's5', action: 'think' },
      { id: 's6', action: 'click', selector: '#go' },
      { id: 's7', action: 'press', key: 'Enter' },
    ]), d, { onProgress: (i, t, l) => progress.push(`${i}/${t} ${l}`) });
    expect(err).toBeNull();
    expect(d.calls).toEqual(['goto https://site.test/new', 'wait #a', 'focus #box clear', 'click #go', 'press Enter']);
    expect(d.typed).toBe('hi there');
    expect(progress[2]).toBe('3/7 Typing caption');
    expect(progress).toHaveLength(7);
    // per-step overrides for step 0 and 1, then default hbe_delay_ms; plus delay + think values
    expect(dp.waits.filter((w) => w !== 1)).toEqual([11, 22, 700, 1234, 700, 3333, 700, 700, 700]);
  });

  it('navigates to start_url first when present', async () => {
    const d = new FakeDriver();
    const { err } = await run(job({ payload: { u: 'https://x.test/' } }), playbook([], { start_url: '{{payload.u}}' }), d);
    expect(err).toBeNull();
    expect(d.calls).toEqual(['goto https://x.test/']);
  });

  it('foreach exposes {{item.x}} and restores scope; if_exists picks then/else', async () => {
    const d = new FakeDriver();
    d.present = new Set(['.row-a', '.row-b', '#has']);
    const j = job({ payload: { rows: [{ sel: '.row-a' }, { sel: '.row-b' }] } });
    const { err } = await run(j, playbook([
      { id: 'f', action: 'foreach', items: '{{payload.rows}}', steps: [
        { id: 'fc', action: 'click', selector: '{{item.sel}}' },
      ] },
      { id: 'i1', action: 'if_exists', selector: '#has', then: [{ id: 't', action: 'press', key: 'A' }], else: [{ id: 'e', action: 'press', key: 'B' }] },
      { id: 'i2', action: 'if_exists', selector: '#nope', then: [{ id: 't2', action: 'press', key: 'C' }], else: [{ id: 'e2', action: 'press', key: 'D' }] },
    ]), d);
    expect(err).toBeNull();
    expect(d.calls).toEqual(['click .row-a', 'click .row-b', 'press A', 'press D']);
  });

  it('foreach over a missing list is a no-op, over a non-list fails', async () => {
    const d = new FakeDriver();
    const ok = await run(job(), playbook([{ id: 'f', action: 'foreach', items: '{{payload.none}}', steps: [{ id: 'x', action: 'press', key: 'A' }] }]), d);
    expect(ok.err).toBeNull();
    const bad = await run(job({ payload: { s: 'str' } }), playbook([{ id: 'f', action: 'foreach', items: '{{payload.s}}', steps: [] }]), d);
    expect(bad.err?.code).toBe('UNKNOWN');
  });

  it('extract, extract_url, extract_list and screenshot fill outputs', async () => {
    const d = new FakeDriver();
    d.present = new Set(['.count', 'a.link']);
    d.values = { '.count': '  42 ', 'a.link@href': '/p/9' };
    d.lists = { '.item': [{ t: '1' }, { t: '2' }, { t: '3' }] };
    d.currentUrl = 'https://site.test/p/9';
    const { out, err } = await run(job(), playbook([
      { id: 'e1', action: 'extract', selector: '.count', as: 'count' },
      { id: 'e2', action: 'extract', selector: 'a.link', attr: 'href', as: 'href' },
      { id: 'e3', action: 'extract', selector: '.missing', as: 'opt', optional: true },
      { id: 'e4', action: 'extract_url', as: 'url' },
      { id: 'e5', action: 'extract_list', selector: '.item', as: 'items', limit: 2, fields: { t: {} } },
      { id: 'e6', action: 'screenshot', as: 'shot' },
      { id: 'e7', action: 'screenshot' },
    ]), d);
    expect(err).toBeNull();
    expect(out?.outputs).toEqual({ count: '42', href: 'https://site.test/p/9', opt: null, url: 'https://site.test/p/9', items: [{ t: '1' }, { t: '2' }], shot: Buffer.from('png').toString('base64') });
    expect(out?.screenshot_b64).toBe(Buffer.from('png').toString('base64'));
  });

  it('outputs from earlier steps are usable in later templates', async () => {
    const d = new FakeDriver();
    d.present = new Set(['.id']);
    d.values = { '.id': 'abc' };
    const { err } = await run(job(), playbook([
      { id: 'e', action: 'extract', selector: '.id', as: 'id' },
      { id: 'g', action: 'goto', url: 'https://site.test/{{outputs.id}}' },
    ]), d);
    expect(err).toBeNull();
    expect(d.calls).toContain('goto https://site.test/abc');
  });

  it('upload downloads files, sets them, then cleans up (also on failure)', async () => {
    const d = new FakeDriver();
    d.present = new Set(['input[type=file]']);
    const j = job({ payload: { media: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'] } });
    const r = await run(j, playbook([{ id: 'u', action: 'upload', selector: 'input[type=file]', files: '{{payload.media}}' }]), d);
    expect(r.err).toBeNull();
    expect(d.calls).toEqual(['upload input[type=file] /tmp/f0,/tmp/f1']);
    expect(r.dp.cleaned).toBe(1);

    const d2 = new FakeDriver();
    const r2 = await run(j, playbook([{ id: 'u', action: 'upload', selector: '#none', files: '{{payload.media}}' }]), d2);
    expect(r2.err?.code).toBe('SELECTOR_NOT_FOUND');
    expect(r2.dp.cleaned).toBe(1);

    const r3 = await run(job(), playbook([{ id: 'u', action: 'upload', selector: '#x', files: '{{payload.none}}' }]), new FakeDriver());
    expect(r3.err?.code).toBe('UPLOAD_FAILED');
  });

  it('scroll repeats with hbe delay between repetitions', async () => {
    const d = new FakeDriver();
    const { err, dp } = await run(job({ hbe: hbe({ hbe_delay_ms: 300 }) }), playbook([{ id: 's', action: 'scroll', pixels: 500, times: 3 }]), d);
    expect(err).toBeNull();
    expect(d.calls).toEqual(['scroll 500', 'scroll 500', 'scroll 500']);
    expect(dp.waits).toEqual([300, 300, 300]);
  });

  it('optional click/wait_for/click_text are skipped when absent', async () => {
    const d = new FakeDriver();
    const { err } = await run(job(), playbook([
      { id: 'c', action: 'click', selector: '#maybe', optional: true },
      { id: 'w', action: 'wait_for', selector: '#maybe', optional: true, timeout_ms: 10 },
      { id: 't', action: 'click_text', text: 'Not now', optional: true },
    ]), d);
    expect(err).toBeNull();
  });
});

describe('executor — foreach accumulation, absolute URLs, templated fields', () => {
  it('extract_list inside foreach appends rows across iterations and tags each row with _item', async () => {
    const d = new FakeDriver();
    const pages: Record<string, Array<Record<string, string | null>>> = {
      'https://site.test/a': [{ name: 'c1', link: '/c/1' }, { name: 'c2', link: 'https://other.test/x' }],
      'https://site.test/b': [{ name: 'c3', link: 'c/3' }],
    };
    d.readList = async () => pages[d.currentUrl] ?? [];
    const items = [{ url: 'https://site.test/a', k: 1 }, { url: 'https://site.test/b', k: 2 }];
    const { out, err } = await run(job({ payload: { posts: items } }), playbook([
      { id: 'f', action: 'foreach', items: '{{payload.posts}}', steps: [
        { id: 'g', action: 'goto', url: '{{item.url}}' },
        { id: 'l', action: 'extract_list', selector: '.comment', as: 'comments', fields: { name: {}, link: { selector: 'a', attr: 'href' } } },
      ] },
    ]), d);
    expect(err).toBeNull();
    expect(out?.outputs.comments).toEqual([
      { name: 'c1', link: 'https://site.test/c/1', _item: items[0] },
      { name: 'c2', link: 'https://other.test/x', _item: items[0] },
      { name: 'c3', link: 'https://site.test/c/3', _item: items[1] },
    ]);
  });

  it('extract inside foreach collects one entry per iteration (null when optional + missing)', async () => {
    const d = new FakeDriver();
    d.present = new Set(['#v']);
    let n = 0;
    d.read = async (sel: string) => { if (sel !== '#v') throw Object.assign(new Error('Timeout 1ms exceeded'), { name: 'TimeoutError' }); return `v${++n}`; };
    const { out, err } = await run(job({ payload: { xs: [{ s: '#v' }, { s: '#none' }, { s: '#v' }] } }), playbook([
      { id: 'f', action: 'foreach', items: '{{payload.xs}}', steps: [
        { id: 'e', action: 'extract', selector: '{{item.s}}', as: 'vals', optional: true },
      ] },
    ]), d);
    expect(err).toBeNull();
    expect(out?.outputs.vals).toEqual(['v1', null, 'v2']);
  });

  it('outside foreach extract/extract_list still replace the value', async () => {
    const d = new FakeDriver();
    d.present = new Set(['#a']);
    d.values = { '#a': 'one' };
    d.lists = { '.r': [{ t: 'x' }] };
    const { out } = await run(job(), playbook([
      { id: 'e1', action: 'extract', selector: '#a', as: 'v' },
      { id: 'e2', action: 'extract', selector: '#a', as: 'v' },
      { id: 'l1', action: 'extract_list', selector: '.r', as: 'rows', fields: { t: {} } },
      { id: 'l2', action: 'extract_list', selector: '.r', as: 'rows', fields: { t: {} } },
    ]), d);
    expect(out?.outputs.v).toBe('one');
    expect(out?.outputs.rows).toEqual([{ t: 'x' }]);
  });

  it('returns absolute href/src for extract attr', async () => {
    const d = new FakeDriver();
    d.currentUrl = 'https://site.test/dir/page';
    d.present = new Set(['a', 'img']);
    d.values = { 'a@href': '../p/7', 'img@src': '//cdn.test/i.png', 'a@data-id': 'rel/keep' };
    const { out } = await run(job(), playbook([
      { id: 'h', action: 'extract', selector: 'a', attr: 'href', as: 'href' },
      { id: 's', action: 'extract', selector: 'img', attr: 'src', as: 'src' },
      { id: 'o', action: 'extract', selector: 'a', attr: 'data-id', as: 'other' },
    ]), d);
    expect(out?.outputs).toEqual({ href: 'https://site.test/p/7', src: 'https://cdn.test/i.png', other: 'rel/keep' });
  });

  it('resolves templates in selectors, click_text text/role, keys and numeric/boolean fields', async () => {
    const d = new FakeDriver();
    d.present = new Set(["a[href*='someone']"]);
    d.texts = new Set(['Follow someone']);
    const j = job({ payload: { handle: 'someone', role: 'button', px: 250, n: 2, opt: true, key: 'Enter' } });
    const { err } = await run(j, playbook([
      { id: 'c', action: 'click', selector: "a[href*='{{payload.handle}}']" },
      { id: 't', action: 'click_text', text: 'Follow {{payload.handle}}', role: '{{payload.role}}' },
      { id: 'p', action: 'press', key: '{{payload.key}}' },
      { id: 's', action: 'scroll', pixels: '{{payload.px}}' as unknown as number, times: '{{payload.n}}' as unknown as number },
      { id: 'o', action: 'click', selector: '#absent', optional: '{{payload.opt}}' as unknown as boolean },
    ]), d);
    expect(err).toBeNull();
    expect(d.calls).toEqual(["click a[href*='someone']", 'clickText Follow someone [button]', 'press Enter', 'scroll 250', 'scroll 250']);
  });
});

describe('executor — guards and error mapping', () => {
  it('aborts with the guard code after goto', async () => {
    const d = new FakeDriver();
    d.onGoto['https://site.test/'] = () => { d.currentUrl = 'https://site.test/accounts/login'; };
    const pb = playbook([
      { id: 'g', action: 'goto', url: 'https://site.test/' },
      { id: 'c', action: 'click', selector: '#never' },
    ], { guards: [{ url_contains: '/accounts/login', code: 'SESSION_EXPIRED' }] });
    const { err } = await run(job(), pb, d);
    expect(err).toBeInstanceOf(AgentError);
    expect(err?.code).toBe('SESSION_EXPIRED');
    expect(err?.stepId).toBe('g');
    expect(d.calls).not.toContain('click #never');
  });

  it('checks selector and text guards after click', async () => {
    const d = new FakeDriver();
    d.present = new Set(['#btn']);
    d.onClick['#btn'] = () => { d.texts.add('Try again later'); };
    const pb = playbook([{ id: 'c', action: 'click', selector: '#btn' }], {
      guards: [{ selector: '#captcha', code: 'CAPTCHA' }, { text: 'Try again later', code: 'ACTION_BLOCKED' }],
    });
    const { err } = await run(job(), pb, d);
    expect(err?.code).toBe('ACTION_BLOCKED');
  });

  it('maps timeouts to SELECTOR_NOT_FOUND for element steps', async () => {
    const d = new FakeDriver();
    const { err } = await run(job(), playbook([{ id: 'c', action: 'click', selector: '#missing' }]), d);
    expect(err?.code).toBe('SELECTOR_NOT_FOUND');
    expect(err?.stepId).toBe('c');
  });

  it('maps navigation errors to NAVIGATION_FAILED and goto timeouts to TIMEOUT', async () => {
    const d = new FakeDriver();
    d.failOn['goto https://down.test/'] = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://down.test/');
    expect((await run(job(), playbook([{ id: 'g', action: 'goto', url: 'https://down.test/' }]), d)).err?.code).toBe('NAVIGATION_FAILED');
    const d2 = new FakeDriver();
    const te = new Error('page.goto: Timeout 60000ms exceeded.'); te.name = 'TimeoutError';
    d2.failOn['goto https://slow.test/'] = te;
    expect((await run(job(), playbook([{ id: 'g', action: 'goto', url: 'https://slow.test/' }]), d2)).err?.code).toBe('TIMEOUT');
  });

  it('assert fails with the step code', async () => {
    const d = new FakeDriver();
    d.present = new Set(['#ok']);
    const pass = await run(job(), playbook([{ id: 'a', action: 'assert', selector: '#ok', code: 'UNKNOWN' }]), d);
    expect(pass.err).toBeNull();
    const fail = await run(job(), playbook([{ id: 'a', action: 'assert', text: 'Your post was shared', code: 'SELECTOR_NOT_FOUND' }]), d);
    expect(fail.err?.code).toBe('SELECTOR_NOT_FOUND');
    const fail2 = await run(job(), playbook([{ id: 'a', action: 'assert', selector: '#nope', code: 'BANNED' }]), d);
    expect(fail2.err?.code).toBe('BANNED');
  });

  it('rejects unknown actions', async () => {
    const pb = playbook([{ id: 'x', action: 'teleport' } as unknown as Playbook['steps'][number]]);
    const { err } = await run(job(), pb, new FakeDriver());
    expect(err?.code).toBe('UNKNOWN');
  });

  it('bounds the whole job by timeout_ms', async () => {
    const d = new FakeDriver();
    const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
    });
    const { err } = await run(job({ timeout_ms: 30 }), playbook([{ id: 'd', action: 'delay', ms: 5000 }]), d, { sleep: realSleep });
    expect(err?.code).toBe('TIMEOUT');
  });

  it('Executor.checkGuards is a no-op without guards', async () => {
    const ex = new Executor(job(), playbook([]), deps(new FakeDriver()));
    await expect(ex.checkGuards('x')).resolves.toBeUndefined();
  });
});

describe('jobRunner', () => {
  const baseDeps = (d: FakeDriver, pb: Playbook) => {
    const adspower = { start: vi.fn(async () => ({ wsEndpoint: 'ws://local/x', debugPort: null })), stop: vi.fn(async () => undefined) };
    const close = vi.fn(async () => undefined);
    return {
      adspower, close,
      deps: {
        agentId: () => 'agent-1',
        fetchPlaybook: vi.fn(async () => pb),
        adspower,
        connect: async () => ({ driver: d, humanized: true, close }),
        download: async () => ({ paths: [], cleanup: async () => undefined }),
        sleep: recordingSleep().sleep,
        logger: nullLogger,
      },
    };
  };

  it('reports success with outputs and always stops the profile', async () => {
    const d = new FakeDriver();
    d.currentUrl = 'https://site.test/p/1';
    const { deps: dp, adspower, close } = baseDeps(d, playbook([{ id: 'u', action: 'extract_url', as: 'post_url' }]));
    const res = await executeJob(job(), dp);
    expect(res.status).toBe('success');
    expect(res.agent_id).toBe('agent-1');
    expect(res.outputs).toEqual({ post_url: 'https://site.test/p/1' });
    expect(adspower.start).toHaveBeenCalledWith('ads-1');
    expect(adspower.stop).toHaveBeenCalledWith('ads-1');
    expect(close).toHaveBeenCalled();
  });

  it('reports failure with code, step id and evidence screenshot', async () => {
    const d = new FakeDriver();
    const { deps: dp, adspower } = baseDeps(d, playbook([{ id: 'c', action: 'click', selector: '#x' }]));
    const res = await executeJob(job(), dp);
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ code: 'SELECTOR_NOT_FOUND', step_id: 'c' });
    expect(res.screenshot_b64).toBe(Buffer.from('png').toString('base64'));
    expect(adspower.stop).toHaveBeenCalled();
  });

  it('reports expired without opening the profile', async () => {
    const d = new FakeDriver();
    const { deps: dp, adspower } = baseDeps(d, playbook([]));
    const res = await executeJob(job({ expires_at: new Date(Date.now() - 1000).toISOString() }), dp);
    expect(res.status).toBe('expired');
    expect(adspower.start).not.toHaveBeenCalled();
    expect(dp.fetchPlaybook).not.toHaveBeenCalled();
  });

  it('maps AdsPower start failures to ADSPOWER_ERROR', async () => {
    const d = new FakeDriver();
    const { deps: dp, adspower } = baseDeps(d, playbook([]));
    adspower.start.mockRejectedValueOnce(new AgentError('ADSPOWER_ERROR', 'AdsPower: profile not found'));
    const res = await executeJob(job(), dp);
    expect(res.error?.code).toBe('ADSPOWER_ERROR');
    expect(adspower.stop).not.toHaveBeenCalled();
  });

  it('reports cancelled when aborted', async () => {
    const d = new FakeDriver();
    const { deps: dp } = baseDeps(d, playbook([{ id: 'd', action: 'delay', ms: 10 }]));
    const ctrl = new AbortController();
    ctrl.abort(new AgentError('CANCELLED', 'bye'));
    const res = await executeJob(job(), dp, ctrl.signal);
    expect(res.status).toBe('cancelled');
  });
});
