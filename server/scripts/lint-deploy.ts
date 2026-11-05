/**
 * npm run lint:deploy -- --env production [--allow-placeholders] [--secrets <wrangler-secret-list.json>]
 * Exit code 1 when the config would deploy unsafely (see scripts/deployLint.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintDeployConfig, parseSecretList } from './deployLint.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const envName = value('--env');
if (!envName) {
  console.error('usage: lint-deploy --env <staging|production> [--allow-placeholders] [--secrets <file.json>]');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(value('--config') ?? join(here, '..', 'wrangler.toml'), 'utf8');
const secretsFile = value('--secrets');
const issues = lintDeployConfig(toml, envName, {
  allowPlaceholders: flag('--allow-placeholders'),
  ...(secretsFile ? { secretNames: parseSecretList(readFileSync(secretsFile, 'utf8')) } : {}),
});
for (const i of issues) console.log(`${i.level === 'error' ? 'ERROR  ' : 'warning'} ${i.message}`);
const errors = issues.filter((i) => i.level === 'error').length;
console.log(errors ? `\n${errors} error(s): ${envName} must not be deployed` : `\n${envName}: OK (${issues.length} warning(s))`);
process.exit(errors ? 1 : 0);
