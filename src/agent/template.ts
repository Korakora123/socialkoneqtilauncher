/**
 * Playbook template resolution.
 *
 * Supported roots: {{payload.x}}, {{item.x}}, {{outputs.x}}, {{hbe.x}}.
 * - A string that is exactly one template returns the raw value (array, number, object…).
 * - Otherwise every template is string-interpolated (missing → "", objects → JSON).
 */
export interface TemplateContext {
  payload: Record<string, unknown>;
  outputs: Record<string, unknown>;
  hbe: unknown;
  item?: unknown;
}

const WHOLE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ROOTS = new Set(['payload', 'outputs', 'hbe', 'item']);

export function lookup(path: string, ctx: TemplateContext): unknown {
  const parts = path.split('.').map((p) => p.trim()).filter((p) => p.length > 0);
  const root = parts.shift();
  if (!root || !ROOTS.has(root)) return undefined;
  let cur: unknown = (ctx as unknown as Record<string, unknown>)[root];
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (key === 'length') { cur = cur.length; continue; }
      const idx = Number(key);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, key) ? (cur as Record<string, unknown>)[key] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Resolve a value: whole-template strings return the raw referenced value. */
export function resolveTemplate(input: unknown, ctx: TemplateContext): unknown {
  if (typeof input !== 'string') return input;
  const whole = WHOLE.exec(input);
  if (whole) return lookup(whole[1], ctx);
  if (!input.includes('{{')) return input;
  return input.replace(ANY, (_m, p: string) => stringify(lookup(p, ctx)));
}

/** Resolve and coerce to a string (for selectors, urls, text, keys). */
export function resolveString(input: string, ctx: TemplateContext): string {
  return stringify(resolveTemplate(input, ctx));
}
