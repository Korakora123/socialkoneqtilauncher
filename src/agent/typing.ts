import type { HbePlan } from '../shared/contract';
import type { PageDriver } from './driver';
import { randomBetween, type SleepFn } from './util';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Types text one character at a time with the timing the brain supplied in `hbe.typing`:
 * - per-character delay uniformly in [min_char_ms, max_char_ms]
 * - with probability typo_rate a wrong letter is typed, then removed with Backspace
 * - after a space, with probability word_pause_rate an extra pause in word_pause_ms
 * Never uses page.fill().
 */
export async function humanType(
  driver: Pick<PageDriver, 'typeChar' | 'press'>,
  text: string,
  typing: HbePlan['typing'],
  sleep: SleepFn,
  rng: () => number = Math.random,
  signal?: AbortSignal,
): Promise<void> {
  const charDelay = (): number => randomBetween(typing.min_char_ms, typing.max_char_ms, rng);
  for (const ch of Array.from(text)) {
    if (/[a-z]/i.test(ch) && typing.typo_rate > 0 && rng() < typing.typo_rate) {
      let wrong = LETTERS[Math.floor(rng() * LETTERS.length) % LETTERS.length];
      if (wrong === ch.toLowerCase()) wrong = LETTERS[(LETTERS.indexOf(wrong) + 1) % LETTERS.length];
      await driver.typeChar(ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong);
      await sleep(charDelay(), signal);
      await driver.press('Backspace');
      await sleep(charDelay(), signal);
    }
    await driver.typeChar(ch);
    await sleep(charDelay(), signal);
    if (ch === ' ' && typing.word_pause_rate > 0 && rng() < typing.word_pause_rate) {
      const [lo, hi] = typing.word_pause_ms;
      await sleep(randomBetween(lo, hi, rng), signal);
    }
  }
}
