import { logger } from './common/logger.js';
import { ensureDataDirs } from './common/paths.js';
import { closeDb } from './db/sqlite.js';
import { initLocalToken } from './http/local-token.js';
import { startLocalHttpServer } from './http/server.js';
import { activatePostPairing, getWsClient } from './lifecycle.js';
import { isPaired } from './pairing/pairing.service.js';
import { initQueue } from './sync/upload-queue.js';
import { startUpdater } from './updater/updater.js';
import { stopWatchers } from './watcher/watcher.js';

async function bootstrap(): Promise<void> {
  logger.info('Bootstrap: debut', { pid: process.pid, node: process.version, platform: process.platform });
  ensureDataDirs();
  logger.info('Bootstrap: dossiers data prets');
  initLocalToken();
  logger.info('Bootstrap: token local initialise');
  initQueue();
  logger.info('Bootstrap: upload-queue initialisee');

  const http = await startLocalHttpServer();
  logger.info('Bootstrap: HTTP local demarre');

  if (isPaired()) {
    logger.info('Bootstrap: agent paired - activation post-pairing');
    await activatePostPairing();
  } else {
    logger.info('Agent demarre non-paired - en attente du flow /pair');
  }

  startUpdater();
  logger.info('Bootstrap: updater demarre - agent pret');

  const shutdown = async (signal: string) => {
    logger.info('Shutdown: debut', { signal });
    try { stopWatchers(); } catch (err) { logger.error('Shutdown: stopWatchers KO', { message: (err as Error).message }); }
    try { getWsClient().stop(); } catch (err) { logger.error('Shutdown: wsClient.stop KO', { message: (err as Error).message }); }
    try { await http.close(); } catch (err) { logger.error('Shutdown: http.close KO', { message: (err as Error).message }); }
    try { closeDb(); } catch (err) { logger.error('Shutdown: closeDb KO', { message: (err as Error).message }); }
    logger.info('Shutdown: fin propre');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err: Error) => {
  logger.error('Bootstrap echoue', { message: err.message, stack: err.stack });
  process.exit(1);
});
