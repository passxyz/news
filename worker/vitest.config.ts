import { defineConfig } from 'vitest/config';

// Lightweight test setup: route handlers are exercised in a Node
// environment via Hono's `app.request(path, init, env)`. The Workers
// runtime is not required because all Cloudflare bindings (KV) and
// outbound fetch calls (Resend / GitHub) are mocked in the tests.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
