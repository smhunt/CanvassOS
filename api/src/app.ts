import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { registerSessionHook } from './auth/guard.js';
import type { Config } from './config.js';
import { createPool, type Db } from './db.js';
import { ApiError } from './lib/errors.js';
import type { FetchLike } from './lib/streetview.js';
import { createProvider, type MessageProvider } from './messaging/provider.js';
import { SendWorker } from './messaging/worker.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { contactRoutes } from './routes/contacts.js';
import { healthRoutes } from './routes/health.js';
import { householdRoutes } from './routes/households.js';
import { messagingRoutes } from './routes/messaging.js';
import { metaRoutes } from './routes/meta.js';
import { searchRoutes } from './routes/search.js';
import { MAX_PHOTO_BYTES, signRoutes } from './routes/signs.js';
import { statsRoutes } from './routes/stats.js';
import { streetRoutes } from './routes/streets.js';
import { publicRequestRoutes } from './routes/public-requests.js';
import { subscribeRoutes } from './routes/subscribe.js';
import { assignmentRoutes, turfRoutes } from './routes/turfs.js';
import { userRoutes } from './routes/users.js';
import { voterContactRoutes } from './routes/voter-contacts.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /**
     * The only outbound HTTP the API makes (Street View imagery). Decorated rather than called as
     * a global so the test suite can hand in a stub — no test ever makes a real, billed request.
     */
    httpFetch: FetchLike;
    /**
     * Phase 5 messaging. The provider is `log` unless MESSAGING_PROVIDER says otherwise, so a
     * default deployment writes the send rows and sends nothing; the worker is the throttled drip
     * that respects daily caps and quiet hours. Decorated (like httpFetch) so tests inject a
     * provider and no test can make a real, billed call.
     */
    messaging: { provider: MessageProvider; worker: SendWorker };
  }
}

export interface BuildOptions {
  config: Config;
  /** Inject an existing pool (tests); otherwise one is created from config.DATABASE_URL. */
  db?: Db;
  /** Inject an outbound fetch (tests); otherwise the platform one. */
  fetchImpl?: FetchLike;
  /** Inject a message provider (tests); otherwise the one MESSAGING_PROVIDER names. */
  provider?: MessageProvider;
  logger?: boolean;
}

// Auth routes must never have their bodies logged (API.md "Logging").
const NO_BODY_LOG = /^\/api\/auth\//;

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          },
    trustProxy: config.TRUST_PROXY === '1' || config.TRUST_PROXY === 'true',
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    disableRequestLogging: false,
    bodyLimit: 64 * 1024,
  });

  const db = opts.db ?? createPool(config.DATABASE_URL);
  app.decorate('db', db);
  app.decorate('config', config);
  // Bound to globalThis explicitly: an unbound `fetch` reference throws "Illegal invocation".
  app.decorate('httpFetch', opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)));
  if (!opts.db) {
    app.addHook('onClose', async () => {
      await db.end();
    });
  }

  const provider = opts.provider ?? createProvider(config, app.log, app.httpFetch);
  const worker = new SendWorker({
    db,
    log: app.log,
    provider,
    quiet: { start: config.MESSAGING_QUIET_START, end: config.MESSAGING_QUIET_END },
  });
  app.decorate('messaging', { provider, worker });
  app.addHook('onClose', async () => {
    worker.stopScheduling();
  });

  await app.register(fastifyHelmet, {
    // JSON API only; the SPA's CSP is set by Caddy. HSTS is also set by Caddy for the whole site.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyCookie, { secret: config.SESSION_SECRET });
  await app.register(fastifyRateLimit, {
    global: false, // opt-in per route (login, accept-invite)
    keyGenerator: (req) => req.ip,
    // The plugin `throw`s whatever this returns, so hand it an ApiError; setErrorHandler shapes it.
    errorResponseBuilder: (_req, ctx) =>
      new ApiError(429, 'rate_limited', `too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s`),
  });

  // Sign photos are the one multipart route in the API. @fastify/multipart is fastify-plugin
  // wrapped, so it applies app-wide however it is registered — declare it here where the other
  // plugins are, with the limits the photo endpoint enforces (one file, 8 MB).
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 8, parts: 12 },
  });

  // Provider webhooks (POST /api/messaging/inbound and /status) arrive as form-encoded bodies,
  // not JSON — that is how carriers post. Parsed here with the platform URLSearchParams rather
  // than by adding a dependency for eleven lines of work.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, payload, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(payload as string)));
    } catch (err) {
      done(err as Error);
    }
  });

  // Uniform error envelope: { error: { code, message } }
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message } });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, reqId: req.id }, 'unhandled error');
      return reply.status(500).send({ error: { code: 'internal_error', message: 'internal server error' } });
    }
    // fastify-generated 4xx (bad JSON, payload too large, ...)
    const code = (err as { code?: string }).code ?? 'bad_request';
    return reply.status(status).send({ error: { code: String(code).toLowerCase(), message: err.message } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: `route ${req.method} ${req.url} not found` } });
  });

  // Never log request bodies; on auth routes also drop the URL query (defensive — they use POST).
  app.addHook('onRequest', async (req) => {
    if (NO_BODY_LOG.test(req.url)) req.log = req.log.child({ auth: true });
  });

  registerSessionHook(app);

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(metaRoutes);
      await api.register(householdRoutes, { prefix: '/households' });
      await api.register(searchRoutes);
      await api.register(streetRoutes);
      await api.register(statsRoutes, { prefix: '/stats' });
      await api.register(turfRoutes, { prefix: '/turfs' });
      await api.register(assignmentRoutes);
      await api.register(contactRoutes);
      await api.register(signRoutes, { prefix: '/signs' });
      await api.register(voterContactRoutes, { prefix: '/voter-contacts' });
      await api.register(messagingRoutes, { prefix: '/messaging' });
      // Public, no session: the self-serve opt-in form posts here. Sits beside /messaging rather
      // than under it because it is the one messaging route an anonymous visitor may call.
      await api.register(subscribeRoutes);
      await api.register(publicRequestRoutes);
      await api.register(auditRoutes);
    },
    { prefix: '/api' },
  );

  await bootstrapAdmin(db, config, app.log);
  return app;
}
