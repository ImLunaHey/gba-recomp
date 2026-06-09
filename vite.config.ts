import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin spins up worker environments that aren't
// compatible with vitest's Node externals, so we only enable it for
// the actual dev/build pipeline. Vitest sets process.env.VITEST.
const isTest = !!process.env.VITEST;

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(isTest ? [] : [cloudflare()])],
  server: {
    fs: { allow: ['..'] },
    // No COOP / COEP — we don't use SharedArrayBuffer or atomics, and
    // `require-corp` blocks cross-origin images (LibRetro thumbnails)
    // since their server doesn't send Cross-Origin-Resource-Policy.
  },
  build: {
    target: 'esnext',
  },
  assetsInclude: ['**/*.gba'],
  test: {
    coverage: {
      provider: 'v8',
      // Cover only the recompiler source, not the React UI / Cloudflare
      // worker / test helpers — those are exercised mostly through
      // end-to-end paths that aren't part of the unit test surface.
      include: ['src/cpu/**', 'src/io/**', 'src/memory/**', 'src/ppu/**', 'src/emulator.ts', 'src/savestate.ts'],
      exclude: [
        '**/*.test.ts',
        'src/test/**',
        '**/node_modules/**',
      ],
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});