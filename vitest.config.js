import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // File parallelism disabled due to Docker port allocation race conditions.
    // When multiple tests run in parallel, they can both find the same port
    // available, then both try to bind it, causing "docker start" failures.
    // CI parallelization is achieved via GitHub Actions matrix sharding instead.
    fileParallelism: false,
    mockReset: true,
    globalSetup: './test/setup/global.js',
    exclude: ['**/node_modules/**', '**/test/web/**', '**/test/tui/**', '**/web/e2e/**'],
  },
});
