import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { one, type Db } from '../db.js';
import { hashPassword } from './password.js';

/**
 * First boot: when app_user is EMPTY and ADMIN_EMAIL/ADMIN_PASSWORD are set, create the initial
 * admin. Never touches an existing user — changing ADMIN_PASSWORD later has no effect (change it
 * from inside the app instead), and the env vars can be removed from .env once the admin exists.
 */
export async function bootstrapAdmin(db: Db, cfg: Config, log: FastifyBaseLogger): Promise<void> {
  const row = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM app_user`);
  if (!row || row.n > 0) return;
  if (!cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) {
    log.warn('app_user is empty and ADMIN_EMAIL/ADMIN_PASSWORD are not set — nobody can log in');
    return;
  }
  const hash = await hashPassword(cfg.ADMIN_PASSWORD);
  // ON CONFLICT guards against two API replicas booting at once.
  await db.query(
    `INSERT INTO app_user (email, name, role, password_hash, active)
     VALUES ($1, $2, 'admin', $3, true)
     ON CONFLICT (email) DO NOTHING`,
    [cfg.ADMIN_EMAIL, cfg.ADMIN_EMAIL.split('@')[0] ?? 'Admin', hash],
  );
  log.info({ email: cfg.ADMIN_EMAIL }, 'first boot: created initial admin user');
}
