import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });

  // The website subscriber sync runs only in the real server, never in a test's buildApp().
  if (app.subscriberSync) {
    app.log.info(
      { interval_ms: config.WEBSITE_SYNC_INTERVAL_MS, auto_accept: config.MATCH_AUTO_ACCEPT },
      'website subscriber sync on',
    );
    app.subscriberSync.startScheduling();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
