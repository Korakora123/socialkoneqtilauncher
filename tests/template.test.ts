import { describe, expect, it } from 'vitest';
import { lookup, resolveString, resolveTemplate, type TemplateContext } from '../src/agent/template';

const ctx: TemplateContext = {
  payload: { caption: 'Hello', media: ['a.jpg', 'b.jpg'], nested: { n: 5 }, tags: ['x'] },
  outputs: { post_url: 'https://example.test/p/1' },
  hbe: { think_ms: 2500 },
  item: { handle: 'someone', idx: 2 },
};

describe('template engine', () => {
  it('returns raw values for a single whole template', () => {
    expect(resolveTemplate('{{payload.media}}', ctx)).toEqual(['a.jpg', 'b.jpg']);
    expect(resolveTemplate('{{ hbe.think_ms }}', ctx)).toBe(2500);
    expect(resolveTemplate('{{payload.nested}}', ctx)).toEqual({ n: 5 });
  });

  it('interpolates mixed strings', () => {
    expect(resolveTemplate('Hi {{item.handle}} #{{item.idx}}', ctx)).toBe('Hi someone #2');
    expect(resolveString('[data-x="{{payload.nested.n}}"]', ctx)).toBe('[data-x="5"]');
    expect(resolveString('{{outputs.post_url}}?a=1', ctx)).toBe('https://example.test/p/1?a=1');
  });

  it('handles missing values and array indexes', () => {
    expect(resolveTemplate('{{payload.missing.deep}}', ctx)).toBeUndefined();
    expect(resolveString('x{{payload.missing}}y', ctx)).toBe('xy');
    expect(lookup('payload.media.1', ctx)).toBe('b.jpg');
    expect(lookup('payload.media.length', ctx)).toBe(2);
  });

  it('only exposes the four documented roots', () => {
    expect(resolveTemplate('{{process.env}}', ctx)).toBeUndefined();
    expect(resolveTemplate('{{constructor}}', ctx)).toBeUndefined();
    expect(lookup('payload.constructor', ctx)).toBeUndefined();
  });

  it('leaves non-template strings and non-strings untouched', () => {
    expect(resolveTemplate('plain', ctx)).toBe('plain');
    expect(resolveTemplate(42, ctx)).toBe(42);
  });

  it('stringifies objects when interpolating', () => {
    expect(resolveString('v={{payload.tags}}', ctx)).toBe('v=["x"]');
  });
});
