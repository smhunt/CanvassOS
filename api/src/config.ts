import { z } from 'zod';

// Environment contract (see API.md "Conventions").
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters (used to sign the session cookie)'),
  DOMAIN: z.string().min(1).default('localhost'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: z.string().default('1'),
  // Set to "false" for plain-http local development; the production stack is TLS-only.
  COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  BOUNDARY_PATH: z.string().default('../data/mc_boundary.json'),
  // Sign photos are files on disk, not rows: they are large, never queried, and living in `data/`
  // means `make purge` shreds them with the CSVs after the election. Created on first boot if absent.
  SIGN_PHOTO_DIR: z.string().default('../data/sign-photos'),
  // Street-level imagery of a door (GET /api/households/:id/streetview). ABSENT = FEATURE OFF, and
  // that is the default on purpose: it is the only call this stack makes to a third party, and a
  // campaign is entitled to decide it would rather make none. When it is set, the key stays here —
  // it is never served to the browser (see lib/streetview.ts for the whole privacy argument).
  STREETVIEW_API_KEY: z.string().min(1).optional(),
  // An enum rather than a string so that adding an openly-licensed provider later is a deliberate
  // code change, not a typo in the environment that silently disables the feature.
  STREETVIEW_PROVIDER: z.enum(['google']).default('google'),

  // ---------------------------------------------------------------- messaging (Phase 5)
  // This subsystem can text thousands of real people, so every default below is the one that
  // sends nothing.
  //
  // `log` writes the message_send rows, logs a line per message, and puts no packet on the wire.
  // A real send needs BOTH this set to a live provider AND that provider's credentials, and
  // loadConfig() refuses to boot with the first without the second — a half-configured deployment
  // fails at startup rather than silently at 3am in the middle of a GOTV drip.
  MESSAGING_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  // The blast radius. POST /campaigns/:id/send refuses an audience larger than this unless the
  // request explicitly overrides it, so "I meant to test on my ward" cannot become 17,000 texts.
  MESSAGING_MAX_AUDIENCE: z.coerce.number().int().positive().default(5000),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  // Weekday sending window, America/Toronto (CRTC telemarketing/ADAD hours). Weekends are narrowed
  // to 10:00-18:00 inside these bounds — see lib/quiet-hours.ts.
  MESSAGING_QUIET_START: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM').default('09:00'),
  MESSAGING_QUIET_END: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM').default('21:30'),
  // How the campaign names itself in an automated STOP/HELP/JOIN reply. Carriers require the reply
  // to identify the sender, and a person who does not recognise the number deserves to know.
  MESSAGING_ORG_NAME: z.string().min(1).max(60).default('This campaign'),
  // Shared secret for the two provider webhooks, checked IN ADDITION to the provider signature and
  // for every provider. Optional, but a deployment reachable from the internet should set it: an
  // unauthenticated POST to /api/messaging/inbound with Body=JOIN would otherwise mint consent for
  // a number of the caller's choosing.
  MESSAGING_WEBHOOK_TOKEN: z.string().min(16).optional(),

  // ---------------------------------------------------------------- advice (reachability report)
  // The second and last thing in this stack that talks to a third party. ABSENT = FEATURE OFF, and
  // that is the default on purpose: the report renders its own written guidance without it. Only
  // aggregate counts are ever sent — see lib/advice.ts for the whole argument and the runtime guard.
  ADVICE_API_KEY: z.string().min(1).optional(),
  // An enum so that adding a provider is a deliberate code change rather than a typo in the
  // environment that silently disables the feature.
  ADVICE_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  ADVICE_MODEL: z.string().min(1).default('claude-sonnet-5'),

  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid environment: ${issues}`);
  }
  const cfg = parsed.data;
  if ((cfg.ADMIN_EMAIL && !cfg.ADMIN_PASSWORD) || (!cfg.ADMIN_EMAIL && cfg.ADMIN_PASSWORD)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
  }
  // Fail at boot, loudly, rather than at the first send. A stack that thinks it is sending for
  // real and cannot authenticate would queue a whole campaign and fail every row of it.
  if (cfg.MESSAGING_PROVIDER === 'twilio' && !(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN)) {
    throw new Error('MESSAGING_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
  }
  if (cfg.MESSAGING_QUIET_START >= cfg.MESSAGING_QUIET_END) {
    throw new Error('MESSAGING_QUIET_START must be earlier than MESSAGING_QUIET_END');
  }
  return cfg;
}

export const SESSION_COOKIE = 'canvass_sid';
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;
