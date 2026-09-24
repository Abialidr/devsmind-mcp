const { spawnSync } = require('child_process');

/**
 * The actual test+typecheck gate `prepublishOnly` runs — pulled into its own script so it can be
 * skipped by `DEVSMIND_SKIP_PUBLISH_TESTS`, set only by `npm run publish:safe -- --skip-test` (see
 * scripts/publish.js). Plain `npm publish` never sets that variable, so the gate runs in full for
 * anyone not deliberately asking to skip it — this is an opt-in escape hatch, not a weaker default.
 */
if (process.env.DEVSMIND_SKIP_PUBLISH_TESTS === '1') {
  console.log('⚠️  DEVSMIND_SKIP_PUBLISH_TESTS is set — skipping typecheck + test suite before publish.');
  process.exit(0);
}

const tsc = spawnSync('node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'], { stdio: 'inherit', shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const jest = spawnSync('node', ['node_modules/jest/bin/jest.js', '--coverage', '--ci'], { stdio: 'inherit', shell: true });
process.exit(jest.status ?? 1);
