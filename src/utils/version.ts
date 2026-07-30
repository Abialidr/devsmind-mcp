import * as fs from 'fs';
import * as path from 'path';

/**
 * The published package version, read from package.json at runtime.
 *
 * Deliberately not a hardcoded constant: the previous one was, and it drifted the whole way from
 * the first commit to 2.5.0 — `devsmind -v` answered `1.0.0` for every release in between, which
 * is worse than no version at all, since a user reporting a bug reads it and believes it. There is
 * exactly one number now (package.json's) and everything that reports a version derives it.
 *
 * `src/<dir>/` and `dist/<dir>/` both sit two levels under the package root, so one relative path
 * resolves correctly under ts-node, jest and the published build alike. A read failure falls back
 * to `'unknown'` rather than throwing — a missing package.json means a broken install, and failing
 * to start the server over a cosmetic string would be the wrong trade.
 */
export const DEVSMIND_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
