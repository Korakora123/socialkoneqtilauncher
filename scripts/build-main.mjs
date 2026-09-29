// Bundles the Electron main + preload processes with esbuild (CommonJS, Node target).
// Runtime dependencies stay external and are loaded from node_modules inside the asar.
// `cloakbrowser` is ESM-only; it is loaded with a dynamic import() which esbuild preserves.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
  // turn `await import('cjs-dep')` into require() so everything loads through Electron's asar-aware require
  supported: { 'dynamic-import': false },
};

await build({ ...common, entryPoints: { main: 'main.ts', preload: 'preload.ts' }, outdir: 'dist/main' });
