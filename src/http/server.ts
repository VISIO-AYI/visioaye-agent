import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { request as undiciRequest } from 'undici';
import { AGENT_VERSION, getCorsOrigins, getServerUrl, LOCAL_HTTP_HOST, LOCAL_HTTP_PORT } from '../common/config.js';
import { logger } from '../common/logger.js';
import { assertBindingPathSafe, BindingPathUnsafeError } from '../common/path-guard.js';
import { getDataDir } from '../common/paths.js';
import { openDb } from '../db/sqlite.js';
import { activatePostPairing } from '../lifecycle.js';
import { getStoredJwt, completePairing, isPaired } from '../pairing/pairing.service.js';
import { refreshManifest } from '../sync/manifest.js';
import { attachBinding } from '../watcher/watcher.js';
import { getLocalToken, verifyLocalToken } from './local-token.js';

const PUBLIC_PATHS = new Set(['/health', '/token']);
const LOCAL_TOKEN_HEADER = 'x-visioaye-local-token';

export async function buildLocalHttpServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  await app.register(cors, {
    origin: getCorsOrigins(),
    methods: ['GET', 'POST', 'DELETE'],
    credentials: false,
    allowedHeaders: ['content-type', 'authorization', 'x-visioaye-local-token'],
  });

  app.addHook('onRequest', (req, reply, done) => {
    if (req.method === 'OPTIONS') return done();
    const url = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return done();
    const provided = req.headers[LOCAL_TOKEN_HEADER];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!verifyLocalToken(token)) {
      logger.warn('HTTP local: token manquant ou invalide', { url });
      reply.code(401).send({ error: 'Token local manquant ou invalide' });
      return;
    }
    done();
  });

  app.get('/health', () => ({
    status: 'ok',
    version: AGENT_VERSION,
    paired: isPaired(),
    serverUrl: getServerUrl(),
  }));

  app.get('/token', () => {
    const token = getLocalToken();
    if (!token) return { error: 'Token non initialise' };
    return { token };
  });

  app.post<{ Body: { serverUrl: string } }>('/config', async (req, reply) => {
    const { serverUrl } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !/^https?:\/\//.test(serverUrl)) {
      return reply.code(400).send({ error: 'serverUrl invalide (http(s)://... attendu)' });
    }
    const configPath = join(getDataDir(), 'config.json');
    writeFileSync(configPath, JSON.stringify({ serverUrl }, null, 2));
    logger.info('Config serveur mise a jour (hot reload actif)', { serverUrl });
    return reply.code(200).send({ serverUrl, applied: true });
  });

  app.post<{ Body: { pairingCode: string } }>('/pair', async (req, reply) => {
    const code = req.body?.pairingCode;
    if (typeof code !== 'string' || code.length < 32) {
      return reply.code(400).send({ error: 'pairingCode manquant ou invalide' });
    }
    try {
      const { deviceId } = await completePairing(code);
      void activatePostPairing();
      return reply.code(201).send({ deviceId });
    } catch (err) {
      logger.error('Pairing echoue', { message: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/pick-folder', () => {
    return { error: 'Dialog systeme natif non disponible en mode service - saisir le chemin manuellement' };
  });

  app.get('/bindings', () => {
    const db = openDb();
    const rows = db
      .prepare('SELECT id, server_id, folder_id, local_path, created_at FROM local_bindings')
      .all() as Array<{ id: number; server_id: number; folder_id: number; local_path: string; created_at: string }>;
    return rows;
  });

  app.post<{ Body: { folderId: number; localPath: string } }>('/bindings', async (req, reply) => {
    const { folderId, localPath } = req.body ?? {};
    if (typeof folderId !== 'number' || typeof localPath !== 'string' || !localPath.trim()) {
      return reply.code(400).send({ error: 'folderId (number) et localPath (string) requis' });
    }
    const jwt = getStoredJwt();
    if (!jwt) return reply.code(409).send({ error: 'Agent non paired' });

    let absPath: string;
    try {
      absPath = assertBindingPathSafe(localPath);
    } catch (err) {
      if (err instanceof BindingPathUnsafeError) {
        logger.warn('Binding refuse (path unsafe)', { path: err.path, reason: err.reason });
        return reply.code(400).send({ error: `Chemin refuse : ${err.reason}` });
      }
      return reply.code(400).send({ error: (err as Error).message });
    }
    try {
      mkdirSync(absPath, { recursive: true });
      const stat = statSync(absPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: `${absPath} n'est pas un dossier` });
      }
    } catch (err) {
      return reply.code(400).send({ error: `Dossier inaccessible : ${(err as Error).message}` });
    }

    const srv = await undiciRequest(`${getServerUrl()}/sync/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ folderId, localPath: absPath }),
    });
    const text = await srv.body.text();
    if (srv.statusCode >= 300) {
      logger.error('Binding serveur refuse', { status: srv.statusCode, text });
      return reply.code(srv.statusCode).send({ error: text });
    }
    const parsed = JSON.parse(text) as { id: number; folderId: number; localPath: string };

    const db = openDb();
    db.prepare(
      `INSERT OR REPLACE INTO local_bindings (server_id, folder_id, local_path)
       VALUES (?, ?, ?)`,
    ).run([parsed.id, parsed.folderId, parsed.localPath]);

    try {
      await refreshManifest(parsed.id, parsed.folderId);
    } catch (err) {
      logger.error('Refresh manifest post-binding echoue', { message: (err as Error).message });
    }

    try {
      await attachBinding(parsed.id, parsed.folderId, parsed.localPath);
    } catch (err) {
      logger.error('Attache watcher post-binding echouee', { message: (err as Error).message });
    }

    logger.info('Binding cree', { folderId: parsed.folderId, localPath: parsed.localPath });
    return reply.code(201).send(parsed);
  });

  return app;
}

export async function startLocalHttpServer(): Promise<FastifyInstance> {
  const app = await buildLocalHttpServer();
  await app.listen({ host: LOCAL_HTTP_HOST, port: LOCAL_HTTP_PORT });
  logger.info('HTTP local demarre', { host: LOCAL_HTTP_HOST, port: LOCAL_HTTP_PORT });
  return app;
}
