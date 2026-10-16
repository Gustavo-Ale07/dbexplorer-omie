import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`pnpm build`): the API serves the web bundle from
// STATIC_DIR, with the mock Omie client, an in-memory database and the offline AI mock.
// Writes are enabled only because every row lives in the mock's memory.
const PORT = 3199;
const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const BOOTSTRAP = { email: 'admin@example.com', password: 'E2E-Bootstrap#2026' };

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `node "${root('../apps/api/dist/server.mjs')}"`,
    url: `http://localhost:${PORT}/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL: 'pglite:memory',
      STATIC_DIR: root('../apps/web/dist'),
      SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP.email,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP.password,
      BOOTSTRAP_ADMIN_NAME: 'Admin Demo',
      OMIE_MODE: 'mock',
      OMIE_MOCK_LATENCY_MS: '20',
      OMIE_READ_ONLY: 'false',
      OMIE_ALLOW_INSERT: 'true',
      OMIE_ALLOW_UPDATE: 'true',
      OMIE_ALLOW_DELETE: 'true',
      AI_PROVIDER: 'mock',
      LOG_LEVEL: 'warn',
    },
  },
});
