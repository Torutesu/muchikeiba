// Builds the ops console into dist/ (no dependencies, works offline).
//   OPS_API_BASE   admin API origin, e.g. https://api.example.com ('' = same origin as the console)
//   OPS_ENV_LABEL  badge shown in the header: local | staging | production
//   OPS_DOCS_BASE  where docs/ links point (default: the GitHub repository)
// Usage: node build.mjs [outDir]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKpiQueries } from './src/kpi-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, 'dist');
const apiBase = (process.env.OPS_API_BASE ?? '').replace(/\/+$/, '');
const envLabel = process.env.OPS_ENV_LABEL ?? 'local';
const docsBase = (process.env.OPS_DOCS_BASE ?? 'https://github.com/Torutesu/muchikeiba/blob/main').replace(/\/+$/, '');

if (apiBase && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(apiBase)) {
  console.error(`OPS_API_BASE must be an origin (scheme://host[:port]), got ${apiBase}`);
  process.exit(1);
}
if (!/^(local|staging|production)$/.test(envLabel)) {
  console.error('OPS_ENV_LABEL must be local|staging|production');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'src'), out, { recursive: true });

// Strict CSP: scripts/styles only from the console itself, API calls only to the console origin and the API origin.
const csp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  `connect-src 'self'${apiBase ? ` ${apiBase}` : ''}`, "base-uri 'none'", "form-action 'none'",
].join('; '); // frame-ancestors only works as a header: the host sends it (serve.mjs, docs/ops/console.md)
const html = readFileSync(join(here, 'src/index.html'), 'utf8').replace('%CSP%', csp);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'config.js'), `window.OPS_CONSOLE_CONFIG = ${JSON.stringify({ apiBase, envLabel, docsBase, builtAt: new Date().toISOString() })};\n`);

// KPI quick view: the queries of docs/ops/kpi-queries.md, grouped by heading
const kpiPath = join(here, '../../docs/ops/kpi-queries.md');
const kpi = parseKpiQueries(readFileSync(kpiPath, 'utf8'));
writeFileSync(join(out, 'kpi.json'), JSON.stringify({ source: 'docs/ops/kpi-queries.md', sections: kpi }, null, 1));
console.log(`ops console → ${out} (api ${apiBase || 'same origin'}, env ${envLabel}, ${kpi.length} KPI sections)`);
