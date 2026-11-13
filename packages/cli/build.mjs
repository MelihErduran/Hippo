// Bundles the CLI into one file (dist/hippo.mjs) and copies the ranker wasm
// next to it, so launchd can run it by absolute path with no node_modules.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/hippo.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});
const wasm = '../core/assets/hippo_ranker.wasm';
if (existsSync(wasm)) copyFileSync(wasm, 'dist/hippo_ranker.wasm');
chmodSync('dist/hippo.mjs', 0o755);
console.log(`built dist/hippo.mjs${existsSync(wasm) ? ' + hippo_ranker.wasm' : ' (no wasm: TypeScript ranker fallback)'}`);
