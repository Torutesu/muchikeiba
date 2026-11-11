import { parse } from 'smol-toml';

/**
 * Deployment config lint (docs/ops/deploy.md). Checks that a deployed environment in wrangler.toml is complete
 * and safe BEFORE `wrangler deploy --env <name>` runs:
 *  - the env exists, names itself (ENVIRONMENT), and never sets DEV_MODE (anywhere in the file)
 *  - no secret is written into [vars] (secrets go through `wrangler secret put`)
 *  - every required var is present and well-formed; production-only policies
 *  - every binding of the local config exists in the env (wrangler does not inherit bindings),
 *    with storage (R2 buckets, Analytics dataset) separate from every other environment
 *  - no placeholder (REPLACE_ME, example.invalid, <...>) is left
 *  - optionally: the deployed Worker has every required secret (`wrangler secret list --env <name>` output)
 */

export const DEPLOY_ENVS = ['staging', 'production'] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/** Secrets every deployed environment needs (`wrangler secret put <NAME> --env <env>`). */
export const REQUIRED_SECRETS = ['TICKET_SECRET', 'VERIFIER_TOKEN', 'ADMIN_TOKENS', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'KPI_SALT'] as const;
/** Secrets that may be set (FCM falls back to GOOGLE_SERVICE_ACCOUNT_JSON; ADMIN_TOKEN is the legacy single token). */
export const OPTIONAL_SECRETS = ['FCM_SERVICE_ACCOUNT_JSON', 'ADMIN_TOKEN', 'FIREBASE_AUTH_SERVICE_ACCOUNT_JSON'] as const;
/** Names that must never appear in [vars] (they would be visible in the dashboard and in git). */
const SECRET_NAMES = new Set<string>([...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]);

export const REQUIRED_VARS = [
  'ENVIRONMENT', 'VERIFIER_URL', 'FIREBASE_PROJECT_ID', 'VERIFY_SAMPLE_RATE', 'ASSET_CDN_BASE',
  'APPLE_BUNDLE_ID', 'GOOGLE_PACKAGE_NAME', 'GOOGLE_PUBSUB_AUDIENCE', 'GOOGLE_PUBSUB_SERVICE_ACCOUNT', 'FCM_PROJECT_ID',
] as const;

const PLACEHOLDER = /REPLACE_ME|example\.invalid|<[^>]*>/i;

export interface LintIssue { level: 'error' | 'warning'; message: string }
export interface LintOptions {
  /** Report placeholders as warnings instead of errors (CI structure check before accounts exist). */
  allowPlaceholders?: boolean;
  /** Secret names present on the deployed Worker; when given, missing required secrets are errors. */
  secretNames?: string[];
}

type Table = Record<string, unknown>;
const isTable = (x: unknown): x is Table => typeof x === 'object' && x !== null && !Array.isArray(x);
const arr = (x: unknown): Table[] => (Array.isArray(x) ? x.filter(isTable) : []);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

/** Every string value inside a value, with its dotted path (for placeholder scanning). */
function walkStrings(x: unknown, path: string, out: { path: string; value: string }[]) {
  if (typeof x === 'string') out.push({ path, value: x });
  else if (Array.isArray(x)) x.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
  else if (isTable(x)) for (const [k, v] of Object.entries(x)) walkStrings(v, path ? `${path}.${k}` : k, out);
  return out;
}

