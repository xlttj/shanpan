import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // LadybugDB uses large memory-mapped files; running test files in parallel
    // exhausts the mmap address space. Sequential execution avoids this.
    fileParallelism: false,
  },
});
