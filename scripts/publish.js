const { spawnSync } = require('child_process');

/**
 * `npm run publish -- --skip-test` (or `-s`): runs `npm publish` with the test+typecheck gate in
 * `prepublishOnly` skipped, via DEVSMIND_SKIP_PUBLISH_TESTS — read directly in package.json's
 * `prepublishOnly` script.
 *
 * Exists for the case that actually comes up: `npm test` already passed clean a minute ago, and a
 * publish attempt failed on something unrelated to the code (auth, OTP, a registry hiccup) — every
 * retry then re-runs the full multi-minute suite for no reason, since nothing changed. This is a
 * DELIBERATE, PER-COMMAND opt-out, never a default: plain `npm publish` (or this script without the
 * flag) runs the full gate exactly as before, so skipping tests always has to be asked for by name.
 */
const skip = process.argv.includes('--skip-test') || process.argv.includes('-s');

if (skip) {
  console.log('⚠️  Skipping tests for this publish (--skip-test) — only safe if `npm test` already passed against this exact code.');
}

const result = spawnSync('npm', ['publish'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ...(skip ? { DEVSMIND_SKIP_PUBLISH_TESTS: '1' } : {}) }
});

process.exit(result.status ?? 1);
