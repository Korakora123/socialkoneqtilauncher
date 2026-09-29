import { nativeImage, type NativeImage } from 'electron';

type Rgb = [number, number, number];
const COLORS: Record<'active' | 'warn' | 'error' | 'paused', Rgb> = {
  active: [0x7c, 0x3a, 0xed],   // violet — brand
  warn: [0xf5, 0x9e, 0x0b],     // starting / reconnecting
  error: [0xef, 0x44, 0x44],    // action needed
  paused: [0x94, 0xa3, 0xb8],   // paused
};

/** Draws a round tray icon in code (no binary assets in the repo). */
export function trayIcon(kind: keyof typeof COLORS, size = 32): NativeImage {
  const [r, g, b] = COLORS[kind];
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5));
      const inner = Math.hypot(x - c, y - c) < radius * 0.38;
      const i = (y * size + x) * 4;
      // BGRA
      buf[i] = inner ? 0xff : b;
      buf[i + 1] = inner ? 0xff : g;
      buf[i + 2] = inner ? 0xff : r;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
