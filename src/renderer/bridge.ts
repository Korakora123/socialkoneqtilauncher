import type { SkBridge } from '../shared/ipc';

declare global {
  interface Window { sk: SkBridge }
}

export const sk: SkBridge = window.sk;
