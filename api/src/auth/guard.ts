import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import { roleAtLeast, type Role } from '../lib/serialize.js';
import { loadSession, type CurrentSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the global onRequest hook when a valid session cookie is present. */
    session: CurrentSession | null;
  }
}

/** Global hook: resolve the session cookie once per request (cheap; one indexed query). */
export function registerSessionHook(app: FastifyInstance): void {
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    req.session = await loadSession(app.db, req);
  });
}

/** preHandler: any logged-in user. */
export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!req.session) throw unauthorized();
};

/** preHandler factory: logged-in AND role >= min. */
export function requireRole(min: Role): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.session) throw unauthorized();
    if (!roleAtLeast(req.session.user.role, min)) {
      throw forbidden(`this route requires the ${min} role`);
    }
  };
}

/** Narrowing helper for handlers behind requireAuth/requireRole. */
export function currentSession(req: FastifyRequest): CurrentSession {
  if (!req.session) throw unauthorized();
  return req.session;
}
