import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@dbx/database';
import { ConfigError, loadConfig } from './config';
import { buildApp } from './app';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Problems name variables, never their values.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // The production bundle ships migrations in dist/migrations; in dev the package default is used.
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  const migrationsDir = config.migrationsDir ?? (existsSync(bundled) ? bundled : undefined);
  const database = await createDatabase(config.databaseUrl, migrationsDir ? { migrationsDir } : {});
  // Versioned migrations are applied on start (never schema push).
  await database.migrate();

  const app = await buildApp({ config, database });
  const bootstrap = await app.services.users.bootstrapAdmin(config.bootstrapAdmin);
  if (bootstrap === 'created')
    app.log.info({ email: config.bootstrapAdmin?.email }, 'bootstrap administrator created');

  const housekeeping = setInterval(() => {
    void app.services.sessions
      .purgeExpired()
      .catch((err: unknown) => app.log.warn({ err }, 'session purge failed'));
    void app.services.confirmations
      .purge()
      .catch((err: unknown) => app.log.warn({ err }, 'preview purge failed'));
  }, 3600_000);
  housekeeping.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(housekeeping);
    try {
      await app.close();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      version: config.version,
      commit: config.commit,
      omieMode: config.omie.mode,
      readOnly: config.omie.readOnly,
      database: database.kind,
      ai: config.ai.provider,
    },
    'Omie SQL Explorer API started',
  );
}

main().catch((err: unknown) => {
  console.error(
    'Fatal error during startup:',
    err instanceof Error ? err.message : 'unknown error',
  );
  process.exit(1);
});
