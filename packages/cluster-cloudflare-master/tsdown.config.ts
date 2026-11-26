import { defineConfig } from 'tsdown'

/** Cloudflare Workers entry bundles from sources; wrangler deploys src/index.ts directly, and Workers never load this lib/. */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
  },
])
