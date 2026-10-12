import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ERROR_MESSAGES } from './jobs.js';
import { SocialUrlError } from './urls.js';
import { InvalidCursorError, type ImportService } from './service.js';

/** Returns the authenticated user id, or null. Plug the project's real token verification in here. */
export type AuthVerifier = (bearerToken: string) => Promise<string | null> | string | null;

/** LOCAL DEVELOPMENT ONLY: token "dev-<userId>" maps to that user. Never enable outside local. */
export const devAuthVerifier: AuthVerifier = (t) => (/^dev-[A-Za-z0-9_-]{1,64}$/.test(t) ? t.slice(4) : null);

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type RequestLog = (entry: Record<string, unknown>) => void;

export function buildServer(service: ImportService, verify: AuthVerifier, log?: RequestLog): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 });

  // Never logs headers, bodies or query strings (cursors/URLs may be sensitive).
  if (log) {
    app.addHook('onResponse', async (req, reply) => {
      log({ msg: 'request', method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
    });
  }

  async function userOf(req: FastifyRequest): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    return (await verify(h.slice(7).trim())) ?? null;
  }

  app.post('/v1/social-videos/import', async (req, reply) => {
    const userId = await userOf(req);
    if (!userId) return reply.code(401).send({ errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });

    const url = (req.body as { url?: unknown } | null)?.url;
    if (typeof url !== 'string') {
      return reply.code(400).send({ errorCode: 'INVALID_URL', message: ERROR_MESSAGES.INVALID_URL });
    }
    try {
      const r = await service.startImport(userId, url);
      return reply.code(r.created ? 202 : 200).send({ jobId: r.jobId, status: r.status });
    } catch (e) {
      if (e instanceof SocialUrlError) {
        return reply.code(400).send({ errorCode: e.code, message: ERROR_MESSAGES[e.code] });
      }
      return reply.code(500).send({ errorCode: 'UNKNOWN_ERROR', message: ERROR_MESSAGES.UNKNOWN_ERROR });
    }
  });

  app.get<{ Params: { jobId: string } }>('/v1/social-videos/import/:jobId', async (req, reply) => {
    const userId = await userOf(req);
    if (!userId) return reply.code(401).send({ errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });
    if (!ID_RE.test(req.params.jobId)) return reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
    const dto = await service.getJob(userId, req.params.jobId);
    return dto ? dto : reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/v1/social-videos', async (req, reply) => {
    const userId = await userOf(req);
    if (!userId) return reply.code(401).send({ errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });
    const { limit: rawLimit, cursor } = req.query;
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && typeof cursor !== 'string')) {
      return reply.code(400).send({ errorCode: 'INVALID_REQUEST', message: 'Invalid pagination parameters.' });
    }
    try {
      return await service.listVideos(userId, limit, cursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return reply.code(400).send({ errorCode: 'INVALID_REQUEST', message: 'Invalid pagination parameters.' });
      }
      throw e;
    }
  });

  app.get<{ Params: { videoId: string } }>('/v1/social-videos/:videoId', async (req, reply) => {
    const userId = await userOf(req);
    if (!userId) return reply.code(401).send({ errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });
    if (!ID_RE.test(req.params.videoId)) return reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
    const dto = await service.getVideo(userId, req.params.videoId);
    return dto ? dto : reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
  });

  app.delete<{ Params: { videoId: string } }>('/v1/social-videos/:videoId', async (req, reply) => {
    const userId = await userOf(req);
    if (!userId) return reply.code(401).send({ errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });
    if (!ID_RE.test(req.params.videoId)) return reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
    const deleted = await service.deleteVideo(userId, req.params.videoId);
    return deleted ? reply.code(204).send() : reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'Not found' });
  });

  return app;
}
