import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist/cli',
    clean: true,
    sourcemap: true,
    dts: false,
    external: ['tree-sitter', 'tree-sitter-typescript', 'tree-sitter-php'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/analyzer/parse-worker.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist/analyzer',
    clean: false,
    sourcemap: true,
    dts: false,
    external: ['tree-sitter', 'tree-sitter-typescript', 'tree-sitter-php'],
  },
]);
