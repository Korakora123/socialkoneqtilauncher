/**
 * Browser adapter: connects to a running AdsPower profile over CDP and applies
 * CloakBrowser's human behaviour layer (Bézier mouse, natural keyboard, smooth scroll).
 *
 * Deviation from the blueprint: cloakbrowser (npm) does not export `chromium` /
 * `chromium.connectOverCDP(ws, { humanize })`. Its public API is `launch*()` plus
 * `humanizeBrowser(browser, { humanize: true })`. So we connect with playwright-core's
 * `chromium.connectOverCDP` and then call cloakbrowser's `humanizeBrowser` on the result.
 * If cloakbrowser cannot be loaded, execution continues with plain Playwright input and a warning.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import type { ListField, PageDriver } from './driver';
import type { Logger } from './util';

export interface BrowserSession {
  driver: PageDriver;
  humanized: boolean;
  /** Disconnects Playwright (the AdsPower profile itself is stopped by the caller). */
  close(): Promise<void>;
}

// cloakbrowser is ESM-only. The main bundle is CommonJS (esbuild converts plain import() to
// require()), so a real native dynamic import is created here where the bundler cannot rewrite it.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importEsm = new Function('s', 'return import(s)') as (specifier: string) => Promise<unknown>;

/**
 * Absolute file URL of an ESM-only package's entry (its exports["."].import), found through the
 * normal node_modules lookup. Packaged builds keep the package in app.asar.unpacked (asarUnpack).
 */
export function resolveEsmEntry(pkg: string, from: string = __filename): string {
  const req = createRequire(from);
  for (const base of req.resolve.paths(pkg) ?? []) {
    const pkgJson = join(base, pkg, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
      main?: string; exports?: { '.'?: { import?: string } | string };
    };
    const dot = meta.exports?.['.'];
    const rel = (typeof dot === 'string' ? dot : dot?.import) ?? meta.main ?? 'index.js';
    let file = join(dirname(pkgJson), rel);
    const unpacked = file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (unpacked !== file && existsSync(unpacked)) file = unpacked;
    return pathToFileURL(file).href;
  }
  throw new Error(`${pkg} is not installed`);
}

export async function connectProfile(wsEndpoint: string, logger: Logger): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core');
  const browser: Browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 60_000 });
  let humanized = false;
  try {
    const cloak = (await importEsm(resolveEsmEntry('cloakbrowser'))) as {
      humanizeBrowser?: (b: Browser, o: { humanize: boolean }) => Promise<void>;
    };
    if (typeof cloak.humanizeBrowser === 'function') {
      await cloak.humanizeBrowser(browser, { humanize: true });
      humanized = true;
    }
  } catch (e) {
    logger.warn('cloakbrowser humanize layer unavailable, using plain input', { reason: e instanceof Error ? e.name : 'unknown' });
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    driver: new PlaywrightDriver(page),
    humanized,
    close: async () => { await browser.close().catch(() => undefined); },
  };
}

export class PlaywrightDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }
  url(): string { return this.page.url(); }
  async waitFor(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }
  async exists(selector: string): Promise<boolean> {
    return (await this.page.locator(selector).count()) > 0;
  }
  async containsText(text: string): Promise<boolean> {
    return (await this.page.getByText(text, { exact: false }).count()) > 0;
  }
  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().click({ timeout: timeoutMs });
  }
  async clickText(text: string, role: string | undefined, timeoutMs: number): Promise<void> {
    const loc = role
      ? this.page.getByRole(role as Parameters<Page['getByRole']>[0], { name: text })
      : this.page.getByText(text, { exact: false });
    await loc.first().click({ timeout: timeoutMs });
  }
  async focus(selector: string, clear: boolean, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().click({ timeout: timeoutMs });
    if (clear) {
      await this.page.keyboard.press('ControlOrMeta+A');
      await this.page.keyboard.press('Backspace');
    }
  }
  async typeChar(ch: string): Promise<void> { await this.page.keyboard.type(ch); }
  async press(key: string): Promise<void> { await this.page.keyboard.press(key); }
  async setInputFiles(selector: string, filePaths: string[], timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().setInputFiles(filePaths, { timeout: timeoutMs });
  }
  async scroll(pixels: number): Promise<void> { await this.page.mouse.wheel(0, pixels); }
  async read(selector: string, attr: string | undefined, timeoutMs: number): Promise<string | null> {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout: timeoutMs });
    if (!attr) return loc.textContent({ timeout: timeoutMs });
    return loc.evaluate((el, a) => {
      const v = el.getAttribute(a);
      if (v === null || (a !== 'href' && a !== 'src')) return v;
      try { return new URL(v, document.baseURI).href; } catch { return v; }
    }, attr.toLowerCase() === 'href' || attr.toLowerCase() === 'src' ? attr.toLowerCase() : attr, { timeout: timeoutMs });
  }
  async readList(selector: string, fields: Record<string, ListField>, limit: number | undefined): Promise<Array<Record<string, string | null>>> {
    return this.page.$$eval(
      selector,
      (els, arg) => {
        const { fields: f, limit: max } = arg as { fields: Record<string, { selector?: string; attr?: string }>; limit: number | null };
        const rows = max !== null ? els.slice(0, max) : els;
        return rows.map((el) => {
          const row: Record<string, string | null> = {};
          for (const [name, spec] of Object.entries(f)) {
            const target = spec.selector ? el.querySelector(spec.selector) : el;
            if (!target) { row[name] = null; continue; }
            if (!spec.attr) { row[name] = (target.textContent ?? '').trim(); continue; }
            const a = spec.attr.toLowerCase();
            const v = target.getAttribute(spec.attr);
            if (v !== null && (a === 'href' || a === 'src')) {
              try { row[name] = new URL(v, document.baseURI).href; } catch { row[name] = v; }
            } else {
              row[name] = v;
            }
          }
          return row;
        });
      },
      { fields, limit: limit ?? null },
    );
  }
  async screenshot(): Promise<Buffer> { return this.page.screenshot({ type: 'png' }); }
}
