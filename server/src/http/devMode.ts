import type { Env } from '../env.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * DEV_MODE (x-dev-user impersonation + fake store) only ever works on loopback in the local environment.
 * If it leaks into a deployed environment, every request fails closed instead of letting anyone mint coins
 * (bug review #12). Deployed environments (wrangler.toml [env.staging]/[env.production]) set ENVIRONMENT and
 * refuse DEV_MODE even via loopback.
 */
export function devModeRefused(req: Request, env: Pick<Env, 'DEV_MODE' | 'ENVIRONMENT'>): boolean {
  if (env.DEV_MODE !== '1') return false;
  if (env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production') return true;
  return !LOOPBACK.has(new URL(req.url).hostname);
}
