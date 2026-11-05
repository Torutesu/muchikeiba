import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { goldenConfigs } from './golden.js';

const dir = join(import.meta.dirname, '../../contracts/golden');
mkdirSync(dir, { recursive: true });
for (const [file, cfg] of Object.entries(goldenConfigs())) {
  writeFileSync(join(dir, file), JSON.stringify(cfg, null, 2) + '\n');
  console.log('wrote', file);
}
