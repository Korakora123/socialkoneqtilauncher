import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Strict CSP for the packaged renderer (dev server needs inline HMR scripts, so build only). */
const csp = (): Plugin => ({
  name: 'sk-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" />`,
  ),
});

// Renderer bundle only. main.ts / preload.ts are bundled by scripts/build-main.mjs (esbuild).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), csp()],
  css: { postcss: resolve(__dirname, 'postcss.config.js') },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
  },
});
