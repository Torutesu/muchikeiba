import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintDeployConfig, parseSecretList, REQUIRED_SECRETS } from '../scripts/deployLint.js';
import { devModeRefused } from '../src/http/devMode.js';

const repoToml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml'), 'utf8');
const errors = (t: string, env: string, o = {}) => lintDeployConfig(t, env, o).filter((i) => i.level === 'error').map((i) => i.message);

/** The repo config with every placeholder filled in, as an operator would before the first deploy. */
const filled = repoToml.replace(/REPLACE_ME/g, 'muchi-real');

describe('deploy config lint (wrangler.toml)', () => {
  it('the repo config is structurally complete for both environments (only placeholders left)', () => {
    for (const env of ['staging', 'production']) {
      expect(errors(repoToml, env, { allowPlaceholders: true })).toEqual([]);
      const strict = errors(repoToml, env);
      expect(strict.length).toBeGreaterThan(0);
      expect(strict.every((m) => m.includes('placeholder'))).toBe(true);
    }
  });

  it('a filled-in config passes, and passes the secrets check only when every required secret is set', () => {
    expect(errors(filled, 'production')).toEqual([]);
    expect(errors(filled, 'production', { secretNames: [...REQUIRED_SECRETS] })).toEqual([]);
    const missing = errors(filled, 'production', { secretNames: ['TICKET_SECRET'] });
    expect(missing).toContainEqual(expect.stringContaining('VERIFIER_TOKEN'));
    expect(missing).toContainEqual(expect.stringContaining('KPI_SALT'));
  });

  it('refuses DEV_MODE anywhere in the file', () => {
    const t = filled.replace('[env.production.vars]\n', '[env.production.vars]\nDEV_MODE = "1"\n');
    expect(errors(t, 'production')).toContainEqual(expect.stringContaining('DEV_MODE'));
    const top = filled.replace('[vars]\n', '[vars]\nDEV_MODE = "1"\n');
    expect(errors(top, 'staging')).toContainEqual(expect.stringContaining('DEV_MODE'));
  });

  it('refuses secrets written as vars', () => {
    const t = filled.replace('[env.staging.vars]\n', '[env.staging.vars]\nKPI_SALT = "oops"\n');
    expect(errors(t, 'staging')).toContainEqual(expect.stringContaining('KPI_SALT is a secret'));
  });

  it('refuses missing bindings, shared storage, missing crons and wrong ENVIRONMENT', () => {
    const noIntegrity = filled.replace('[[env.production.durable_objects.bindings]]\nname = "INTEGRITY"\nclass_name = "IntegrityDO"\n', '');
    expect(errors(noIntegrity, 'production')).toContainEqual(expect.stringContaining('INTEGRITY'));
    const shared = filled.replace('bucket_name = "muchi-replays-production"', 'bucket_name = "muchi-replays-staging"');
    expect(errors(shared, 'production')).toContainEqual(expect.stringContaining('shared with staging'));
    const noCron = filled.replace('[env.production.triggers]\ncrons = ["*/5 * * * *", "23 18 * * *", "7 3 * * *"]', '[env.production.triggers]\ncrons = ["*/5 * * * *"]');
    expect(errors(noCron, 'production')).toContainEqual(expect.stringContaining('23 18 * * *'));
    const wrongEnv = filled.replace('ENVIRONMENT = "production"', 'ENVIRONMENT = "staging"');
    expect(errors(wrongEnv, 'production')).toContainEqual(expect.stringContaining('ENVIRONMENT must be "production"'));
  });

  it('production-only policies', () => {
    const testBuys = filled.replace('GOOGLE_ACCEPT_TEST = "0"', 'GOOGLE_ACCEPT_TEST = "1"');
    expect(errors(testBuys, 'production')).toContainEqual(expect.stringContaining('GOOGLE_ACCEPT_TEST'));
    expect(errors(testBuys, 'staging')).toEqual([]); // staging may accept test purchases
  });

  it('rejects unknown environments and unparsable files', () => {
    expect(errors(filled, 'prod')).toContainEqual(expect.stringContaining('unknown deploy environment'));
    expect(errors('this is = = not toml', 'production')[0]).toMatch(/does not parse/);
  });

  it('reads wrangler secret list output', () => {
    expect(parseSecretList('[{"name":"KPI_SALT","type":"secret_text"},{"name":"TICKET_SECRET","type":"secret_text"}]')).toEqual(['KPI_SALT', 'TICKET_SECRET']);
    expect(parseSecretList('["A","B"]')).toEqual(['A', 'B']);
  });
});

describe('DEV_MODE guard at runtime', () => {
  it('is refused in deployed environments even on loopback', () => {
    const local = new Request('http://127.0.0.1:8787/v1/health');
    expect(devModeRefused(local, { DEV_MODE: '1', ENVIRONMENT: 'local' })).toBe(false);
    expect(devModeRefused(local, { DEV_MODE: '1', ENVIRONMENT: 'staging' })).toBe(true);
    expect(devModeRefused(local, { DEV_MODE: '1', ENVIRONMENT: 'production' })).toBe(true);
    expect(devModeRefused(new Request('https://api.example/v1/health'), { DEV_MODE: '1' })).toBe(true);
    expect(devModeRefused(local, { ENVIRONMENT: 'production' })).toBe(false);
  });
});
