import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Files that run for many minutes (the 90-day economy simulation: 57 simulated players). Vitest orders files by the
 * durations of earlier runs and, without that cache (a fresh checkout or worktree), by file size, so this small file
 * used to start LAST and the whole run waited for it after everything else had finished (the "stalled" full run).
 * They start first, on their own worker, while the other workers take the rest.
 */
const LONG_RUNNING = ['/test/economy.test.ts'];

class LongFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const sorted = await super.sort(files);
    const long = (f: TestSpecification) => LONG_RUNNING.some((x) => f.moduleId.replaceAll('\\', '/').endsWith(x));
    return [...sorted.filter(long), ...sorted.filter((f) => !long(f))];
  }
}

export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 20000, sequence: { sequencer: LongFirstSequencer } } });
