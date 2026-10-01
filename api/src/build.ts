/*
 * What is running: version, commit, build time and which environment this is. Shown in the app's
 * footer so anyone can tell a demo from production at a glance, and whether the web and the API
 * came from the same commit.
 *
 * The commit and build time come from the image (`GIT_COMMIT` / `BUILD_TIME`, build args set by the
 * Makefile and passed through docker-compose.yml); outside Docker — `npm run dev`, the demo stack —
 * they are read from git, and "unknown" when neither is possible. The version is package.json's,
 * which a web test keeps equal to the SPA's and to CHANGELOG.md.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.js';

export type AppEnv = 'production' | 'demo' | 'development';

export interface BuildInfo {
  version: string;
  commit: string;
  built_at: string;
  env: AppEnv;
}

const DEV_DOMAINS = /^(localhost|127\.0\.0\.1|\[::1\])$|\.dev\.ecoworks\.ca$|^dev\.ecoworks\.ca$/;

/**
 * Demo is decided by the database, not by a flag: `canvass_demo` holds invented residents and
 * nothing else, and a stack reading from it is a demo whatever else is set. After that an explicit
 * `APP_ENV` wins; then a development domain; then the image's NODE_ENV=production.
 */
export function deriveEnv(cfg: Pick<Config, 'DATABASE_URL' | 'DOMAIN' | 'APP_ENV'>, nodeEnv = process.env.NODE_ENV): AppEnv {
  if (/\/canvass_demo(\?|$)/.test(cfg.DATABASE_URL)) return 'demo';
  if (cfg.APP_ENV) return cfg.APP_ENV;
  if (DEV_DOMAINS.test(cfg.DOMAIN)) return 'development';
  return nodeEnv === 'production' ? 'production' : 'development';
}

function fromGit(args: string): string | null {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    // dist/build.js and src/build.ts both sit one level below api/package.json.
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function loadBuildInfo(cfg: Pick<Config, 'DATABASE_URL' | 'DOMAIN' | 'APP_ENV'>, env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commit = env.GIT_COMMIT?.trim() || fromGit('rev-parse --short HEAD') || 'unknown';
  const built_at = env.BUILD_TIME?.trim() || new Date().toISOString();
  return { version: packageVersion(), commit, built_at, env: deriveEnv(cfg, env.NODE_ENV) };
}
