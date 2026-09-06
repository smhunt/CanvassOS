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
  return cfg;
}

export const SESSION_COOKIE = 'canvass_sid';
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;