export function lintDeployConfig(tomlText: string, envName: string, opts: LintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warning', message });

  let root: Table;
  try {
    root = parse(tomlText) as Table;
  } catch (e) {
    return [{ level: 'error', message: `wrangler.toml does not parse: ${(e as Error).message}` }];
  }
  if (!(DEPLOY_ENVS as readonly string[]).includes(envName)) return [{ level: 'error', message: `unknown deploy environment "${envName}" (expected ${DEPLOY_ENVS.join(' | ')})` }];

  const envs = isTable(root.env) ? root.env : {};
  const env = envs[envName];
  if (!isTable(env)) return [{ level: 'error', message: `[env.${envName}] is missing` }];

  // DEV_MODE must not be set anywhere in the file (local passes it with --var)
  const topVars = isTable(root.vars) ? root.vars : {};
  if ('DEV_MODE' in topVars) err('DEV_MODE is set in top-level [vars]; pass it with `--var DEV_MODE:1` for local runs only');
  for (const [name, e] of Object.entries(envs)) {
    if (isTable(e) && isTable(e.vars) && 'DEV_MODE' in e.vars) err(`DEV_MODE is set in [env.${name}.vars]`);
  }

  // vars
  const vars = isTable(env.vars) ? env.vars : {};
  for (const k of Object.keys(vars)) if (SECRET_NAMES.has(k)) err(`${k} is a secret but is written in [env.${envName}.vars]; use \`wrangler secret put ${k} --env ${envName}\``);
  for (const k of REQUIRED_VARS) {
    const v = vars[k];
    if (typeof v !== 'string' || v.trim() === '') err(`[env.${envName}.vars] ${k} is required`);
  }
  if (vars.ENVIRONMENT !== undefined && vars.ENVIRONMENT !== envName) err(`[env.${envName}.vars] ENVIRONMENT must be "${envName}" (got "${String(vars.ENVIRONMENT)}")`);
  if (typeof vars.VERIFIER_URL === 'string' && !vars.VERIFIER_URL.startsWith('https://')) err('VERIFIER_URL must be https://');
  if (typeof vars.ASSET_CDN_BASE === 'string' && (!vars.ASSET_CDN_BASE.startsWith('https://') || vars.ASSET_CDN_BASE.endsWith('/') || /[?#]/.test(vars.ASSET_CDN_BASE))) {
    err('ASSET_CDN_BASE must be https://… without a trailing slash, query or fragment (REQ-DLV-002)');
  }
  if (typeof vars.VERIFY_SAMPLE_RATE === 'string') {
    const r = Number(vars.VERIFY_SAMPLE_RATE);
    if (!(r >= 0 && r <= 1)) err(`VERIFY_SAMPLE_RATE must be between 0 and 1 (got "${vars.VERIFY_SAMPLE_RATE}")`);
  }
  if (envName === 'production') {
    if (vars.GOOGLE_ACCEPT_TEST !== '0') err('production must set GOOGLE_ACCEPT_TEST = "0" (license-testing purchases are not revenue)');
    if (vars.APPLE_ACCEPT_SANDBOX !== '0' && vars.APPLE_ACCEPT_SANDBOX !== '1') err('production must set APPLE_ACCEPT_SANDBOX explicitly ("1" only while App Review needs sandbox IAP on this backend, else "0")');
    if (vars.APPLE_ACCEPT_SANDBOX === '1') warn('production accepts Apple sandbox receipts (App Review). They credit free coins only; point TestFlight builds at staging and set "0" after review');
    if (env.workers_dev !== false) err('production must set workers_dev = false (serve only on the custom domain)');
    if (strings(env.routes).length === 0 && arr(env.routes).length === 0) err('production needs routes (custom domain)');
  }

  // bindings: everything the local config binds must exist in the env (not inherited by wrangler)
  const doNames = (t: Table) => new Map(arr(isTable(t.durable_objects) ? t.durable_objects.bindings : undefined).map((b) => [String(b.name), String(b.class_name)]));
  const localDo = doNames(root);
  const envDo = doNames(env);
  for (const [name, cls] of localDo) {
    if (!envDo.has(name)) err(`[env.${envName}] is missing the Durable Object binding ${name} (${cls})`);
    else if (envDo.get(name) !== cls) err(`[env.${envName}] Durable Object ${name} uses class ${envDo.get(name)}, expected ${cls}`);
  }
  const r2 = (t: Table) => new Map(arr(t.r2_buckets).map((b) => [String(b.binding), String(b.bucket_name)]));
  const ae = (t: Table) => new Map(arr(t.analytics_engine_datasets).map((b) => [String(b.binding), String(b.dataset)]));
  const others: { label: string; t: Table }[] = [{ label: 'local', t: root }, ...Object.entries(envs).filter(([n, e]) => n !== envName && isTable(e)).map(([n, e]) => ({ label: n, t: e as Table }))];
  for (const [kind, get] of [['R2 bucket', r2], ['Analytics Engine dataset', ae]] as const) {
    const mine = get(env);
    for (const binding of get(root).keys()) if (!mine.has(binding)) err(`[env.${envName}] is missing the ${kind} binding ${binding}`);
    for (const [binding, resource] of mine) {
      for (const o of others) {
        for (const [ob, ores] of get(o.t)) if (ores === resource) err(`${kind} "${resource}" (${binding}) is shared with ${o.label} (${ob}); every environment needs its own`);
      }
    }
  }
  const crons = (t: Table) => (isTable(t.triggers) ? strings(t.triggers.crons) : []);
  const localCrons = crons(root);
  const envCrons = crons(env);
  for (const c of localCrons) if (!envCrons.includes(c)) err(`[env.${envName}.triggers] is missing cron "${c}"`);
  if (typeof env.name !== 'string' || env.name === root.name) err(`[env.${envName}] needs its own Worker name`);

  // placeholders
  for (const { path, value } of walkStrings(env, `env.${envName}`, [])) {
    if (PLACEHOLDER.test(value)) (opts.allowPlaceholders ? warn : err)(`${path} still has a placeholder: "${value}"`);
  }

  // secrets on the deployed Worker
  if (opts.secretNames) {
    const have = new Set(opts.secretNames);
    for (const s of REQUIRED_SECRETS) if (!have.has(s)) err(`secret ${s} is not set on ${envName}: wrangler secret put ${s} --env ${envName}`);
  }
  return issues;
}

/** Accepts `wrangler secret list --format json` output (`[{name,type}]`) or a plain string array. */
export function parseSecretList(json: string): string[] {
  const x: unknown = JSON.parse(json);
  if (!Array.isArray(x)) throw new Error('secret list must be a JSON array');
  return x.map((e) => (typeof e === 'string' ? e : isTable(e) && typeof e.name === 'string' ? e.name : '')).filter((s) => s !== '');
}
