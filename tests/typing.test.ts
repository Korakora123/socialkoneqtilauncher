import { describe, expect, it } from 'vitest';
import { humanType } from '../src/agent/typing';
import { FakeDriver, hbe, recordingSleep } from './helpers';

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('humanType', () => {
  it('types char by char with per-char delays inside the brain-supplied range', async () => {
    const d = new FakeDriver();
    const { sleep, waits } = recordingSleep();
    const typing = hbe({ typing: { min_char_ms: 40, max_char_ms: 90, typo_rate: 0, word_pause_rate: 0, word_pause_ms: [0, 0] } }).typing;
    await humanType(d, 'Hello world', typing, sleep, seq([0, 0.5, 0.99, 0.25]));
    expect(d.typed).toBe('Hello world');
    expect(waits).toHaveLength('Hello world'.length);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(40);
      expect(w).toBeLessThanOrEqual(90);
    }
    expect(waits.slice(0, 3)).toEqual([40, 65, 90]);
  });

  it('makes typos at typo_rate and corrects them with Backspace', async () => {
    const d = new FakeDriver();
    const typedSeq: string[] = [];
    const orig = d.typeChar.bind(d);
    d.typeChar = async (c: string) => { typedSeq.push(c); await orig(c); };
    const { sleep } = recordingSleep();
    const typing = hbe({ typing: { min_char_ms: 10, max_char_ms: 10, typo_rate: 1, word_pause_rate: 0, word_pause_ms: [0, 0] } }).typing;
    await humanType(d, 'ab 1', typing, sleep, () => 0);
    expect(d.typed).toBe('ab 1');
    // 'a' and 'b' each get one wrong letter first; space and digit never get typos
    expect(typedSeq.length).toBe(6);
    expect(typedSeq[1]).toBe('a');
    expect(typedSeq[0]).not.toBe('a');
  });

  it('adds word pauses after spaces within word_pause_ms', async () => {
    const d = new FakeDriver();
    const { sleep, waits } = recordingSleep();
    const typing = hbe({ typing: { min_char_ms: 5, max_char_ms: 5, typo_rate: 0, word_pause_rate: 1, word_pause_ms: [400, 800] } }).typing;
    await humanType(d, 'a b c', typing, sleep, () => 0.5);
    const pauses = waits.filter((w) => w !== 5);
    expect(pauses).toEqual([600, 600]);
  });

  it('respects abort signals', async () => {
    const d = new FakeDriver();
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    const { sleep } = recordingSleep();
    await expect(humanType(d, 'abc', hbe().typing, sleep, Math.random, ctrl.signal)).rejects.toThrow('stop');
  });
});
