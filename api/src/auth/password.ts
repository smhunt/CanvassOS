import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP recommended minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    // Still burn comparable time so a missing hash is not distinguishable by timing.
    await argon2.hash(password, ARGON_OPTS);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Random invite token (URL-safe). The DB stores only its sha256 (see users.ts). */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
