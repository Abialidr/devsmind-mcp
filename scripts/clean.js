const fs = require('fs');
const path = require('path');

/**
 * Wipe `dist/` before a build.
 *
 * `tsc` overwrites what it emits but never removes an output whose source is gone, and
 * `copy-assets.js` only copies the files it names — so a deleted source leaves its build artifact
 * behind forever. That is not theoretical: `visualizer_2d.html`, `visualizer_3d.html` and
 * `visualizer_activity.html` were deleted from `src/` when the view app became a single page, and
 * kept shipping in the published tarball afterwards — 53KB of dead pages no route even serves,
 * sitting in every user's node_modules looking like current code.
 *
 * Cheap insurance: the build is a few seconds either way, and a stale artifact is the kind of bug
 * you only find by reading a tarball listing.
 */
const distDir = path.join(__dirname, '..', 'dist');

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log('✓ Cleaned dist/');
} else {
  console.log('✓ dist/ already absent — nothing to clean');
}
