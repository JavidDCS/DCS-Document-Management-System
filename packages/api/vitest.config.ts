import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@dcs-docs/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  test: {
    // Empties and migrates the "_test" database before any test, and refuses to run against any other database.
    globalSetup: ['./test/setup/globalSetup.ts'],
    env: { NODE_ENV: 'test' },
    include: ['test/**/*.test.ts'],
    // Test files share one database; running them one at a time removes cross-file races.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
