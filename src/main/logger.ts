import log from 'electron-log/main';
import type { Logger } from '../agent/util';

log.initialize();
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';

const SECRET = /(sk_live_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g;
const scrub = (v: unknown): unknown => (typeof v === 'string' ? v.replace(SECRET, '[redacted]') : v);
const clean = (meta?: Record<string, unknown>): Record<string, unknown> | undefined =>
  meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, scrub(v)])) : undefined;

/**
 * Local log. Only job ids / types / statuses / error codes are ever logged —
 * never API keys, payload text or playbook content.
 */
export const logger: Logger = {
  info: (msg, meta) => log.info(msg, ...(meta ? [clean(meta)] : [])),
  warn: (msg, meta) => log.warn(msg, ...(meta ? [clean(meta)] : [])),
  error: (msg, meta) => log.error(msg, ...(meta ? [clean(meta)] : [])),
};
