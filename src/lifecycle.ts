import { logger } from './common/logger.js';
import { refreshAllBindings } from './sync/manifest.js';
import { WsClient } from './sync/ws-client.js';
import { startWatchers } from './watcher/watcher.js';

let wsClient: WsClient | null = null;
let activated = false;

export function getWsClient(): WsClient {
  if (!wsClient) wsClient = new WsClient();
  return wsClient;
}

export async function activatePostPairing(): Promise<void> {
  if (activated) {
    logger.debug('activatePostPairing ignore : deja active');
    return;
  }
  activated = true;
  const ws = getWsClient();
  ws.start();
  try {
    await refreshAllBindings();
  } catch (err) {
    logger.error('refreshAllBindings a echoue post-pairing', { message: (err as Error).message });
  }
  try {
    await startWatchers();
  } catch (err) {
    logger.error('startWatchers a echoue post-pairing', { message: (err as Error).message });
  }
  logger.info('Agent active post-pairing : WS + manifests + watchers en route');
}

export function isActivated(): boolean {
  return activated;
}
