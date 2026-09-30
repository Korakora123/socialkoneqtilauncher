/**
 * The only browser surface the executor uses. Implemented for Playwright pages by
 * PlaywrightDriver (browser.ts) and by fakes in tests. Contains no selectors or URLs.
 */
export interface ListField { selector?: string; attr?: string }

/** A browser cookie as read from / written to the profile's context (session backups only). */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface PageDriver {
  goto(url: string, timeoutMs: number): Promise<void>;
  url(): string;
  waitFor(selector: string, timeoutMs: number): Promise<void>;
  exists(selector: string): Promise<boolean>;
  containsText(text: string): Promise<boolean>;
  click(selector: string, timeoutMs: number): Promise<void>;
  clickText(text: string, role: string | undefined, timeoutMs: number): Promise<void>;
  /** Focus an input by clicking it; `clear` empties it via keyboard (select-all + Backspace). */
  focus(selector: string, clear: boolean, timeoutMs: number): Promise<void>;
  /** Types exactly one character through the keyboard. */
  typeChar(ch: string): Promise<void>;
  press(key: string): Promise<void>;
  setInputFiles(selector: string, filePaths: string[], timeoutMs: number): Promise<void>;
  scroll(pixels: number): Promise<void>;
  read(selector: string, attr: string | undefined, timeoutMs: number): Promise<string | null>;
  readList(selector: string, fields: Record<string, ListField>, limit: number | undefined): Promise<Array<Record<string, string | null>>>;
  screenshot(): Promise<Buffer>;
  /** Session backup/restore (Protocol 5). Values stay on this PC — never logged, never reported. */
  getCookies(): Promise<SessionCookie[]>;
  addCookies(cookies: SessionCookie[]): Promise<void>;
  /** localStorage of the current page's origin. */
  getLocalStorage(): Promise<Record<string, string>>;
  setLocalStorage(items: Record<string, string>): Promise<void>;
}

/** True when a thrown error is a Playwright timeout. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(err.message));
}

export function isNavigationError(err: unknown): boolean {
  return err instanceof Error && /net::ERR_|NS_ERROR_|Navigation failed|navigating to/i.test(err.message);
}
